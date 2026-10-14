// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.2] Pin identitas peer (TOFU) yang tidak bisa "diam-diam" tergantikan.
 *
 * Masalah sebelumnya: empat jalur (X3DH initiator, bulk prekey fetch, X3DH
 * recipient, protokol-reset poll) membandingkan kunci identitas peer dengan
 * `ID_PUB_<userId>` lalu **langsung menimpanya**:
 *
 *     if (existing && existing !== bundle.identityKey) { warning(...) }
 *     await savePeerIdentityKey(uid, bundle.identityKey)   // ← pin hilang
 *
 * Konsekuensinya: setelah peringatan pertama, pin sudah jadi kunci penyerang,
 * sehingga perubahan berikutnya tidak lagi memicu warning dan `safety number`
 * yang pernah diverifikasi user berhenti mencocokkan tanpa penjelasan. Ini
 * justru perilaku yang menguntungkan MITM terarah (docs/29 §5.1).
 *
 * Aturan sekarang:
 *   - `trustedKey` = kunci yang DIPERCAYA; hanya berubah bila user menerima
 *     (`acceptPendingPeerIdentity`) — yang di UI dilakukan dengan memverifikasi
 *     safety number baru.
 *   - perubahan kunci dicatat sebagai `pendingKey` + `changedAt` + `previousKey`
 *     (riwayat pin tidak hilang), dan pengiriman pesan user diblokir selama
 *     perubahan itu belum diterima (gate di `store/message.ts`).
 *
 * Penyimpanan: satu blob JSON terenkripsi at-rest (`ENC1:`, masterSeed-bound)
 * di `db.kvStore` — bukan localStorage (dulu verifikasi tidak ditandatangani dan
 * gampang dibersihkan skrip/konsol), dan bukan tabel `identityKeys` plaintext
 * (dump profil browser tidak boleh memuat daftar "siapa bicara dengan siapa").
 * Nilai lama dari `ID_PUB_*` dibaca sebagai tepat satu pin awal (migrasi tanpa
 * memunculkan warning palsu), lalu tidak ditulis lagi.
 */

import { db } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';
import { KT_CONFIRMATION_TTL_MS } from './ktBundleProof';

const KV_KEY = 'nyx_peer_identity_v1';
const LEGACY_PREFIX = 'ID_PUB_';

export interface PeerIdentityTrust {
  /** Kunci identitas yang dipercaya (pin aktif). */
  trustedKey: string;
  /** Kapan pin pertama dibuat (ms). */
  firstSeenAt: number;
  /** Pin sebelumnya, bila pin pernah berganti (diterima user). */
  previousKey?: string;
  /** Kapan perubahan kunci terakhir terlihat (ms). */
  changedAt?: number;
  /** Kunci baru yang MENUNGGU penerimaan user; selama ada, kirim diblokir. */
  pendingKey?: string;
  /**
   * [docs/34 §34.6 poin 1] Kapan kunci ini terakhir dikonfirmasi **log Key
   * Transparency** (ms). `trustedKey` yang punya cap ini sudah dibuktikan ada
   * di log publik, bukan cuma hasil TOFU.
   */
  ktVerifiedAt?: number;
  /** `keyVersion` log saat konfirmasi terakhir. */
  ktKeyVersion?: number;
  /**
   * Log KT menyajikan kunci yang BERBEDA dari bundle (bukti sah) — indikasi
   * MITM terarah. Selama ada, kirim diblokir sampai user menerima kunci baru
   * (`acceptPendingPeerIdentity`) setelah memverifikasi safety number.
   */
  ktMismatch?: { servedKey: string; logKey: string; at: number };
  /** Verdict KT terakhir yang bukan `confirmed` (untuk banner/diagnostik). */
  ktLastVerdict?: string;
  ktCheckedAt?: number;
}

/** Asal sebuah perubahan kunci: TOFU biasa, atau pertentangan dengan log KT. */
export type IdentityChangeSource = 'tofu' | 'kt';

