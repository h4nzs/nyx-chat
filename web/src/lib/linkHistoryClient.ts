// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40] Transport arsip riwayat perangkat hasil link.
 *
 * Kontrak server (`server/src/routes/linkHistory.ts`):
 *   POST /api/auth/link/history/presign  {deviceId, size} → {uploadUrl, size}
 *   POST /api/auth/link/history/ready    {deviceId, size, digest, sealedKey}
 *   GET  /api/auth/link/history          → {state:'none'|'ready', size?, digest?}
 *   POST /api/auth/link/history/download → {downloadUrl, sealedKey, size, digest}
 *   POST /api/auth/link/history/consume  {digest} → {deleted}
 *
 * Aturan privasi yang dijaga di sini:
 *   - Kunci arsip (`K`, 32 byte acak) hanya hidup di memori perangkat lama dan
 *     diseal ke X-Wing perangkat baru (`pq_box_seal_v2`). Server tidak pernah
 *     melihat `K` maupun isi arsip.
 *   - Byte arsip di-PUT langsung ke URL presigned R2 (bukan lewat API), dan
 *     diverifikasi `size` + `digest` sebelum kunci disentuh saat impor.
 */

import { api } from './api';
import { getSodium } from './sodiumInitializer';
import { sealForDevice, openSealedForDevice } from './pqBoxSeal';
import { useAuthStore } from '@store/auth';

/** Penanda versi payload di dalam sealed key (bukan versi arsip). */
export const HISTORY_KEY_PAYLOAD_VERSION = 1;

export type HistoryServerState = 'none' | 'ready';

export interface HistoryStatus {
  state: HistoryServerState;
  size?: number;
  digest?: string;
}

export interface HistoryLimits {
  /** Kuota satu arsip untuk akun ini (byte) — angka yang sama dipakai presign. */
  maxBytes: number;
  verified: boolean;
}

export interface HistoryDownloadTicket {
  downloadUrl: string;
  sealedKey: string;
  size: number;
  digest: string;
}

const BASE = '/api/auth/link/history';

function base64Url(bytes: Uint8Array): Promise<string> {
  return getSodium().then((sodium) =>
    sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
  );
}

async function fromBase64Url(value: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** BLAKE2b-256 atas byte arsip → hex huruf kecil (format `digest` server). */
export async function digestArchive(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_hex(sodium.crypto_generichash(32, bytes));
}

export async function getHistoryStatus(): Promise<HistoryStatus> {
  const res = await api<HistoryStatus>(BASE);
  return res?.state === 'ready' ? res : { state: 'none' };
}

/**
 * [docs/40 §40.7 langkah 8] Kuota efektif akun (tier, dipotong 25 MB untuk akun
 * belum terverifikasi). Dibaca SEBELUM mengunggah supaya kelebihan ukuran
 * dilaporkan sebagai pesan yang bisa ditindaklanjuti, bukan 400 dari presign
 * setelah puluhan MB terkirim.
 */
export async function getHistoryLimits(): Promise<HistoryLimits> {
  const res = await api<HistoryLimits>(`${BASE}/limits`);
  return {
    maxBytes: typeof res?.maxBytes === 'number' && res.maxBytes > 0 ? res.maxBytes : 0,
    verified: Boolean(res?.verified),
  };
}

export async function presignHistoryUpload(
  deviceId: string,
  size: number
): Promise<{ uploadUrl: string; size: number; urlTtl: number }> {
  return api(`${BASE}/presign`, {
    method: 'POST',
    body: JSON.stringify({ deviceId, size }),
  });
}

export async function markHistoryReady(input: {
  deviceId: string;
  size: number;
  digest: string;
  sealedKey: string;
}): Promise<void> {
  await api(`${BASE}/ready`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function requestHistoryDownload(): Promise<HistoryDownloadTicket> {
  return api(`${BASE}/download`, { method: 'POST' });
}

/**
 * Batalkan unggahan (gagal di tengah / tidak ada yang bisa dikirim).
 *
 * Penting untuk UX: tanpa ini, perangkat baru menunggu penuh 60 detik karena
 * `status.history` tetap `preparing` sampai TTL intent habis.
 */
export async function abortHistoryUpload(deviceId: string): Promise<void> {
  await api(`${BASE}/abort`, {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  });
}

/** Hapus objek R2 + state server. Idempoten (konsumsi kedua tetap sukses). */
export async function consumeHistoryArchive(digest: string): Promise<void> {
  await api(`${BASE}/consume`, {
    method: 'POST',
    body: JSON.stringify({ digest }),
  });
}

/**
 * PUT byte arsip ke URL presigned. `fetch` langsung (bukan `api()`): URL-nya
 * milik R2, bukan API kita, dan tidak boleh membawa cookie/header CSRF.
 */
export async function uploadHistoryArchive(uploadUrl: string, bytes: Uint8Array): Promise<void> {
  const body = new Uint8Array(bytes);
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) throw new Error(`HISTORY_UPLOAD_FAILED:${res.status}`);
}

export async function fetchHistoryArchive(downloadUrl: string): Promise<Uint8Array> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`HISTORY_DOWNLOAD_FAILED:${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Bungkus `K` untuk perangkat baru: X-Wing sealed box berisi JSON kecil. */
export async function sealArchiveKey(input: {
  key: Uint8Array;
  pqPublicKeyB64: string;
  records: number;
}): Promise<string> {
  const pqPublicKey = await fromBase64Url(input.pqPublicKeyB64);
  const payload = JSON.stringify({
    v: HISTORY_KEY_PAYLOAD_VERSION,
    k: await base64Url(input.key),
    n: input.records,
    d: new Date().toISOString(),
  });
  const sealed = await sealForDevice(payload, pqPublicKey);
  return base64Url(sealed);
}

/**
 * Buka `sealedKey` dengan kunci X-Wing perangkat INI. Cache kunci privat sudah
 * terisi setelah `login()` (alur link), jadi tidak ada prompt password kedua.
 */
export async function openArchiveKey(sealedKeyB64: string): Promise<Uint8Array> {
  const { privateKey } = await useAuthStore.getState().getPqEncryptionKeyPair();
  const sealed = await fromBase64Url(sealedKeyB64);
  const plaintext = await openSealedForDevice(sealed, privateKey);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    v?: unknown;
    k?: unknown;
  };
  if (parsed.v !== HISTORY_KEY_PAYLOAD_VERSION || typeof parsed.k !== 'string') {
    throw new Error('HISTORY_KEY_PAYLOAD_INVALID');
  }
  const key = await fromBase64Url(parsed.k);
  if (key.length !== 32) throw new Error('HISTORY_KEY_INVALID');
  return key;
}

/** Kunci arsip acak 32 byte (hanya di memori perangkat lama). */
export async function generateArchiveKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(32);
}
