// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import { ktConfigPinMatches, parseKtConfigPin } from '../ktConfigPin';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const AUDITOR_1 = 'c'.repeat(64);
const AUDITOR_2 = 'd'.repeat(64);

describe('ktConfigPin — validasi bentuk', () => {
  it('menerima konfigurasi lengkap dan menormalkan huruf besar', () => {
    const pin = parseKtConfigPin({
      mode: 1,
      signatureKey: KEY_A.toUpperCase(),
      vrfKey: KEY_B,
      auditorKeys: [AUDITOR_1.toUpperCase()],
    });
    expect(pin).toEqual({
      mode: 1,
      signatureKey: KEY_A,
      vrfKey: KEY_B,
      auditorKeys: [AUDITOR_1],
    });
  });

  it('menolak panjang/tipe yang salah', () => {
    expect(parseKtConfigPin(undefined)).toBeUndefined();
    expect(parseKtConfigPin({})).toBeUndefined();
    expect(parseKtConfigPin({ mode: 1, signatureKey: 'abc', vrfKey: KEY_B })).toBeUndefined();
    expect(parseKtConfigPin({ mode: 'x', signatureKey: KEY_A, vrfKey: KEY_B })).toBeUndefined();
  });

  it('menolak auditor bukan hex 32 byte', () => {
    expect(
      parseKtConfigPin({ mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: ['nope'] })
    ).toBeUndefined();
  });
});

describe('ktConfigPin — ktConfigPinMatches', () => {
  const base = parseKtConfigPin({
    mode: 1,
    signatureKey: KEY_A,
    vrfKey: KEY_B,
    auditorKeys: [AUDITOR_1, AUDITOR_2],
  })!;

  it('identik → cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({
          mode: 1,
          signatureKey: KEY_A,
          vrfKey: KEY_B,
          auditorKeys: [AUDITOR_1, AUDITOR_2],
        })!
      )
    ).toBe(true);
  });

  it('kunci tanda tangan berubah → tidak cocok (server menukar kunci)', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ mode: 1, signatureKey: KEY_B, vrfKey: KEY_B, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('kunci VRF berubah → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ mode: 1, signatureKey: KEY_A, vrfKey: KEY_A, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('mode berubah → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ mode: 2, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('auditor ditamb/hilang/berbeda urutan → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_1] })!
      )
    ).toBe(false);
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_2, AUDITOR_1] })!
      )
    ).toBe(false);
  });
});
