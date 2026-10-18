// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R11 2026-10-15] Isyarat keadaan konfigurasi anti-abuse saat boot.
 *
 * Kenapa perlu: `ABUSE_REGISTRATION_GUARD` dan `ABUSE_REQUIRE_ATTESTATION`
 * default-nya `off`. Deployment produksi yang lupa menyalakannya **tampak
 * sempurna** — tidak ada error, tidak ada penolakan, tidak ada log — hanya saja
 * tidak ada perlindungan terhadap pendaftaran massal. Satu-satunya cara
 * mengetahuinya waktu itu adalah mengingat env-nya.
 *
 * Modul ini membuat keadaan itu eksplisit dalam dua bentuk yang bisa dipantau:
 *   1. **gauge** `nyx_abuse_guard_enabled{guard=…}` (1 = menyala, 0 = tidak) →
 *      alert `NyxAbuseGuardDisabled` (`ops/prometheus/alerts.yml`);
 *   2. **peringatan log** saat boot, termasuk peringatan untuk kebijakan
 *      `/api/admin/cleanup` (R6) yang juga mudah lupa dikonfigurasi.
 *
 * Logikanya murni (tanpa I/O) supaya bisa diuji tanpa menjalankan server.
 */

import { parseRegistrationGuardMode, isKnownRegistrationGuardModeValue } from './registrationGuard.js'
import { adminCleanupConfigWarnings } from './adminCleanupAuth.js'

export interface AbuseGuardEnv {
  ABUSE_REGISTRATION_GUARD?: string | undefined
  ABUSE_REQUIRE_ATTESTATION?: string | undefined
  ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN?: string | undefined
  ABUSE_ATTESTATION_ALLOW_NONE?: string | undefined
  ABUSE_ATTESTATION_ALLOW_UNATTESTED?: string | undefined
  ABUSE_ATTESTATION_ROOTS?: string | undefined
  ABUSE_ATTESTATION_ROOTS_FILE?: string | undefined
  ADMIN_CLEANUP_SECRET?: string | undefined
  ADMIN_CLEANUP_IP_ALLOWLIST?: string | undefined
  CHAT_SECRET?: string | undefined
  NODE_ENV?: string | undefined
}

export interface AbuseGuardState {
  /** Nama guard (label metrik). */
  guard: 'registration' | 'attestation'
  /** 1 = perlindungan aktif, 0 = tidak (termasuk mode `shadow`). */
  enabled: 0 | 1
  /** Mode efektif untuk log: `on`/`shadow`/`off`. */
  mode: string
}

/**
 * Keadaan guard. Mode `shadow` dihitung **0**: ia mengevaluasi penuh tapi tidak
 * menahan siapa pun, jadi secara perlindungan ia setara `off` — perbedaannya
 * hanya berguna untuk pengukuran, dan itu sudah terlihat di
 * `nyx_registration_guard_observed_total`.
 */
export function abuseGuardStates(env: AbuseGuardEnv): AbuseGuardState[] {
  const rawGuard = env.ABUSE_REGISTRATION_GUARD
  const known = isKnownRegistrationGuardModeValue(rawGuard)
  const guardMode = known ? parseRegistrationGuardMode(rawGuard) : 'off'

  const rawAttestation = (env.ABUSE_REQUIRE_ATTESTATION ?? '').trim().toLowerCase()
  const attestationMode = rawAttestation === '' ? 'off' : rawAttestation

  return [
    { guard: 'registration', enabled: guardMode === 'on' ? 1 : 0, mode: guardMode },
    { guard: 'attestation', enabled: attestationMode === 'on' ? 1 : 0, mode: attestationMode },
  ]
}

/**
 * Peringatan boot (tanpa efek samping, hanya string). Dipisah dari `console.*`
 * supaya urutan/isi pesannya bisa diuji persis.
 */
