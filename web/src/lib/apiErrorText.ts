// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Menerjemahkan error REST menjadi kalimat yang bisa ditindaklanjuti.
 *
 * Masalah yang ditutup: server menjawab 4xx dengan **kode mesin**
 * (`RATE_LIMITED`, `TOKEN_STALE`, `MEMBERS_REMAIN: group still has active
 * members`, …). Dulu `handleApiError` mengembalikan `e.message` apa adanya dan
 * komponen lain memakai `error.message` langsung, sehingga toast pengguna bisa
 * berisi `SANDBOX_LIMIT_REACHED: …`, `TOKEN_UNKNOWN`, atau teks Inggris hardcoded
 * yang tidak bisa diterjemahkan — dan tidak satu pun memberi tahu apa yang harus
 * dilakukan.
 *
 * Modul ini murni (tanpa i18n global, tanpa store) supaya bisa diuji tanpa DOM:
 * ia hanya mengurai error menjadi `{ status, code, prose }`, lalu memilih kunci
 * terjemahan. Pemanggil yang butuh teks menerjemahkan lewat `t`; yang tidak
 * (log, store tanpa React) memakai fallback Inggris dari tabel yang sama.
 *
 * Urutan prioritas teks:
 *   1. kode mesin yang dikenal → kalimat spesifik (bisa diterjemahkan);
 *   2. pesan manusia dari server (kalimat, bukan kode);
 *   3. fallback berdasarkan status HTTP;
 *   4. `api_unknown`.
 * Kode mesin **tidak pernah** menjadi teks yang ditampilkan.
 */

export type Translator = (key: string, options?: Record<string, unknown>) => string;

/**
 * Bungkus `t` dari `useTranslation`/i18n agar kunci `api_*` selalu dibaca dari
 * namespace `errors`. Komponen memakai namespace berbeda-beda (`auth`, `modals`,
 * `settings`, `common`), jadi tanpa prefix hasilnya `api_rate_limited` mentah.
 */
export function apiErrorTranslator(t: Translator): Translator {
  return (key, options) => t(`errors:${key}`, options);
}

export interface ApiErrorHint {
  /** Status HTTP; 0 = jaringan/timeout/error lokal. */
  status: number;
  /** Kode mesin (`SANDBOX_LIMIT_REACHED`, `TOKEN_STALE`, …) atau null. */
  code: string | null;
  /** Kalimat dari server (tanpa prefix kode) atau null. */
  prose: string | null;
}

/** Kode mesin: huruf besar/angka/underscore, minimal 3 karakter. */
const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** `ACCESS DENIED: …` memakai spasi, tetapi tetap kode kontrak. */
const ACCESS_DENIED = 'ACCESS DENIED';

/** Kode mesin → kunci terjemahan. */
export const API_ERROR_CODE_KEYS: Readonly<Record<string, string>> = {
  // Anti-abuse. Semua bentuk "terlalu sering" berbagi satu kalimat.
  RATE_LIMITED: 'api_rate_limited',
  SEARCH_RATE_LIMITED: 'api_rate_limited',
  STORY_VIEW_RATE_LIMIT: 'api_rate_limited',
  CONTACT_BUNDLE_RATE_LIMIT: 'api_rate_limited',

  // Keanggotaan grup berbasis token (`docs/16`, `docs/37` §37.3).
  TOKEN_UNKNOWN: 'api_group_access_expired',
  TOKEN_STALE: 'api_group_access_expired',
  GROUP_AUTH_REQUIRED: 'api_group_access_expired',

  // Otorisasi grup: capability hilang/berputar.
  ADMIN_AUTH_REQUIRED: 'api_admin_required',
  BLIND_AUTH_REQUIRED: 'api_blind_auth_required',
  MEMBERS_REMAIN: 'api_members_remain',

  // Akun belum terverifikasi (batas sandbox).
  SANDBOX_LIMIT: 'api_unverified_limited',
  SANDBOX_LIMIT_REACHED: 'api_unverified_limited',
  SANDBOX_UPLOAD_RESTRICTION: 'api_unverified_limited',

  STORY_BLOCKED: 'api_story_blocked',
  PP_PROOF_REQUIRED: 'api_privacy_proof',
  PP_TOKEN_REJECTED: 'api_privacy_proof',
  ACCESS_DENIED: 'api_account_suspended',
};

