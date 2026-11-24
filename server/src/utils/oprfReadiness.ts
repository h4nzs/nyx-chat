// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.15.4 langkah 2] Kesiapan `oprfIndex` sebelum PIR dinyalakan.
 *
 * Kenapa tidak ada backfill server-side: `User.usernameHash` disimpan sebagai
 * HMAC ber-pepper (`pepperedIdentifier`) dan identifier Argon2 mentah tidak
 * pernah dipersist. `oprfIndex` hanya bisa dihitung pada register/login — satu-
 * satunya saat server menerima identifier mentah. Akun lama karena itu terisi
 * lazily saat login berikutnya, bukan oleh skrip.
 *
 * Fungsi ini murni (tanpa DB) supaya bisa diuji: skrip `oprf:readiness` hanya
 * menghitung agregat, lalu memakai verdict ini untuk exit code. Tidak ada
 * identitas pengguna yang dicetak.
 */

export interface OprfReadinessCounts {
  /** Jumlah seluruh baris `User`. */
  total: number;
  /** Baris dengan `oprfIndex` tidak NULL. */
  indexed: number;
  /** Baris ber-`oprfIndex` yang bukan 32 byte hex huruf kecil. */
  malformed: number;
}

export interface OprfReadinessOptions {
  /** `--require-ready`: exit 1 bila belum siap. */
  requireReady: boolean;
  /** `PIR_OPRF_ENABLED` saat ini; tanpa ini login tidak mengisi index. */
  oprfEnabled: boolean;
}

export interface OprfReadinessVerdict {
  ready: boolean;
  usable: number;
  missing: number;
  code: number;
  lines: string[];
}

function safeCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function oprfReadinessVerdict(
  counts: OprfReadinessCounts,
  options: OprfReadinessOptions
): OprfReadinessVerdict {
  const total = safeCount(counts.total);
  const indexed = Math.min(safeCount(counts.indexed), total);
  const malformed = Math.min(safeCount(counts.malformed), indexed);
  const usable = indexed - malformed;
  const missing = total - indexed;

  const lines = [
    `OPRF readiness: total=${total} usable=${usable} missing=${missing} malformed=${malformed}`,
  ];

  if (!options.oprfEnabled) {
    lines.push(
      'PIR_OPRF_ENABLED belum 1: login tidak akan mengisi oprfIndex. Nyalakan gate server (dan klien) sebelum PIR.'
    );
  }
  if (total === 0) {
    lines.push('Belum ada user: snapshot PIR menolak indeks kosong.');
  } else if (missing > 0) {
    lines.push(
      `${missing} akun tanpa oprfIndex akan terisi saat login berikutnya; tidak ada backfill server-side karena identifier mentah tidak disimpan.`
    );
  }
  if (malformed > 0) {
    lines.push(
      `${malformed} baris ber-oprfIndex bukan 32 byte hex huruf kecil — periksa seed/keyring sebelum PIR.`
    );
  }

  const ready = options.oprfEnabled && total > 0 && missing === 0 && malformed === 0;
  if (ready) {
    lines.push(
      'Semua akun punya oprfIndex valid; aman menyalakan PIR setelah dua sidecar + OHTTP diuji.'
    );
  }

  return {
    ready,
    usable,
    missing: missing + malformed,
    code: options.requireReady && !ready ? 1 : 0,
    lines,
  };
}
