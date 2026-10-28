// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [2026-10-27] Pemetaan error 4xx → kalimat yang bisa ditindaklanjuti.
 *
 * Kontrak yang dijaga:
 *   1. Kode mesin (`RATE_LIMITED`, `TOKEN_STALE`, `MEMBERS_REMAIN: …`) TIDAK
 *      PERNAH menjadi teks yang ditampilkan — dulu toast bisa berisi kode itu
 *      karena `handleApiError` mengembalikan `e.message` apa adanya.
 *   2. Kode yang dikenal dipetakan ke kunci terjemahan (bukan teks Inggris
 *      hardcoded), sehingga komponen bisa menerjemahkannya.
 *   3. Kalau server memberi kalimat manusia, kalimat itu dipakai — server tahu
 *      kekhususan yang tidak bisa ditebak klien (mis. "Story has expired").
 *   4. Setiap kunci yang dipakai ada di keempat bahasa.
 */

import { describe, it, expect } from 'vitest';

import { ApiError } from '../api';
import {
  API_ERROR_CODE_KEYS,
  API_ERROR_FALLBACKS,
  API_ERROR_STATUS_KEYS,
  apiErrorHint,
  apiErrorKey,
  apiErrorTranslator,
  formatApiError,
  formatApiErrorCode,
  formatApiErrorOr,
  formatApiOrLocalError,
  hasApiErrorDetail,
  isSandboxLimit,
} from '../apiErrorText';
import enErrors from '../../../public/locales/en/errors.json';
import esErrors from '../../../public/locales/es/errors.json';
import idErrors from '../../../public/locales/id/errors.json';
import ptBrErrors from '../../../public/locales/pt-BR/errors.json';

/** `t` palsu yang mencatat kunci yang diminta. */
function fakeT(): { t: (key: string, options?: Record<string, unknown>) => string; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    t: (key, options) => {
      keys.push(key);
      return `t:${key}:${String(options?.defaultValue ?? '')}`;
    },
  };
}

describe('apiErrorHint: memisahkan status, kode mesin, dan kalimat server', () => {
  it('kode + kalimat dengan prefix ":" dipisahkan', () => {
    const hint = apiErrorHint(
      new ApiError(403, 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token', {
        error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
      })
    );
    expect(hint.status).toBe(403);
    expect(hint.code).toBe('ADMIN_AUTH_REQUIRED');
    expect(hint.prose).toBe('Invalid or missing X-Admin-Token');
  });

  it('`ACCESS DENIED: …` (spasi) tetap dikenali sebagai kode kontrak', () => {
    const hint = apiErrorHint(
      new ApiError(403, 'ACCESS DENIED: Your account has been suspended.', {
        error: 'ACCESS DENIED: Your account has been suspended.',
        reason: 'spam',
      })
    );
    expect(hint.code).toBe('ACCESS_DENIED');
    expect(hint.prose).toBe('Your account has been suspended.');
  });

  it('string mentah dari payload realtime diperlakukan sama', () => {
    const hint = apiErrorHint('SANDBOX_LIMIT_REACHED: sandbox limit reached');
    expect(hint.code).toBe('SANDBOX_LIMIT_REACHED');
    expect(hint.prose).toBe('sandbox limit reached');
  });

  it('error jaringan lokal tidak dianggap berkode', () => {
    const hint = apiErrorHint(new Error('Failed to fetch'));
    expect(hint).toMatchObject({ status: 0, code: null, prose: 'Failed to fetch' });
  });

  it('nilai kosong aman', () => {
    expect(apiErrorHint(null)).toEqual({ status: 0, code: null, prose: null });
    expect(apiErrorHint(undefined)).toEqual({ status: 0, code: null, prose: null });
    expect(apiErrorHint(42)).toEqual({ status: 0, code: null, prose: null });
  });
});

