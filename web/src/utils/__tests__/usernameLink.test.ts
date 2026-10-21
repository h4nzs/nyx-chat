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
  SHARE_ID_PREFIX,
  buildUsernameLink,
  isValidShareHandle,
  isValidShareId,
  isValidUsernameHash,
  parseProfileShareLink,
  parseUsernameHashSegment,
  resolveRecoveryIdentifierInput,
} from '../usernameLink';

const BASE64_HASH = 'A'.repeat(USERNAME_HASH_BASE64URL_LENGTH); // 43 char base64url
const HEX_HASH = 'ab'.repeat(32); // 64 hex
const SHARE_ID = `${SHARE_ID_PREFIX}${'B'.repeat(43)}`; // s1_<43 base64url>

describe('usernameLink: validasi hashId', () => {
  it('menerima 43 base64url dan 64 hex', () => {
    expect(BASE64_HASH).toHaveLength(43);
    expect(HEX_HASH).toHaveLength(64);
    expect(isValidUsernameHash(BASE64_HASH)).toBe(true);
    expect(isValidUsernameHash(HEX_HASH)).toBe(true);
  });

  it('[docs/28 §R5] shareId `s1_…` sah sebagai handle, tapi bukan hash username', () => {
    expect(isValidShareId(SHARE_ID)).toBe(true);
    expect(isValidShareHandle(SHARE_ID)).toBe(true);
    expect(isValidUsernameHash(SHARE_ID)).toBe(false);
    expect(isValidShareId(BASE64_HASH)).toBe(false);
    expect(isValidShareId(`${SHARE_ID_PREFIX}${'B'.repeat(42)}`)).toBe(false);
    expect(isValidShareId(`${SHARE_ID_PREFIX}${'B'.repeat(44)}`)).toBe(false);
    expect(isValidShareId(`${SHARE_ID_PREFIX}${'B'.repeat(42)}!`)).toBe(false);
    expect(isValidShareId(undefined)).toBe(false);
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
    expect(parseUsernameHashSegment(SHARE_ID)).toBe(SHARE_ID);
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

  it('[docs/28 §R5] shareId membangun link baru, dan tautan lama tetap bekerja', () => {
    expect(buildUsernameLink('https://nyx-app.my.id', SHARE_ID)).toBe(
      `https://nyx-app.my.id/u/${SHARE_ID}`
    );
    expect(buildUsernameLink('https://nyx-app.my.id', BASE64_HASH)).toBe(
      `https://nyx-app.my.id/u/${BASE64_HASH}`
    );
  });

  it('menolak hashId tidak sah (tidak ada link rusak yang tersebar)', () => {
    expect(() => buildUsernameLink('https://nyx-app.my.id', 'rusak')).toThrow(/tidak sah/);
    expect(() => buildUsernameLink('https://nyx-app.my.id', `${SHARE_ID_PREFIX}${'B'.repeat(42)}`)).toThrow(/tidak sah/);
  });
});

/**
 * [docs/30 §30.13 WS-I] Tautan yang dipindai/ditempel: satu parser untuk dua
 * bentuk, dan segmen tak sah TIDAK pernah menjadi request pencarian.
 */
describe('parseProfileShareLink', () => {
  it('link pendek WS-I → hanya `u` diteruskan (tanpa i/p)', () => {
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/${BASE64_HASH}`)).toBe(`?u=${BASE64_HASH}`);
    expect(parseProfileShareLink(`https://app.nyx-app.my.id/u/${HEX_HASH}/`)).toBe(`?u=${HEX_HASH}`);
    expect(parseProfileShareLink(`http://localhost:5173/u/${BASE64_HASH}`)).toBe(`?u=${BASE64_HASH}`);
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/${SHARE_ID}`)).toBe(`?u=${SHARE_ID}`);
  });

  it('link pendek hasil buildUsernameLink selalu bisa diurai kembali (roundtrip)', () => {
    const link = buildUsernameLink('https://nyx-app.my.id', BASE64_HASH);
    expect(parseProfileShareLink(link)).toBe(`?u=${BASE64_HASH}`);
  });

  it('segmen hash tak sah ditolak di klien (tidak ada lookup sampah)', () => {
    expect(parseProfileShareLink('https://nyx-app.my.id/u/rusak')).toBeNull();
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/${'A'.repeat(42)}`)).toBeNull();
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/${'AB'.repeat(32).toUpperCase()}`)).toBeNull();
    expect(parseProfileShareLink('https://nyx-app.my.id/u/')).toBeNull();
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/${BASE64_HASH}/extra`)).toBeNull();
  });

  it('QR lama `/connect?u=…&i=…&p=…` diteruskan apa adanya (tautan beredar tetap hidup)', () => {
    const legacy = `https://nyx-app.my.id/connect?u=${BASE64_HASH}&i=user-1&p=${encodeURIComponent('cipher+text')}`;
    expect(parseProfileShareLink(legacy)).toBe(`?u=${BASE64_HASH}&i=user-1&p=${encodeURIComponent('cipher+text')}`);
  });

  it('QR lama dengan `u` terlalu pendek / tanpa `u` ditolak (aturan lama dipertahankan)', () => {
    expect(parseProfileShareLink('https://nyx-app.my.id/connect?u=pendek')).toBeNull();
    expect(parseProfileShareLink('https://nyx-app.my.id/connect?i=user-1')).toBeNull();
  });

  it('host tidak dipatok (self-host/custom domain) — yang difollow tetap hashId saja', () => {
    // Sengaja tanpa allow-list host: deployment self-host memakai domain sendiri,
    // dan yang diteruskan ke `/connect` hanyalah hashId — tidak ada permintaan
    // jaringan ke host yang tertulis di QR.
    expect(parseProfileShareLink(`https://nyx.example.org/u/${BASE64_HASH}`)).toBe(`?u=${BASE64_HASH}`);
  });

  it('bukan tautan berbagi / bukan URL → null (pemindai lanjut, tidak error)', () => {
    expect(parseProfileShareLink('https://nyx-app.my.id/chat')).toBeNull();
    expect(parseProfileShareLink('cuma teks biasa')).toBeNull();
    expect(parseProfileShareLink('')).toBeNull();
    expect(parseProfileShareLink('  ')).toBeNull();
  });

  it('skema non-http(s) ditolak, termasuk escape persen yang rusak', () => {
    expect(parseProfileShareLink(`javascript:alert(1)//u/${BASE64_HASH}`)).toBeNull();
    expect(parseProfileShareLink(`https://nyx-app.my.id/u/%E0%A4%A`)).toBeNull();
  });
});

