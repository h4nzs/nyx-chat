// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [SEC 2026-10-30] Kode verifikasi (SAS) untuk tautan perangkat.
 *
 * Masalah yang ditutup: perangkat lama menyegel kunci arsip riwayat (`K`) ke
 * X-Wing public key perangkat baru yang **diterimanya lewat server**
 * (`auth:linking_request`). QR hanya membawa token `t=…` yang dibuat perangkat
 * LAMA, jadi perangkat baru tidak pernah membuktikan kunci mana yang miliknya.
 * Server yang jahat/terkompromi bisa menukar `pqPublicKey` dengan miliknya:
 * perangkat lama menyegel `K` ke kunci itu, server membuka `K`, membaca seluruh
 * arsip — tanpa jejak di kedua perangkat (impor di perangkat baru gagal
 * membuka `sealedKey`, tapi data sudah bocor).
 *
 * Mengapa QR tidak bisa membawa hash kunci perangkat baru: QR ditampilkan
 * perangkat LAMA, sedangkan kunci perangkat baru dibuat SETELAH token dipindai
 * (dan perangkat baru yang memindai). Membalik arah (perangkat baru menampilkan
 * QR) menuntut kamera di perangkat lama — tidak realistis untuk web desktop.
 *
 * Solusi: kode pendek yang dibandingkan MANUSIA di dua layar (pola SAS /
 * numeric comparison yang sama dengan SSP Bluetooth dan safety number Signal).
 * Kedua perangkat menurunkan kode dari `pqPublicKey` yang sama:
 *   - perangkat baru  → dari kuncinya sendiri (`LinkDevicePage`),
 *   - perangkat lama  → dari kunci yang dikirim server (`LinkDeviceModal`).
 * Server yang menukar kunci akan membuat dua kode BERBEDA; pengguna melihat
 * ketidakcocokan dan menolak, sehingga tidak ada arsip yang diseal. Peluang
 * server menebak kunci pengganti dengan kode sama = 1/10^6 per percobaan, dan
 * setiap percobaan terlihat sebagai kode yang tidak cocok.
 *
 * Kode TIDAK dirahasiakan (bukan kunci) dan tidak dikirim ke server.
 */

import { getSodium } from './sodiumInitializer';

/** Domain separation: kode ini tidak boleh bertabrakan dengan hash lain. */
export const LINK_SAS_DOMAIN = 'nyx-link-sas-v1';

/** 6 digit ≈ 20 bit: cukup untuk perbandingan manusia, terlalu besar untuk ditebak. */
export const LINK_SAS_DIGITS = 6;

const SAS_MODULUS = 10 ** LINK_SAS_DIGITS;

/** Sealed key yang diseal ke kunci yang salah = perangkat lama salah percaya. */
export class LinkSasMismatchError extends Error {
  readonly code = 'LINK_SAS_MISMATCH';
  constructor(message = 'Link verification code does not match the new device key.') {
    super(message);
    this.name = 'LinkSasMismatchError';
  }
}

function decodePublicKey(sodium: Awaited<ReturnType<typeof getSodium>>, b64: string): Uint8Array {
  // Kunci dari server = base64url tanpa padding; kunci dari kripto lokal juga.
  // Toleransi ke base64 standar hanya untuk pemanggil yang lebih tua (mis. test
  // fixture) — bukan jalur wire.
  const variants = [
    sodium.base64_variants.URLSAFE_NO_PADDING,
    sodium.base64_variants.ORIGINAL_NO_PADDING,
    sodium.base64_variants.ORIGINAL,
  ];
  for (const variant of variants) {
    try {
      const decoded = sodium.from_base64(b64, variant);
      if (decoded instanceof Uint8Array && decoded.length > 0) return decoded;
    } catch {
      // coba varian berikutnya
    }
  }
  // Kode yang tidak bisa diturunkan TIDAK boleh dianggap cocok.
  throw new LinkSasMismatchError('Invalid new-device public key for link verification.');
}

/**
 * Kode 6 digit (`"123456"`) dari X-Wing public key perangkat baru.
 *
 * Deterministik dan identik di kedua perangkat. Kunci kosong/rusak → melempar:
 * kode yang tidak bisa diturunkan TIDAK boleh dianggap "cocok".
 */
export async function deriveLinkSas(pqPublicKeyB64: string): Promise<string> {
  if (typeof pqPublicKeyB64 !== 'string' || pqPublicKeyB64.length === 0) {
    throw new LinkSasMismatchError('Missing new-device public key for link verification.');
  }
  const sodium = await getSodium();
  const keyBytes = decodePublicKey(sodium, pqPublicKeyB64);

  const domain = new TextEncoder().encode(LINK_SAS_DOMAIN);
  const input = new Uint8Array(domain.length + 1 + keyBytes.length);
  input.set(domain, 0);
  input[domain.length] = 0; // pemisah domain | kunci
  input.set(keyBytes, domain.length + 1);

  const digest = sodium.crypto_generichash(32, input);
  const value =
    ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return String(value % SAS_MODULUS).padStart(LINK_SAS_DIGITS, '0');
}

/** `"123456"` → `"123 456"` (lebih mudah dibaca dari dua layar berbeda). */
export function formatLinkSas(code: string): string {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== LINK_SAS_DIGITS) return code;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
