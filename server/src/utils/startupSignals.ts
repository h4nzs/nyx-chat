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
        'ABUSE_REGISTRATION_GUARD tidak menyala di production: tidak ada batas burst pendaftaran per IP/instalasi/ASN. Set `on` (atau `shadow` dulu untuk mengukur) — lihat docs/10 §10.6.'
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
