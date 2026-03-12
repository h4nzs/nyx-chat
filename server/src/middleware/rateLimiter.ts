import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { env } from '../config.js'
import { RedisStore } from 'rate-limit-redis'
import { redisClient } from '../lib/redis.js'
import { Request } from 'express';

// Secure IP Extractor: Pakai helper bawaan untuk cegah bypass IPv6
const secureKeyGenerator = (req: Request): string => {
  // 1. Ambil teks IP-nya dulu (dari Cloudflare atau bawaan Express)
  const clientIp = (req.headers['cf-connecting-ip'] as string) || req.ip || 'unknown';
  
  // 2. Lempar teks IP (string) tersebut ke polisi library biar di-format dengan aman
  return ipKeyGenerator(clientIp);
};

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

// 4. OTP Limiter: Untuk endpoint verifikasi OTP
// Batas: 5 percobaan per 15 menit per IP
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRules,
  keyGenerator: secureKeyGenerator,
  validate: { trustProxy: false },
  message: {
    error: 'Too many OTP verification attempts. Please try again later.'
  },
  store: new RedisStore({
    prefix: 'rl:otp:',
    sendCommand: (...args: string[]) => redisClient.sendCommand(args)
  })
})
