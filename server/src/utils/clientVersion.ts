// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-15] Gerbang **versi klien minimum** — sisi server dari temuan
 * "legacy purge = breaking change yang gagal diam-diam".
 *
 * Konteksnya: sejak 2026-10-10, envelope distribusi sender-key v0/v1 tidak lagi
 * dibaca (`handleGroupKeyDistribution` menolaknya) dan metadata grup non-v2
 * menjadi `null`. Klien lama yang masih tersimpan di service worker/PWA akan
 * **kehilangan pesan grup tanpa error**. Sisi UI sudah diperbaiki (pesan sistem +
 * toast, lihat `crypto.ts` / `common:security_legacy_group_key`); modul ini
 * menutup sisi yang lain: memberi klien lama **penolakan yang jelas** alih-alih
 * perilaku setengah jalan.
 *
 * Kontrak header:
 *   - Klien mengirim `x-nyx-client-version: <versi build>` (dari `__APP_VERSION__`,
 *     `web/src/lib/api.ts`).
 *   - Operator menyetel `MIN_CLIENT_VERSION` (mis. `3.0.0`). Kosong = gerbang mati.
 *
 * Dua kelonggaran yang **disengaja**, dan keduanya penting supaya gerbang ini
 * tidak berubah menjadi pemadaman:
 *
 *   1. **Tanpa `MIN_CLIENT_VERSION` → semua lolos.** Gerbang hanya menyala bila
 *      operator memintanya.
 *   2. **Header tidak ada / tidak bisa dibaca → lolos** (fail-open). Semua klien
 *      yang dirilis sebelum 3.0.0 tidak mengirim header ini — menolaknya berarti
 *      mematikan basis pengguna yang sudah ada, bukan memberi mereka jalan
 *      keluar. Karena itu gerbang ini mengikat **mulai 3.0.0**: klien 3.0.0+ yang
 *      terlalu tua untuk protokol terkini akan ditolak; prapenanda-versi apa pun
 *      tetap harus diurus lewat catatan rilis/migrasi.
 *
 * [D1 2026-10-27] Kelonggaran #2 membuat gerbang ini **tidak bisa** dipakai
 * sebagai kontrol keamanan: penyerang cukup tidak mengirim header untuk lolos.
 * Karena itu ada mode ketat yang eksplisit (`CLIENT_VERSION_REQUIRE_MUTATIONS=1`
 * → `requireMutations`): request **mutasi** (selain GET/HEAD/OPTIONS) tanpa
 * header versi yang bisa dibaca ditolak, sedangkan **baca tetap fail-open**
 * supaya klien lama masih bisa melihat data dan mendapat pesan yang jelas saat
 * mencoba menulis. Default tetap longgar — mode ini menyalakan perilaku baru,
 * jadi operator harus memilihnya sadar (mis. saat cutover protokol), bukan
 * mendapatkannya diam-diam setelah upgrade.
 *
 * Logikanya murni (tanpa I/O) supaya bisa diuji tanpa menjalankan server;
 * pemasangan middleware-nya ada di `middleware/clientVersion.ts`.
 */

export interface ClientVersionPolicy {
  /** `MIN_CLIENT_VERSION` — kosong/tak diisi = gerbang mati. */
  minimumVersion?: string | undefined
  /**
   * `CLIENT_VERSION_REQUIRE_MUTATIONS=1` — [D1] tolak request **mutasi** yang
   * tidak menyertakan header versi terbaca. Baca (GET/HEAD/OPTIONS) tetap
   * fail-open; lihat komentar modul untuk alasannya.
   */
  requireMutations?: boolean | undefined
}

export type ClientVersionReason =
  | 'no-minimum'
  | 'no-header'
  | 'ok'
  | 'too-old'
  /** Mode ketat: mutasi tanpa header versi yang bisa diurai. */
  | 'strict-no-header'

/** Metode yang dianggap **baca** — satu-satunya yang tetap fail-open di mode ketat. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Apakah metode ini mengubah state? Apa pun yang bukan GET/HEAD/OPTIONS
 * dihitung mutasi (termasuk metode tak dikenal: menolak lebih aman daripada
 * menganggapnya baca).
 */
export function isMutationMethod(method: string | undefined | null): boolean {
  if (typeof method !== 'string') return false
  return !READ_METHODS.has(method.trim().toUpperCase())
}

export interface ClientVersionDecision {
  ok: boolean;
  reason: ClientVersionReason;
  /** Versi klien yang terbaca (hanya bila header bisa diurai). */
  clientVersion?: string | undefined;
  /** Versi minimum yang berlaku (hanya bila kebijakannya bisa diurai). */
  minimumVersion?: string | undefined;
}

