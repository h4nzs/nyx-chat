// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.13 WS-I] Link `/u/<hashId>`: aturan bentuk harus sama dengan
 * server (`users.ts` `isExactHash`) supaya link yang dibangun di klien pasti
 * diterima lookup persis, dan input tak sah tidak pernah dikirim ke server.
 */
import { describe, it, expect } from 'vitest';
import {
  USERNAME_HASH_BASE64URL_LENGTH,
  USERNAME_HASH_HEX_LENGTH,
  buildUsernameLink,
  isValidUsernameHash,
  parseUsernameHashSegment,
} from '../usernameLink';

const BASE64_HASH = 'A'.repeat(USERNAME_HASH_BASE64URL_LENGTH); // 43 char base64url
const HEX_HASH = 'ab'.repeat(32); // 64 hex

describe('usernameLink: validasi hashId', () => {
  it('menerima 43 base64url dan 64 hex', () => {
    expect(BASE64_HASH).toHaveLength(43);
    expect(HEX_HASH).toHaveLength(64);
    expect(isValidUsernameHash(BASE64_HASH)).toBe(true);
    expect(isValidUsernameHash(HEX_HASH)).toBe(true);
  });

  it('menolak panjang/alfabet salah dan nilai non-string', () => {
    expect(isValidUsernameHash('terlalu-pendek')).toBe(false);
    expect(isValidUsernameHash('A'.repeat(43) + '!')).toBe(false); // alfabet salah
    expect(isValidUsernameHash('A'.repeat(42))).toBe(false);
    expect(isValidUsernameHash('AB'.repeat(32).toUpperCase())).toBe(false); // hex harus lowercase
    expect(isValidUsernameHash(undefined)).toBe(false);
    expect(isValidUsernameHash(null)).toBe(false);
    expect(isValidUsernameHash(12345)).toBe(false);
  });

  it('parseUsernameHashSegment mengembalikan null untuk segmen tak sah', () => {
    expect(parseUsernameHashSegment(BASE64_HASH)).toBe(BASE64_HASH);
    expect(parseUsernameHashSegment('nope')).toBeNull();
    expect(parseUsernameHashSegment(undefined)).toBeNull();
  });
});

describe('usernameLink: buildUsernameLink', () => {
  it('membangun link pendek dan menormalkan trailing slash origin', () => {
    expect(buildUsernameLink('https://nyx-app.my.id', BASE64_HASH)).toBe(
      `https://nyx-app.my.id/u/${BASE64_HASH}`
    );
    expect(buildUsernameLink('https://nyx-app.my.id/', BASE64_HASH)).toBe(
      `https://nyx-app.my.id/u/${BASE64_HASH}`
    );
  });

  it('menolak hashId tidak sah (tidak ada link rusak yang tersebar)', () => {
    expect(() => buildUsernameLink('https://nyx-app.my.id', 'rusak')).toThrow(/tidak sah/);
  });
});
