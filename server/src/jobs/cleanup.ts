// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/10 §10.13 · docs/30 WS-G] Pemeliharaan basis data — satu implementasi,
 * dua pemanggil.
 *
 * Sebelum ini logika pembersihan hanya hidup di dalam closure cron
 * `jobs/systemSweeper.ts`, sehingga:
 *
 *   1. `POST /api/admin/cleanup` (jalur manual untuk operator) **tidak mungkin**
 *      memanggilnya — endpoint itu hanya memvalidasi `x-admin-key` lalu menjawab
 *      "Cleanup triggered" tanpa melakukan apa pun (stub);
 *   2. tidak ada satu pun test yang bisa membuktikan langkah-langkahnya, karena
 *      semuanya terikat pada `prisma` global + `cron.schedule`.
 *
 * Modul ini memisahkan **kebijakan** (apa yang dihapus, dengan ambang apa) dari
 * **pengikatan**: `CleanupDb` adalah irisan kecil dari Prisma yang benar-benar
 * dipakai, `purgeUser` disuntik (jalur produksi meneruskan
 * `purgeSealedUserRows`, test meneruskan fungsi palsu), dan `now` selalu
 * parameter. Karena itu test perilakunya berjalan tanpa Postgres/Redis.
 *
 * Perilaku yang **sengaja berbeda** dari versi closure lama: tiap langkah
 * diisolasi (`try/catch` per langkah). Dulu satu error di langkah pertama
 * membuat langkah 2–5 tidak pernah jalan — kegagalan sebuah tabel menahan
 * pembersihan tabel lain tanpa alasan teknis. Sekarang semuanya dicoba, dan
 * kegagalannya dilaporkan per langkah (`errors`) supaya terlihat di metrik,
 * log, dan respons endpoint.
 */

/** Nama langkah; dipakai untuk pelaporan (tanpa identitas apa pun). */
export type CleanupStep =
  | 'refresh_token'
  | 'session_key'
  | 'account'
  | 'subscription'
  | 'story'
  | 'group_mailbox';

export interface CleanupCounts {
  /** RefreshToken kadaluarsa / sudah di-revoke. */
  refreshTokens: number;
  /** SessionKey kadaluarsa atau basi (> 30 hari). */
  sessionKeys: number;
  /** Akun yang dihancurkan dead-man's switch. */
  accounts: number;
  /** Langganan SUBSCRIBER yang jatuh tempo → FREE. */
  subscriptions: number;
  /** Story yang sudah kedaluwarsa. */
  stories: number;
  /** [docs/37 §37.3.2] Item mailbox grup yang lewat TTL. */
  mailboxItems: number;
}

export interface CleanupReport extends CleanupCounts {
  /** Pesan kegagalan per langkah (mis. `refresh_token: ...`), tanpa identitas. */
  errors: string[];
}

/** Jendela "kunci sesi basi" — sama dengan versi lama (30 hari). */
export const STALE_SESSION_KEY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * [BUGFIX 2026-10-18] Token refresh yang sudah di-revoke DIPERTAHANKAN selama
 * jendela ini, bukan dihapus begitu saja.
 *
 * Rantai `replacedById` adalah satu-satunya bukti untuk membedakan
 * "klien mengulang karena respons rotasi hilang" dari "token lama diputar
 * ulang". Dulu cleanup menghapus SEMUA baris revoked setiap hari, sehingga:
 *   - retry benign berubah menjadi `Refresh token not found` → klien logout
 *     tanpa alasan (dan tanpa bisa dilacak);
 *   - replay token lama tidak lagi bisa dideteksi (baris hilang).
 * Retensi 7 hari cukup menutup umur sesi praktis, sementara tabel tetap
 * terkendali (satu sesi aktif ≈ 96 rotasi/hari).
 */
export const REVOKED_REFRESH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Irisan Prisma yang dipakai modul ini.
 *
 * Tipenya sengaja **permissif** (`args?: unknown`): Prisma 7 mengetik argumen
 * `deleteMany`/`findMany` sebagai generic `SelectSubset<…>` yang tidak bisa
 * dijadikan supertipe dari tipe argumen spesifik (parameter kontravarian), jadi
 * kontrak yang longgar adalah satu-satunya bentuk yang menerima Prisma nyata
 * **dan** fake di test tanpa `as` di sisi pemanggil. Yang tetap ketat: bentuk
 * nilai kembalian (`{ count }`) dan kolom yang boleh dibaca pada `findMany`.
 */
