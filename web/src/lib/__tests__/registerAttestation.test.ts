// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Helper attestation pendaftaran — `api` dan
 * `@simplewebauthn/browser` di-stub (tanpa jaringan/authenticator nyata).
 *
 * Properti yang dikunci:
 *   1. Hanya 428 (atau pesan ATTESTATION_REQUIRED) yang memicu upacara WebAuthn;
 *      error lain dilewatkan apa adanya (tidak diam-diam mencoba attestation).
 *   2. Opsi diambil dari endpoint server dan upacara dijalankan dengan opsi itu.
 *   3. Perangkat tanpa authenticator platform → kegagalan jelas, bukan dilewati.
 *   4. Penolakan server dipetakan ke kunci i18n yang tepat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiMock, startRegistrationMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  startRegistrationMock: vi.fn(),
}));

vi.mock('../api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: startRegistrationMock,
}));

import { ApiError } from '../api';
import {
  ATTESTATION_UNSUPPORTED_DEVICE,
  attestationErrorKey,
  createRegistrationAttestation,
  isAttestationRequiredError,
} from '../registerAttestation';

const CHALLENGE = 'Y2hhbGxlbmdlLWJhc2U2NHVybC1jaGFsbGVuZ2U';

beforeEach(() => {
  apiMock.mockReset();
  startRegistrationMock.mockReset();
  // jsdom tidak punya WebAuthn; sediakan objek minimal supaya jalur sukses teruji.
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
});

describe('isAttestationRequiredError', () => {
  it('hanya 428 / ATTESTATION_REQUIRED yang dianggap permintaan attestation', () => {
    expect(isAttestationRequiredError(new ApiError(428, 'ATTESTATION_REQUIRED'))).toBe(true);
    expect(isAttestationRequiredError(new Error('ATTESTATION_REQUIRED'))).toBe(true);
    expect(isAttestationRequiredError(new ApiError(403, 'ATTESTATION_REJECTED: NOT_HARDWARE_ATTESTATION'))).toBe(false);
    expect(isAttestationRequiredError(new ApiError(429, 'REGISTRATION_BURST_LIMIT'))).toBe(false);
    expect(isAttestationRequiredError(new Error('network'))).toBe(false);
    expect(isAttestationRequiredError(undefined)).toBe(false);
  });
});

describe('createRegistrationAttestation', () => {
  it('mengambil opsi dari server lalu menjalankan upacara dengan opsi itu', async () => {
    apiMock.mockResolvedValueOnce({ challenge: CHALLENGE, rp: { id: 'app.example.test' }, pubKeyCredParams: [] });
    startRegistrationMock.mockResolvedValueOnce({ id: 'cred-id', rawId: 'cred-id', type: 'public-key', response: {} });

    const result = await createRegistrationAttestation();

    expect(apiMock).toHaveBeenCalledWith('/api/auth/register/attestation-options', { method: 'POST' });
    expect(startRegistrationMock).toHaveBeenCalledTimes(1);
    const ceremonyArg = (startRegistrationMock.mock.calls[0] ?? [])[0] as
      | { optionsJSON: { challenge: string } }
      | undefined;
    expect(ceremonyArg?.optionsJSON.challenge).toBe(CHALLENGE);
    expect(result.challenge).toBe(CHALLENGE);
    expect(result.response).toMatchObject({ id: 'cred-id' });
  });

  it('opsi tanpa challenge → gagal jelas (tidak mengirim bukti kosong)', async () => {
    apiMock.mockResolvedValueOnce({ rp: { id: 'app.example.test' } });
    await expect(createRegistrationAttestation()).rejects.toThrow('ATTESTATION_OPTIONS_INVALID');
    expect(startRegistrationMock).not.toHaveBeenCalled();
  });

  it('perangkat tanpa navigator.credentials → ATTESTATION_UNSUPPORTED_DEVICE', async () => {
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
    await expect(createRegistrationAttestation()).rejects.toThrow(ATTESTATION_UNSUPPORTED_DEVICE);
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('attestationErrorKey', () => {
  it('memetakan penolakan server ke kunci i18n yang tepat', () => {
    expect(attestationErrorKey(new Error(ATTESTATION_UNSUPPORTED_DEVICE))).toBe('registration_attestation_unsupported');
    expect(attestationErrorKey(new Error('ATTESTATION_CHALLENGE_INVALID'))).toBe('registration_attestation_expired');
    expect(attestationErrorKey(new Error('ATTESTATION_INVALID'))).toBe('registration_attestation_invalid');
    expect(attestationErrorKey(new Error('ATTESTATION_REJECTED: NOT_HARDWARE_ATTESTATION'))).toBe('registration_attestation_hardware_required');
    expect(attestationErrorKey(new Error('ATTESTATION_REJECTED: SELF_ATTESTATION_NOT_ALLOWED'))).toBe('registration_attestation_hardware_required');
    expect(attestationErrorKey(new Error('ATTESTATION_REJECTED: SYNCED_AUTHENTICATOR_NOT_ALLOWED'))).toBe('registration_attestation_hardware_required');
    expect(attestationErrorKey(new Error('ATTESTATION_REJECTED: USER_VERIFICATION_REQUIRED'))).toBe('registration_attestation_user_verification');
    expect(attestationErrorKey(new Error('sesuatu yang lain'))).toBe('registration_attestation_invalid');
  });
});
