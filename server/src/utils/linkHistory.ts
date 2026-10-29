// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40] State machine arsip riwayat perangkat hasil link.
 *
 * Alurnya (semua state di Redis, nilai TER-SEAL seperti `deviceLinking.ts`):
 *
 *   1. Perangkat lama menekan "setujui + sertakan riwayat"
 *      → `link_history_intent:<deviceId>` (TTL 10 menit). Perangkat baru yang
 *        memantau `GET /link/status/:id` melihat `history: 'preparing'` dan
 *        MENUNGGU sebelum memanggil `complete` — kalau tidak, login perangkat
 *        baru mencabut sesi perangkat lama di tengah unggahan.
 *   2. Perangkat lama minta URL PUT (`link_history_presign:<deviceId>`, TTL 10
 *        menit) lalu mengunggah blob ke R2. Server tidak pernah melihat isi.
 *   3. `ready` menyimpan pointer: `link_history:<deviceId>` =
 *        seal({size, digest, sealedKey}) TTL 30 menit.
 *   4. Perangkat baru (sesi milik deviceId itu) membaca pointer, mengunduh,
 *        mengimpor, lalu `consume` → state + objek dihapus.
 *
 * Modul ini SENGAJA murni (tanpa Express/Prisma/Redis langsung) supaya aturan
 * yang mahal bila salah — ukuran harus cocok dengan presign, digest harus hex,
 * `sealedKey` harus masuk akal — bisa diuji tanpa infra.
 */

import type { LinkingSealer, LinkingStore } from './deviceLinking.js';

/** Seberapa lama pointer arsip hidup setelah `ready`. */
export const LINK_HISTORY_TTL_SECONDS = 1800;

/** Umur izin presign (harus lebih pendek dari TTL pointer). */
export const LINK_HISTORY_PRESIGN_TTL_SECONDS = 600;

/**
 * Umur sinyal "perangkat lama sedang menyiapkan arsip". Klien menunggu maks 60
 * detik; TTL ini hanya mencegah status `preparing` menggantung bila perangkat
 * lama mati sebelum mengunggah.
 */
export const LINK_HISTORY_INTENT_TTL_SECONDS = 600;

/** `digest` = BLAKE2b-256 atas byte arsip, hex huruf kecil. */
export const HISTORY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Batas atas `sealedKey` (base64url). Isinya X-Wing ct (~1.1 KB) + payload
 * kecil; 4 KB memberi ruang tanpa membuka pintu untuk blob sembarang.
 */
export const HISTORY_SEALED_KEY_MAX_CHARS = 4096;

export const historyStateKey = (deviceId: string) => `link_history:${deviceId}`;
export const historyPresignKey = (deviceId: string) => `link_history_presign:${deviceId}`;
export const historyIntentKey = (deviceId: string) => `link_history_intent:${deviceId}`;

export interface HistoryState {
  size: number;
  digest: string;
  /** Kunci arsip yang sudah diseal ke X-Wing perangkat baru (base64url). */
  sealedKey: string;
  /** Unix ms saat `ready` — diagnostik, bukan dipakai untuk otorisasi. */
  at: number;
}

export interface HistoryUploadInput {
  size: unknown;
  digest: unknown;
  sealedKey: unknown;
}

export type HistoryUploadValidation =
  | { ok: true; size: number; digest: string; sealedKey: string }
  | { ok: false; error: string };

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Validasi semantik body `ready`. `zodValidate` di route hanya memeriksa tipe
 * kasar; aturan yang menentukan (hex huruf kecil, panjang sealedKey) ada di
 * sini supaya bisa diuji dan dipakai ulang.
 */
export function validateHistoryUpload(input: HistoryUploadInput): HistoryUploadValidation {
  const size = positiveInt(input.size);
  if (size === null) return { ok: false, error: 'invalid_size' };
  if (typeof input.digest !== 'string' || !HISTORY_DIGEST_PATTERN.test(input.digest)) {
    return { ok: false, error: 'invalid_digest' };
  }
  if (
    typeof input.sealedKey !== 'string' ||
    input.sealedKey.length === 0 ||
    input.sealedKey.length > HISTORY_SEALED_KEY_MAX_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(input.sealedKey)
  ) {
    return { ok: false, error: 'invalid_sealed_key' };
  }
  return { ok: true, size, digest: input.digest, sealedKey: input.sealedKey };
}

