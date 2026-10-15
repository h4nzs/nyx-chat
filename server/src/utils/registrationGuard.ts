// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Anti-abuse registrasi bertingkat **tanpa PII**.
 *
 * Masalah: pendaftaran massal (sybil) membuat satu sumber membuat ratusan akun
 * dalam hitungan menit. Yang TIDAK boleh dilakukan: menyimpan IP mentah,
 * memasang CAPTCHA baru, atau ML atas data pribadi.
 *
 * Lapisan (semua counter Redis atomik INCR+EXPIRE, fail-open bila infra error):
 *
 *   1. **per sumber** — IP di-HMAC dengan pepper (`pepperedIdentifier('ip:'+ip)`),
 *   2. **per instalasi** — `deviceInstallationTag` (`Device.installationTag`),
 *   3. **per jaringan (ASN)** — ASN di-HMAC; ASN diperoleh dari tabel lokal
 *      (`utils/asnLookup.ts`, tanpa layanan pihak ketiga) dan **IP mentah tidak
 *      pernah ditulis**. Batas keras: akun ke-100 dari satu ASN dalam satu jam
 *      ditahan (kriteria §30.12).
 *   4. **heuristik burst** — paket pendaftaran cepat dari satu ASN (jendela 10
 *      menit) tidak langsung diblokir, tetapi **mewajibkan attestation perangkat**
 *      (WS-H langkah 2). Ini yang membedakan kantor ber-NAT besar (40 akun
 *      tersebar sepanjang jam, jarang menumpuk di 10 menit) dari sybil.
 *
 * Fail-open (NaN dari Redis) berarti infra error tidak memblokir trafik sah —
 * preseden limiter lain di repo.
 */

import { ApiError } from './errors.js';
import { deviceInstallationTag, pepperedIdentifier } from './atRestSecrets.js';
import { asnIndexFromEnv, lookupAsn } from './asnLookup.js';
import { incCounter, REGISTRATION_GUARD_OBSERVED } from './metrics.js';

/** Jendela burst (detik) — 1 jam. */
export const REGISTRATION_BURST_WINDOW_SECONDS = 3600;

/** Jendela velocity untuk heuristik sybil (detik) — 10 menit. */
export const REGISTRATION_SYBIL_WINDOW_SECONDS = 600;

/** Maksimum registrasi per sumber (IP-hash) dalam satu jendela. */
export const REGISTRATION_MAX_PER_SOURCE = 20;

/** Maksimum registrasi per instalasi (klien/browser) dalam satu jendela. */
export const REGISTRATION_MAX_PER_INSTALLATION = 10;

/**
 * Batas keras per ASN dalam satu jam. Akun ke-100 sudah ditahan (kriteria
 * §30.12: "100 akun dari satu ASN dalam 1 jam → tertahan").
 */
export const REGISTRATION_MAX_PER_ASN = 100;

/**
 * Ambang burst per ASN dalam 10 menit yang memicu **kewajiban attestation**.
 * Sengaja di bawah batas keras: sinyal awal, bukan blokir, supaya jaringan besar
 * yang sah tidak dikunci hanya karena ramai.
 */
export const REGISTRATION_SYBIL_BURST_MAX_PER_ASN = 25;

export type RegistrationCounterFn = (key: string, ttlSeconds: number) => Promise<number>;

/**
 * Mode guard (`ABUSE_REGISTRATION_GUARD`):
 *
 *   - `off` (default) — no-op, tidak menyentuh Redis.
 *   - `shadow` — **evaluasi penuh, tidak menahan siapa pun**: verdict dicatat ke
 *     metrik `nyx_registration_guard_observed_total{action="would_*"}` dan log.
 *     Ini jalur untuk mengukur false-positive jaringan besar (NAT kantor) di
 *     lapangan sebelum menyalakan blokir — tanpa mengubah perilaku satu pun
 *     pengguna, dan tanpa menyimpan identitas apa pun.
 *   - `on` — berlaku penuh: batas keras → 429, heuristik burst → wajib attestation.
 *
 * Mode tak dikenal dibaca sebagai `off` (fail-open, pola env lain di repo) dan
 * dicatat — jangan biarkan salah tulis env mengunci registrasi.
 */
export type RegistrationGuardMode = 'off' | 'shadow' | 'on';

export function parseRegistrationGuardMode(value: string | undefined | null): RegistrationGuardMode {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return 'on';
  if (normalized === 'shadow') return 'shadow';
  return 'off';
}

/** True bila env berisi nilai yang dikenali (`on`/`true`/`1`/`shadow`/`off`/kosong). */
export function isKnownRegistrationGuardModeValue(value: string | undefined | null): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '' || ['on', 'true', '1', 'shadow', 'off', 'false', '0'].includes(normalized);
}

/** Ringkasan keputusan guard untuk observabilitas (tanpa identitas apa pun). */
export interface RegistrationGuardObservation {
  mode: RegistrationGuardMode;
  /** Keputusan yang **akan** diambil mode `on` (dipakai juga oleh mode `on`). */
  verdict: RegistrationBurstVerdict;
  /** Nilai counter mentah (tanpa identitas) — untuk log diagnostik operator. */
  counts: { source: number | null; installation: number | null; asn: number | null; asnBurst: number | null };
}

