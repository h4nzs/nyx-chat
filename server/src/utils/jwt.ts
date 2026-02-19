import jwt, { JwtPayload } from 'jsonwebtoken'
import crypto from 'node:crypto'
import { env } from '../config.js'

const ACCESS_TTL = '15m'
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30 // 30d

export function signAccessToken (payload: any, opts: any = {}) {
  if (env.nodeEnv === 'production' && env.jwtSecret === 'dev-secret') {
    throw new Error('JWT_SECRET must be set in production environment')
  }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: ACCESS_TTL, ...opts })
}

export function verifyJwt (token: string): JwtPayload | string | null {
  try {
    return jwt.verify(token, env.jwtSecret)
  } catch {
    return null
  }
}

export function newJti (): string {
  return crypto.randomUUID()
}

export function refreshExpiryDate (): Date {
  return new Date(Date.now() + REFRESH_TTL_SEC * 1000)
}
