// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.5] Kontrak presentasi credential — VERIFIER SAJA.
 *
 * Tidak ada issuer di build ini: primitif PQ blind-signature yang layak
 * (BRaccoon/blind UOV) belum ada implementasi yang diaudit, dan aturan repo
 * melarang menulis lattice/UOV sendiri. Yang dikunci sekarang adalah hal-hal
 * yang mahal diperbaiki setelah klien terlanjur memakai wire format:
 *
 *   - **body biner**, bukan header (signature PQ 3–5 KB tidak muat di header);
 *   - **binding lengkap**: groupId + epoch + keyVersion + suite + expiry;
 *   - **suite allowlist** (default kosong = tolak semua, fail-closed);
 *   - tidak ada fallback RSA/kripto klasik apa pun.
 *
 * Wire format (big-endian):
 *   magic "NYXC" (4)
 *   suite       u8
 *   keyVersion  u16
 *   epoch       u64
 *   groupIdLen  u8
 *   groupId     groupIdLen byte (ASCII)
 *   expiresAt   u64  (unix seconds)
 *   sigLen      u16
 *   sig         sigLen byte
 */

export const CREDENTIAL_MAGIC = 'NYXC'
export const CREDENTIAL_MAX_BYTES = 8 * 1024
const HEADER_FIXED = 4 + 1 + 2 + 8 + 1 + 8 + 2

export interface CredentialPresentation {
  suite: number
  keyVersion: number
  epoch: number
  groupId: string
  expiresAt: number
  signature: Uint8Array
}

export type CredentialRejectReason =
  | 'body_too_large'
  | 'bad_magic'
  | 'truncated'
  | 'bad_lengths'
  | 'bad_group_id'
  | 'expired'
  | 'epoch_mismatch'
  | 'group_mismatch'
  | 'suite_not_allowed'
  | 'no_verifier'

export type CredentialVerification =
  | { ok: true; presentation: CredentialPresentation }
  | { ok: false; reason: CredentialRejectReason }

/**
 * Parse body biner. Mengembalikan alasan penolakan yang spesifik (untuk log
 * operator), bukan `null` generik — tetapi TIDAK memuat isi signature.
 */
export function parseCredentialPresentation (
  body: Uint8Array
): { ok: true; presentation: CredentialPresentation } | { ok: false; reason: CredentialRejectReason } {
  if (body.length > CREDENTIAL_MAX_BYTES) return { ok: false, reason: 'body_too_large' }
  if (body.length < HEADER_FIXED) return { ok: false, reason: 'truncated' }
  for (let i = 0; i < 4; i += 1) {
    if (body[i] !== CREDENTIAL_MAGIC.charCodeAt(i)) return { ok: false, reason: 'bad_magic' }
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  let offset = 4

  const suite = view.getUint8(offset); offset += 1
  const keyVersion = view.getUint16(offset); offset += 2
  const epochBig = view.getBigUint64(offset); offset += 8
  const groupIdLen = view.getUint8(offset); offset += 1

  if (groupIdLen === 0 || offset + groupIdLen + 8 + 2 > body.length) {
    return { ok: false, reason: 'bad_lengths' }
  }
  const groupIdBytes = body.subarray(offset, offset + groupIdLen)
  offset += groupIdLen
  // groupId adalah id percakapan (ASCII) — nilai non-ASCII pasti bukan id sah.
  const groupId = Buffer.from(groupIdBytes).toString('latin1')
  if (!/^[\x20-\x7e]+$/.test(groupId)) return { ok: false, reason: 'bad_group_id' }

  const expiresBig = view.getBigUint64(offset); offset += 8
  const sigLen = view.getUint16(offset); offset += 2

  if (sigLen === 0 || offset + sigLen !== body.length) {
    return { ok: false, reason: 'bad_lengths' }
  }

  return {
    ok: true,
    presentation: {
      suite,
      keyVersion,
      epoch: Number(epochBig),
      groupId,
      expiresAt: Number(expiresBig),
      signature: body.subarray(offset, offset + sigLen),
    },
  }
}

/**
 * Verifier yang bisa dipasang operator. Default TIDAK ADA: tanpa modul
 * verifikasi, setiap presentasi ditolak (`no_verifier`), bukan diterima.
 */
export interface CredentialVerifier {
  suite: number
  verify (presentation: CredentialPresentation, expected: { groupId: string; epoch: number }): Promise<boolean>
}

const verifiers = new Map<number, CredentialVerifier>()

export function registerCredentialVerifier (verifier: CredentialVerifier): void {
  verifiers.set(verifier.suite, verifier)
}

export function clearCredentialVerifiersForTests (): void {
  verifiers.clear()
}

/**
 * Validasi binding + allowlist + verifier. Urutan sengaja: allowlist diperiksa
 * sebelum verifier supaya suite yang tidak diizinkan tidak pernah menyentuh
 * kripto pihak ketiga, dan tidak ada jalur "default true".
 */
export async function verifyCredentialPresentation (
  body: Uint8Array,
  expected: { groupId: string; epoch: number; now?: Date; allowlist?: readonly number[] }
): Promise<CredentialVerification> {
  const parsed = parseCredentialPresentation(body)
  if (!parsed.ok) return parsed

  const now = expected.now ?? new Date()
  const presentation = parsed.presentation

  if (presentation.groupId !== expected.groupId) return { ok: false, reason: 'group_mismatch' }
  if (presentation.epoch !== expected.epoch) return { ok: false, reason: 'epoch_mismatch' }
  if (presentation.expiresAt * 1000 <= now.getTime()) return { ok: false, reason: 'expired' }

  const allowlist = expected.allowlist ?? []
  if (!allowlist.includes(presentation.suite)) return { ok: false, reason: 'suite_not_allowed' }

  const verifier = verifiers.get(presentation.suite)
  if (!verifier) return { ok: false, reason: 'no_verifier' }

  const valid = await verifier.verify(presentation, { groupId: expected.groupId, epoch: expected.epoch })
  return valid ? { ok: true, presentation } : { ok: false, reason: 'no_verifier' }
}

/** CSV `CREDENTIAL_SUITE_ALLOWLIST` → array suite (default kosong = tolak semua). */
export function parseSuiteAllowlist (raw: string | undefined): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{1,3}$/.test(part))
    .map((part) => Number(part))
    .filter((suite) => suite > 0 && suite <= 255)
}
