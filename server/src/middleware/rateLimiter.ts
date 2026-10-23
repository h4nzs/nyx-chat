import rateLimit from 'express-rate-limit'
import { env } from '../config.js'
import { RedisStore } from 'rate-limit-redis'
import { redisClient } from '../lib/redis.js'
import { Request, Response, NextFunction } from 'express';
import { clientIpTag } from '../utils/clientIp.js'
import { searchRateKey } from '../utils/searchRateKey.js'
import { ADMIN_CLEANUP, incCounter } from '../utils/metrics.js'

// Secure IP Extractor: prioritas pada CF-Connecting-IP — melalui edge/tunnel
// Cloudflare header ini SELALU ditimpa CF dengan IP klien asli (tidak bisa
// dipalsukan), sedangkan X-Forwarded-For membawa entri palsu di posisi depan
// sehingga req.ip (hasil trust proxy) bisa jatuh ke entri terkontrol penyerang
// bila trafik tidak melewati lapisan nginx yang menormalkan XFF.
//
// [docs/30 §30.12 WS-H] Yang di-key bukan alamatnya, melainkan **tag HMAC
// pepper** dari alamat itu (`clientIpTag`): `RedisStore` menulis
// `rl:general:<key>` ke Redis, jadi IP mentah di sini = daftar alamat klien di
// snapshot Redis (melanggar kriteria audit "tidak ada IP di DB/Redis").
const secureKeyGenerator = (req: Request): string => clientIpTag(req);

// Helper: Skip kalo di development ATAU kalau requestnya cuma OPTIONS (CORS Preflight)
const skipRules = (req: Request) => {
  return env.nodeEnv === 'development' || req.method === 'OPTIONS';
};

// 1. General Limiter: Untuk semua route API umum
// Batas: 300 request per 15 menit per IP
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 300,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  message: {
    error: 'Too many requests, please try again later.'
  },
  store: new RedisStore({
    prefix: 'rl:general:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})

// 2. Auth Limiter: Sangat Ketat untuk Login/Register/Restore
// Batas: 20 request per jam per IP (Dinaikkan agar tidak mudah terblokir)
export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 jam
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  message: {
    error: 'Too many login attempts. Please try again after an hour.'
  },
  store: new RedisStore({
    prefix: 'rl:auth:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})

// 3. Upload Limiter: Mencegah spam upload file
// Batas: 20 upload per jam
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  message: {
    error: 'Upload limit reached. Please wait a while.'
  },
  store: new RedisStore({
    prefix: 'rl:upload:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})

// 4. [R6 2026-10-15] Admin cleanup limiter.
//
// Endpoint `POST /api/admin/cleanup` kini benar-benar menghapus baris (termasuk
// akun dorman), jadi menebak `x-admin-key` harus lambat: 5 percobaan per jam per
// IP. Limiter umum (`generalLimiter`, 300/15 menit) terlalu longgar untuk satu
// operasi destruktif.
//
// Sengaja TANPA `RedisStore`, berbeda dari limiter lain: kalau Redis mati,
// `rate-limit-redis` melempar dan endpoint ops justru gagal 500 saat paling
// dibutuhkan. NYX berjalan satu instance (`docs/10`), jadi hitungan in-memory
// sudah menutup tujuan limiter di sini (memperlambat brute-force kunci), tanpa
// menambah ketergantungan yang bisa mematikannya.
/**
 * [docs/35 Fase 4] Batas pencarian PER AKUN: 30/menit.
 *
 * Limiter umum menghitung per IP, sehingga satu akun di balik NAT/CGNAT bisa
 * memborong jatah bersama, sementara banyak akun dari satu IP (kantor, VPN)
 * saling memblokir. Pencarian adalah endpoint enumerasi, jadi batasnya harus
 * melekat pada akun. Kunci = tag HMAC (`utils/searchRateKey.ts`).
 */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRules,
  keyGenerator: searchRateKey,
  validate: { trustProxy: false },
  message: { error: 'SEARCH_RATE_LIMITED: Too many searches. Please wait a minute.' },
  store: new RedisStore({
    prefix: 'rl:search:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})

/**
 * Batas per IP: 90/menit. Bukan pengganti batas akun, melainkan penahan
 * pembuatan banyak akun untuk mengakali batas akun di satu host.
 */
export const searchIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  message: { error: 'SEARCH_RATE_LIMITED: Too many searches from this network.' },
  store: new RedisStore({
    prefix: 'rl:search-ip:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})

export const adminCleanupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  handler: (req: Request, res: Response, _next: NextFunction) => {
    // Terhitung supaya percobaan brute-force terlihat di dashboard, bukan hanya
    // di respons klien yang menyerang.
    incCounter(ADMIN_CLEANUP, { result: 'rate_limited' })
    res.status(429).json({ error: 'Too many cleanup attempts. Try again later.' })
  }
})