describe('pemilihan kunci: kode dikenal → kunci, kode asing → status', () => {
  it('kode yang dipetakan memakai kuncinya', () => {
    expect(apiErrorKey(new ApiError(429, 'RATE_LIMITED', { error: 'RATE_LIMITED' }))).toBe('api_rate_limited');
    expect(apiErrorKey({ status: 410, details: { error: 'TOKEN_STALE' } })).toBe('api_group_access_expired');
    expect(apiErrorKey({ status: 409, details: { error: 'MEMBERS_REMAIN: group still has active members' } })).toBe(
      'api_members_remain'
    );
  });

  it('kode asing tidak pernah menjadi teks: jatuh ke kunci status', () => {
    expect(apiErrorKey({ status: 400, details: { error: 'SOMETHING_BRAND_NEW' } })).toBe('api_bad_request');
    expect(apiErrorKey({ status: 418, details: { error: 'IM_A_TEAPOT' } })).toBe('api_unknown');
  });

  it('kalimat server menang atas fallback status bila tidak ada kode dikenal', () => {
    const error = new ApiError(410, 'Story has expired', { error: 'Story has expired' });
    expect(apiErrorKey(error)).toBeNull();
    expect(formatApiError(error)).toBe('Story has expired');
  });
});

describe('formatApiError: tidak pernah menampilkan kode mesin', () => {
  const CODES = [
    'RATE_LIMITED',
    'SEARCH_RATE_LIMITED',
    'TOKEN_UNKNOWN',
    'TOKEN_STALE',
    'GROUP_AUTH_REQUIRED',
    'ADMIN_AUTH_REQUIRED',
    'BLIND_AUTH_REQUIRED',
    'MEMBERS_REMAIN',
    'SANDBOX_LIMIT',
    'SANDBOX_LIMIT_REACHED',
    'SANDBOX_UPLOAD_RESTRICTION',
    'STORY_BLOCKED',
    'PP_PROOF_REQUIRED',
    'PP_TOKEN_REJECTED',
    'ACCESS DENIED',
    'SOMETHING_BRAND_NEW',
  ];

  it.each(CODES)('%s tidak muncul di teks', (code) => {
    const text = formatApiError({ status: 403, details: { error: code } });
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/^[A-Z][A-Z0-9_]{2,}$/);
  });

  it('kode + kalimat berbahasa Inggris: kalimat lokal yang dipakai, bukan prose server', () => {
    const error = new ApiError(403, 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token', {
      error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token',
    });
    const text = formatApiError(error);
    expect(text).toContain('secret issued');
    expect(text).not.toContain('Invalid or missing X-Group-Token');
  });

  it('fallback status untuk 4xx yang tidak membawa kode', () => {
    const expectations: Array<[number, string]> = [
      [400, 'rejected as invalid'],
      [401, 'session has expired'],
      [403, "don't have permission"],
      [404, 'no longer exists'],
      [409, 'current state'],
      [410, 'expired or was removed'],
      [413, 'too large'],
      [429, 'Too many attempts'],
      [0, 'Something went wrong'],
    ];
    for (const [status, fragment] of expectations) {
      const text = formatApiError({ status });
      expect(text).toContain(fragment);
    }
  });

  it('menerjemahkan lewat `t` dan meminta kunci yang benar', () => {
    const { t, keys } = fakeT();
    const text = formatApiError(new ApiError(429, 'RATE_LIMITED', { error: 'RATE_LIMITED' }), t);
    expect(text).toContain('t:api_rate_limited:');
    expect(keys).toEqual(['api_rate_limited']);
  });

  it('apiErrorTranslator selalu membaca namespace `errors`', () => {
    const { t, keys } = fakeT();
    apiErrorTranslator(t)('api_unknown');
    expect(keys).toEqual(['errors:api_unknown']);
  });

  it('formatApiErrorCode bekerja untuk payload realtime', () => {
    expect(formatApiErrorCode(null)).toBeNull();
    expect(formatApiErrorCode('TOKEN_STALE')).toContain('access to this group has expired');
    expect(formatApiErrorCode('SOMETHING_BRAND_NEW')).toContain('Something went wrong');
  });
});

