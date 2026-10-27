// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-07] Kunci Redis per job cron.
 *
 * `deploy.yml` menjalankan `pm2 start … -i max`: setiap worker menjalankan
 * `node-cron` sendiri, jadi tanpa kunci keempat worker menghapus baris yang
 * sama, mengunggah arsip snapshot KT ke R2 empat kali (nama objek sama → saling
 * timpa, hitungan metrik 4×), dan membangun ulang snapshot PIR empat kali.
 *
 * Aturan yang dijaga:
 *  - **Satu pemegang** per nama job: `SET job:<name> <token> NX EX <ttl>`
 *    (objek opsi, bukan argumen posisional — bentuk posisional diabaikan
 *    node-redis 6, lihat audit F-01).
 *  - **Dilepas dengan aman**: hanya bila token kita yang masih tersimpan
 *    (Lua compare-and-delete). Tanpa ini, job yang selesai lebih cepat dari TTL
 *    akan menahan worker lain sampai TTL habis, dan job yang lambat bisa
 *    menimpa kunci milik worker lain.
 *  - **TTL selalu ada**: worker yang mati di tengah job tidak boleh mengunci
 *    job itu selamanya.
 *  - **Fail-closed**: Redis tidak bisa dihubungi → job dilewati dan dicatat.
 *    Menjalankan job di semua worker saat Redis down justru yang ingin dicegah;
 *    kerja yang terlewat dilanjutkan pada jadwal berikutnya.
 */

import { randomUUID } from 'node:crypto'
import { redisClient } from '../lib/redis.js'

export type JobLockOutcome = 'ran' | 'busy' | 'unavailable'

/** Bagian klien Redis yang dipakai kunci; cukup sempit agar bisa di-fake di test. */
export interface JobLockRedis {
  set (key: string, value: string, options: { NX: true; EX: number }): Promise<string | null>
  eval (script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export interface JobLockDeps {
  redis?: JobLockRedis
  log?: (message: string) => void
  /** Token unik per percobaan; di-override hanya oleh test. */
  token?: () => string
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

/**
 * Jalankan `run` hanya bila worker ini mendapat kunci `job:<name>`.
 *
 * @param ttlSeconds batas atas umur kunci — harus lebih besar dari durasi normal
 *   job, karena kunci hanya dilepas saat `run` selesai (atau TTL habis bila
 *   proses mati).
 */
export async function runWithJobLock (
  name: string,
  ttlSeconds: number,
  run: () => Promise<void>,
  deps: JobLockDeps = {}
): Promise<JobLockOutcome> {
  const redis = deps.redis ?? (redisClient as unknown as JobLockRedis)
  const log = deps.log ?? ((message: string) => console.warn(message))
  const key = `job:${name}`
  const token = (deps.token ?? randomUUID)()

  let acquired: string | null
  try {
    acquired = await redis.set(key, token, { NX: true, EX: ttlSeconds })
  } catch (error) {
    log(`[job:${name}] dilewati: kunci Redis tidak bisa diambil (${(error as Error).message})`)
    return 'unavailable'
  }
  if (acquired !== 'OK') return 'busy'

  try {
    await run()
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] })
    } catch (error) {
      // Kunci akan habis sendiri lewat TTL; jangan menutupi hasil job.
      log(`[job:${name}] kunci tidak bisa dilepas (${(error as Error).message}) — menunggu TTL`)
    }
  }
  return 'ran'
}
