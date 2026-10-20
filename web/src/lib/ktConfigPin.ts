// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.5] Pin konfigurasi log Key Transparency (trust-on-first-use).
 *
 * `resolveConfig` di `ktBundleProof.ts` mengambil `mode`/`signatureKey`/`vrfKey`/
 * `auditorKeys` dari `GET /api/keys/kt/config`, yang dilayani server yang sama
 * yang juga menyajikan bukti log. Tanpa pin, server yang jahat cukup menukar
 * kunci verifikasi untuk memalsukan seluruh log — verifier WASM akan menilai
 * "sah" karena ia mempercayai kunci yang diberikan penyerang.
 *
 * Pin menutup celah itu dengan cara termurah: kunci PERTAMA yang dilihat disimpan
 * ter-seal `ENC1:` (masterSeed), dan setiap konfigurasi berikutnya harus identik.
 * Perubahan kunci yang sah (rotasi operator log) berarti klien harus melepas pin
 * secara eksplisit; itu keputusan produk, bukan sesuatu yang boleh terjadi diam-diam.
 *
 * Yang **tidak** dilakukan modul ini: tidak membuat pin yang tahan terhadap
 * penyerang yang menguasai IndexedDB lokal (masterSeed ada di memori saat
 * terbuka). Pin kuat sejati (trust anchor dari rilis aplikasi) menunggu KT Scope B.
 */

import { db } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';

/** PK baris tunggal di tabel `ktConfig`. */
export const KT_CONFIG_ROW_ID = 'kt-config';

const HEX_32_BYTE = /^[0-9a-fA-F]{64}$/;

/** Bentuk pin tersimpan: kunci verifikasi log sebagai hex huruf kecil. */
export interface KtConfigPin {
  mode: number;
  signatureKey: string;
  vrfKey: string;
  auditorKeys: string[];
}

const isHex32 = (value: unknown): value is string =>
  typeof value === 'string' && HEX_32_BYTE.test(value);

/** Normalisasi + validasi bentuk pin; `undefined` bila tidak lengkap. */
export function parseKtConfigPin(value: unknown): KtConfigPin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<KtConfigPin>;
  if (typeof candidate.mode !== 'number' || !Number.isInteger(candidate.mode)) return undefined;
  if (!isHex32(candidate.signatureKey) || !isHex32(candidate.vrfKey)) return undefined;
  const auditorKeys = candidate.auditorKeys ?? [];
  if (!Array.isArray(auditorKeys) || !auditorKeys.every(isHex32)) return undefined;
  return {
    mode: candidate.mode,
    signatureKey: candidate.signatureKey.toLowerCase(),
    vrfKey: candidate.vrfKey.toLowerCase(),
    auditorKeys: auditorKeys.map((key) => key.toLowerCase()),
  };
}

/**
 * Bandingkan konfigurasi remote (hex) dengan pin. Keduanya sudah dinormalisasi
 * huruf kecil; urutan `auditorKeys` dianggap bagian dari identitas konfigurasi.
 */
export function ktConfigPinMatches(pin: KtConfigPin, candidate: KtConfigPin): boolean {
  if (pin.mode !== candidate.mode) return false;
  if (pin.signatureKey !== candidate.signatureKey) return false;
  if (pin.vrfKey !== candidate.vrfKey) return false;
  if (pin.auditorKeys.length !== candidate.auditorKeys.length) return false;
  return pin.auditorKeys.every((key, index) => key === candidate.auditorKeys[index]);
}

/** Muat pin tersimpan. Baris rusak/tidak ada → `undefined` (belum di-pin). */
export async function loadKtConfigPin(): Promise<KtConfigPin | undefined> {
  try {
    const row = await db.ktConfig.get(KT_CONFIG_ROW_ID);
    if (!row) return undefined;
    const plain = await decryptValueAtRest(row.blob);
    if (!plain) return undefined;
    return parseKtConfigPin(JSON.parse(plain));
  } catch {
    return undefined;
  }
}

/** Simpan pin (TOFU). Kegagalan tulis ditelan: pin adalah sinyal, bukan blocker. */
export async function saveKtConfigPin(pin: KtConfigPin): Promise<void> {
  try {
    const blob = await encryptValueAtRest(JSON.stringify(pin));
    await db.ktConfig.put({ id: KT_CONFIG_ROW_ID, blob });
  } catch {
    // IndexedDB ikut terhapus saat wipe; kegagalan menulis bukan alasan
    // menggagalkan jalur kunci.
  }
}

/** Hapus pin (logout/wipe/rotasi yang disengaja). */
export async function clearKtConfigPin(): Promise<void> {
  try {
    await db.ktConfig.delete(KT_CONFIG_ROW_ID);
  } catch {
    // Baris ikut terhapus bersama IndexedDB saat wipe.
  }
}
