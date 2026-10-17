// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Attestation perangkat saat mendaftar akun baru.
 *
 * Server bisa menolak pendaftaran dengan **428 ATTESTATION_REQUIRED** (kebijakan
 * operator) atau karena heuristik burst sybil per-jaringan. Alur klien:
 *
 *   1. kirim pendaftaran seperti biasa;
 *   2. pada 428 → ambil opsi dari `POST /api/auth/register/attestation-options`
 *      (attestation `direct`), jalankan upacara WebAuthn platform, lalu kirim
 *      ulang pendaftaran bersama buktinya;
 *   3. server memverifikasi sebelum akun dibuat — kegagalan berarti tidak ada
 *      akun, bukan akun tanpa verifikasi.
 *
 * Tidak ada fallback: bila perangkat tidak punya authenticator platform, kita
 * memberi tahu user dengan pesan yang jelas, bukan diam-diam melewati gerbang.
 */

import { api, ApiError } from './api';

/** Status yang dipakai server saat bukti attestation diminta. */
export const ATTESTATION_REQUIRED_STATUS = 428;

/** Penanda kegagalan sisi klien (perangkat tanpa authenticator platform). */
export const ATTESTATION_UNSUPPORTED_DEVICE = 'ATTESTATION_UNSUPPORTED_DEVICE';

export interface RegistrationAttestation {
  challenge: string;
  response: unknown;
}

/** Apakah error ini berarti "server meminta attestation"? */
export function isAttestationRequiredError(error: unknown): boolean {
  if (error instanceof ApiError && error.status === ATTESTATION_REQUIRED_STATUS) return true;
  return error instanceof Error && error.message.includes('ATTESTATION_REQUIRED');
}

/**
 * Ambil opsi attestation dari server lalu jalankan upacara WebAuthn.
 * Melempar `ATTESTATION_UNSUPPORTED_DEVICE` bila perangkat tidak bisa.
 */
export async function createRegistrationAttestation(): Promise<RegistrationAttestation> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error(ATTESTATION_UNSUPPORTED_DEVICE);
  }

  const options = await api<{ challenge?: unknown } & Record<string, unknown>>(
    '/api/auth/register/attestation-options',
    { method: 'POST' }
  );
  if (typeof options.challenge !== 'string' || options.challenge.length === 0) {
    throw new Error('ATTESTATION_OPTIONS_INVALID');
  }

  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: options as never });

  return { challenge: options.challenge, response };
}

/**
 * Terjemahkan penolakan server menjadi kunci i18n (namespace `errors`), supaya
 * user tahu apa yang harus dilakukan (mis. perangkat tidak memenuhi kriteria
 * perangkat keras).
 */
export function attestationErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes(ATTESTATION_UNSUPPORTED_DEVICE)) return 'registration_attestation_unsupported';
  if (message.includes('ATTESTATION_CHALLENGE_INVALID')) return 'registration_attestation_expired';
  if (message.includes('ATTESTATION_INVALID')) return 'registration_attestation_invalid';
  if (
    message.includes('NOT_HARDWARE_ATTESTATION') ||
    message.includes('SELF_ATTESTATION_NOT_ALLOWED') ||
    message.includes('ATTESTATION_FORMAT_NOT_ALLOWED') ||
    message.includes('SYNCED_AUTHENTICATOR_NOT_ALLOWED') ||
    message.includes('AAGUID_BLOCKED') ||
    // Kegagalan rantai: sertifikat ada, tapi jalurnya tidak berakhir di anchor
    // yang dipercaya (root belum dipin, rantai tidak tersambung, kedaluwarsa).
    message.includes('CHAIN_TOO_SHORT') ||
    message.includes('CHAIN_NOT_LINKED') ||
    message.includes('CHAIN_UNPARSEABLE') ||
    message.includes('TOP_NOT_SELF_SIGNED') ||
    message.includes('ROOT_NOT_TRUSTED') ||
    message.includes('PINNED_ROOT_UNPARSEABLE') ||
    message.includes('CERTIFICATE_EXPIRED') ||
    message.includes('CERTIFICATE_NOT_YET_VALID') ||
    message.includes('LEAF_IS_CA') ||
    message.includes('TPM_AIK_EKU_MISSING')
  ) {
    return 'registration_attestation_hardware_required';
  }
  if (message.includes('USER_VERIFICATION_REQUIRED')) return 'registration_attestation_user_verification';
  return 'registration_attestation_invalid';
}