describe('resolveRecoveryIdentifierInput (jalur pemulihan akun)', () => {
  it('hash ID dikirim apa adanya — server punya kandidat untuk keduanya', () => {
    expect(resolveRecoveryIdentifierInput(BASE64_HASH)).toEqual({ kind: 'hash-id', value: BASE64_HASH });
    expect(resolveRecoveryIdentifierInput(HEX_HASH)).toEqual({ kind: 'hash-id', value: HEX_HASH });
  });

  it('username diperlakukan sebagai username (harus di-hash Argon2id dulu oleh pemanggil)', () => {
    expect(resolveRecoveryIdentifierInput('han')).toEqual({ kind: 'username', value: 'han' });
    // Panjang 43 tapi alfabetnya salah (mis. memuat spasi/'!') bukan hash ID.
    expect(resolveRecoveryIdentifierInput('A'.repeat(42) + '!')).toEqual({
      kind: 'username',
      value: 'A'.repeat(42) + '!',
    });
  });

  it('trim spasi di tepi — pengguna menempel hash ID dengan spasi tetap bekerja', () => {
    expect(resolveRecoveryIdentifierInput(`  ${HEX_HASH}  `)).toEqual({ kind: 'hash-id', value: HEX_HASH });
    expect(resolveRecoveryIdentifierInput('  han  ')).toEqual({ kind: 'username', value: 'han' });
  });

  it('string kosong → username kosong (bukan hash ID kosong yang dikirim ke server)', () => {
    expect(resolveRecoveryIdentifierInput('   ')).toEqual({ kind: 'username', value: '' });
  });
});
