// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [26.8.1 + docs/29 §7.1] Format pesan credential keanggotaan grup.
 *
 * Klien membangun pesan acak per (conversation, anggota) dengan bentuk tetap:
 *
 *     nyx-grp-cred:v1:<conversationId>:<nonce 32 hex>
 *
 * Pesan itu lalu di-blind (RFC 9474 / RSABSSA-SHA384-PSS-Randomized) dan
 * ditandatangani buta oleh server. Klien yang memegang (pesan, tanda tangan)
 * = bukti keanggotaan tanpa identitas.
 *
 * Karena formatnya tetap, server **bisa** memeriksa binding konteks: pesan yang
 * ditandatangani wajib menyebut `conversationId` yang diklaim. Tanpa cek ini,
 * credential satu grup bisa dipakai untuk mengklaim grup lain (server hanya
 * mencocokkan serial terdaftar). Berbagi modul ini membuat klien & server tidak
 * lagi menyimpan format sebagai string duplikat yang bisa menyimpang.
 *
 * Catatan blind signature: `suite.prepare()` dari RSABSSA-...-Randomized
 * menempelkan prefix acak (32 byte) di depan pesan — jadi pada `preparedMsg`
 * yang ikut dipresentasikan, body pesan mulai di offset 32. Angka itu bagian
 * dari suite yang beku (`CREDENTIAL_SUITE`), jangan diubah tanpa rotasi suite.
 */

/** Tag versi format pesan. Perubahan bentuk = versi baru, bukan edit di tempat. */
export const CREDENTIAL_MESSAGE_PREFIX = 'nyx-grp-cred:v1';

/** Panjang nonce acak (hex) — 128 bit, bagian yang membuat pesan unik per anggota. */
export const CREDENTIAL_RANDOM_HEX_LENGTH = 32;

/** Prefix acak yang ditambahkan `suites.prepare()` (RSABSSA-...-Randomized). */
export const CREDENTIAL_PREPARE_PREFIX_BYTES = 32;

const NONCE_RE = /^[a-f0-9]{32}$/;

/** Bangun pesan credential (pesan yang akan di-blind klien). */
export function buildCredentialMessage(conversationId: string, nonce: string): string {
  if (!NONCE_RE.test(nonce)) {
    throw new Error(`[credentials] nonce harus ${CREDENTIAL_RANDOM_HEX_LENGTH} hex`);
  }
  return `${CREDENTIAL_MESSAGE_PREFIX}:${conversationId}:${nonce}`;
}

/**
 * Baca kembali klaim dari pesan credential. `null` = bukan format NYX yang
 * sah. conversationId diambil dari segmen terakhir sebelum nonce supaya
 * conversationId yang mengandung ':' (tidak dipakai hari ini, tapi mungkin
 * untuk id non-UUID) tetap terbaca apa adanya.
 */
export function parseCredentialMessage(message: string): { conversationId: string; nonce: string } | null {
  const prefix = `${CREDENTIAL_MESSAGE_PREFIX}:`;
  if (!message.startsWith(prefix)) return null;
  const rest = message.slice(prefix.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const conversationId = rest.slice(0, sep);
  const nonce = rest.slice(sep + 1);
  if (!conversationId || !NONCE_RE.test(nonce)) return null;
  return { conversationId, nonce };
}

/**
 * Klaim conversationId dari `preparedMsg` yang dipresentasikan (sudah melewati
 * `prepare()` → prefix acak 32 byte di depan). Dipakai server untuk memastikan
 * credential terikat ke conversation yang diklaim.
 */
export function credentialClaimFromPrepared(preparedMsg: Uint8Array): { conversationId: string } | null {
  if (preparedMsg.length <= CREDENTIAL_PREPARE_PREFIX_BYTES) return null;
  const body = new TextDecoder().decode(preparedMsg.subarray(CREDENTIAL_PREPARE_PREFIX_BYTES));
  const parsed = parseCredentialMessage(body);
  return parsed ? { conversationId: parsed.conversationId } : null;
}
