// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * QR device-linking: bentuk URL/token yang diterima.
 *
 * Yang dikunci:
 *   1. QR yang dibuat perangkat lama dan yang dibaca perangkat baru memakai
 *      parameter yang SAMA (`t`) — kalau salah, tautan hanya "tidak sah".
 *   2. Perangkat baru menerima URL penuh (hasil scan) MAUPUN token mentah
 *      (input manual), tanpa membuang karakter penting.
 *   3. Input kosong/sampah tidak pernah menghasilkan token palsu.
 */

import { describe, expect, it } from 'vitest';

import {
  LINK_TOKEN_QUERY_PARAM,
  buildDeviceLinkUrl,
  parseDeviceLinkToken,
} from '../deviceLinking';

const TOKEN = 'a1b2c3d4'.repeat(8);

describe('buildDeviceLinkUrl', () => {
  it('menaruh token di parameter t dengan origin tanpa trailing slash', () => {
    expect(buildDeviceLinkUrl('https://nyx.example/', TOKEN)).toBe(
      `https://nyx.example/link?${LINK_TOKEN_QUERY_PARAM}=${TOKEN}`,
    );
    expect(buildDeviceLinkUrl('https://nyx.example', TOKEN)).toBe(
      `https://nyx.example/link?${LINK_TOKEN_QUERY_PARAM}=${TOKEN}`,
    );
  });

  it('meng-encode token (aman walau bentuknya menyimpang)', () => {
    const url = buildDeviceLinkUrl('https://nyx.example', 'a b&c');
    expect(url).toContain('%20');
    expect(url).toContain('%26');
  });
});

describe('parseDeviceLinkToken', () => {
  it('menerima URL penuh hasil scan', () => {
    expect(parseDeviceLinkToken(`https://nyx.example/link?t=${TOKEN}`)).toBe(TOKEN);
    expect(parseDeviceLinkToken(`/link?t=${TOKEN}`)).toBe(TOKEN);
    expect(
      parseDeviceLinkToken(`https://nyx.example/link?utm=x&t=${TOKEN}&other=1`),
    ).toBe(TOKEN);
  });

  it('menerima token mentah (input manual)', () => {
    expect(parseDeviceLinkToken(TOKEN)).toBe(TOKEN);
    expect(parseDeviceLinkToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it('kosong / null tidak menghasilkan token', () => {
    expect(parseDeviceLinkToken(null)).toBeNull();
    expect(parseDeviceLinkToken(undefined)).toBeNull();
    expect(parseDeviceLinkToken('')).toBeNull();
    expect(parseDeviceLinkToken('   ')).toBeNull();
  });

  it('tautan tanpa parameter t → null (bukan diperlakukan sebagai token)', () => {
    expect(parseDeviceLinkToken('https://nyx.example/login')).toBeNull();
    expect(parseDeviceLinkToken('/link?x=1')).toBeNull();
    expect(parseDeviceLinkToken('link?t=')).toBeNull();
  });
});
