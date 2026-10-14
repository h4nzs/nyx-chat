// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(2)] Penerbit alamat relay panggilan.
 *
 * Dua operasi, keduanya `requireAuth`:
 *
 *   POST /api/call-tokens           → `{ self, peers }`  (alamat relay saya +
 *                                     alamat relay peer yang saya tuju)
 *   POST /api/call-tokens/resolve   → `{ users }`        (token masuk → userId,
 *                                     supaya penerima tahu siapa yang memanggil)
 *
 * Yang TIDAK dilakukan endpoint ini: mengembalikan userId untuk sebuah token
 * atau token untuk userId tanpa autentikasi. Body hanya memuat id yang sudah
 * diketahui pemanggil (mis. dari daftar percakapan), dan alamat yang dikembalikan
 * adalah nilai acak — jadi endpoint ini tidak bisa dipakai untuk enumerasi.
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { redisClient } from '../lib/redis.js'
import { zodValidate } from '../utils/validate.js'
import { identityKey } from '../utils/redisIdentity.js'
import {
  ensureCallRelayToken,
  isCallRelayToken,
  resolveCallRelayToken,
} from '../utils/callRelayTokens.js'
import type { AuthJwtPayload } from '@nyx/shared'

const router = Router()

/** Batas jumlah peer per permintaan (panggilan grup mesh punya plafon ukuran). */
export const MAX_CALL_TOKEN_PEERS = 32

/** Batas jumlah token yang boleh diselesaikan sekaligus. */
export const MAX_CALL_TOKEN_RESOLVE = 64

const issueSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).max(MAX_CALL_TOKEN_PEERS).optional(),
})

const resolveSchema = z.object({
  tokens: z.array(z.string().min(1).max(128)).max(MAX_CALL_TOKEN_RESOLVE),
})

/**
 * Perangkat aktif peer dari Redis (kalau ada). Dipakai supaya alamat relay
 * diarahkan ke perangkat yang benar-benar login; `null` → sidecar meneruskan ke
 * semua perangkat user (perilaku lama).
 */
async function activeDeviceOf(userId: string): Promise<string | null> {
  const deviceId = await redisClient.get(identityKey('active_device', userId)).catch(() => null)
  return typeof deviceId === 'string' && deviceId ? deviceId : null
}

router.post('/', requireAuth, zodValidate({ body: issueSchema }), async (req: Request, res: Response): Promise<unknown> => {
  const auth = req.user as AuthJwtPayload
  const body = req.body as z.infer<typeof issueSchema>

  const self = await ensureCallRelayToken(redisClient, {
    userId: auth.id,
    deviceId: typeof auth.deviceId === 'string' && auth.deviceId ? auth.deviceId : await activeDeviceOf(auth.id),
  })

  const peers: Record<string, string> = {}
  const requested = [...new Set(body.userIds ?? [])]
  for (const peerId of requested) {
    if (peerId === auth.id) continue
    peers[peerId] = await ensureCallRelayToken(redisClient, {
      userId: peerId,
      deviceId: await activeDeviceOf(peerId),
    })
  }

  return res.json({ self, peers })
})

router.post('/resolve', requireAuth, zodValidate({ body: resolveSchema }), async (req: Request, res: Response): Promise<unknown> => {
  const body = req.body as z.infer<typeof resolveSchema>
  const users: Record<string, string | null> = {}

  // Token berbentuk salah dijawab `null` (bukan error) supaya klien bisa
  // memproses paket relay yang datang bersamaan tanpa membocorkan alasan.
  for (const token of [...new Set(body.tokens)]) {
    if (!isCallRelayToken(token)) {
      users[token] = null
      continue
    }
    const session = await resolveCallRelayToken(redisClient, token)
    users[token] = session ? session.userId : null
  }

  return res.json({ users })
})

export default router
