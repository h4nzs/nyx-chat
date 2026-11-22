// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.5] Pin konfigurasi log Key Transparency (trust-on-first-use).
 *
 * `resolveConfig` di `ktBundleProof.ts` mengambil `mode`/`signatureKey`/
 * `auditorKeys` dari `GET /api/keys/kt/config`, yang
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
 * [docs/43 §43.3.2] Hanya ABI 2. Tidak ada lagi pin ABI 1 maupun migrasi
 * ABI 1 → ABI 2: pin lama (tanpa `abiVersion` atau dengan `vrfKey`) ditolak
 * `parseKtConfigPin`, sehingga perangkat lama menjalani TOFU sekali lagi
 * alih-alih mempercayai kunci yang tidak bisa memverifikasi log v2.
 *
 * Yang **tidak** dilakukan modul ini: tidak membuat pin yang tahan terhadap
 * penyerang yang menguasai IndexedDB lokal (masterSeed ada di memori saat
 * terbuka). Pin kuat sejati (trust anchor dari rilis aplikasi) menunggu KT Scope B.
 */

import type { KtConfigRow } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';
import { clearKvPrefix, KT_CONFIG_PREFIX, openKtSqliteKv } from './storage/ktKv';
import type { KvStore } from './storage/types';

/** Prefix PK di tabel `ktConfig`. */
export const KT_CONFIG_ROW_ID = 'kt-config';

/**
 * [docs/43 §43.3.2] Hanya ABI 2 (ML-DSA-65 + SHA-256 index). ABI 1 (Ed25519 +
 * EC-VRF) tidak punya log aktif lagi, jadi tidak ada bentuk pin kedua yang
 * perlu diterima — pin ABI 1 di perangkat lama ditolak dan di-pin ulang lewat
 * alur TOFU biasa, bukan diinferensi diam-diam.
 */
export type KtConfigAbi = 2;

const HEX_1952_BYTE = /^[0-9a-fA-F]{3904}$/;

/** Bentuk pin tersimpan: kunci verifikasi log sebagai hex huruf kecil. */
export interface KtConfigPin {
  abiVersion: KtConfigAbi;
  mode: number;
  /** ML-DSA-65 (1952 B). */
  signatureKey: string;
  auditorKeys: string[];
}

const isHex1952 = (value: unknown): value is string =>
  typeof value === 'string' && HEX_1952_BYTE.test(value);

/** Normalisasi + validasi bentuk pin; `undefined` bila tidak lengkap. */
export function parseKtConfigPin(value: unknown): KtConfigPin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<KtConfigPin> & { vrfKey?: unknown };
  if (typeof candidate.mode !== 'number' || !Number.isInteger(candidate.mode)) return undefined;

  // ABI lain (termasuk pin lama tanpa `abiVersion` atau dengan `vrfKey`)
  // ditolak: tidak ada jalur inferensi lagi.
  if (candidate.abiVersion !== 2) return undefined;
  if (!isHex1952(candidate.signatureKey)) return undefined;
  if (candidate.vrfKey !== undefined && candidate.vrfKey !== '') return undefined;

  const auditorKeys = candidate.auditorKeys ?? [];
  if (!Array.isArray(auditorKeys) || !auditorKeys.every((key) => isHex1952(key))) {
    return undefined;
  }

  return {
    abiVersion: 2,
    mode: candidate.mode,
    signatureKey: candidate.signatureKey.toLowerCase(),
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
  if (pin.auditorKeys.length !== candidate.auditorKeys.length) return false;
  return pin.auditorKeys.every((key, index) => key === candidate.auditorKeys[index]);
}

/**
 * [audit N8-03] PK pin **per akun**, bukan satu baris global.
 *
 * Logout tidak lagi menghapus pin (itu menurunkan perlindungan TOFU menjadi
 * per-sesi: server bisa menukar `signatureKey` di antara logout dan login tanpa
 * terdeteksi). Dengan baris per akun, akun A mempertahankan kontinuitasnya dan
 * akun B di perangkat yang sama tidak pernah membaca/mewarisi pin A. Id akun di
 * PK bukan rahasia baru: perangkat ini memang tahu siapa yang login, dan nilai
 * pin sendiri tetap ter-seal `ENC1:`.
 */