export type IdentityObservation =
  | { status: 'new' }
  | { status: 'unchanged' }
  | { status: 'changed'; trustedKey: string; pendingKey: string; source: IdentityChangeSource };

export interface ObserveOptions {
  /**
   * Username peer (login name) — dibutuhkan untuk menurunkan search key log KT
   * (`0x75 || Argon2id(username)`). Bila tidak diberikan, `ktSubject`
   * menurunkannya dari profil E2EE peer; kalau tetap tidak ketemu, verifikasi
   * dilewati (`unknown-subject`) dan pin tetap TOFU.
   */
  username?: string | null;
  /** Hook test: ganti cara menurunkan username peer. */
  resolveUsername?: (userId: string) => Promise<string | undefined>;
  /** Hook test: ganti pemeriksa log KT. */
  checkKeyTransparency?: (input: {
    userId: string;
    username?: string | null;
    identityKey: string;
  }) => Promise<{ status: string; keyVersion?: number; logIdentityKey?: string; reason?: string }>;
  /** Hook test: waktu sekarang. */
  now?: number;
}

// Rantai serialisasi: kvStore read-modify-write untuk satu blob, jadi dua
// observasi paralel tidak boleh saling menimpa.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function loadMap(): Promise<Record<string, PeerIdentityTrust>> {
  try {
    const row = await db.kvStore.get(KV_KEY);
    const stored = typeof row?.value === 'string' ? row.value : null;
    if (!stored) return {};
    const plain = await decryptValueAtRest(stored);
    if (!plain) return {};
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, PeerIdentityTrust>;
  } catch (e) {
    console.warn('[PeerIdentityTrust] Gagal membaca pin identitas (fail-open, tanpa pin):', e);
    return {};
  }
}

async function saveMap(map: Record<string, PeerIdentityTrust>): Promise<void> {
  try {
    await db.kvStore.put({ key: KV_KEY, value: await encryptValueAtRest(JSON.stringify(map)) });
  } catch (e) {
    console.error('[PeerIdentityTrust] Gagal menyimpan pin identitas:', e);
  }
}

/** Pin legacy (plaintext `ID_PUB_<userId>` di tabel identityKeys). */
async function legacyTrustedKey(peerId: string): Promise<string | undefined> {
  try {
    const row = await db.identityKeys.get(`${LEGACY_PREFIX}${peerId}`);
    return row?.key ?? undefined;
  } catch {
    return undefined;
  }
}

/** Pin identitas peer; `undefined` = belum pernah melihat peer ini. */
export async function getPeerIdentityTrust(peerId: string): Promise<PeerIdentityTrust | undefined> {
  const map = await loadMap();
  const record = map[peerId];
  if (record) return record;

  const legacy = await legacyTrustedKey(peerId);
  if (!legacy) return undefined;
  // Belum ada record baru → adopsi pin lama apa adanya (jangan bikin warning
  // palsu hanya karena format penyimpanan berpindah).
  return await enqueue(async () => {
    const current = await loadMap();
    if (current[peerId]) return current[peerId]!;
    const adopted: PeerIdentityTrust = { trustedKey: legacy, firstSeenAt: 0 };
    current[peerId] = adopted;
    await saveMap(current);
    return adopted;
  });
}

/**
 * Catat kunci identitas yang diamati untuk peer. Kunci yang DIPERCAYA hanya
 * dibuat saat pertama kali; perubahan hanya menjadi `pendingKey`.
 *
 * [docs/34 §34.6 poin 1] Bila `username` peer diketahui, kunci yang akan dipin
 * diperiksa dulu terhadap **log Key Transparency**. Dua konsekuensi yang
 * mengubah perilaku:
 *
 *   - `mismatch` (bukti log sah tapi berisi kunci lain) menandai perubahan
 *     kunci **ber-sumber `kt`** walau pin belum pernah ada — inilah kasus MITM
 *     kontak-pertama yang dulu tak terdeteksi TOFU, dan gate kirim ikut menutup.
 *   - `confirmed` mencatat `ktVerifiedAt`, sehingga pengamatan berikutnya dalam
 *     TTL tidak perlu memanggil log lagi.
 */
