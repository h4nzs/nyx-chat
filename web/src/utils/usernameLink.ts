// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.13 WS-I] Username links `/u/<hashId>`.
 *
 * Link berbagi profil lama (`/connect?u=&i=&p=`) memuat userId + profil
 * terenkripsi di query string. Link pendek ini hanya membawa **hashId** —
 * nilai yang sudah dikirim klien ke `/api/users/search` untuk pencocokan persis
 * (tanpa enumerasi, rate-limit + exact match). Validasi di sini memakai aturan
 * yang sama dengan server (`users.ts` `isExactHash`): 43 char base64url
 * (Argon2id klien) atau 64 hex (blind index ter-pepper).
 */

/** Panjang hashId Argon2id-base64url dari klien. */
export const USERNAME_HASH_BASE64URL_LENGTH = 43;

/** Panjang blind index ter-pepper (hex). */
export const USERNAME_HASH_HEX_LENGTH = 64;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEX_RE = /^[a-f0-9]{64}$/;

/**
 * true bila nilai berbentuk hashId yang sah. Dipakai di klien agar format salah
 * tidak pernah dikirim ke server (hemat request + tidak menambah sampah rate-limit).
 */
export function isValidUsernameHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === USERNAME_HASH_BASE64URL_LENGTH && BASE64URL_RE.test(value)) return true;
  if (value.length === USERNAME_HASH_HEX_LENGTH && HEX_RE.test(value)) return true;
  return false;
}

/** Ambil hashId dari segmen URL `/u/:hashId`; `null` bila tidak sah. */
export function parseUsernameHashSegment(raw: string | undefined | null): string | null {
  return isValidUsernameHash(raw) ? raw : null;
}

/**
 * [2026-10-15] Bentuk identitas yang diketik pengguna di halaman pemulihan.
 *
 * Kenapa ini dipisah jadi fungsi murni: halaman pemulihan menerima DUA bentuk
 * masukan yang berbeda secara kriptografis, dan salah menebaknya membuat akun
 * tak bisa dipulihkan (bukan sekadar pesan error):
 *
 *   - **`hash-id`** — 43 char base64url (Argon2id klien) atau 64 hex (blind
 *     index ter-pepper yang dikembalikan server). Dikirim apa adanya: server
 *     sudah punya jalur kandidat untuk keduanya.
 *   - **`username`** — teks biasa. HARUS di-hash Argon2id dulu di klien
 *     (`hashUsername`); mengirimnya apa adanya tidak akan pernah cocok.
 *
 * Pemilihan bentuk username juga memperbaiki jalur Key Transparency: log KT
 * berkunci `0x75 || Argon2id(username)` (32 byte), jadi hanya bentuk Argon2id
 * yang bisa dicatat. Sebelum ini, pengguna yang mengetik username (atau hash ID
 * ter-pepper) membuat entri KT pemulihan **dilewati** — padahal pemulihan
 * menukar kunci identitas, tepat peristiwa yang harus terlihat di log.
 */
export type RecoveryIdentifierInput =
  | { kind: 'hash-id'; value: string }
  | { kind: 'username'; value: string };

export function resolveRecoveryIdentifierInput(raw: string): RecoveryIdentifierInput {
  const value = (raw ?? '').trim();
  if (isValidUsernameHash(value)) return { kind: 'hash-id', value };
  return { kind: 'username', value };
}

/**
 * [docs/30 §30.13 WS-I] Urai tautan berbagi yang dipindai/ditempel pengguna.
 *
 * Dua bentuk diterima, karena QR dan tautan lama **sudah beredar** dan tidak
 * boleh berhenti bekerja:
 *
 *   1. **Bentuk pendek (WS-I)** — `/u/<hashId>` → hanya `u` yang diteruskan ke
 *      alur `/connect`. hashId harus sah menurut aturan bentuk yang sama dengan
 *      server, jadi segmen sampah tidak pernah menjadi request pencarian.
 *   2. **Bentuk lama** — `/connect?u=…&i=…&p=…` → query string diteruskan APA
 *      ADANYA (termasuk `i`/`p`), dengan aturan penerimaan lama (`u.length > 10`)
 *      supaya scan tidak berubah perilaku untuk link yang sudah tersebar.
 *
 * Mengembalikan query string siap-pakai untuk `/connect`, atau `null` bila
 * tautan bukan tautan berbagi NYX (atau rusak).
 */
export function parseProfileShareLink(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // bukan URL (mis. teks biasa) — pemindai tetap berjalan
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const short = url.pathname.match(/^\/u\/([^/]+)\/?$/);
  if (short) {
    let segment: string;
    try {
      segment = decodeURIComponent(short[1] ?? '');
    } catch {
      return null; // escape rusak
    }
    return isValidUsernameHash(segment) ? `?u=${encodeURIComponent(segment)}` : null;
  }

  if (/\/connect\/?$/.test(url.pathname)) {
    const u = url.searchParams.get('u');
    return typeof u === 'string' && u.length > 10 ? url.search : null;
  }

  return null;
}

/**
 * Bangun link pendek absolut. Melempar bila hashId tidak sah — mencegah link
 * rusak ikut tersebar.
 */
export function buildUsernameLink(origin: string, hashId: string): string {
  if (!isValidUsernameHash(hashId)) throw new Error('Hash ID tidak sah');
  const base = origin.replace(/\/+$/, '');
  return `${base}/u/${encodeURIComponent(hashId)}`;
}
