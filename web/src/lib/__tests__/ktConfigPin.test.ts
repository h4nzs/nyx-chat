// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import { ktConfigPinMatches, parseKtConfigPin } from '../ktConfigPin';

const MLDSA_A = 'a'.repeat(3904);
const MLDSA_B = 'b'.repeat(3904);
const MLDSA_AUDITOR_1 = 'c'.repeat(3904);
const MLDSA_AUDITOR_2 = 'd'.repeat(3904);
/** Panjang kunci ABI 1 (Ed25519, 32 byte) — harus ditolak. */
const ED25519_A = 'a'.repeat(64);
const ED25519_B = 'b'.repeat(64);

describe('ktConfigPin — validasi bentuk', () => {
  it('menerima konfigurasi ABI 2 (ML-DSA 1952 byte) dan menormalkan huruf besar', () => {
    const pin = parseKtConfigPin({
      abiVersion: 2,
      mode: 1,
      signatureKey: MLDSA_A.toUpperCase(),
      auditorKeys: [MLDSA_AUDITOR_1.toUpperCase()],
    });
    expect(pin).toEqual({
      abiVersion: 2,
      mode: 1,
      signatureKey: MLDSA_A,
      auditorKeys: [MLDSA_AUDITOR_1],
    });
  });

  it('menolak pin ABI 1 (tidak ada lagi jalur inferensi)', () => {
    // Kunci 32 byte + vrfKey: bentuk pin lama. [docs/43 §43.3.2]
    expect(
      parseKtConfigPin({ abiVersion: 1, mode: 1, signatureKey: ED25519_A, vrfKey: ED25519_B })
    ).toBeUndefined();
    // Pin lama tanpa `abiVersion` juga tidak diinferensikan lagi.
    expect(
      parseKtConfigPin({ mode: 1, signatureKey: ED25519_A, vrfKey: ED25519_B })
    ).toBeUndefined();
  });

  it('menolak ABI 2 yang masih membawa vrfKey (bentuk campuran)', () => {
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, vrfKey: ED25519_B })
    ).toBeUndefined();
  });

  it('menolak panjang/tipe/ABI yang salah', () => {
    expect(parseKtConfigPin(undefined)).toBeUndefined();
    expect(parseKtConfigPin({})).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: 'abc' })).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 2, mode: 'x', signatureKey: MLDSA_A })).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: 3, mode: 1, signatureKey: MLDSA_A })).toBeUndefined();
    expect(parseKtConfigPin({ abiVersion: '2', mode: 1, signatureKey: MLDSA_A })).toBeUndefined();
  });

  it('menolak auditor yang bukan hex 1952 byte', () => {
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: ['nope'] })
    ).toBeUndefined();
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: [ED25519_A] })
    ).toBeUndefined();
    expect(
      parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: ['y'.repeat(3904)] })
    ).toBeUndefined();
  });

  it('auditor yang tidak disebut dianggap daftar kosong', () => {
    expect(parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A })?.auditorKeys).toEqual([]);
  });
});

describe('ktConfigPin — ktConfigPinMatches', () => {
  const base = parseKtConfigPin({
    abiVersion: 2,
    mode: 1,
    signatureKey: MLDSA_A,
    auditorKeys: [MLDSA_AUDITOR_1, MLDSA_AUDITOR_2],
  })!;

  it('identik → cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({
          abiVersion: 2,
          mode: 1,
          signatureKey: MLDSA_A,
          auditorKeys: [MLDSA_AUDITOR_1, MLDSA_AUDITOR_2],
        })!
      )
    ).toBe(true);
  });

  it('kunci tanda tangan berubah → tidak cocok (server menukar kunci)', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_B, auditorKeys: [MLDSA_AUDITOR_1, MLDSA_AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('mode berubah → tidak cocok', () => {
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 2, mode: 2, signatureKey: MLDSA_A, auditorKeys: [MLDSA_AUDITOR_1, MLDSA_AUDITOR_2] })!
      )
    ).toBe(false);
  });

  it('auditor ditambah/hilang/berbeda urutan → tidak cocok', () => {
    expect(
      ktConfigPinMatches(base, parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: [MLDSA_AUDITOR_1] })!)
    ).toBe(false);
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: [MLDSA_AUDITOR_2, MLDSA_AUDITOR_1] })!
      )
    ).toBe(false);
    expect(
      ktConfigPinMatches(
        base,
        parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A, auditorKeys: [MLDSA_AUDITOR_1, MLDSA_AUDITOR_2, 'e'.repeat(3904)] })!
      )
    ).toBe(false);
    expect(
      ktConfigPinMatches(base, parseKtConfigPin({ abiVersion: 2, mode: 1, signatureKey: MLDSA_A })!)
    ).toBe(false);
  });
});
