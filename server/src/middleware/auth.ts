import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { Socket } from 'socket.io'
import { env } from '../config.js'
import { AuthPayload } from '../types/auth.js'

// === Middleware untuk REST API ===
export function requireAuth (req: Request, res: Response, next: NextFunction) {
  // Prioritaskan pembacaan token dari cookie
  const token = req.cookies?.at || // access token dari cookie
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null)

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthPayload
    req.user = payload
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
  } catch (error) {
    res.status(403).json({ error: 'Forbidden' })
  }
}

// === Helper untuk verifikasi token ===
export function verifySocketAuth (token?: string): AuthPayload | null {
  if (!token) return null
  try {
    return jwt.verify(token, env.jwtSecret) as AuthPayload
  } catch {
    return null
  }
}

// === Middleware khusus Socket.IO ===
export function socketAuthMiddleware (
  socket: Socket,
  next: (err?: Error) => void
) {
  try {
    let token: string | undefined

    if (socket.handshake.headers?.cookie) {
      const cookies = Object.fromEntries(
        socket.handshake.headers.cookie.split(';').map((c) => {
          const [k, v] = c.trim().split('=')
          return [k, decodeURIComponent(v)]
        })
      )
      token = cookies.at || undefined
    }

    const user = verifySocketAuth(token)
    if (user) {
      (socket as any).user = user
    }

    next()
  } catch (err) {
    console.error('Socket authentication error:', err)
    next(new Error('Internal server error during auth'))
  }
}
