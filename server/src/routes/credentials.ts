// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.7 — Fase 6] Anonymous issuance.
 *
 * Router ini sengaja TIDAK memakai `router.use(requireAuth)`:
 *  - `POST /tokens` terautentikasi (membeli batch token single-use);
 *  - `POST /issuance` dan `POST /commit` anonim — bukti keanggotaan hanya
 *    `X-Group-Token` (grup-level), tanpa cookie/JWT.
 *
 * CSRF dikecualikan di `app.ts` hanya untuk dua path anonim itu: keduanya tidak
 * membaca cookie, jadi tidak ada sesi yang bisa dipalsukan lintas situs; token
 * bearer ada di body. Endpoint bank tetap di bawah CSRF.
 *
 * Replay: token dan commit ticket dikonsumsi atomik (Lua GET+DEL). Request
 * paralel kedua selalu melihat key yang sudah hilang.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { redisClient } from '../lib/redis.js'
import { requireAuth } from '../middleware/auth.js'
import { anonCredentialLimiter } from '../middleware/rateLimiter.js'
import { ApiError } from '../utils/errors.js'
import { zodValidate } from '../utils/validate.js'
import { blindSign, recordIssuedCredential, SERIAL_HEX_LENGTH } from '../lib/groupCredentials.js'
import { credentialTokenMatches } from '../utils/atRestSecrets.js'
import { credentialDay } from '../utils/credentialIssuance.js'
import {
  CREDENTIAL_CONSUME_LUA,
  CREDENTIAL_INCRBY_LUA,
  CREDENTIAL_TICKET_TTL_SECONDS,
  CREDENTIAL_TOKEN_BATCH_MAX,
  CREDENTIAL_TOKEN_TTL_SECONDS,
  commitTicketKey,
  credentialTokenKey,
  credentialTokenQuotaKey,
  exceedsTokenQuota,
  generateCommitTicket,
  generateCredentialToken,
  isCommitTicket,
  isCredentialToken,
} from '../utils/credentialTokens.js'

const router: Router = Router()

function headerToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return String(value[0] ?? '')
  return ''
}

/**
 * Bukti keanggotaan jalur anonim: HANYA authSecret grup. Delivery token tidak
 * diterima karena ia pseudonim stabil per anggota — memakainya di sini akan
 * mengembalikan keterkaitan user↔credential yang justru ingin dihapus.
 */
async function hasGroupProof(conversationId: string, headers: Record<string, unknown>): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { authSecret: true },
  })
  if (!conversation) return false
  return credentialTokenMatches(conversation.authSecret, headerToString(headers['x-group-token']))
}

// Bank token: terautentikasi + CSRF (lihat catatan di atas).
router.post('/tokens', requireAuth, zodValidate({
  body: z.object({
    count: z.number().int().min(1).max(CREDENTIAL_TOKEN_BATCH_MAX).optional(),
  }),
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const count = (req.body as { count?: number }).count ?? 1

    // Kuota per user per hari. Key ber-tag (bukan userId mentah) — Redis
    // persisten tidak boleh menjadi daftar pembeli token.
    const quotaKey = credentialTokenQuotaKey(req.user.id, credentialDay())
    const used = Number(await redisClient.eval(CREDENTIAL_INCRBY_LUA, {
      keys: [quotaKey],
      arguments: [String(CREDENTIAL_TOKEN_TTL_SECONDS), String(count)],
    }))
    if (exceedsTokenQuota(used)) {
      return res.status(429).json({ error: 'CREDENTIAL_TOKEN_QUOTA: Daily token quota exceeded.' })
    }

    const tokens = Array.from({ length: count }, () => generateCredentialToken())
    await Promise.all(tokens.map(token =>
      redisClient.set(credentialTokenKey(token), '1', { EX: CREDENTIAL_TOKEN_TTL_SECONDS })
    ))
    res.status(201).json({ tokens })
  } catch (error) { next(error) }
})

router.post('/issuance', anonCredentialLimiter, zodValidate({
  body: z.object({
    token: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(64),
    blindedMsg: z.string().min(1).max(1024),
  }),
}), async (req, res, next) => {
  try {
    const { token, conversationId, blindedMsg } = req.body as {
      token: string; conversationId: string; blindedMsg: string
    }
    if (!isCredentialToken(token)) {
      return res.status(403).json({ error: 'CREDENTIAL_TOKEN_INVALID: Unknown or already used token.' })
    }

    // Bukti keanggotaan diperiksa SEBELUM token dibakar: request yang tidak
    // berhak tidak boleh menghabiskan kuota pembeli.
    if (!(await hasGroupProof(conversationId, req.headers as unknown as Record<string, unknown>))) {
      return res.status(403).json({ error: 'MEMBERSHIP_PROOF_REQUIRED: Valid X-Group-Token required.' })
    }

    const consumed = await redisClient.eval(CREDENTIAL_CONSUME_LUA, {
      keys: [credentialTokenKey(token)],
      arguments: [],
    })
    if (consumed === null || consumed === undefined) {
      return res.status(403).json({ error: 'CREDENTIAL_TOKEN_INVALID: Unknown or already used token.' })
    }

    const blinded = Buffer.from(blindedMsg, 'base64url')
    if (blinded.length === 0 || blinded.length > 512) {
      return res.status(400).json({ error: 'Invalid blinded message size' })
    }

    const { blindSig, keyVersion } = await blindSign(new Uint8Array(blinded))
    const commitTicket = generateCommitTicket()
    await redisClient.set(commitTicketKey(commitTicket), conversationId, {
      EX: CREDENTIAL_TICKET_TTL_SECONDS,
    })

    res.json({
      blindSig: Buffer.from(blindSig).toString('base64url'),
      keyVersion,
      commitTicket,
    })
  } catch (error) { next(error) }
})

router.post('/commit', anonCredentialLimiter, zodValidate({
  body: z.object({
    commitTicket: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(64),
    keyVersion: z.number().int().min(1),
    serial: z.string().length(SERIAL_HEX_LENGTH),
  }),
}), async (req, res, next) => {
  try {
    const { commitTicket, conversationId, keyVersion, serial } = req.body as {
      commitTicket: string; conversationId: string; keyVersion: number; serial: string
    }
    if (!isCommitTicket(commitTicket)) {
      return res.status(403).json({ error: 'CREDENTIAL_TICKET_INVALID: Unknown or already used ticket.' })
    }

    const boundConversation = await redisClient.eval(CREDENTIAL_CONSUME_LUA, {
      keys: [commitTicketKey(commitTicket)],
      arguments: [],
    })
    if (boundConversation === null || boundConversation === undefined) {
      return res.status(403).json({ error: 'CREDENTIAL_TICKET_INVALID: Unknown or already used ticket.' })
    }
    // Ticket terikat conversation: ticket sah untuk grup lain tetap ditolak
    // (dan sudah terbakar — tidak bisa dicoba ulang).
    if (String(boundConversation) !== conversationId) {
      return res.status(403).json({ error: 'CREDENTIAL_TICKET_INVALID: Ticket does not match conversation.' })
    }

    await recordIssuedCredential(serial, conversationId, keyVersion)
    res.status(201).json({ ok: true })
  } catch (error) { next(error) }
})

export default router
