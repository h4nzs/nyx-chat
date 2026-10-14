// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(2)] Cache alamat relay panggilan — diuji dengan `api`
 * yang di-stub (tanpa jaringan).
 *
 * Properti yang dikunci:
 *   1. Token dari server dipakai apa adanya; nilai yang **bukan** token (mis.
 *      userId yang bocor) tidak pernah masuk cache maupun dikirim ke wire.
 *   2. Cache: satu request per peer, id yang sudah ada tidak diminta ulang.
 *   3. Kegagalan API → `null` (fail-closed), bukan jatuh ke userId.
 *   4. Token yang tampak masuk akal tapi tidak dikenal server → `null`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

import {
  callRelayTokenFor,
  ensureCallRelayTokens,
  isCallRelayToken,
  resetCallRelayTokenCache,
  userIdForCallRelayToken,
} from '../callRelayTokens';

const PEER = 'user-11111111-2222-3333-4444-555555555555';
const OTHER = 'user-99999999-8888-7777-6666-555555555555';

const tokenA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const tokenB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const tokenC = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

beforeEach(() => {
  apiMock.mockReset();
  resetCallRelayTokenCache();
});

describe('isCallRelayToken', () => {
  it('menerima 32 karakter base64url dan menolak userId', () => {
    expect(isCallRelayToken(tokenA)).toBe(true);
    expect(isCallRelayToken('Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab3_-Ab')).toBe(true); // 32 char, seluruh alfabet
    expect(isCallRelayToken(`${tokenA.slice(0, 31)}+`)).toBe(false);
    expect(isCallRelayToken(PEER)).toBe(false);
    expect(isCallRelayToken(tokenA.slice(0, 31))).toBe(false);
    expect(isCallRelayToken(null)).toBe(false);
  });
});

describe('ensureCallRelayTokens', () => {
  it('satu request untuk banyak peer, dan hanya untuk id yang belum ada', async () => {
    apiMock.mockResolvedValueOnce({ self: tokenC, peers: { [PEER]: tokenA, [OTHER]: tokenB } });

    await ensureCallRelayTokens([PEER, OTHER, PEER, '']);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiMock.mock.calls[0] as [string, { body: string }];
    expect(path).toBe('/api/call-tokens');
    expect(JSON.parse(options.body)).toEqual({ userIds: [PEER, OTHER] });

    // Semua sudah ter-cache → tidak ada request kedua.
    await ensureCallRelayTokens([PEER, OTHER]);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('mengabaikan nilai yang bukan token (userId tidak pernah masuk cache)', async () => {
    apiMock.mockResolvedValueOnce({ self: tokenC, peers: { [PEER]: PEER } });
    await ensureCallRelayTokens([PEER]);
    expect(await callRelayTokenFor(PEER)).toBeNull();
  });
});

describe('callRelayTokenFor', () => {
  it('mengembalikan token peer dan memakainya lagi dari cache', async () => {
    apiMock.mockResolvedValueOnce({ self: tokenC, peers: { [PEER]: tokenA } });

    expect(await callRelayTokenFor(PEER)).toBe(tokenA);
    expect(await callRelayTokenFor(PEER)).toBe(tokenA);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('gagal API → null (fail-closed), tidak melempar', async () => {
    apiMock.mockRejectedValueOnce(new Error('network down'));
    expect(await callRelayTokenFor(PEER)).toBeNull();
  });
});

describe('userIdForCallRelayToken', () => {
  it('memetakan paket masuk ke userId lalu mem-cache pemetaannya', async () => {
    apiMock.mockResolvedValueOnce({ users: { [tokenA]: PEER } });

    expect(await userIdForCallRelayToken(tokenA)).toBe(PEER);
    expect(await userIdForCallRelayToken(tokenA)).toBe(PEER);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('bentuk salah → null tanpa memanggil API', async () => {
    expect(await userIdForCallRelayToken(PEER)).toBeNull();
    expect(await userIdForCallRelayToken('x'.repeat(31))).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('token tak dikenal server → null', async () => {
    apiMock.mockResolvedValueOnce({ users: { [tokenA]: null } });
    expect(await userIdForCallRelayToken(tokenA)).toBeNull();
  });

  it('jawaban rusak/bukan string → null (tidak melempar)', async () => {
    apiMock.mockResolvedValueOnce({ users: { [tokenA]: 42 } });
    expect(await userIdForCallRelayToken(tokenA)).toBeNull();

    apiMock.mockRejectedValueOnce(new Error('boom'));
    expect(await userIdForCallRelayToken(tokenB)).toBeNull();
  });
});
