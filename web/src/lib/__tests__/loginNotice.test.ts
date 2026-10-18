// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi UX 2026-10-18: `/login?reason=revoked|kicked|banned` dirender kosong.
 *
 * Tiga jalur redirect punya arti berbeda dan tidak boleh tertukar:
 *   - revoked → sesi dicabut (perangkat ini masih sah, hanya perlu masuk lagi)
 *   - kicked  → putus karena login di perangkat lain
 *   - banned  → akun diblokir; `msg` dari admin ikut ditampilkan
 */

import { describe, expect, it } from 'vitest';

import { loginNoticeFromSearch } from '../loginNotice';

describe('loginNoticeFromSearch', () => {
  it('revoked → pesan sesi dicabut tanpa detail', () => {
    expect(loginNoticeFromSearch('?reason=revoked')).toEqual({
      key: 'auth:messages.session_revoked',
      detail: null,
    });
  });

  it('kicked → pesan diputus karena login di tempat lain', () => {
    expect(loginNoticeFromSearch('?reason=kicked')).toEqual({
      key: 'auth:messages.session_kicked',
      detail: null,
    });
  });

  it('banned → pesan blokir + detail alasan dari server', () => {
    expect(loginNoticeFromSearch('?reason=banned&msg=Spam%20berulang')).toEqual({
      key: 'auth:messages.account_banned',
      detail: 'Spam berulang',
    });
    expect(loginNoticeFromSearch('?reason=banned')).toEqual({
      key: 'auth:messages.account_banned',
      detail: null,
    });
  });

  it('tanpa alasan / alasan tak dikenal → tidak ada banner', () => {
    expect(loginNoticeFromSearch('')).toBeNull();
    expect(loginNoticeFromSearch('?foo=bar')).toBeNull();
    expect(loginNoticeFromSearch('?reason=expired')).toBeNull();
  });
});
