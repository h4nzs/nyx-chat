// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Satu-satunya bentuk wire ratchet: braid SPQR v2.
 *
 * Header DR v1 (`{kemPk, ct, n, pn}`) tidak dibaca maupun ditulis lagi. v2
 * tidak punya keduanya (braid mengirim frame 37 byte dan tidak butuh `ct`),
 * dan bentuknya eksplisit:
 *
 *   v2: `{ v: 2, b: [frame…] }`.
 *
 * v2 **tidak** membawa penghitung (`n`/`pn`): urutan & pesan hilang ditangani
 * braid itu sendiri (skipped key hidup di state SPQR, bukan di peta klien), dan
 * menghitung ulang `n` di klien hanya menambah state yang bisa desinkron.
 *
 * `b` adalah **daftar** frame, bukan satu frame: satu langkah ratchet SPQR bisa
 * menghasilkan beberapa frame tanpa message key (pertukaran braid/chunk) sebelum
 * frame yang membawa key — pengirim mengumpulkannya dalam satu pesan agar
 * "satu pesan pengguna = satu frame wire" tetap berlaku (`docs/04`).
 *
 * Semua parser di sini fail-closed: masukan tak dikenal → `null`, bukan objek
 * setengah terbentuk. Header datang dari jaringan.
 */

/** Penanda versi di header DR untuk jalur braid SPQR. */
export const SPQR_RATCHET_WIRE_VERSION = 2;

/**
 * Batas jumlah frame braid per pesan. Satu langkah normal = 1 frame; rantai
 * pertukaran (header → ek → ct1 → ack) bisa beberapa. 16 memberi ruang jauh
 * lebih dari cukup sekaligus menahan header yang sengaja dibengkakkan.
 */
export const SPQR_MAX_FRAMES_PER_MESSAGE = 16;

/**
 * Batas panjang satu frame (karakter base64url). Frame mapan 37 byte (~50
 * karakter b64); chunk braid bisa lebih besar. 4096 karakter ≈ 3 KiB mentah —
 * cukup untuk chunk, tapi bukan "kirim 1 MB lewat header".
 */
export const SPQR_MAX_FRAME_B64_CHARS = 4096;

export interface SpqrDrHeader {
  /** Selalu 2 — header v1 tidak punya bidang ini. */
  v: typeof SPQR_RATCHET_WIRE_VERSION;
  /** Frame braid berurutan (base64url, non-kosong, minimal satu). */
  b: string[];
}

const B64_RE = /^[A-Za-z0-9_-]+$/;

/** Apakah header mentah menandai dirinya jalur v2? */
export function isSpqrHeader(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === SPQR_RATCHET_WIRE_VERSION;
}

/**
 * Parse + validasi header v2. `null` = bukan header v2 yang sah — pemanggil
 * **tidak boleh** menebak versi lain darinya.
 */
export function parseSpqrHeader(raw: unknown): SpqrDrHeader | null {
  if (!isSpqrHeader(raw)) return null;
  const value = raw as { b?: unknown };
  if (!Array.isArray(value.b)) return null;
  if (value.b.length === 0 || value.b.length > SPQR_MAX_FRAMES_PER_MESSAGE) return null;
  const framesValid = value.b.every((frame): frame is string =>
    typeof frame === 'string' && frame.length > 0 && frame.length <= SPQR_MAX_FRAME_B64_CHARS && B64_RE.test(frame)
  );
  if (!framesValid) return null;
  return { v: SPQR_RATCHET_WIRE_VERSION, b: value.b as string[] };
}

/**
 * Bangun header v2 dari frame braid. Melempar bila frame tidak sah — pengirim
 * yang menghasilkan header rusak lebih baik gagal terlihat daripada menulis
 * pesan yang tidak bisa dibuka peer.
 */
export function buildSpqrHeader(input: { frames: Uint8Array[] }): SpqrDrHeader {
  if (input.frames.length === 0) throw new Error('spqr-wire: tidak ada frame braid');
  if (input.frames.length > SPQR_MAX_FRAMES_PER_MESSAGE) {
    throw new Error(`spqr-wire: terlalu banyak frame (${input.frames.length})`);
  }
  const b = input.frames.map((frame) => {
    if (frame.length === 0) throw new Error('spqr-wire: frame kosong');
    const encoded = base64UrlFromBytes(frame);
    if (encoded.length > SPQR_MAX_FRAME_B64_CHARS) {
      throw new Error(`spqr-wire: frame terlalu besar (${encoded.length} karakter)`);
    }
    return encoded;
  });
  return { v: SPQR_RATCHET_WIRE_VERSION, b };
}

/** Dekode frame dari header yang sudah divalidasi `parseSpqrHeader`. */
export function decodeSpqrFrames(header: SpqrDrHeader): Uint8Array[] {
  return header.b.map((frame) => bytesFromBase64Url(frame));
}

// ---------------------------------------------------------------------------
// Kodek (tanpa Buffer — modul ini ikut bundel browser & worker)
// ---------------------------------------------------------------------------

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}
