// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Klasifikasi replay refresh token (rotasi) — dipisah dari route supaya bisa
 * diuji sebagai **perilaku** tanpa Postgres/Redis.
 *
 * Latar belakang bug (2026-10-18): logout sendiri saat idle + `/login?reason=revoked`
 * di perangkat yang sama. Penyebabnya bukan serangan, melainkan tiga kejadian
 * klien yang normal tetapi ditafsirkan sebagai pencurian token:
 *
 *   1. **Respons rotasi hilang / timeout.** Klien mem-POST `rt` = R1; server
 *      merotasi ke R2 lalu respons hilang (tab di-freeze, jaringan pindah,
 *      timeout 30 s). Klien mencoba ulang dengan R1. Dulu toleransi hanya
 *      `now - R2.createdAt < 5 s`, sementara timeout request 30 s + retry —
 *      retry yang wajar pun melewati jendela itu → family di-revoke.
 *   2. **Family sudah mati.** Logout di tab lain (atau revokasi sesi) sudah
 *      mencabut seluruh family; tab yang tertinggal mem-POST token lama. Dulu
 *      ini tetap dianggap "reuse attack" dan memicu `force_logout` untuk
 *      **semua** device, padahal tidak ada sesi hidup yang perlu dilindungi.
 *   3. **Device lain ikut ter-logout.** Event `force_logout` tidak pernah
 *      di-scope ke device asal replay.
 *
 * Keputusan yang dikembalikan:
 *   - `session_ended` → tidak ada token hidup di family. Ini sesi yang SUDAH
 *     berakhir (logout/revoke/cleanup): balas 401 biasa, jangan broadcast
 *     `force_logout`, jangan alarm "hijacked".
 *   - `benign` → token yang dipresentasikan adalah **pendahulu langsung** dari
 *     token hidup terbaru (tip) dan tip dibuat dalam jendela toleransi.
 *     Konsisten dengan "respons rotasi hilang, klien mengulang" → lanjutkan
 *     dari tip, tanpa mencabut apa pun.
 *   - `reuse` → tip hidup tetapi bukan penerus langsung token ini (atau sudah
 *     di luar jendela toleransi) → perlakukan sebagai replay token lama:
 *     revoke family + beri tahu HANYA device terkait.
 *
 * Catatan keamanan: jendela toleransi memperlebar kemungkinan replay token
 * lama yang masih menyisakan tip hidup, jadi nilainya dibatasi (default 2
 * menit, maksimum 24 jam) dan hanya berlaku untuk penerus langsung. Setelah
 * klien yang sah memakai tip (tip berotasi), token lama tidak lagi cocok →
 * tetap terdeteksi.
 */

import { ApiError } from './errors.js';

export const DEFAULT_REFRESH_REPLAY_GRACE_MS = 120_000;
export const MAX_REFRESH_REPLAY_GRACE_MS = 24 * 60 * 60 * 1000;

export type RefreshReplayDecision = 'benign' | 'reuse' | 'session_ended';

export interface LiveRefreshTip {
  /** `RefreshToken.id` baris tip (token hidup terbaru di family). */
  id: string;
  /** `RefreshToken.replacedById` — token pendahulu yang digantikan tip ini. */
  replacesId: string | null;
  createdAt: Date;
}

/**
 * Baca `REFRESH_REPLAY_GRACE_MS` dari env dengan clamp aman. Nilai tidak valid
 * atau negatif → default (jangan pernah membuat window tak terbatas).
 */
export function refreshReplayGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REFRESH_REPLAY_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_REPLAY_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REFRESH_REPLAY_GRACE_MS;
  return Math.min(Math.floor(parsed), MAX_REFRESH_REPLAY_GRACE_MS);
}

export function classifyRefreshReplay(input: {
  /** `RefreshToken.id` token yang dipresentasikan klien. */
  presentedId: string;
  /** Token hidup terbaru di family (revokedAt null, replacedById null), atau null. */
  tip: LiveRefreshTip | null;
  now: number;
  graceMs?: number;
}): RefreshReplayDecision {
  const { presentedId, tip } = input;
  if (!tip) return 'session_ended';

  const graceMs = input.graceMs ?? DEFAULT_REFRESH_REPLAY_GRACE_MS;
  const age = input.now - new Date(tip.createdAt).getTime();
  const withinGrace = Number.isFinite(age) && age >= 0 && age <= graceMs;

  // Hanya penerus LANGSUNG yang boleh dianggap retry benign. Rantai lebih
  // panjang berarti token ini sudah lama ditinggalkan (bukan retry).
  const isImmediateSuccessor = tip.replacesId === presentedId;

  return isImmediateSuccessor && withinGrace ? 'benign' : 'reuse';
}

/** 401 untuk sesi yang memang sudah berakhir (bukan serangan). */
export function sessionEndedError(): ApiError {
  return new ApiError(401, 'Session has ended. Please login again.');
}
