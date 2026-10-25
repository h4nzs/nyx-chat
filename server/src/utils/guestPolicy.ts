// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Batas untuk identitas GUEST (Burner Chat `/drop`).
 *
 * Identitas guest dibuat tanpa syarat oleh `POST /api/auth/burner`, dan setiap
 * guest baru mendapat bucket rate limit sendiri. Akibatnya limit per-user
 * (chat 120/menit) tidak membatasi siapa pun: satu IP bisa membuat ratusan guest
 * lalu memakai masing-masing untuk membanjiri `targetRecipients` (≤500 userId
 * sembarang, tiap penerima dapat push).
 *
 * Aturan di sini sengaja berlaku pada DATA, bukan pada form login, supaya klien
 * lama tidak perlu diubah:
 *   - guest hanya boleh mengirim ke sedikit penerima (burner = 1 lawan bicara);
 *   - guest punya jatah chat lebih kecil (manusia tetap bisa mengetik);
 *   - event burner (join/send/reply) punya batas yang sama ketatnya.
 *
 * Bukan pengganti limiter pembuatan guest (`burnerLimiter` di
 * `middleware/rateLimiter.ts`) — keduanya menutup dua sisi yang berbeda.
 */
import { isEphemeralGuestSubject } from './sessionUtils.js'

/** Batas penerima untuk akun normal — sama dengan schema `MessageSendPayloadSchema`. */
export const MAX_RECIPIENTS = 500;

/** Burner adalah percakapan guest↔host; guest tidak butuh fan-out lebih dari ini. */
export const GUEST_MAX_RECIPIENTS = 2;

/** Jatah kirim chat untuk guest (per menit). */
export const GUEST_CHAT_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

/** Jatah event burner (join/send/reply) per menit — klien burner mengirim 1 frame per aksi. */
export const BURNER_EVENT_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/** Berapa penerima yang boleh disebut oleh pengirim ini dalam satu pesan. */
export function maxRecipientsFor (userId: string): number {
  return isEphemeralGuestSubject(userId) ? GUEST_MAX_RECIPIENTS : MAX_RECIPIENTS;
}