export async function observePeerIdentityKey(
  peerId: string,
  identityKey: string,
  options: ObserveOptions = {}
): Promise<IdentityObservation> {
  if (!peerId || !identityKey) return { status: 'unchanged' };

  const now = options.now ?? Date.now();
  const existing = await getPeerIdentityTrust(peerId);

  const kt = await checkLog({
    peerId,
    identityKey,
    username: options.username,
    resolveUsername: options.resolveUsername,
    existing,
    now,
    check: options.checkKeyTransparency,
  });

  if (kt.verdict !== null && kt.verdict !== 'unknown-subject') {
    await rememberVerdict(peerId, kt.verdict, kt.keyVersion, now);
  }

  if (!existing) {
    if (kt.verdict === 'mismatch') {
      // Kunci yang disajikan BUKAN yang ada di log → jangan pernah jadi pin.
      await enqueue(async () => {
        const map = await loadMap();
        if (map[peerId]) return;
        map[peerId] = {
          trustedKey: identityKey,
          firstSeenAt: now,
          pendingKey: identityKey,
          changedAt: now,
          ktMismatch: { servedKey: identityKey, logKey: kt.logIdentityKey ?? '', at: now },
          ktLastVerdict: 'mismatch',
          ktCheckedAt: now,
        };
        await saveMap(map);
      });
      return { status: 'changed', trustedKey: identityKey, pendingKey: identityKey, source: 'kt' };
    }

    await enqueue(async () => {
      const map = await loadMap();
      if (map[peerId]) return;
      map[peerId] = {
        trustedKey: identityKey,
        firstSeenAt: now,
        ...(kt.verdict === 'confirmed'
          ? { ktVerifiedAt: now, ktKeyVersion: kt.keyVersion, ktCheckedAt: now }
          : {}),
      };
      await saveMap(map);
    });
    return { status: 'new' };
  }

  if (existing.trustedKey === identityKey && kt.verdict !== 'mismatch') {
    if (existing.pendingKey || existing.ktMismatch) {
      await enqueue(async () => {
        const map = await loadMap();
        const rec = map[peerId];
        if (!rec || rec.trustedKey !== identityKey) return;
        // Pertentangan KT TIDAK hilang sendiri: user harus menerimanya lewat
        // `acceptPendingPeerIdentity` — kecuali log kini sudah MENGONFIRMASI
        // kunci itu (`confirmed`), artinya pertentangannya selesai sendiri.
        // `pendingKey` TOFU biasa tetap dibersihkan seperti sebelumnya.
        if (rec.ktMismatch && kt.verdict !== 'confirmed') return;
        delete rec.pendingKey;
        delete rec.changedAt;
        delete rec.ktMismatch;
        await saveMap(map);
      });
    }
    return { status: 'unchanged' };
  }

  const trustedKey = existing.trustedKey;
  const fromKt = kt.verdict === 'mismatch';
  await enqueue(async () => {
    const map = await loadMap();
    const rec = map[peerId] ?? { trustedKey, firstSeenAt: now };
    // Pin lama tetap utuh — hanya pendingKey yang bergerak.
    rec.trustedKey = trustedKey;
    rec.pendingKey = identityKey;
    rec.changedAt = now;
    if (fromKt) {
      rec.ktMismatch = { servedKey: identityKey, logKey: kt.logIdentityKey ?? '', at: now };
    } else if (kt.verdict === 'confirmed') {
      // Log kini mengonfirmasi kunci yang sedang menunggu penerimaan: tidak ada
      // lagi pertentangan, jadi tandanya dibuang. Gate kirim TIDAK ikut terbuka —
      // `pendingKey !== trustedKey` tetap menahannya sampai user menerima.
      delete rec.ktMismatch;
    }
    map[peerId] = rec;
    await saveMap(map);
  });
  return { status: 'changed', trustedKey, pendingKey: identityKey, source: fromKt ? 'kt' : 'tofu' };
}

