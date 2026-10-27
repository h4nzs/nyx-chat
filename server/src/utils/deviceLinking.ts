// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [LINK 2026-10-18] State machine untuk menautkan perangkat baru lewat QR.
 *
 * Sebelum ini hanya ada separuh fitur: `auth:request_linking_qr` membuat token
 * 5 menit di Redis lalu meng-emit `auth:linking_qr_ready`, tetapi TIDAK ada
 * endpoint redeem, TIDAK ada persetujuan perangkat lama, dan TIDAK ada listener
 * di klien — jadi QR-nya tidak bisa dipakai untuk apa pun.
 *
 * Alur lengkap (semua state di Redis, nilai TER-SEAL seperti artefak lain —
 * lihat docs/28 Tier 1.5 / D14):
 *
 *   1. Perangkat lama (authenticated) → `auth:request_linking_qr`
 *      → `linking_token:<hex>` = seal({userId, deviceId}), TTL 5 menit.
 *   2. Perangkat baru (belum login) → POST /api/auth/link/claim
 *      → token dibakar (single-use), state `link_pending:<id>` dibuat, dan
 *        perangkat lama menerima `auth:linking_request`.
 *   3. Perangkat lama → POST /api/auth/link/approve
 *      → Device row dibuat untuk kunci perangkat baru, state = `approved:<deviceId>`.
 *   4. Perangkat baru → POST /api/auth/link/complete
 *      → { deviceId, usernameHash }, lalu klien menjalankan alur /login yang
 *        sudah ada (verifikasi password + kunci lokal) agar satu jalur sesi.
 *
 * Catatan keamanan:
 *  - `pendingId` adalah bearer secret (UUID v4) — satu-satunya yang memegangnya
 *    adalah perangkat baru; approve/deny tetap butuh sesi perangkat lama dan
 *    mencocokkan `userId` pemilik pending.
 *  - Semua nilai disimpan ter-seal: token membawa identitas (userId), dan
 *    pending membawa nama perangkat + bundel kunci (walau publik).
 *  - Token HANYA bisa dipakai sekali (`consumeLinkToken` menghapusnya).
 */

import { randomUUID } from 'node:crypto';

/** Token kedaluwarsa 5 menit; pending juga 5 menit sejak claim. */
export const LINK_PENDING_TTL_SECONDS = 300;

/** Token dibuat handler WS via `sodium.to_hex(randombytes_buf(32))`. */
export const LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const linkTokenKey = (token: string) => `linking_token:${token}`;
export const pendingLinkKey = (pendingId: string) => `link_pending:${pendingId}`;
export const linkStateKey = (pendingId: string) => `link_state:${pendingId}`;

