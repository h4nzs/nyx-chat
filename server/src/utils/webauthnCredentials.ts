// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Normalisasi credential ID WebAuthn untuk `@simplewebauthn/server` v13.
 *
 * Latar belakang bug (2026-10-18): `GET /api/auth/webauthn/register/options`
 * mengirim `excludeCredentials[].id` sebagai **Buffer** (hasil decode base64url
 * → byte, lalu dikirim apa adanya). Library v13 menuntut `Base64URLString`:
 * `generateRegistrationOptions` memanggil `isBase64URL()` → `trimPadding()` →
 * `input.replace(...)`, dan Buffer tidak punya `.replace` →
 * `TypeError: input.replace is not a function` → 500 "Internal server error".
 *
 * Akibatnya: setiap akun yang SUDAH punya authenticator (mis. kredensial
 * attestation saat pendaftaran) gagal membuka langkah biometric/"verify device"
 * — persis saat pengguna mencoba memverifikasi dirinya. Efek berantai: akun
 * tetap `isVerified=false`, sehingga unggah backup ke awan ditolak
 * (`SANDBOX_UPLOAD_RESTRICTION`) dan pengguna hanya melihat toast gagal.
 *
 * Aturan normalisasi:
 *   - base64url (`A–Z a–z 0–9 - _`) → dipakai apa adanya (bentuk yang ditulis
 *     v13 pada saat verifikasi registrasi);
 *   - base64 standar (`+` `/` `=`, baris lama) → dikonversi ke base64url;
 *   - bukan string / kosong → `null` (baris dibuang, bukan diteruskan).
 *
 * Nilai yang tidak dikenal tetap diteruskan setelah normalisasi: id yang tidak
 * ada di authenticator cukup diabaikan browser, sementara MENOLAK baris karena
 * bentuknya akan membuat kredensial sah ikut hilang dari daftar exclude.
 */

/** base64url yang sudah sah: tanpa padding, tanpa `+`/`/`. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Ubah nilai credential ID tersimpan menjadi `Base64URLString` yang diterima
 * `@simplewebauthn/server` v13. `null` = baris tidak bisa dipakai.
 */
export function toBase64UrlCredentialId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (BASE64URL_RE.test(trimmed)) return trimmed;
  // Baris lama: base64 standar → base64url (buang padding, ganti alfabet).
  const converted = trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return converted.length > 0 ? converted : null;
}

/**
 * `Authenticator.transports` disimpan sebagai CSV (`usb,internal`). Nilai kosong
 * → `undefined` (library memperlakukannya sebagai "semua transport").
 */
export function parseCredentialTransports(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}