/** Fallback per status untuk error yang tidak punya kode dikenal. */
export const API_ERROR_STATUS_KEYS: Readonly<Record<number, string>> = {
  400: 'api_bad_request',
  401: 'api_session_expired',
  403: 'api_forbidden',
  404: 'api_not_found',
  409: 'api_conflict',
  410: 'api_gone',
  413: 'api_too_large',
  422: 'api_bad_request',
  429: 'api_rate_limited',
};

/** Teks Inggris untuk konteks tanpa `t` (log, store non-React, fallback). */
export const API_ERROR_FALLBACKS: Readonly<Record<string, string>> = {
  api_rate_limited: 'Too many attempts. Wait a moment and try again.',
  api_group_access_expired: 'Your access to this group has expired. Rejoin from a new invite, or ask an admin to add you again.',
  api_admin_required: 'Only a group admin can do this. Your admin capability may have been rotated — reopen the group and try again.',
  api_blind_auth_required: "This action needs the secret issued when it was created, and this device doesn't have it.",
  api_members_remain: 'Other members still have access. Remove them before deleting the group.',
  api_unverified_limited: 'Unverified accounts are limited. Verify your account to unlock this.',
  api_story_blocked: "You can't interact with this story.",
  api_privacy_proof: 'The privacy proof was rejected. Try again in a moment.',
  api_account_suspended: 'Your account has been suspended. Contact support if you think this is a mistake.',
  api_session_expired: 'Your session has expired. Please sign in again.',
  api_bad_request: 'The request was rejected as invalid. Reload and try again.',
  api_forbidden: "You don't have permission to do that.",
  api_not_found: 'That item no longer exists.',
  api_conflict: "This can't be done in the current state. Reload and try again.",
  api_gone: 'This item has expired or was removed.',
  api_too_large: 'That file is too large. Try a smaller one.',
  api_unknown: 'Something went wrong. Please try again.',
};

/** Kode yang berarti "akun belum terverifikasi" (dipakai untuk banner CTA). */
const SANDBOX_CODES = ['SANDBOX_LIMIT', 'SANDBOX_LIMIT_REACHED', 'SANDBOX_UPLOAD_RESTRICTION'];

/**
 * Pisahkan error menjadi status + kode + kalimat server.
 *
 * Menerima `ApiError` (status + `details`), error jaringan biasa (`message`),
 * maupun string mentah dari payload realtime (`res.error`), karena kedua jalur
 * menyampaikan kode yang sama ke UI.
 */
export function apiErrorHint(error: unknown): ApiErrorHint {
  const hint: ApiErrorHint = { status: 0, code: null, prose: null };
  if (error === null || error === undefined) return hint;

  if (typeof error === 'string') {
    return applyMachineString(hint, error);
  }

  if (typeof error !== 'object') return hint;

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isFinite(status)) hint.status = status;

  const details = (error as { details?: unknown }).details;
  if (typeof details === 'object' && details !== null) {
    const body = details as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') applyMachineString(hint, body.error);
    if (typeof body.message === 'string' && body.message.trim()) hint.prose = body.message.trim();
  }

  // Error lokal (`Error('…')`) atau jalur yang hanya membawa `message`.
  if (!hint.code && !hint.prose) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) applyMachineString(hint, message);
  }

  return hint;
}

/**
 * Isi `hint` dari string yang mungkin berbentuk `KODE`, `KODE: kalimat`, atau
 * kalimat biasa. Kode yang dikenali tetap disimpan walau ada kalimatnya, karena
 * kalimat server berbahasa Inggris/hardcoded dan tidak bisa diterjemahkan.
 */
function applyMachineString(hint: ApiErrorHint, raw: string): ApiErrorHint {
  const text = raw.trim();
  if (!text) return hint;

  const separator = text.indexOf(':');
  const head = (separator >= 0 ? text.slice(0, separator) : text).trim();
  const tail = separator >= 0 ? text.slice(separator + 1).trim() : '';

  if (head === ACCESS_DENIED) {
    hint.code = 'ACCESS_DENIED';
    if (tail) hint.prose = tail;
    return hint;
  }

  if (CODE_RE.test(head)) {
    hint.code = head;
    if (tail) hint.prose = tail;
    return hint;
  }

  // Kode asing tanpa prefix (`SOMETHING_ELSE`) disimpan sebagai KODE, bukan
  // kalimat: dengan begitu `apiErrorKey` jatuh ke fallback status dan kode
  // mentahnya tidak pernah muncul di layar.
  if (CODE_RE.test(text)) {
    hint.code = text;
    return hint;
  }
  hint.prose = text;
  return hint;
}