export interface CleanupDb {
  refreshToken: {
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
  sessionKey: {
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
  user: {
    findMany(args?: unknown): Promise<Array<{ id: string; lastActiveDay: Date; autoDestructDays: number | null }>>;
    updateMany(args?: unknown): Promise<{ count: number }>;
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
  story: {
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
  // [docs/37 §37.3.2] Mailbox grup: item lewat TTL dihapus job harian.
  groupMailboxItem: {
    deleteMany(args?: unknown): Promise<{ count: number }>;
  };
}

export interface CleanupOptions {
  /** Waktu "sekarang" — selalu disuntik supaya ambang bisa diuji. */
  now?: Date;
  /** Bersihkan baris ter-seal milik akun sebelum akunnya dihapus (docs/28 D8/D9). */
  purgeUser?: (userId: string) => Promise<void>;
  /** Pencatat: default no-op (test tidak ingin noise, produksi memakai console). */
  log?: (message: string) => void;
}

/** Ambang batas keputusan murni: apakah akun sudah lewat tenggat auto-destruct. */
export function isDeadManSwitchDue(
  user: { lastActiveDay: Date; autoDestructDays: number | null },
  now: Date
): boolean {
  if (!user.autoDestructDays) return false;
  const deadline = new Date(user.lastActiveDay);
  deadline.setDate(deadline.getDate() + user.autoDestructDays);
  return now > deadline;
}

/**
 * Jalankan seluruh pembersihan. Tiap langkah diisolasi; hasilnya selalu berupa
 * laporan (tidak pernah melempar) supaya pemanggil cron maupun endpoint bisa
 * menampilkan keadaan sebenarnya.
 */
export async function runCleanup(db: CleanupDb, options: CleanupOptions = {}): Promise<CleanupReport> {
  const now = options.now ?? new Date();
  const purgeUser = options.purgeUser ?? (async () => {});
  const log = options.log ?? (() => {});

  const report: CleanupReport = {
    refreshTokens: 0,
    sessionKeys: 0,
    accounts: 0,
    subscriptions: 0,
    stories: 0,
    mailboxItems: 0,
    errors: [],
  };

  const step = async <T>(name: CleanupStep, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${name}: ${message}`);
      log(`[Cleanup] langkah ${name} gagal: ${message}`);
      return undefined;
    }
  };

  // 1. RefreshToken kadaluarsa & revoked yang sudah melewati masa retensi.
  // Revoked yang masih segar SENGAJA disimpan — lihat
  // REVOKED_REFRESH_TOKEN_RETENTION_MS (rantai reuse-detection).
  await step('refresh_token', async () => {
    const revokedBefore = new Date(now.getTime() - REVOKED_REFRESH_TOKEN_RETENTION_MS);
    const deleted = await db.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { revokedAt: { not: null, lt: revokedBefore } },
        ],
      },
    });
    report.refreshTokens = deleted.count;
    if (deleted.count > 0) log(`[Cleanup] ${deleted.count} refresh token kadaluarsa/revoked dihapus.`);
  });

  // 2. SessionKey kadaluarsa eksplisit, atau basi (> 30 hari).
  await step('session_key', async () => {
    const staleBefore = new Date(now.getTime() - STALE_SESSION_KEY_MS);
    const deleted = await db.sessionKey.deleteMany({
      where: {
        OR: [
          { expiresAt: { not: null, lte: now } },
          { createdAt: { lte: staleBefore } },
        ],
      },
    });
    report.sessionKeys = deleted.count;
    if (deleted.count > 0) log(`[Cleanup] ${deleted.count} session key kadaluarsa/basi dihapus.`);
  });

  // 3. Dead man's switch: akun dorman dihancurkan beserta jejak ter-sealnya.
  await step('account', async () => {
    const candidates = await db.user.findMany({
      where: { autoDestructDays: { not: null } },
      select: { id: true, lastActiveDay: true, autoDestructDays: true },
    });
    for (const user of candidates) {
      if (!isDeadManSwitchDue(user, now)) continue;
      try {
        await purgeUser(user.id);
        await db.user.deleteMany({ where: { id: user.id } });
        report.accounts += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Identitas akun tidak masuk laporan; log server yang menangani detail.
        report.errors.push(`account: ${message}`);
        log(`[Cleanup] gagal menghancurkan akun dorman: ${message}`);
      }
    }
    if (report.accounts > 0) log(`[Cleanup] ${report.accounts} akun dorman dihancurkan.`);
  });

  // 4. Langganan SUBSCRIBER yang jatuh tempo → FREE.
  await step('subscription', async () => {
    const downgraded = await db.user.updateMany({
      where: { subscriptionTier: 'SUBSCRIBER', subscriptionExpiresAt: { lt: now } },
      data: { subscriptionTier: 'FREE', subscriptionExpiresAt: null },
    });
    report.subscriptions = downgraded.count;
    if (downgraded.count > 0) log(`[Cleanup] ${downgraded.count} langganan jatuh tempo → FREE.`);
  });

  // 5b. Mailbox grup kadaluarsa (docs/37 §37.3.2): TTL 7 hari.
  await step('group_mailbox', async () => {
    const deleted = await db.groupMailboxItem.deleteMany({ where: { expiresAt: { lte: now } } });
    report.mailboxItems = deleted.count;
    if (deleted.count > 0) log(`[Cleanup] ${deleted.count} item mailbox grup kadaluarsa dihapus.`);
  });

  // 5. Story kadaluarsa: hapus fisik (dulu menumpuk selamanya; audit temuan #9).
  await step('story', async () => {
    const deleted = await db.story.deleteMany({ where: { expiresAt: { lte: now } } });
    report.stories = deleted.count;
    if (deleted.count > 0) log(`[Cleanup] ${deleted.count} story kadaluarsa dihapus.`);
  });

  return report;
}
