import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config.js'
import { AuthPayload } from '../types/auth.js'
import { redisClient } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { isOhttpScopeRequestAllowed, isOhttpScopedPayload } from '../utils/ohttpToken.js'
import { evaluateTokenGate, type TokenGateDb } from '../utils/authGate.js'

// === Middleware untuk REST API ===
export async function requireAuth (req: Request, res: Response, next: NextFunction) {
  // Prioritaskan pembacaan token dari cookie
  const token = req.cookies?.at || // access token dari cookie HttpOnly (sesi normal)
    // [AUDIT 2026-10-24] Fallback halaman embed (`/embed/:id?token=…`): token
    // dikirim lewat query string, jadi klien menyimpannya sebagai cookie bernama
    // LAIN (`embed_at`, non-HttpOnly, umur = `exp` token). Dulu klien menulis
    // nama `at` — bertabrakan dengan cookie sesi HttpOnly.
    req.cookies?.embed_at ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null)

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthPayload

    // [docs/35 Fase 3] Token carriage OHTTP: umur 120 detik dan HANYA untuk
    // target allowlist (GET search/prekey). Tanpa cek ini, token yang bocor
    // dari amplop sama kuasanya dengan sesi penuh.
    if (isOhttpScopedPayload(payload as unknown as { scope?: unknown }) &&
        !isOhttpScopeRequestAllowed(req.method, req.originalUrl)) {
      return res.status(403).json({ error: 'OHTTP_SCOPE_DENIED' })
    }

    // ========== BLACKLIST + BAN: satu aturan untuk REST dan realtime ==========
    // Dulu blok ini hanya hidup di sini, sehingga pintu socket menerima token
    // yang sudah di-revoke / akun yang sudah di-ban. Logikanya kini di
    // `utils/authGate.ts` dan dipakai juga oleh `realtime/gateway.ts`.
    const gate = await evaluateTokenGate(payload, {
      redis: redisClient,
      db: prisma as unknown as TokenGateDb,
    })
    if (!gate.ok) {
      return res.status(gate.status).json(
        gate.reason ? { error: gate.error, reason: gate.reason } : { error: gate.error }
      )
    }

    req.user = payload
    if (payload.deviceId) {
      req.deviceId = payload.deviceId
    }
    next()
  } catch (err) {
    console.error('Authentication error:', err)
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access Denied: Admins Only' })
    }
    next()
  } catch (_error) {
    res.status(403).json({ error: 'Forbidden' })
  }
}

// === Helper untuk verifikasi token ===
export function verifyAuth (token?: string): AuthPayload | null {
  if (!token) return null
  try {
    return jwt.verify(token, env.jwtSecret) as AuthPayload
  } catch {
    return null
  }
}
