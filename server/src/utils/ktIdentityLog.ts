// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.7 poin 2] Entri log KT untuk **perubahan
 * kunci identitas di luar registrasi & pemulihan**.
 *
 * Kenapa modul ini ada: selain `register`/`recover`, ada tiga jalur yang menimpa
 * `Device.publicKey` — `POST /keys/prekey-bundle` (`routes/keys.ts`),
 * `PUT /users/me/keys` (`routes/users.ts`), dan re-sync kunci saat
 * `POST /auth/login` (`routes/auth.ts`). Tanpa entri log, setelah rotasi log
 * masih memuat kunci LAMA: peer yang memverifikasi bundle mendapat verdict
 * `mismatch` (kunci tersaji ≠ kunci log), `peerIdentityTrust` menyimpannya sebagai
 * `ktMismatch` + `pendingKey`, dan gate kirim menutup sampai user menerimanya —
 * padahal yang terjadi adalah rotasi yang sah.
 *
 * Kenapa identifier dikirim klien: search key log adalah `0x75 || Argon2id(raw)`,
 * sedangkan yang tersimpan di DB adalah identifier ter-pepper
 * (`pepperedIdentifier`) yang tidak bisa dibalik tanpa pepper. Server karena itu
 * TIDAK bisa menurunkan search key sendiri.
 *
 * **Verifikasi kepemilikan wajib.** Karena identifier datang dari klien, tanpa
 * verifikasi siapa pun yang sudah login bisa menulis entri ke search key akun
 * lain (log adalah ruang publik → vektor defacement/poisoning). Aturannya:
 * `identifierLookupCandidates(kiriman)` harus memuat `User.usernameHash` milik
 * pemanggil — bentuk ter-pepper (echo server) maupun Argon2id mentah sama-sama
 * lolos, bentuk yang menunjuk akun lain ditolak dan TERLIHAT sebagai
 * `nyx_kt_writes_total{result="identifier_mismatch"}`.
 *
 * Sifat lain mengikuti penulis registrasi/pemulihan: **tidak pernah melempar**
 * (jalur respons tidak boleh gagal karena log), fail-visible lewat metrik + log
 * tanpa identitas, dan hanya material publik yang masuk log (`identityKey`,
 * `pqIdentityKey`, `signingKey`, label alur, bucket harian).
 */

import { ML_DSA_65_PUBLIC_KEY_BYTES } from '@nyx/shared';
import { incCounter, KT_WRITES } from './metrics.js';
import { dayBucket } from './temporalBucket.js';
import { identifierLookupCandidates } from './atRestSecrets.js';
import {
  KT_KEY_VERSION_REGISTRATION,
  KT_KEY_VERSION_ROTATION,
  publishKeyTransparencyEntry,
  type KtCommitResult,
  type KtTransport,
} from './keyTransparency.js';

/** Baca identifier tersimpan (`User.usernameHash`) untuk verifikasi kepemilikan. */
export type KtStoredIdentifierLookup = (userId: string) => Promise<string | null>;

export interface IdentityKeyChangeInput {
  /** User yang terautentikasi di jalur ini. */
  userId: string;
  /**
   * Identifier mentah dari klien: base64url dari Argon2id 32 byte (`hashUsername`).
   * Jalur `/login` memakai `usernameHash` dari body (sudah dipepper-lookup untuk
   * menemukan akun, jadi kepemilikannya terbukti oleh login itu sendiri).
   */
  usernameHash?: string | null;
  identityKey?: Uint8Array | null;
  pqIdentityKey?: Uint8Array | null;
  signingKey?: Uint8Array | null;
  /** Verification key ML-DSA-65; bila ada, entri ditulis sebagai nilai log v2. */
  signingKeyV2?: Uint8Array | null;
  /** Label alur; default `KT_KEY_VERSION_ROTATION`. */
  keyVersion?: number;
}

export interface IdentityKeyChangeDeps {
  /** Hook test: ganti pembacaan identifier dari DB (tanpa Prisma). */
  lookupStoredIdentifier?: KtStoredIdentifierLookup;
  transport?: KtTransport;
  now?: number;
}

/**
 * Baca identifier dari DB lewat impor dinamis: modul ini diimpor jalur route
 * (yang memang memakai Prisma), tetapi test-nya harus tetap bebas infra.
 */
const defaultLookup: KtStoredIdentifierLookup = async (userId) => {
  const { prisma } = await import('../lib/prisma.js');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { usernameHash: true },
  });
  return user?.usernameHash ?? null;
};

/**
 * Tulis entri log untuk satu perubahan kunci identitas. Tidak pernah melempar.
 *
 * Mengembalikan hasil yang **bisa dibedakan** supaya pemanggil/operator tahu
 * kenapa sebuah rotasi tidak tercatat:
 *   - `KT_IDENTIFIER_MISSING` — klien tidak mengirim identifier (bundel lama).
 *   - `KT_IDENTIFIER_MISMATCH` — identifier bukan milik akun pemanggil.
 *   - `*` — diteruskan apa adanya dari `publishKeyTransparencyEntry`
 *     (`invalid`, `KT_USERNAME_HASH_LENGTH_INVALID`, atau sukses).
 */