describe('konteks pemanggil', () => {
  it('hasApiErrorDetail hanya benar bila ada kode dikenal atau kalimat server', () => {
    expect(hasApiErrorDetail(new ApiError(409, 'MEMBERS_REMAIN: x', { error: 'MEMBERS_REMAIN: x' }))).toBe(true);
    expect(hasApiErrorDetail(new ApiError(404, 'Story has expired', { error: 'Story has expired' }))).toBe(true);
    expect(hasApiErrorDetail({ status: 500 })).toBe(false);
    // Error jaringan lokal tidak membawa detail server — pemanggil harus
    // memakai pesan konteksnya sendiri, bukan "Failed to fetch" mentah.
    expect(hasApiErrorDetail(new Error('Failed to fetch'))).toBe(false);
  });

  it('formatApiErrorOr memakai kalimat konteks saat server tidak memberi detail', () => {
    const { t } = fakeT();
    expect(formatApiErrorOr({ status: 500 }, t, 'Gagal memulai chat')).toBe('Gagal memulai chat');
    expect(
      formatApiErrorOr({ status: 429, details: { error: 'RATE_LIMITED' } }, apiErrorTranslator(t), 'Gagal')
    ).toContain('errors:api_rate_limited');
  });

  it('formatApiOrLocalError hanya memetakan error server, error perangkat tetap apa adanya', () => {
    const { t } = fakeT();
    // 4xx/5xx atau kode dikenal → kalimat terjemahan, kode tidak tampil.
    expect(formatApiOrLocalError({ status: 413 }, t, 'Gagal upload')).toContain('api_too_large');
    expect(
      formatApiOrLocalError({ status: 403, details: { error: 'ADMIN_AUTH_REQUIRED: x' } }, t, 'Gagal')
    ).toContain('api_admin_required');
    // Kegagalan di perangkat (crypto/rotasi/penyimpanan) tetap bisa didiagnosis.
    expect(formatApiOrLocalError(new Error('EPOCH_ROTATION_timeout'), t, 'Gagal')).toBe('EPOCH_ROTATION_timeout');
    // Tidak ada pesan sama sekali → kalimat konteks pemanggil.
    expect(formatApiOrLocalError({}, t, 'Gagal rotasi kunci')).toBe('Gagal rotasi kunci');
  });

  it('isSandboxLimit mengenali ketiga kode dan tidak salah pada RATE_LIMITED', () => {
    for (const code of ['SANDBOX_LIMIT', 'SANDBOX_LIMIT_REACHED', 'SANDBOX_UPLOAD_RESTRICTION']) {
      expect(isSandboxLimit({ status: 403, details: { error: `${code}: nope` } })).toBe(true);
      expect(isSandboxLimit(code)).toBe(true);
    }
    expect(isSandboxLimit(new ApiError(429, 'RATE_LIMITED', { error: 'RATE_LIMITED' }))).toBe(false);
    expect(isSandboxLimit(new Error('Failed to fetch'))).toBe(false);
  });
});

describe('kunci i18n untuk error API ada di keempat bahasa', () => {
  const bundles: Array<[string, Record<string, string>]> = [
    ['en', enErrors as Record<string, string>],
    ['es', esErrors as Record<string, string>],
    ['id', idErrors as Record<string, string>],
    ['pt-BR', ptBrErrors as Record<string, string>],
  ];

  const keys = [...new Set([
    ...Object.values(API_ERROR_CODE_KEYS),
    ...Object.values(API_ERROR_STATUS_KEYS),
    ...Object.keys(API_ERROR_FALLBACKS),
    'sandbox_banner_message',
    'sandbox_banner_action',
  ])].sort();

  it('setiap kunci yang dirujuk punya fallback Inggris', () => {
    for (const key of keys) {
      if (key.startsWith('sandbox_banner')) continue;
      expect(typeof API_ERROR_FALLBACKS[key]).toBe('string');
      expect(API_ERROR_FALLBACKS[key]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it.each(bundles)('%s', (_lang, bundle) => {
    for (const key of keys) {
      expect(typeof bundle[key], `${key} hilang`).toBe('string');
      expect(bundle[key]?.length ?? 0).toBeGreaterThan(0);
      // Terjemahan tidak boleh meninggalkan kode mesin di dalam kalimat.
      expect(bundle[key]).not.toMatch(/\b[A-Z]{3,}_[A-Z0-9_]+\b/);
    }
  });
});