/** Tandai bahwa perangkat lama BERKOMITMEN mengunggah arsip (dipanggil saat approve). */
export async function markHistoryIntent(store: LinkingStore, deviceId: string): Promise<void> {
  if (!deviceId) return;
  await store.setEx(historyIntentKey(deviceId), LINK_HISTORY_INTENT_TTL_SECONDS, '1');
}

export async function hasHistoryIntent(store: LinkingStore, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  return (await store.get(historyIntentKey(deviceId))) !== null;
}

/** Catat ukuran yang disetujui presign; `ready` wajib memakai ukuran yang sama. */
export async function recordHistoryPresign(
  store: LinkingStore,
  sealer: LinkingSealer,
  deviceId: string,
  size: number
): Promise<void> {
  await store.setEx(
    historyPresignKey(deviceId),
    LINK_HISTORY_PRESIGN_TTL_SECONDS,
    await sealer.seal(JSON.stringify({ size, at: Date.now() }))
  );
}

export async function readHistoryPresign(
  store: LinkingStore,
  sealer: LinkingSealer,
  deviceId: string
): Promise<{ size: number; at: number } | null> {
  const raw = await sealer.open(await store.get(historyPresignKey(deviceId)));
  const obj = parseJsonObject(raw);
  const size = positiveInt(obj?.size);
  if (size === null) return null;
  const at = typeof obj?.at === 'number' ? obj.at : 0;
  return { size, at };
}

export type HistoryReadyResult =
  | { ok: true; state: HistoryState }
  | { ok: false; reason: 'invalid' | 'no_presign' | 'size_mismatch' };

/**
 * Simpan pointer arsip. Menolak bila:
 *  - isi tidak lolos `validateHistoryUpload`,
 *  - tidak ada presign (klien melewati urutan, atau TTL presign habis),
 *  - `size` berbeda dari yang disetujui presign (presign 4 MB lalu PUT 40 MB
 *    harus ketahuan di sini, bukan saat unduh).
 */
export async function markHistoryReady(
  store: LinkingStore,
  sealer: LinkingSealer,
  deviceId: string,
  input: HistoryUploadInput
): Promise<HistoryReadyResult> {
  const validated = validateHistoryUpload(input);
  if (!validated.ok) return { ok: false, reason: 'invalid' };

  const presign = await readHistoryPresign(store, sealer, deviceId);
  if (!presign) return { ok: false, reason: 'no_presign' };
  if (presign.size !== validated.size) return { ok: false, reason: 'size_mismatch' };

  const state: HistoryState = {
    size: validated.size,
    digest: validated.digest,
    sealedKey: validated.sealedKey,
    at: Date.now(),
  };
  await store.setEx(
    historyStateKey(deviceId),
    LINK_HISTORY_TTL_SECONDS,
    await sealer.seal(JSON.stringify(state))
  );
  return { ok: true, state };
}

export async function readHistoryState(
  store: LinkingStore,
  sealer: LinkingSealer,
  deviceId: string
): Promise<HistoryState | null> {
  if (!deviceId) return null;
  const obj = parseJsonObject(await sealer.open(await store.get(historyStateKey(deviceId))));
  const size = positiveInt(obj?.size);
  const digest = typeof obj?.digest === 'string' ? obj.digest : '';
  const sealedKey = typeof obj?.sealedKey === 'string' ? obj.sealedKey : '';
  if (size === null || !HISTORY_DIGEST_PATTERN.test(digest) || !sealedKey) return null;
  const at = typeof obj?.at === 'number' ? obj.at : 0;
  return { size, digest, sealedKey, at };
}

/**
 * Hapus pointer + presign + intent. Mengembalikan state yang dibakar (atau null)
 * supaya pemanggil tahu apakah ada objek R2 yang harus dihapus. Idempoten:
 * `consume` kedua tidak menemukan apa pun dan tidak melempar.
 */
export async function burnHistory(
  store: LinkingStore,
  sealer: LinkingSealer,
  deviceId: string
): Promise<HistoryState | null> {
  if (!deviceId) return null;
  const state = await readHistoryState(store, sealer, deviceId);
  await store.del(historyStateKey(deviceId), historyPresignKey(deviceId), historyIntentKey(deviceId));
  return state;
}