/**
 * Urai versi semver longgar: `3.0.0`, `v3.0.0`, `web/3.0.0`, `3.0`,
 * `3.0.0+build.7`, `3.0.0-beta.1`. Semua yang tidak mengandung tiga angka
 * → `null` (diperlakukan "tidak diketahui", bukan "paling tua": tebakan
 * "paling tua" akan menolak klien sah yang formatnya kebetulan tidak dikenal).
 */
export function parseClientVersion(raw: string | undefined | null): { major: number; minor: number; patch: number; normalized: string } | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > 64) return null

  // Ambil token versi terakhir dari bentuk seperti `web/3.0.0` atau `nyx 3.0.0`.
  const token = trimmed.split(/[/\s]+/).filter(Boolean).pop() ?? ''
  const withoutPrefix = token.replace(/^v/i, '')
  // Buang metadata build (`+…`) dan prarilis (`-…`): gerbang ini soal
  // kompatibilitas protokol, bukan urutan rilis.
  const core = (withoutPrefix.split('+')[0] ?? '').split('-')[0] ?? ''
  const match = /^(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?$/.exec(core)
  if (!match) return null

  const [, majorRaw, minorRaw, patchRaw] = match
  if (majorRaw === undefined) return null
  const major = Number(majorRaw)
  const minor = Number(minorRaw ?? '0')
  const patch = Number(patchRaw ?? '0')
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null

  return { major, minor, patch, normalized: `${major}.${minor}.${patch}` }
}

/** −1 / 0 / 1 untuk `a` relatif terhadap `b`. Bagian yang tidak ada = 0. */
export function compareClientVersions(a: string, b: string): number | null {
  const left = parseClientVersion(a)
  const right = parseClientVersion(b)
  if (!left || !right) return null

  const pairs: Array<[number, number]> = [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ]
  for (const [lv, rv] of pairs) {
    if (lv !== rv) return lv < rv ? -1 : 1
  }
  return 0
}

/**
 * Putuskan boleh/tidak. Urutan: kebijakan dulu (tanpa minimum = lolos), lalu
 * keterbacaan header (tidak terbaca = lolos, kecuali mutasi di mode ketat),
 * baru perbandingan.
 */
export function evaluateClientVersion(
  header: unknown,
  policy: ClientVersionPolicy = {},
  method: string = 'GET'
): ClientVersionDecision {
  const minimum = parseClientVersion(policy.minimumVersion)
  if (!minimum) return { ok: true, reason: 'no-minimum' }

  const client = typeof header === 'string' ? parseClientVersion(header) : null
  if (!client) {
    if (policy.requireMutations === true && isMutationMethod(method)) {
      return { ok: false, reason: 'strict-no-header', minimumVersion: minimum.normalized }
    }
    return { ok: true, reason: 'no-header', minimumVersion: minimum.normalized }
  }

  if (compareClientVersions(client.normalized, minimum.normalized) === -1) {
    return {
      ok: false,
      reason: 'too-old',
      clientVersion: client.normalized,
      minimumVersion: minimum.normalized,
    }
  }
  return { ok: true, reason: 'ok', clientVersion: client.normalized, minimumVersion: minimum.normalized }
}

/**
 * Pesan yang dilihat pengguna klien lama. Sengaja menyebut versi minimum dan
 * langkah yang bisa dilakukan pengguna awam (muat ulang / pasang ulang PWA):
 * penolakan yang tidak bisa ditindaklanjuti sama buruknya dengan kegagalan senyap.
 */
export function clientVersionRejectionMessage(decision: ClientVersionDecision): string {
  const minimum = decision.minimumVersion ?? 'terbaru'
  if (decision.reason === 'strict-no-header') {
    // Bedanya dengan `too-old`: di sini servernya tidak tahu versi klien, hanya
    // tahu klien tidak menyatakannya. Pesannya tetap menyebut minimum supaya
    // pengguna punya angka konkret yang bisa dicocokkan dengan halaman rilis.
    return `Versi NYX ini tidak bisa diverifikasi — minimal ${minimum}. `
      + 'Muat ulang halaman; bila masih sama, tutup dan buka lagi aplikasi (PWA) atau pasang ulang dari situs NYX.'
  }
  return `Versi NYX ini (${decision.clientVersion ?? 'tidak diketahui'}) tidak lagi didukung — minimal ${minimum}. `
    + 'Muat ulang halaman; bila masih sama, tutup dan buka lagi aplikasi (PWA) atau pasang ulang dari situs NYX.'
}
