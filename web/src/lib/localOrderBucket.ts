// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Bucket waktu orde lokal — modul **daun** (tanpa import apa pun).
 *
 * Dipisah dari `localAtRest`/`localOrderKey` karena `db.ts` juga butuh
 * perhitungan bucket (migrasi indeks Dexie) sementara dua modul itu menarik
 * `keychainDb`, yang justru meng-import `db.ts` → siklus impor.
 *
 * Nilai bucket HARUS sama dengan `MESSAGE_TIME_BUCKET_MS` server
 * (`server/src/utils/temporalBucket.ts`) dan `localAtRest`, supaya granularitas
 * yang tersisa di klien tidak lebih halus dari yang sudah dipublikasikan server
 * (docs/28 Tier 2 — B3/B4).
 */

/** Bucket waktu metadata lokal — 15 menit. */
export const LOCAL_TIME_BUCKET_MS = 15 * 60 * 1000;

/**
 * Waktu → bucket plaintext 15 menit (floor). Menerima number (ms), `Date`, atau
 * string ISO. Nilai tak valid → `null` (baris tetap bisa dibaca lewat lapis
 * presisi ter-seal, tapi tidak akan muncul di indeks bucket).
 */
export function orderBucketOf(value: string | Date | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / LOCAL_TIME_BUCKET_MS) * LOCAL_TIME_BUCKET_MS;
}