/** Nama label `reason` untuk metrik (bounded — tidak ada nilai runtime). */
const observationReason = (verdict: RegistrationBurstVerdict): string =>
  verdict.reason ?? (verdict.requireAttestation ? 'BURST' : 'none');

export interface RegistrationBurstInput {
  sourceCount: number;
  /** `null` bila klien tidak mengirim installation id. */
  installationCount: number | null;
  /** `null`/undefined bila tabel ASN tidak tersedia (lapisan dilewati). */
  asnCount?: number | null;
  /** Jumlah registrasi ASN yang sama dalam jendela 10 menit. */
  asnBurstCount?: number | null;
}

export interface RegistrationBurstVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: 'SOURCE' | 'INSTALLATION' | 'ASN';
  /** True = lanjut tapi wajib attestation perangkat (heuristik burst). */
  requireAttestation: boolean;
}

/** Angka tak terhingga/NaN (Redis error) diperlakukan **di bawah batas**. */
const isOver = (count: number | null | undefined, limit: number, inclusive = false): boolean =>
  typeof count === 'number' && Number.isFinite(count) && (inclusive ? count >= limit : count > limit);

/**
 * Keputusan murni. Urutan penting: blokir keras dulu (sumber → instalasi → ASN),
 * baru sinyal sybil.
 */
export function evaluateRegistrationBurst(input: RegistrationBurstInput): RegistrationBurstVerdict {
  if (isOver(input.sourceCount, REGISTRATION_MAX_PER_SOURCE)) {
    return { allowed: false, retryAfterSeconds: REGISTRATION_BURST_WINDOW_SECONDS, reason: 'SOURCE', requireAttestation: false };
  }
  if (isOver(input.installationCount, REGISTRATION_MAX_PER_INSTALLATION)) {
    return { allowed: false, retryAfterSeconds: REGISTRATION_BURST_WINDOW_SECONDS, reason: 'INSTALLATION', requireAttestation: false };
  }
  // Batas ASN inklusif: akun ke-100 dalam satu jam sudah ditahan.
  if (isOver(input.asnCount, REGISTRATION_MAX_PER_ASN, true)) {
    return { allowed: false, retryAfterSeconds: REGISTRATION_BURST_WINDOW_SECONDS, reason: 'ASN', requireAttestation: false };
  }
  const requireAttestation = isOver(input.asnBurstCount, REGISTRATION_SYBIL_BURST_MAX_PER_ASN, true);
  return { allowed: true, requireAttestation };
}

/** Key counter per sumber — hanya memuat IP ter-HMAC (bukan IP mentah). */
export const registrationSourceKey = (ip: string): string =>
  `regburst:src:${pepperedIdentifier(`ip:${ip}`)}`;

/** Key counter per instalasi — memakai tag instalasi (HMAC pepper). */
export const registrationInstallationKey = (installationId: string): string =>
  `regburst:inst:${deviceInstallationTag(installationId)}`;

/** Key counter per jaringan — ASN ter-HMAC (bukan nomor jaringan mentah). */
export const registrationAsnKey = (asn: string): string =>
  `regburst:asn:${pepperedIdentifier(`asn:${asn}`)}`;

/** Key counter velocity (10 menit) per jaringan. */
export const registrationAsnBurstKey = (asn: string): string =>
  `regburst:asnfast:${pepperedIdentifier(`asn:${asn}`)}`;

/**
 * Gate dengan counter yang dapat disuntik.
 *
 * `mode` boleh berupa boolean untuk pemanggil lama (`true` = `on`, `false` =
 * `off`). Mode `on` melempar `ApiError(429)` saat salah satu tingkat keras
 * terlampaui dan mengembalikan `requireAttestation` saat heuristik burst menyala;
 * mode `shadow` mengembalikan keputusan yang sama **tanpa menahan**, plus
 * `observation` supaya pemanggil bisa mencatatnya.
 */
