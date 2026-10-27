// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §5.5 / §7.3] Metadata struktur lokal (IndexedDB) yang dikasar atau
 * di-seal.
 *
 * Vault lokal sudah mengenkripsi ISI (`content`, `senderName`, `participants`,
 * `fileMeta`, `decryptedMetadata`), tetapi kolom struktur tetap plaintext.
 * Siapa pun yang memegang profil browser (atau backup profil, atau device
 * tercuri) bisa membaca **pola aktivitas**: kapan percakapan aktif, seberapa
 * jauh urutan pesan, dst. Ini kontras dengan sisi server yang justru membucket
 * `lastMessageAt`/`createdAt` (docs/28 Tier 2 — B3/B4) — aneh kalau klien
 * membiarkannya presisi.
 *
 * Dua perlakuan, sesuai kebutuhan konsumen:
 *
 *  1. `bucketLocalTimestamp()` — `Conversation.lastMessageAt` tidak dibaca
 *     siapa pun untuk pengurutan (daftar chat diurutkan dari pesan terakhir di
 *     memori), jadi presisinya murni kebocoran. Dipotong ke bucket 15 menit
 *     yang SAMA dengan server (`MESSAGE_TIME_BUCKET_MS`) supaya nilai lokal dan
 *     server tetap sebanding.
 *
 *  2. `sealLocalNumber()` / `openLocalNumber()` — `Message.seq` dipakai untuk
 *     kursor paginasi, bukan indeks/query, jadi bisa disimpan sebagai envelope
 *     `ENC1:` (masterSeed, pola yang sama dengan keychain) tanpa mengubah alur
 *     baca: dibuka saat record di-parse. Baris lama berbentuk angka plaintext
 *     tetap terbaca (perangkat user tidak bisa di-reset seperti DB server) dan
 *     ter-upgrade saat ditulis ulang.
 *
 *  Semua helper `seal*` **melempar** `AtRestSealUnavailableError` bila vault
 *  terkunci / worker gagal ([audit D7]); pemanggil harus melewati penulisan
 *  kolom itu (atau membatalkan tulis barisnya), **bukan** menyimpan plaintext.
 *
 *  3. `sealLocalText()` / `sealLocalFlag()` + pembacanya — [docs/30 WS-F
 *     langkah 3] kolom struktur yang **tidak** dipakai untuk pengurutan/seleksi
 *     (`senderId`, `repliedToId`, `isViewOnce`, `isDeletedLocal`, `expiresAt`,
 *     `Conversation.isGroup`). Di-seal **di tempat** (satu kolom berisi
 *     plaintext lama ATAU envelope `ENC1:`, sama seperti `seq`) karena tidak ada
 *     indeks yang bergantung padanya. Kolom `status` sengaja tidak ikut: tidak
 *     ada satu pun jalur tulis yang menyimpannya (hanya dibaca dari baris lama).
 *     Kolom yang tidak lagi dipakai sebagai indeks dicoret dari skema Dexie
 *     (versi 10).
 */

import { decryptValueAtRest, encryptValueAtRest, AT_REST_PREFIX } from './keychainDb';
// Modul daun (tanpa import) → `db.ts` bisa memakai bucket tanpa siklus impor
// lewat `keychainDb`. Diekspor ulang agar pemanggil lama tidak berubah.
export { LOCAL_TIME_BUCKET_MS } from './localOrderBucket';
import { LOCAL_TIME_BUCKET_MS } from './localOrderBucket';

/**
 * Potong waktu ke bucket 15 menit (floor), dalam ISO string. `null`/kosong →
 * `null`. Format keluaran sama seperti masukan supaya kolom tetap bisa dibaca
 * konsumen lama.
 */
export function bucketLocalTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / LOCAL_TIME_BUCKET_MS) * LOCAL_TIME_BUCKET_MS).toISOString();
}

/**
 * Simpan angka sebagai envelope `ENC1:`. `null`/tak valid → null.
 * Vault terkunci / worker gagal → melempar `AtRestSealUnavailableError`
 * ([audit D7] tidak ada fallback plaintext).
 */
export async function sealLocalNumber(value: number | null | undefined): Promise<string | null> {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return await encryptValueAtRest(String(value));
}

/**
 * Baca angka yang di-seal. Menerima juga baris lama berbentuk angka plaintext
 * (atau string angka) — dipakai untuk migrasi diam-diam saat record ditulis ulang.
 */
export async function openLocalNumber(raw: number | string | null | undefined): Promise<number | null> {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.startsWith(AT_REST_PREFIX)) {
    const plain = await decryptValueAtRest(raw);
    if (!plain) return null;
    const parsed = Number(plain);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const legacy = Number(raw);
  return Number.isFinite(legacy) ? legacy : null;
}

type TextLike = string | null | undefined;

/**
 * Simpan teks pendek (mis. `senderId`, `repliedToId`) sebagai envelope `ENC1:`.
 * String kosong/`null` → `null` (kolom opsional tetap kosong).
 * Vault terkunci → melempar `AtRestSealUnavailableError`; jangan simpan plaintext.
 */
export async function sealLocalText(value: TextLike): Promise<string | null> {
  if (typeof value !== 'string' || value.length === 0) return null;
  return await encryptValueAtRest(value);
}

/**
 * Baca teks yang di-seal; string tanpa prefix dianggap baris lama (plaintext)
 * dan dikembalikan apa adanya. `null`/tipe tak terduga → `null`.
 */
export async function openLocalText(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith(AT_REST_PREFIX)) return raw;
  return await decryptValueAtRest(raw);
}

/**
 * Simpan boolean sebagai envelope `ENC1:` (`'true'`/`'false'`).
 * Vault terkunci → melempar `AtRestSealUnavailableError`; jangan simpan plaintext.
 */
export async function sealLocalFlag(value: boolean | null | undefined): Promise<string | null> {
  if (typeof value !== 'boolean') return null;
  return await encryptValueAtRest(value ? 'true' : 'false');
}

/** Baca boolean yang di-seal; boolean baris lama (plaintext) tetap terbaca. */
export async function openLocalFlag(raw: unknown): Promise<boolean | null> {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (!raw.startsWith(AT_REST_PREFIX)) return null;
    const plain = await decryptValueAtRest(raw);
    if (plain === 'true') return true;
    if (plain === 'false') return false;
  }
  return null;
}