/** Subset client Redis yang dipakai (memudahkan fake di test). */
export interface LinkingStore {
  get(key: string): Promise<string | null>;
  setEx(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  /** [audit F-11] `GETDEL`: baca + hapus dalam satu perintah atomik. */
  getDel(key: string): Promise<string | null>;
}

/** Seal/open at-rest dengan kunci server (lihat utils/atRestSecrets). */
export interface LinkingSealer {
  seal(plaintext: string): Promise<string>;
  open(sealed: string | null | undefined): Promise<string | null>;
}

/** Pembuat token QR: identitas pemilik token + device yang memintanya. */
export interface LinkTokenOwner {
  userId: string;
  deviceId: string;
}

/** Kunci yang didaftarkan perangkat baru (semua sudah ada di kontrak /register). */
export interface PendingDeviceLink {
  userId: string;
  requestDeviceId: string;
  deviceName?: string;
  publicKey: string;
  pqPublicKey?: string;
  signingKey: string;
  /** [PQ v2 Fase 1.5 langkah 9] Kunci verifikasi ML-DSA perangkat baru. */
  signingKeyV2?: string;
  encryptedPrivateKey: string;
  /**
   * Binding hardware PERANGKAT BARU (sudah ter-index/ter-tag server) — diambil
   * saat claim, bukan saat approve. Kalau diambil dari request approve, device
   * baru akan terikat ke sidik jari perangkat LAMA dan login berikutnya di
   * perangkat baru langsung ditolak sebagai "hardware mismatch".
   */
  fingerprint?: string;
  installationTag?: string | null;
}

export interface ApprovedDeviceLink {
  pending: PendingDeviceLink;
  deviceId: string;
}

export type LinkState = 'pending' | 'approved' | 'expired';

const STATE_APPROVED_PREFIX = 'approved:';

function parseObject(raw: string | null): Record<string, unknown> | null {
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTokenOwner(raw: string | null): LinkTokenOwner | null {
  const obj = parseObject(raw);
  const userId = nonEmptyString(obj?.userId);
  const deviceId = nonEmptyString(obj?.deviceId) ?? '';
  return userId ? { userId, deviceId } : null;
}

function parsePending(raw: string | null): PendingDeviceLink | null {
  const obj = parseObject(raw);
  if (!obj) return null;
  const userId = nonEmptyString(obj.userId);
  const publicKey = nonEmptyString(obj.publicKey);
  const signingKey = nonEmptyString(obj.signingKey);
  const encryptedPrivateKey = nonEmptyString(obj.encryptedPrivateKey);
  if (!userId || !publicKey || !signingKey || !encryptedPrivateKey) return null;
  const signingKeyV2 = nonEmptyString(obj.signingKeyV2);
  return {
    userId,
    requestDeviceId: nonEmptyString(obj.requestDeviceId) ?? '',
    deviceName: nonEmptyString(obj.deviceName) ?? undefined,
    publicKey,
    pqPublicKey: nonEmptyString(obj.pqPublicKey) ?? undefined,
    signingKey,
    ...(signingKeyV2 ? { signingKeyV2 } : {}),
    encryptedPrivateKey,
    fingerprint: nonEmptyString(obj.fingerprint) ?? undefined,
    installationTag: nonEmptyString(obj.installationTag) ?? null,
  };
}

/**
 * Baca token QR tanpa membakarnya. Dipakai handler/pengujian; jalur HTTP
 * memakai `consumeLinkToken` supaya token benar-benar sekali pakai.
 */
export async function readLinkToken(
  store: LinkingStore,
  sealer: LinkingSealer,
  token: string
): Promise<LinkTokenOwner | null> {
  if (!LINK_TOKEN_PATTERN.test(token)) return null;
  const sealed = await store.get(linkTokenKey(token));
  if (!sealed) return null;
  return parseTokenOwner(await sealer.open(sealed));
}

/**
 * Baca + hapus: token QR tidak boleh dipakai dua kali.
 *
 * [audit F-11] Dulu `GET` lalu `DEL`: dua request claim yang berbarengan bisa
 * sama-sama membaca token sebelum salah satunya menghapus, sehingga satu QR
 * menghasilkan dua `link_pending` (dan perangkat lama menerima dua
 * `auth:linking_request`). `GETDEL` membuat baca-bakar itu satu operasi atomik;
 * request kedua selalu mendapat `null`.
 */
export async function consumeLinkToken(
  store: LinkingStore,
  sealer: LinkingSealer,
  token: string
): Promise<LinkTokenOwner | null> {
  if (!LINK_TOKEN_PATTERN.test(token)) return null;
  const sealed = await store.getDel(linkTokenKey(token));
  if (!sealed) return null;
  return parseTokenOwner(await sealer.open(sealed));
}

export async function createPendingLink(
  store: LinkingStore,
  sealer: LinkingSealer,
  pending: PendingDeviceLink
): Promise<string> {
  const pendingId = randomUUID();
  await store.setEx(
    pendingLinkKey(pendingId),
    LINK_PENDING_TTL_SECONDS,
    await sealer.seal(JSON.stringify(pending))
  );
  await store.setEx(linkStateKey(pendingId), LINK_PENDING_TTL_SECONDS, 'pending');
  return pendingId;
}

export async function readPendingLink(
  store: LinkingStore,
  sealer: LinkingSealer,
  pendingId: string
): Promise<PendingDeviceLink | null> {
  const sealed = await store.get(pendingLinkKey(pendingId));
  if (!sealed) return null;
  return parsePending(await sealer.open(sealed));
}

export async function getLinkState(store: LinkingStore, pendingId: string): Promise<LinkState> {
  const state = await store.get(linkStateKey(pendingId));
  if (!state) return 'expired';
  if (state.startsWith(STATE_APPROVED_PREFIX)) return 'approved';
  return (await store.get(pendingLinkKey(pendingId))) ? 'pending' : 'expired';
}

/**
 * Tandai disetujui SETELAH Device row dibuat. Mengembalikan null bila pending
 * hilang/kedaluwarsa, milik user lain, atau sudah disetujui (idempoten: approve
 * kedua tidak boleh membuat device kedua).
 */
export async function approvePendingLink(
  store: LinkingStore,
  sealer: LinkingSealer,
  pendingId: string,
  approverUserId: string,
  deviceId: string
): Promise<ApprovedDeviceLink | null> {
  const pending = await readPendingLink(store, sealer, pendingId);
  if (!pending || pending.userId !== approverUserId) return null;
  if (await getLinkState(store, pendingId) !== 'pending') return null;
  await store.setEx(
    linkStateKey(pendingId),
    LINK_PENDING_TTL_SECONDS,
    `${STATE_APPROVED_PREFIX}${deviceId}`
  );
  return { pending, deviceId };
}

export async function denyPendingLink(store: LinkingStore, pendingId: string): Promise<void> {
  await store.del(pendingLinkKey(pendingId), linkStateKey(pendingId));
}

/**
 * Ambil hasil yang sudah disetujui lalu hapus SEMUA state (sekali pakai).
 * Null bila belum disetujui / kedaluwarsa — klien tidak boleh mendapat token
 * sesi tanpa persetujuan perangkat lama.
 */
export async function takeApprovedLink(
  store: LinkingStore,
  sealer: LinkingSealer,
  pendingId: string
): Promise<ApprovedDeviceLink | null> {
  const state = await store.get(linkStateKey(pendingId));
  if (!state || !state.startsWith(STATE_APPROVED_PREFIX)) return null;
  const deviceId = state.slice(STATE_APPROVED_PREFIX.length);
  const pending = await readPendingLink(store, sealer, pendingId);
  await store.del(pendingLinkKey(pendingId), linkStateKey(pendingId));
  if (!pending || !deviceId) return null;
  return { pending, deviceId };
}
