// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Logika murni untuk webhook NOWPayments.
 *
 * Dipisah supaya bisa diuji tanpa Prisma/Redis (konvensi test server), dan
 * supaya dua keputusan yang menentukan uang tinggal di satu tempat:
 *
 *   1. **Kunci idempotensi** — IPN NOWPayments dikirim ulang (retry) dan
 *      tanda tangannya tidak punya timestamp, jadi body+sig yang sama tetap sah
 *      selamanya. Tanpa kunci per pembayaran, satu pembayaran memperpanjang
 *      langganan setiap kali dikirim ulang.
 *   2. **Awal periode baru** — dihitung dari sisa langganan (`max(now, expiry)`),
 *      bukan dari "sekarang". Dulu pembayaran kedua menghapus sisa hari
 *      pembayaran pertama karena expiry ditimpa `now + 30 hari`.
 */

/** Panjang satu periode langganan PRO (hari) — sama dengan yang dijanjikan UI. */
export const SUBSCRIPTION_PERIOD_DAYS = 30;

/**
 * Kunci idempotensi per pembayaran: `payment_id` bila ada (satu invoice bisa
 * punya banyak status, semuanya berbagi `payment_id`), selain itu `order_id`
 * yang sudah divalidasi pemanggil.
 */
export function resolveWebhookPaymentKey (
  payload: Record<string, unknown>,
  fallbackOrderId: string
): string {
  for (const candidate of [payload.payment_id, payload.order_id, fallbackOrderId]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return fallbackOrderId;
}

/**
 * Kapan langganan berakhir setelah pembayaran lunas.
 * `current` yang masih di masa depan diperpanjang; yang sudah lewat (atau null)
 * dimulai dari `now`, sehingga tidak ada hari yang hilang maupun tertinggal.
 */
export function nextSubscriptionExpiry (
  current: Date | null,
  now: Date,
  days: number = SUBSCRIPTION_PERIOD_DAYS
): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}