export async function publishIdentityKeyChange(
  input: IdentityKeyChangeInput,
  deps: IdentityKeyChangeDeps = {}
): Promise<KtCommitResult> {
  const { identityKey, signingKey } = input;
  if (!identityKey?.length || !signingKey?.length) {
    incCounter(KT_WRITES, { result: 'invalid' });
    console.warn('[KT] Perubahan kunci identitas dilewati: kunci wajib tidak lengkap.');
    return { ok: false, reason: 'IDENTITY_KEYS_MISSING' };
  }

  // Tanpa endpoint & tanpa transport injeksi = fitur mati (no-op, bukan error).
  if (!process.env.KT_V2_SERVER_URL && !deps.transport) {
    return { ok: false, skipped: 'DISABLED' };
  }

  const raw = input.usernameHash?.trim();
  if (!raw) {
    incCounter(KT_WRITES, { result: 'no_identifier' });
    console.warn(
      '[KT] Perubahan kunci identitas tidak tercatat: klien tidak mengirim identifier ' +
        '(search key tidak bisa diturunkan server). Lihat docs/32 §32.7 poin 2.'
    );
    return { ok: false, reason: 'KT_IDENTIFIER_MISSING' };
  }

  const lookup = deps.lookupStoredIdentifier ?? defaultLookup;
  let stored: string | null = null;
  try {
    stored = await lookup(input.userId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN';
    incCounter(KT_WRITES, { result: 'error' });
    console.error(`[KT] Gagal memverifikasi kepemilikan identifier rotasi: ${reason}`);
    return { ok: false, reason };
  }

  if (!stored || !identifierLookupCandidates(raw).includes(stored)) {
    incCounter(KT_WRITES, { result: 'identifier_mismatch' });
    console.warn('[KT] Perubahan kunci identitas dilewati: identifier bukan milik akun pemanggil.');
    return { ok: false, reason: 'KT_IDENTIFIER_MISMATCH' };
  }

  return publishKeyTransparencyEntry(
    {
      usernameHash: raw,
      identityKey,
      pqIdentityKey: input.pqIdentityKey ?? new Uint8Array(0),
      signingKey,
      signingKeyV2: input.signingKeyV2 ?? null,
      keyVersion: input.keyVersion ?? KT_KEY_VERSION_ROTATION,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    },
    { transport: deps.transport, now: deps.now }
  );
}

/**
 * Bandingkan material identitas lama vs baru. Dipakai jalur route untuk menulis
 * log **hanya saat kunci benar-benar berubah** — upload bundle yang sama
 * (auto-heal, login berulang) tidak boleh membanjiri log dengan entri identik.
 */
export function identityKeysChanged(
  before:
    | { publicKey?: Uint8Array | null; signingKey?: Uint8Array | null; signingKeyV2?: Uint8Array | null }
    | null
    | undefined,
  after: { identityKey?: Uint8Array | null; signingKey?: Uint8Array | null; signingKeyV2?: Uint8Array | null }
): boolean {
  if (!before?.publicKey?.length || !before.signingKey?.length) return true; // belum ada identitas tercatat
  const sameIdentity =
    Buffer.from(before.publicKey).equals(Buffer.from(after.identityKey ?? new Uint8Array(0)));
  const sameSigning =
    Buffer.from(before.signingKey).equals(Buffer.from(after.signingKey ?? new Uint8Array(0)));
  // Kunci v2 belum tentu ada di kedua sisi (bundle legacy): hanya dianggap
  // berubah bila salah satu sisi benar-benar membawa material v2.
  const sameV2 =
    !before.signingKeyV2?.length && !after.signingKeyV2?.length
      ? true
      : Buffer.from(before.signingKeyV2 ?? new Uint8Array(0)).equals(
          Buffer.from(after.signingKeyV2 ?? new Uint8Array(0))
        );
  return !(sameIdentity && sameSigning && sameV2);
}


/**
 * Backfill v2 pada login (opsional, `KT_V2_BACKFILL_ON_LOGIN=1`).
 *
 * Akun yang mendaftar sebelum log v2 ada tidak pernah masuk v2; cutover baca
 * tidak bisa dilakukan selama populasi v2 tertinggal. Login membuktikan
 * kepemilikan identifier dan membawa kunci perangkat saat ini, jadi entri
 * registrasi bisa ditulis **hanya ke v2**. Nilai v2 wajib punya ML-DSA-65
 * (`signingKeyV2`); perangkat lama tanpa kunci itu dilewati — mereka harus
 * rotasi ke v2 dulu. Update KT idempoten per `(searchKey, keyVersion, value)`,
 * jadi login berulang tidak menambah daun baru.
 */
export interface KtV2BackfillInput {
  usernameHash: string;
  identityKey: Uint8Array;
  pqIdentityKey?: Uint8Array | null;
  signingKey: Uint8Array;
  signingKeyV2: Uint8Array;
}

export interface KtV2BackfillDeps {
  transport?: KtTransport;
  now?: number;
}

export async function backfillKtV2IdentityOnLogin(
  input: KtV2BackfillInput,
  deps: KtV2BackfillDeps = {}
): Promise<KtCommitResult> {
  if (input.signingKeyV2.length !== ML_DSA_65_PUBLIC_KEY_BYTES) {
    return { ok: false, reason: 'V2_SIGNING_KEY_INVALID' };
  }
  if (!process.env.KT_V2_SERVER_URL && !deps.transport) {
    return { ok: false, skipped: 'DISABLED' };
  }
  return publishKeyTransparencyEntry(
    {
      usernameHash: input.usernameHash,
      identityKey: input.identityKey,
      pqIdentityKey: input.pqIdentityKey ?? new Uint8Array(0),
      signingKey: input.signingKey,
      signingKeyV2: input.signingKeyV2,
      keyVersion: KT_KEY_VERSION_REGISTRATION,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    },
    { transport: deps.transport, now: deps.now }
  );
}
