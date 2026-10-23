// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8 residual] Klasifikasi amplop pesan untuk audit v1 residual.
 *
 * Denylist legacy baru bisa menjadi literal 0 kalau sudah tidak ada sesi/pesan
 * v1 yang perlu dibaca. Server tidak bisa mendekripsi isi pesan, tetapi bentuk
 * amplopnya tetap terlihat (JSON wrapper) — cukup untuk menghitung berapa pesan
 * yang masih memakai X3DH v1 (`x3dh.handshakeVersion` 1/absen) atau tanda
 * tangan grup v1 (`sigV` 1/absen). Yang dicetak hanya agregat, bukan sampel.
 *
 * Klasifikasi sengaja konservatif: JSON yang tidak dikenali masuk `other` dan
 * TIDAK dianggap aman — nilainya harus diperiksa manusia sebelum penghapusan.
 */
export type EnvelopeClass =
  | 'direct-v2'
  | 'direct-v1'
  | 'group-v2'
  | 'group-v1'
  | 'other';

interface EnvelopeShape {
  x3dh?: { handshakeVersion?: unknown } | null;
  header?: unknown;
  ciphertext?: unknown;
  signature?: unknown;
  sigV?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `null`/bukan JSON = `other` (mis. metadata sistem yang memang plaintext atau
 * baris rusak). Pesan grup dideteksi dari triple header+ciphertext+signature;
 * pesan 1:1 dari keberadaan `x3dh`.
 */
export function classifyEnvelope(content: string | null | undefined): EnvelopeClass {
  if (typeof content !== 'string' || content.length === 0) return 'other';

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 'other';
  }
  if (!isObject(parsed)) return 'other';

  const envelope = parsed as EnvelopeShape;

  const hasGroupShape =
    isObject(envelope.header) &&
    typeof envelope.ciphertext === 'string' &&
    typeof envelope.signature === 'string';
  if (hasGroupShape) {
    // `sigV` absen pada wrapper v1 lama (lihat pqV2.spec: `parsed.sigV ?? 1`).
    return envelope.sigV === 2 ? 'group-v2' : 'group-v1';
  }

  if (isObject(envelope.x3dh)) {
    return envelope.x3dh.handshakeVersion === 2 ? 'direct-v2' : 'direct-v1';
  }

  return 'other';
}

export interface EnvelopeCounts {
  'direct-v2': number;
  'direct-v1': number;
  'group-v2': number;
  'group-v1': number;
  other: number;
  total: number;
}

export function emptyEnvelopeCounts(): EnvelopeCounts {
  return { 'direct-v2': 0, 'direct-v1': 0, 'group-v2': 0, 'group-v1': 0, other: 0, total: 0 };
}

export function addEnvelope(counts: EnvelopeCounts, envelopeClass: EnvelopeClass): void {
  counts[envelopeClass] += 1;
  counts.total += 1;
}

/** Sinyal yang menahan denylist legacy di atas 0. */
export function legacyEnvelopeCount(counts: EnvelopeCounts): number {
  return counts['direct-v1'] + counts['group-v1'];
}