/**
 * Kunci terjemahan untuk error ini, atau `null` bila server sudah memberi
 * kalimat yang layak ditampilkan apa adanya.
 */
export function apiErrorKey(error: unknown): string | null {
  const hint = apiErrorHint(error);
  const fromCode = hint.code ? API_ERROR_CODE_KEYS[hint.code] : undefined;
  if (fromCode) return fromCode;

  // Kalimat server lebih spesifik daripada fallback status (mis. "Story has
  // expired" pada 410). Kode asing tidak punya kalimat, jadi jatuh ke status.
  if (hint.prose) return null;

  return API_ERROR_STATUS_KEYS[hint.status] ?? 'api_unknown';
}

/**
 * Teks final untuk ditampilkan. `t` opsional: tanpa itu dipakai fallback Inggris
 * (log, store tanpa React). Kalimat server dipakai apa adanya bila ada dan tidak
 * ada kode yang dipetakan — itu pilihan sadar: server sudah menjelaskan
 * kekhususan yang tidak bisa ditebak klien.
 */
export function formatApiError(error: unknown, t?: Translator): string {
  const hint = apiErrorHint(error);
  const key = apiErrorKey(error);

  if (!key) return hint.prose ?? API_ERROR_FALLBACKS.api_unknown ?? 'Something went wrong. Please try again.';

  const fallback = API_ERROR_FALLBACKS[key] ?? API_ERROR_FALLBACKS.api_unknown ?? 'Something went wrong. Please try again.';
  return t ? t(key, { defaultValue: fallback }) : fallback;
}

/**
 * Detail dari server bila ada; kalau tidak, kalimat konteks pemanggil.
 * Dipakai jalur yang punya pesan sendiri ("Gagal memulai chat", …) — tanpa ini
 * pesan konteksnya hilang dan pengguna hanya melihat "Something went wrong".
 */
export function formatApiErrorOr(error: unknown, t: Translator, fallback: string): string {
  return hasApiErrorDetail(error) ? formatApiError(error, t) : fallback;
}

/**
 * Format untuk `catch` campuran: error server **dan** error lokal (crypto,
 * penyimpanan, validasi) masuk ke blok yang sama. Error server diformat (kode
 * mesin tidak pernah tampil); error lokal tetap memakai pesannya sendiri supaya
 * kegagalan di perangkat masih bisa didiagnosis ("EPOCH_ROTATION_timeout").
 */
export function formatApiOrLocalError(error: unknown, t?: Translator, fallback?: string): string {
  const hint = apiErrorHint(error);
  const isServerError = hint.status >= 400 || (hint.code !== null && API_ERROR_CODE_KEYS[hint.code] !== undefined);
  if (isServerError) return formatApiError(error, t);
  return hint.prose ?? fallback ?? API_ERROR_FALLBACKS.api_unknown ?? 'Something went wrong. Please try again.';
}

/** Teks untuk kode mesin mentah (payload realtime `res.error`). */
export function formatApiErrorCode(code: string | null | undefined, t?: Translator): string | null {
  if (!code) return null;
  return formatApiError({ status: 0, details: { error: code } }, t);
}

/**
 * Apakah server memberi detail yang lebih spesifik daripada fallback konteks?
 * Dipakai pemanggil yang punya kunci sendiri (mis. `failed_to_delete_group`):
 * kode/kalimat server menang bila ada; kalau tidak, kalimat konteks yang dipakai
 * supaya pesan tidak menjadi "Something went wrong" yang tidak berguna.
 */
export function hasApiErrorDetail(error: unknown): boolean {
  const hint = apiErrorHint(error);
  if (hint.code && API_ERROR_CODE_KEYS[hint.code]) return true;
  // Kalimat dari server (status 4xx) lebih informatif daripada kalimat konteks;
  // pesan error lokal (`Failed to fetch`, status 0) TIDAK dihitung, supaya
  // pemanggil memakai pesan konteksnya yang sudah diterjemahkan.
  return hint.status >= 400 && typeof hint.prose === 'string' && hint.prose.length > 0;
}

/** Apakah error ini berarti "akun belum terverifikasi" (batas sandbox). */
export function isSandboxLimit(error: unknown): boolean {
  const hint = apiErrorHint(error);
  if (hint.code && SANDBOX_CODES.includes(hint.code)) return true;
  // Jalur realtime mengirim string mentah; tetap kenali walau bentuknya `KODE: …`.
  const text = typeof error === 'string' ? error : hint.prose ?? '';
  return SANDBOX_CODES.some((code) => text.includes(code));
}