/**
 * Jalankan pemeriksaan log KT bila masuk akal: ada username (diberikan atau
 * diturunkan dari profil E2EE peer), dan belum dikonfirmasi untuk kunci yang
 * sama dalam TTL. Verdict `null` = tidak ada pemeriksaan (TOFU apa adanya).
 */
async function checkLog(input: {
  peerId: string;
  identityKey: string;
  username?: string | null;
  resolveUsername?: ObserveOptions['resolveUsername'];
  existing?: PeerIdentityTrust;
  now: number;
  check?: ObserveOptions['checkKeyTransparency'];
}): Promise<{ verdict: string | null; keyVersion?: number; logIdentityKey?: string }> {
  // Sudah dikonfirmasi log untuk kunci yang sama dan masih segar → tak perlu
  // memanggil log lagi (verifikasi adalah operasi jaringan + WASM + Argon2id).
  const fresh =
    input.existing?.trustedKey === input.identityKey &&
    typeof input.existing?.ktVerifiedAt === 'number' &&
    input.now - (input.existing.ktVerifiedAt as number) < KT_CONFIRMATION_TTL_MS;
  if (fresh) return { verdict: null };

  const username = await resolveUsernameFor(input);
  // Bukan error: tanpa username peer, search key log tak bisa diturunkan sama
  // sekali (`docs/34` batas #1). Pin tetap TOFU dan verdict ini tidak ditulis.
  if (!username) return { verdict: 'unknown-subject' };

  try {
    const check =
      input.check ??
      (await import('@lib/ktBundleProof')).checkBundleAgainstKeyTransparency;
    const verdict = await check({
      userId: input.peerId,
      username,
      identityKey: input.identityKey,
    });
    return {
      verdict: verdict.status,
      keyVersion: verdict.keyVersion,
      logIdentityKey: verdict.logIdentityKey,
    };
  } catch (error) {
    // Verifikasi tidak boleh memblokir pengiriman karena bug lokal.
    console.warn('[PeerIdentityTrust] Pemeriksaan log KT gagal:', error);
    return { verdict: null };
  }
}

/** Username dari pemanggil, kalau tidak ada turunkan dari profil E2EE peer. */
async function resolveUsernameFor(input: {
  peerId: string;
  username?: string | null;
  resolveUsername?: ObserveOptions['resolveUsername'];
}): Promise<string | undefined> {
  const explicit = input.username?.trim();
  if (explicit) return explicit;
  try {
    const resolve = input.resolveUsername ?? (await import('@lib/ktSubject')).resolvePeerUsername;
    return await resolve(input.peerId);
  } catch (error) {
    console.warn('[PeerIdentityTrust] Gagal menurunkan username peer untuk log KT:', error);
    return undefined;
  }
}

/** Catat verdict terakhir + cap konfirmasi (bila ada) untuk baris peer. */
async function rememberVerdict(
  peerId: string,
  verdict: string,
  keyVersion: number | undefined,
  now: number
): Promise<void> {
  await enqueue(async () => {
    const map = await loadMap();
    const rec = map[peerId];
    if (!rec) return;
    // Verdict non-konfirmasi yang sama berulang tidak menambah apa pun — hindari
    // menulis ulang blob hanya karena satu pesan masuk.
    if (rec.ktLastVerdict === verdict && verdict !== 'confirmed') return;
    rec.ktLastVerdict = verdict;
    rec.ktCheckedAt = now;
    if (verdict === 'confirmed') {
      rec.ktVerifiedAt = now;
      if (keyVersion !== undefined) rec.ktKeyVersion = keyVersion;
    }
    await saveMap(map);
  });
}

/** Apakah ada perubahan kunci yang belum diterima user? */
export async function hasPendingPeerIdentityChange(peerId: string): Promise<boolean> {
  const record = await getPeerIdentityTrust(peerId);
  if (!record) return false;
  // Pertentangan log KT memblokir walau pin-nya belum pernah berganti: pada
  // kontak pertama, kunci yang disajikan server tidak ada di log publik.
  if (record.ktMismatch) return true;
  return !!record.pendingKey && record.pendingKey !== record.trustedKey;
}

