// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import { ktConfigPinMatches, parseKtConfigPin } from '../ktConfigPin';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const AUDITOR_1 = 'c'.repeat(64);
const AUDITOR_2 = 'd'.repeat(64);
const MLDSA_A = 'a'.repeat(3904);
const MLDSA_B = 'b'.repeat(3904);
const MLDSA_AUDITOR = 'c'.repeat(3904);

describe('ktConfigPin — validasi bentuk', () => {
  it('menerima konfigurasi ABI 1 lengkap dan menormalkan huruf besar', () => {
    const pin = parseKtConfigPin({
      abiVersion: 1,
      mode: 1,
      signatureKey: KEY_A.toUpperCase(),
      vrfKey: KEY_B,
      auditorKeys: [AUDITOR_1.toUpperCase()],
    });
    expect(pin).toEqual({
      abiVersion: 1,
      mode: 1,
      signatureKey: KEY_A,
      vrfKey: KEY_B,
      auditorKeys: [AUDITOR_1],
    });
  });

  it('menginferensikan pin lama menjadi ABI 1 (tanpa kehilangan pin)', () => {
    expect(parseKtConfigPin({ mode: 1, signatureKey: KEY_A, vrfKey: KEY_B })).toEqual({
      abiVersion: 1,
      mode: 1,
      signatureKey: KEY_A,
      vrfKey: KEY_B,
      auditorKeys: [],
    });
  });

  it('menerima konfigurasi ABI 2 (ML-DSA 1952 byte) tanpa vrfKey', () => {
    const pin = parseKtConfigPin({
      abiVersion: 2,
      mode: 1,
      signatureKey: MLDSA_A.toUpperCase(),
      auditorKeys: [MLDSA_AUDITOR],
    });
    expect(pin).toEqual({
      abiVersion: 2,
      mode: 1,
      signatureKey: MLDSA_A,
      auditorKeys: [MLDSA_AUDITOR],
    });
    expect(pin?.vrfKey).toBeUndefined();
  });

  it('menolak panjang/tipe yang salah', () => {
    expect(parseKtConfigPin(undefined)).toBeUndefined();
    expect(parseKtConfigPin({})).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: 'abc', vrfKey: KEY_B })).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 1, mode: 'x', signatureKey: KEY_A, vrfKey: KEY_B })).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 3, mode: 1, signatureKey: KEY_A, vrfKey: KEY_B })).toBeUndefined();
  });

  it('menolak campuran ABI (kunci 1952 byte dengan vrfKey, atau sebaliknya)', () => {
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, vrfKey: KEY_B })
    ).toBeUndefined();
    expect(
      parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [MLDSA_AUDITOR] })
    ).toBeUndefined();
  });

  it('menolak auditor bukan hex dengan panjang yang sesuai ABI', () => {
    expect(
      parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: ['nope'] })
    ).toBeUndefined();
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: [AUDITOR_1] })
    ).toBeUndefined();
  });
});

describe('ktConfigPin — ktConfigPinMatches', () => {
  const base = parseKtConfigPin({
    abiVersion: 1,
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
          abiVersion: 1,
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
        parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_B, vrfKey: KEY_B, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('kunci VRF berubah → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_A, vrfKey: KEY_A, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('mode berubah → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 1, mode: 2, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_1, AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('ABI berbeda → tidak cocok (upgrade ditangani resolveConfig, bukan match)', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A })!
      )
    ).toBe(false);
  });

  it('auditor ditambah/hilang/berbeda urutan → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_1] })!
      )
    ).toBe(false);
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: KEY_A, vrfKey: KEY_B, auditorKeys: [AUDITOR_2, AUDITOR_1] })!
      )
    ).toBe(false);
  });
});
