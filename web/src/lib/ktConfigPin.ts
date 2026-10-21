// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.5] Pin konfigurasi log Key Transparency (trust-on-first-use).
 *
 * `resolveConfig` di `ktBundleProof.ts` mengambil `mode`/`signatureKey`/
 * `auditorKeys` (dan `vrfKey` untuk ABI 1) dari `GET /api/keys/kt/config`, yang
 * dilayani server yang sama yang juga menyajikan bukti log. Tanpa pin, server
 * yang jahat cukup menukar kunci verifikasi untuk memalsukan seluruh log —
 * verifier WASM akan menilai "sah" karena ia mempercayai kunci yang diberikan
 * penyerang.
 *
 * Pin menutup celah itu dengan cara termurah: kunci PERTAMA yang dilihat disimpan
 * ter-seal `ENC1:` (masterSeed), dan setiap konfigurasi berikutnya harus identik.
 * Perubahan kunci yang sah (rotasi operator log) berarti klien harus melepas pin
 * secara eksplisit; itu keputusan produk, bukan sesuatu yang boleh terjadi diam-diam.
 *
 * [docs/35 §35.7 Fase 7] Migrasi ABI 1 → ABI 2 adalah satu-satunya pengecualian:
 * PIN LAMA (ABI 1) boleh digantikan pin ABI 2 dengan `mode` yang sama, karena
 * log v2 adalah pohon terpisah dengan kunci ML-DSA baru sehingga kunci ABI 1
 * tidak mungkin dipakai untuk memverifikasinya. Penggantian tetap **setelah
 * bukti v2 terbukti sah** (`commitKtConfigPin`), bukan saat config dibaca, dan
 * arah sebaliknya (v2 → v1) selalu ditolak.
 *
 * Yang **tidak** dilakukan modul ini: tidak membuat pin yang tahan terhadap
 * penyerang yang menguasai IndexedDB lokal (masterSeed ada di memori saat
 * terbuka). Pin kuat sejati (trust anchor dari rilis aplikasi) menunggu KT Scope B.
 */

import { db } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';

/** PK baris tunggal di tabel `ktConfig`. */
export const KT_CONFIG_ROW_ID = 'kt-config';

/** ABI frame verifier: 1 = Ed25519 + EC-VRF, 2 = ML-DSA-65 + SHA-256 index. */
export type KtConfigAbi = 1 | 2;

const HEX_32_BYTE = /^[0-9a-fA-F]{64}$/;
const HEX_1952_BYTE = /^[0-9a-fA-F]{3904}$/;

/** Bentuk pin tersimpan: kunci verifikasi log sebagai hex huruf kecil. */
export interface KtConfigPin {
  abiVersion: KtConfigAbi;
  mode: number;
  /** Ed25519 (32 B) pada ABI 1, ML-DSA-65 (1952 B) pada ABI 2. */
  signatureKey: string;
  /** Hanya ABI 1: kunci EC-VRF log (32 B). */
  vrfKey?: string;
  auditorKeys: string[];
}

const isHex32 = (value: unknown): value is string =>
  typeof value === 'string' && HEX_32_BYTE.test(value);

const isHex1952 = (value: unknown): value is string =>
  typeof value === 'string' && HEX_1952_BYTE.test(value);

const isKeyForAbi = (value: unknown, abi: KtConfigAbi): value is string =>
  abi === 1 ? isHex32(value) : isHex1952(value);

/** Normalisasi + validasi bentuk pin; `undefined` bila tidak lengkap. */
export function parseKtConfigPin(value: unknown): KtConfigPin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<KtConfigPin>;
  if (typeof candidate.mode !== 'number' || !Number.isInteger(candidate.mode)) return undefined;

  // Pin yang ditulis sebelum v2 tidak punya `abiVersion`; bentuknya (dua kunci
  // 32 byte) hanya mungkin milik ABI 1, jadi inferensi itu aman dan menjaga
  // pengguna lama tetap ter-pin alih-alih jatuh ke TOFU ulang.
  let abi: KtConfigAbi;
  if (candidate.abiVersion === undefined) {
    abi = isHex32(candidate.signatureKey) && isHex32(candidate.vrfKey) ? 1 : 2;
  } else if (candidate.abiVersion === 1 || candidate.abiVersion === 2) {
    abi = candidate.abiVersion;
  } else {
    return undefined;
  }

  if (!isKeyForAbi(candidate.signatureKey, abi)) return undefined;
  if (abi === 1) {
    if (!isHex32(candidate.vrfKey)) return undefined;
  } else if (candidate.vrfKey !== undefined && candidate.vrfKey !== '') {
    // ABI 2 tidak punya VRF. Kehadiran kunci VRF berarti config mencampur dua
    // skema — jangan dinormalisasi diam-diam.
    return undefined;
  }

  const auditorKeys = candidate.auditorKeys ?? [];
  if (!Array.isArray(auditorKeys) || !auditorKeys.every((key) => isKeyForAbi(key, abi))) {
    return undefined;
  }

  const pin: KtConfigPin = {
    abiVersion: abi,
    mode: candidate.mode,
    signatureKey: candidate.signatureKey.toLowerCase(),
    auditorKeys: auditorKeys.map((key) => key.toLowerCase()),
  };
  if (abi === 1) pin.vrfKey = candidate.vrfKey!.toLowerCase();
  return pin;
}

/**
 * Bandingkan konfigurasi remote (hex) dengan pin. Keduanya sudah dinormalisasi
 * huruf kecil; urutan `auditorKeys` dianggap bagian dari identitas konfigurasi.
 */
export function ktConfigPinMatches(pin: KtConfigPin, candidate: KtConfigPin): boolean {
  if (pin.abiVersion !== candidate.abiVersion) return false;
  if (pin.mode !== candidate.mode) return false;
  if (pin.signatureKey !== candidate.signatureKey) return false;
  if ((pin.vrfKey ?? '') !== (candidate.vrfKey ?? '')) return false;
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