export function startupWarnings(env: AbuseGuardEnv): string[] {
  const warnings: string[] = []
  const isProd = env.NODE_ENV === 'production'

  const rawGuard = env.ABUSE_REGISTRATION_GUARD
  if (!isKnownRegistrationGuardModeValue(rawGuard)) {
    warnings.push(
      `ABUSE_REGISTRATION_GUARD="${rawGuard ?? ''}" bukan nilai yang dikenali → diperlakukan "off". Nilai sah: on | shadow | off.`
    )
  }
  const guardMode = isKnownRegistrationGuardModeValue(rawGuard) ? parseRegistrationGuardMode(rawGuard) : 'off'

  if (isProd) {
    if (guardMode === 'off') {
      warnings.push(
        'ABUSE_REGISTRATION_GUARD tidak menyala di production: tidak ada batas burst pendaftaran per IP/instalasi/ASN. Set `on` (atau `shadow` dulu untuk mengukur) — checklist docs/10 §10.16, tabel env-nya §10.6.'
      )
    } else if (guardMode === 'shadow') {
      warnings.push(
        'ABUSE_REGISTRATION_GUARD=shadow: guard hanya MENGUKUR, tidak menahan siapa pun. Jadwalkan peralihan ke `on` setelah false-positive NAT besar terukur.'
      )
    }
    if ((env.ABUSE_REQUIRE_ATTESTATION ?? '').trim().toLowerCase() !== 'on') {
      warnings.push(
        'ABUSE_REQUIRE_ATTESTATION tidak menyala di production: akun baru tidak wajib attestation perangkat. Attestation tetap dipicu heuristik burst sybil per-ASN bila ASN_DB_FILE diisi.'
      )
    }
  }

  // [docs/30 §30.12 WS-H] Kebijakan rantai attestation: dua keadaan yang mudah
  // salah dan tidak menghasilkan error sampai ada user sungguhan yang mendaftar.
  const attestationOn = (env.ABUSE_REQUIRE_ATTESTATION ?? '').trim().toLowerCase() === 'on'
  if (attestationOn) {
    if ((env.ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN ?? '').trim().toLowerCase() === 'on') {
      warnings.push(
        'ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=on: verifikasi rantai attestation DIMATIKAN. Sertifikat self-signed buatan siapa pun dapat masuk tier "hardware". Set `off` + pin root vendor di ABUSE_ATTESTATION_ROOTS_FILE (docs/10 §10.16).'
      )
    } else if (!(env.ABUSE_ATTESTATION_ROOTS ?? '').trim() && !(env.ABUSE_ATTESTATION_ROOTS_FILE ?? '').trim()) {
      warnings.push(
        'Rantai attestation diperiksa ketat tapi belum ada root yang dipin: rantai perangkat nyata yang `x5c`-nya berhenti di intermediate (TPM/Apple/YubiKey) akan ditolak. Isi ABUSE_ATTESTATION_ROOTS_FILE dengan root vendor (docs/10 §10.16).'
      )
    }

    // [2026-10-18] `ALLOW_NONE=on` membuat gerbang menerima passkey tersinkron
    // (`fmt: none`, `multiDevice`) — alur default Android/iOS. Tanpa peringatan
    // ini, satu env terlihat seperti "attestation menyala" padahal tidak ada
    // bukti perangkat yang diperiksa sama sekali, dan akun hasil jalur itu juga
    // tidak ditandai terverifikasi (`isVerified: tier === 'hardware'`).
    if ((env.ABUSE_ATTESTATION_ALLOW_NONE ?? '').trim().toLowerCase() === 'on') {
      warnings.push(
        'ABUSE_ATTESTATION_ALLOW_NONE=on: pendaftaran menerima attestation `none` (passkey tersinkron) — gate TIDAK membuktikan perangkat keras lagi, hanya authenticator ber-UV. Akun lewat jalur ini dibuat dengan isVerified=false; sybil resistance bergantung pada Turnstile + ABUSE_REGISTRATION_GUARD (docs/10 §10.16). Jangan lupa menambahkan `none` ke ABUSE_ATTESTATION_FORMATS.'
      )
    }

    // [2026-10-18] Jalur "perangkat tanpa authenticator sama sekali": akun
    // dibuat tanpa bukti apa pun, jadi isVerified=false dan sandbox tetap aktif.
    // Peringatan ini mencegahnya terlupakan sebagai keadaan permanen.
    if ((env.ABUSE_ATTESTATION_ALLOW_UNATTESTED ?? '').trim().toLowerCase() === 'on') {
      warnings.push(
        'ABUSE_ATTESTATION_ALLOW_UNATTESTED=on: perangkat tanpa authenticator boleh mendaftar tanpa bukti. Akun tersebut isVerified=false (upload & pencarian luas tetap tertutup) dan jalur burst sybil per-ASN TIDAK bisa memakainya. Sybil resistance bergantung pada Turnstile + ABUSE_REGISTRATION_GUARD (docs/10 §10.16).'
      )
    }
  }

  warnings.push(
    ...adminCleanupConfigWarnings({
      cleanupSecret: env.ADMIN_CLEANUP_SECRET,
      chatSecret: env.CHAT_SECRET,
      ipAllowlist: env.ADMIN_CLEANUP_IP_ALLOWLIST,
      nodeEnv: env.NODE_ENV,
    })
  )

  return warnings
}
