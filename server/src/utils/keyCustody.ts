// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P6] Custody kunci at-rest — abstraksi provider, TANPA klaim HSM.
 *
 * Kenapa dipisah: `atRestSecrets.ts` butuh **satu** hal saja dari custody, yaitu
 * materi key ring. Kalau pembacaan env/file ditanam di sana, setiap tes keyring
 * harus mengotori env dan tidak ada tempat untuk menambah provider (systemd-creds,
 * Vault, file 0400) tanpa menyentuh kode kripto.
 *
 * Yang tersedia sekarang:
 *  - `env`  — nilai di environment (`NYX_AT_REST_KEYRING`). Paling sederhana,
 *             tetapi environment bocor lewat `ps`/crash report/dump proses.
 *  - `file` — path di `NYX_AT_REST_KEYRING_FILE` (hasil
 *             `systemd-creds decrypt --with-key=host … -`), dibaca sekali saat
 *             keyring dimuat. File dengan izin longgar memicu peringatan, bukan
 *             penolakan, supaya deploy tidak mati karena umask.
 *
 * Yang TIDAK diklaim: ini bukan HSM/TEE. Kunci tetap berada di memori proses
 * `nyx-api`, dan root di host tetap bisa membacanya. Status di
 * `/api/admin/system-status` hanya menyebut **ada/tidak** dan sumbernya, tidak
 * pernah nilainya.
 */

import { readFileSync, statSync } from 'node:fs'

export type KeyCustodyProvider = 'env' | 'file' | 'none'

export interface CustodySecret {
  /** Materi mentah (JSON keyring atau secret lain), sudah di-trim. */
  material: string | null
  provider: KeyCustodyProvider
  /** Nama env var atau path file — bukan rahasia, aman ditampilkan ke admin. */
  source: string | null
}

export interface CustodyOptions {
  envVar: string
  fileVar: string
}

const warnedLoosePermissions = new Set<string>()

function warnLoosePermissions (path: string): void {
  if (warnedLoosePermissions.has(path)) return
  try {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      warnedLoosePermissions.add(path)
      console.warn(
        `[keyCustody] ${path} dapat dibaca grup/lainnya (mode ${mode.toString(8)}). ` +
          'Untuk kunci at-rest, gunakan 0400/0600 (systemd-creds sudah begitu).'
      )
    }
  } catch {
    // stat gagal = file menghilang setelah dibaca; bukan urusan pemeriksaan izin.
  }
}

/**
 * Baca secret custody. Urutan: env dulu (deploy cepat / dev), lalu file
 * (produksi selfhost). Keduanya kosong → `provider: 'none'`.
 *
 * Tidak melempar untuk file yang hilang: pemanggil memutuskan apakah kondisi
 * itu fatal (keyring: fallback legacy + peringatan; pepper: throw di produksi).
 */
export function readCustodySecret (opts: CustodyOptions): CustodySecret {
  const fromEnv = (process.env[opts.envVar] ?? '').trim()
  if (fromEnv) return { material: fromEnv, provider: 'env', source: opts.envVar }

  const path = (process.env[opts.fileVar] ?? '').trim()
  if (!path) return { material: null, provider: 'none', source: null }

  try {
    const material = readFileSync(path, 'utf8').trim()
    if (!material) return { material: null, provider: 'none', source: null }
    warnLoosePermissions(path)
    return { material, provider: 'file', source: path }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN'
    console.warn(`[keyCustody] ${opts.fileVar}=${path} tidak bisa dibaca: ${reason}`)
    return { material: null, provider: 'none', source: null }
  }
}

/** Status untuk `/api/admin/system-status` — tidak memuat nilai rahasia. */
export function custodyStatus (opts: CustodyOptions): {
  provider: KeyCustodyProvider
  configured: boolean
  source: string | null
} {
  const read = readCustodySecret(opts)
  return { provider: read.provider, configured: read.material !== null, source: read.source }
}
