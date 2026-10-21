import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CREDENTIAL_SUITES,
  CREDENTIAL_SUITE_RSA_V1,
  credentialSuiteInfo,
  isSupportedCredentialSuite,
  requireCredentialSuite,
} from '@nyx/shared'
import { CREDENTIAL_PREPARE_PREFIX_BYTES } from '@nyx/shared'

// [docs/35 §35.6.6 — Fase 5] Abstraksi suite credential: satu daftar bersama
// dipakai server (iklankan + verifikasi) dan worker (blind/finalize). Test ini
// mengunci perilaku fail-closed-nya, karena bug di sini berarti credential
// ditandatangani/diverifikasi dengan parameter yang salah.

describe('credentialSuite — daftar & fail-closed', () => {
  test('suite v1 terdaftar sebagai satu-satunya suite yang didukung', () => {
    assert.equal(CREDENTIAL_SUITES.length, 1)
    assert.equal(CREDENTIAL_SUITES[0]?.id, CREDENTIAL_SUITE_RSA_V1)
    assert.equal(CREDENTIAL_SUITE_RSA_V1, 'RSABSSA-SHA384-PSS-Randomized')
    assert.equal(CREDENTIAL_SUITES[0]?.postQuantum, false)
  })

  test('prefix prepare ikut deklarasi suite, bukan angka duplikat', () => {
    const info = credentialSuiteInfo(CREDENTIAL_SUITE_RSA_V1)
    assert.ok(info)
    assert.equal(info.preparePrefixBytes, CREDENTIAL_PREPARE_PREFIX_BYTES)
    assert.equal(CREDENTIAL_PREPARE_PREFIX_BYTES, 32)
  })

  test('suite asing / bukan string ditolak', () => {
    for (const value of ['BRACCOON-V1', 'rsabssa-sha384-pss-randomized', '', null, undefined, 42]) {
      assert.equal(isSupportedCredentialSuite(value), false, `harus menolak ${String(value)}`)
      assert.equal(credentialSuiteInfo(value), undefined)
      assert.throws(() => requireCredentialSuite(value), /suite tidak didukung/)
    }
  })

  test('requireCredentialSuite mengembalikan info untuk suite yang didukung', () => {
    const info = requireCredentialSuite(CREDENTIAL_SUITE_RSA_V1)
    assert.equal(info.id, CREDENTIAL_SUITE_RSA_V1)
    assert.equal(info.keyVersion, 1)
  })
})
