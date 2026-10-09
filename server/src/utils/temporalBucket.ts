// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B4] Bucket waktu untuk metadata temporal.
 *
 * `Device.lastActiveAt` dan `User.lastActiveDay` tidak butuh presisi detik.
 * Dengan menyimpan nilai yang dipotong ke bucket, dump DB tidak lagi memberi
 * pola aktivitas perangkat/user yang presisi (traffic analysis D11) — hanya
 * "kira-kira kapan". Nilai diturunkan secara deterministik (floor) agar tetap
 * stabil & bisa dibandingkan.
 */

/** Bucket aktivitas perangkat: 15 menit. */
export const DEVICE_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;

/** Bucket aktivitas user: 1 hari (UTC). */
export const DAY_BUCKET_MS = 24 * 60 * 60 * 1000;

export function truncateToBucket(date: Date, bucketMs: number): Date {
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

/** Nilai `Device.lastActiveAt` yang boleh disimpan (dipotong ke 15 menit). */
export function deviceActivityBucket(now: Date = new Date()): Date {
  return truncateToBucket(now, DEVICE_ACTIVITY_BUCKET_MS);
}

/** Nilai `User.lastActiveDay` yang boleh disimpan (dipotong ke hari). */
export function dayBucket(now: Date = new Date()): Date {
  return truncateToBucket(now, DAY_BUCKET_MS);
}

/**
 * [docs/28 Tier 2 — B3] Bucket waktu pesan (15 menit) untuk `Message.createdAt`
 * dan `Message.expiresAt` server.
 *
 * Urutan pesan TIDAK lagi memakai createdAt (lihat B1 — `seq`), dan tampilan
 * presisi memakai `sentAt` dari ciphertext (B2), jadi createdAt server boleh
 * dikasar. PENTING: `expiresAt` harus diturunkan dari waktu kasar yang SAMA —
 * kalau tidak, `expiresAt − TTL` membocorkan createdAt presisi. Toleransi TTL
 * sweeper ≤ 1 bucket (15 menit).
 */
export const MESSAGE_TIME_BUCKET_MS = 15 * 60 * 1000;

export function messageTimeBucket(now: Date = new Date()): Date {
  return truncateToBucket(now, MESSAGE_TIME_BUCKET_MS);
}