export const makeRegistrationGuard =
  (incr: RegistrationCounterFn, mode: RegistrationGuardMode | boolean = 'off') =>
  async (opts: {
    ip: string;
    installationId?: string;
    asn?: string | null;
    /** Dipanggil pada mode `shadow` dengan keputusan hipotetis (log/metrik). */
    onObservation?: (observation: RegistrationGuardObservation) => void;
  }): Promise<{ requireAttestation: boolean; observation?: RegistrationGuardObservation }> => {
    const effectiveMode: RegistrationGuardMode = typeof mode === 'boolean' ? (mode ? 'on' : 'off') : mode;
    if (effectiveMode === 'off') return { requireAttestation: false };

    const sourceCount = await incr(registrationSourceKey(opts.ip), REGISTRATION_BURST_WINDOW_SECONDS);
    const installationCount = opts.installationId
      ? await incr(registrationInstallationKey(opts.installationId), REGISTRATION_BURST_WINDOW_SECONDS)
      : null;

    let asnCount: number | null = null;
    let asnBurstCount: number | null = null;
    if (opts.asn) {
      asnCount = await incr(registrationAsnKey(opts.asn), REGISTRATION_BURST_WINDOW_SECONDS);
      asnBurstCount = await incr(registrationAsnBurstKey(opts.asn), REGISTRATION_SYBIL_WINDOW_SECONDS);
    }

    const verdict = evaluateRegistrationBurst({ sourceCount, installationCount, asnCount, asnBurstCount });

    if (effectiveMode === 'shadow') {
      // Nama label SENGAJA pendek: penjaga di `metrics.ts` menolak nilai label
      // yang berbentuk base64url (≥22 karakter dari [A-Za-z0-9_-]) — dan enum
      // panjang seperti `would_require_attestation` masuk pola itu. Ditolaknya
      // tidak senyap: `nyx_metrics_rejected_total` naik dan alarm KRITIS
      // `NyxMetricsIdentityLeakAttempt` menyala. Nilai pendek = aman.
      const action = !verdict.allowed
        ? 'would_block'
        : verdict.requireAttestation
          ? 'would_attest'
          : 'allowed';
      incCounter(REGISTRATION_GUARD_OBSERVED, { action, reason: observationReason(verdict) });
      const observation: RegistrationGuardObservation = {
        mode: 'shadow',
        verdict,
        counts: { source: sourceCount, installation: installationCount, asn: asnCount, asnBurst: asnBurstCount },
      };
      opts.onObservation?.(observation);
      // Shadow TIDAK pernah mengubah perilaku: tidak memblokir, tidak menuntut
      // attestation. Keputusan hipotetisnya hanya terlihat lewat metrik/log.
      return { requireAttestation: false, observation };
    }

    if (!verdict.allowed) {
      incCounter(REGISTRATION_GUARD_OBSERVED, { action: 'blocked', reason: observationReason(verdict) });
      const scope =
        verdict.reason === 'SOURCE' ? 'network' : verdict.reason === 'INSTALLATION' ? 'device' : 'network operator';
      throw new ApiError(
        429,
        `REGISTRATION_BURST_LIMIT: Too many accounts created from this ${scope}. Please try again later.`
      );
    }
    incCounter(REGISTRATION_GUARD_OBSERVED, {
      action: verdict.requireAttestation ? 'require_attestation' : 'allowed',
      reason: observationReason(verdict),
    });
    return { requireAttestation: verdict.requireAttestation };
  };

/** Lua INCR+EXPIRE atomik (pola yang sama dengan limiter lain). */
const REG_BURST_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * Jalur produksi: `ABUSE_REGISTRATION_GUARD` = `on` | `shadow` | `off`
 * (default `off`; rollback terdokumentasi lewat env, `docs/30` §30.19.5).
 *
 * Redis diimpor dinamis supaya modul ini tetap bisa diuji tanpa Redis; tabel ASN
 * dibaca dari berkas lokal (`ASN_DB_FILE`) dan lapisan ASN dilewati bila berkas
 * tidak ada (lapisan yang dilewati tetap terlihat: `asnCount = null`).
 *
 * Mode `shadow` adalah jalur pengukuran WS-H: keputusan hipotetis dicatat ke
 * `nyx_registration_guard_observed_total` + log operator, perilaku untuk pengguna
 * **tidak berubah sama sekali** (`requireAttestation` selalu false).
 */
export async function enforceRegistrationBurst(opts: {
  ip: string;
  installationId?: string;
}): Promise<{ requireAttestation: boolean }> {
  if (!isKnownRegistrationGuardModeValue(process.env.ABUSE_REGISTRATION_GUARD)) {
    // Fail-open, tapi berisik: salah tulis env tidak boleh diam-diam
    // menonaktifkan guard saat operator mengira sudah `on`.
    console.warn(
      `[RegistrationGuard] ABUSE_REGISTRATION_GUARD="${process.env.ABUSE_REGISTRATION_GUARD}" tak dikenal → diperlakukan "off". Nilai sah: on | shadow | off.`
    );
  }

  const mode = parseRegistrationGuardMode(process.env.ABUSE_REGISTRATION_GUARD);
  if (mode === 'off') return { requireAttestation: false };

  const { redisClient } = await import('../lib/redis.js');
  const incr: RegistrationCounterFn = async (key, ttlSeconds) =>
    Number(await redisClient.eval(REG_BURST_LUA, { keys: [key], arguments: [String(ttlSeconds)] }));

  const asn = lookupAsn(asnIndexFromEnv(), opts.ip);
  return makeRegistrationGuard(incr, mode)({
    ...opts,
    asn,
    onObservation: (observation) => {
      // Tanpa identitas: hanya angka counter + verdict.
      console.warn('[RegistrationGuard][shadow]', {
        wouldBlock: !observation.verdict.allowed,
        reason: observation.verdict.reason ?? null,
        wouldRequireAttestation: observation.verdict.requireAttestation,
        counts: observation.counts,
      });
    },
  });
}
