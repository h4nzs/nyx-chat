// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.6 — Fase 5] Abstraksi suite credential keanggotaan.
 *
 * Credential grup adalah blind signature: klien memilih suite yang ditawarkan
 * issuer (dari `GET /api/conversations/credential-issuer-key`), memakai
 * parameternya untuk blind/finalize, dan server memverifikasi dengan suite yang
 * sama. Sebelum ini, suite adalah string beku di dua tempat (server + worker)
 * sehingga penambahan suite PQ akan menuntut perubahan wire diam-diam.
 *
 * Aturan yang dijaga modul ini:
 *
 * - **Fail-closed.** Suite yang tidak ada di `SUPPORTED_CREDENTIAL_SUITES`
 *   ditolak, bukan ditebak. Server yang menawarkan suite asing tidak boleh
 *   membuat klien menandatangani dengan parameter yang salah.
 * - **Tidak ada downgrade diam-diam.** Klien memakai suite yang ditawarkan
 *   issuer apa adanya; kalau tidak didukung → gagal, jangan jatuh ke v1
 *   (credential v1 untuk grup yang sudah v2 akan ditolak server, dan
 *   kegagalan diam-diam membuat anggota kehilangan akses tanpa pesan jelas).
 * - **`preparePrefixBytes` bagian dari suite.** RSABSSA-...-Randomized
 *   menempelkan prefix acak 32 byte di depan pesan; `credentialClaimFromPrepared`
 *   mengandalkan angka itu. Suite lain wajib mendeklarasikan nilainya sendiri.
 *
 * Status Fase 5: suite v1 (RSA, RFC 9474) tetap satu-satunya suite yang
 * diimplementasikan. BRaccoon/blind UOV **belum** ditambahkan karena belum ada
 * implementasi yang sudah ditinjau; menulis blind signature lattice sendiri
 * bukan pilihan (lihat docs/35 §35.11). Interface-nya sudah siap: menambah
 * suite = menambah entri di daftar ini + implementasi `blind/blindSign/finalize/
 * verify` di worker/server.
 */

/** ID suite v1: RSABSSA-SHA384-PSS-Randomized (RFC 9474). */
export const CREDENTIAL_SUITE_RSA_V1 = 'RSABSSA-SHA384-PSS-Randomized' as const;

export type CredentialSuiteId = typeof CREDENTIAL_SUITE_RSA_V1;

export interface CredentialSuiteInfo {
  readonly id: CredentialSuiteId;
  /** Versi parameter suite; naik bila ukuran/format berubah. */
  readonly keyVersion: number;
  /** Byte prefix acak yang ditambahkan `prepare()` sebelum pesan asli. */
  readonly preparePrefixBytes: number;
  /** True bila suite sudah PQ (belum ada). */
  readonly postQuantum: boolean;
}

export const CREDENTIAL_SUITES: readonly CredentialSuiteInfo[] = [
  {
    id: CREDENTIAL_SUITE_RSA_V1,
    keyVersion: 1,
    preparePrefixBytes: 32,
    postQuantum: false,
  },
];

export const SUPPORTED_CREDENTIAL_SUITE_IDS: readonly string[] = CREDENTIAL_SUITES.map(
  (suite) => suite.id
);

/** True bila `id` adalah suite yang benar-benar diimplementasikan klien ini. */
export function isSupportedCredentialSuite(id: unknown): id is CredentialSuiteId {
  return typeof id === 'string' && SUPPORTED_CREDENTIAL_SUITE_IDS.includes(id);
}

/** Info suite; `undefined` bila tidak didukung. */
export function credentialSuiteInfo(id: unknown): CredentialSuiteInfo | undefined {
  if (!isSupportedCredentialSuite(id)) return undefined;
  return CREDENTIAL_SUITES.find((suite) => suite.id === id);
}

/**
 * Pilih suite yang ditawarkan issuer. Gagal (throw) bila tidak didukung —
 * jangan pernah mengganti diam-diam ke suite default.
 */
export function requireCredentialSuite(id: unknown): CredentialSuiteInfo {
  const info = credentialSuiteInfo(id);
  if (!info) {
    throw new Error(
      `[credentials] suite tidak didukung: ${String(id)} (didukung: ${SUPPORTED_CREDENTIAL_SUITE_IDS.join(', ')})`
    );
  }
  return info;
}