export function ktConfigPinRowId(userId: string): string {
  return `${KT_CONFIG_ROW_ID}:${userId}`;
}

interface KtConfigBackend {
  get(id: string): Promise<KtConfigRow | undefined>;
  put(row: KtConfigRow): Promise<void>;
  clear(): Promise<void>;
}

function sqliteKtConfig(kv: KvStore): KtConfigBackend {
  return {
    get: (id) => kv.get<KtConfigRow>(`${KT_CONFIG_PREFIX}${id}`),
    put: async (row) => { await kv.put({ key: `${KT_CONFIG_PREFIX}${row.id}`, value: row }); },
    clear: () => clearKvPrefix(kv, KT_CONFIG_PREFIX),
  };
}

async function getKtConfigBackend(): Promise<KtConfigBackend> {
  return sqliteKtConfig(await openKtSqliteKv());
}

/** Id akun yang sedang login; `undefined` bila belum/tidak ada sesi. */
async function currentKtAccountId(): Promise<string | undefined> {
  try {
    const { useAuthStore } = await import('@store/auth');
    const id = useAuthStore.getState().user?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * [audit N9-02] Hasil pencarian pin — tiga keadaan yang tidak boleh disamakan.
 *
 * Sebelumnya semuanya dilaporkan sebagai `undefined`, sehingga `resolveConfig`
 * memperlakukannya sebagai "belum pernah di-pin" (TOFU): konfigurasi yang
 * disajikan server diterima tanpa perbandingan. Itu benar untuk `empty`, tetapi
 * salah untuk `unknown-account` — saat store belum terhidrasi atau verifikasi
 * berjalan setelah logout, jendela itu mematikan TOFU untuk sesi tersebut.
 * `unreadable` juga bukan `empty`: baris ada tetapi tidak bisa dibuka (vault
 * terkunci / rusak) berarti jangkar tidak diketahui, bukan belum ada jangkar.
 */
export type KtConfigPinState =
  | { status: 'pin'; pin: KtConfigPin }
  | { status: 'empty' }
  | { status: 'unknown-account' }
  | { status: 'unreadable' };

export async function resolveKtConfigPin(): Promise<KtConfigPinState> {
  const accountId = await currentKtAccountId();
  // Tanpa id akun kita TIDAK membaca baris mana pun: pin milik akun lain tidak
  // boleh dipakai sebagai jangkar, dan "tidak tahu akun" bukan "belum di-pin".
  if (!accountId) return { status: 'unknown-account' };
  try {
    const row = await (await getKtConfigBackend()).get(ktConfigPinRowId(accountId));
    if (!row) return { status: 'empty' };
    const plain = await decryptValueAtRest(row.blob);
    if (!plain) return { status: 'unreadable' };
    const pin = parseKtConfigPin(JSON.parse(plain));
    return pin ? { status: 'pin', pin } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Muat pin tersimpan (bentuk lama). `undefined` untuk ketiga keadaan tanpa pin —
 * pemanggil yang perlu membedakannya memakai `resolveKtConfigPin`.
 */
export async function loadKtConfigPin(): Promise<KtConfigPin | undefined> {
  const state = await resolveKtConfigPin();
  return state.status === 'pin' ? state.pin : undefined;
}

/** Simpan pin (TOFU). Kegagalan tulis ditelan: pin adalah sinyal, bukan blocker. */
export async function saveKtConfigPin(pin: KtConfigPin): Promise<void> {
  try {
    const accountId = await currentKtAccountId();
    if (!accountId) return;
    const blob = await encryptValueAtRest(JSON.stringify(pin));
    await (await getKtConfigBackend()).put({ id: ktConfigPinRowId(accountId), blob });
  } catch {
    // IndexedDB ikut terhapus saat wipe; kegagalan menulis bukan alasan
    // menggagalkan jalur kunci.
  }
}

/**
 * Hapus SEMUA pin (rotasi kunci yang disengaja / wipe). **Bukan** jalur logout:
 * `logout` mempertahankan pin akun itu supaya kontinuitas TOFU lintas sesi
 * terjaga (audit N8-03); isolasi antar-akun datang dari PK per akun.
 */
export async function clearKtConfigPin(): Promise<void> {
  try {
    await (await getKtConfigBackend()).clear();
  } catch {
    // Baris ikut terhapus bersama IndexedDB saat wipe.
  }
}