/** Daftar kunci baru yang menunggu penerimaan user (untuk banner/alert UI). */
export async function listPendingPeerIdentityChanges(): Promise<Array<{ peerId: string; previousKey: string; pendingKey: string; changedAt: number; source: IdentityChangeSource }>> {
  const map = await loadMap();
  return Object.entries(map)
    .filter(
      ([, rec]) =>
        (!!rec.pendingKey && rec.pendingKey !== rec.trustedKey) || !!rec.ktMismatch
    )
    .map(([peerId, rec]) => ({
      peerId,
      previousKey: rec.trustedKey,
      pendingKey: rec.pendingKey ?? rec.trustedKey,
      changedAt: rec.changedAt ?? rec.ktMismatch?.at ?? 0,
      // [docs/34 §34.6 poin 1] Pertentangan dengan log KT lebih kuat daripada TOFU.
      source: rec.ktMismatch ? ('kt' as const) : ('tofu' as const),
    }));
}

/**
 * Apakah pin peer ini pernah bertentangan dengan log Key Transparency?
 * Dipakai UI untuk menandai "kunci tidak cocok dengan log publik" (lebih kuat
 * daripada sekadar "kunci berubah").
 */
export async function getKtMismatch(
  peerId: string
): Promise<{ servedKey: string; logKey: string; at: number } | undefined> {
  const record = await getPeerIdentityTrust(peerId);
  return record?.ktMismatch;
}

/**
 * Terima kunci baru sebagai pin yang dipercaya (dipanggil HANYA setelah user
 * memverifikasi safety number baru). Mengembalikan kunci yang diterima.
 */
export async function acceptPendingPeerIdentity(peerId: string): Promise<string | null> {
  return await enqueue(async () => {
    const map = await loadMap();
    const rec = map[peerId];
    if (!rec) return null;
    const hasPending = !!rec.pendingKey && rec.pendingKey !== rec.trustedKey;
    // Mismatch pada kontak pertama tidak punya `pendingKey` yang berbeda, tapi
    // tetap butuh penerimaan user supaya gate kirim bisa dibuka.
    if (!hasPending && !rec.ktMismatch) return null;
    const accepted = hasPending ? rec.pendingKey! : rec.trustedKey;
    map[peerId] = {
      trustedKey: accepted,
      firstSeenAt: rec.firstSeenAt || Date.now(),
      previousKey: rec.trustedKey,
      changedAt: rec.changedAt ?? Date.now(),
      // Kunci lama sudah dilihat sebagai pertentangan log; kunci baru belum
      // diverifikasi log (itu tugas `observePeerIdentityKey` berikutnya).
      ktLastVerdict: rec.ktMismatch ? 'mismatch-acknowledged' : rec.ktLastVerdict,
      ktCheckedAt: rec.ktCheckedAt,
    };
    await saveMap(map);
    return accepted;
  });
}

/**
 * Perubahan kunci untuk peer pada percakapan 1:1 ini? Dipakai gate kirim
 * (pesan user tidak dikirim sampai user menerima kunci baru).
 */
export async function hasPendingIdentityChangeForConversation(conversationId: string): Promise<boolean> {
  try {
    const { useConversationStore } = await import('@store/conversation');
    const { getParticipantUserId } = await import('@nyx/shared');
    const { useAuthStore } = await import('@store/auth');
    const myId = useAuthStore.getState().user?.id;
    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation || conversation.isGroup) return false;
    const peer = conversation.participants.find(p => getParticipantUserId(p) !== myId);
    if (!peer) return false;
    return await hasPendingPeerIdentityChange(getParticipantUserId(peer));
  } catch {
    return false;
  }
}

/** Hapus semua pin (dipakai wipe/panic — lihat nukeProtocol). */
export async function clearPeerIdentityTrust(): Promise<void> {
  await enqueue(async () => {
    try {
      await db.kvStore.delete(KV_KEY);
    } catch (e) {
      console.warn('[PeerIdentityTrust] Gagal menghapus pin identitas:', e);
    }
  });
}
