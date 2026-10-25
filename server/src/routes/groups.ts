// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3/§37.3.4] Jalur grup yang TIDAK memakai akun.
 *
 * Semua route di sini diautentikasi oleh **possession token** (body), bukan
 * cookie/JWT, sehingga:
 *  - `app.ts` mengecualikan prefix `/api/groups` dari CSRF (tidak ada cookie
 *    yang bisa dipalsukan lintas situs di jalur ini);
 *  - tidak ada handler yang menulis/membaca `userId` — discovery, refresh, dan
 *    leave semuanya bekerja lewat `tokenHash`;
 *  - log/metrik hanya memuat `status`/jumlah, tidak pernah token/hash-nya.
 *
 * Endpoint:
 *   POST   /api/groups/sync            — discovery + mailbox pull (anonim)
 *   POST   /api/groups/token/refresh   — perpanjang TTL member token
 *   POST   /api/groups/:id/epoch       — rotasi token grup (admin capability)
 *   DELETE /api/groups/:id/membership  — holder-initiated revoke
 */

import express, { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { redisClient } from '../lib/redis.js'
import { zodValidate } from '../utils/validate.js'
import { hoistConvoKeys, toConversation, type RawConversationData } from '../utils/mappers.js'
import { requireAdminCapability, type AdminCapabilityDb } from '../utils/adminCapability.js'
import {
  evaluateMemberToken,
  groupTokenMatches,
  hashGroupToken,
  isOpaqueToken,
  refreshMemberToken,
  rotateGroupToken,
  type GroupTokenDb,
} from '../utils/groupTokens.js'
import { resolveSyncMemberships, MAX_SYNC_TOKENS, type SyncDb } from '../utils/groupSync.js'
import { evaluateSyncProofs } from '../utils/syncProofs.js'
import { createCheckRateLimit } from '../utils/redisResilience.js'
import { incCounter, GROUP_SYNC, PRIVACY_PASS, CREDENTIAL_PRESENT } from '../utils/metrics.js'
import { parseSuiteAllowlist, verifyCredentialPresentation } from '../utils/credentialPresentation.js'
import {
  MAILBOX_MAX_ITEMS_PER_PULL,
  parseMailboxCursor,
  postMailboxItems,
  pullMailboxItems,
  validateMailboxItems,
  type MailboxDb,
} from '../utils/groupMailbox.js'
import {
  PP_ISSUE_LIMIT,
  PP_MAX_ISSUE_PER_REQUEST,
  PP_SUITE,
  loadPpIssuerKeys,
  ppBlindSign,
  ppRedeemToken,
} from '../utils/privacyPass.js'

const router: Router = Router()

const groupDb = prisma as unknown as GroupTokenDb
const syncDb = prisma as unknown as SyncDb
const adminDb = prisma as unknown as AdminCapabilityDb

const checkRateLimit = createCheckRateLimit(redisClient)

/** 120 sync/menit/token: polling 15 detik butuh 4, sisanya untuk reconnect. */
const SYNC_RATE = { limit: 120, windowSeconds: 60 } as const
const REFRESH_RATE = { limit: 10, windowSeconds: 60 } as const

const tokenSchema = z.string().refine(isOpaqueToken, 'invalid token')

const syncBodySchema = z.object({
  tokens: z.array(tokenSchema).max(MAX_SYNC_TOKENS),
  // `ids` TIDAK dipakai untuk discovery (itu jalur JWT `/conversations/sync`);
  // diterima hanya agar klien bisa mengirim satu request bentuk lama saat migrasi.
  ids: z.array(z.string()).max(200).optional(),
  // [docs/37 §37.3.3] Bukti Privacy Pass (satu token = satu sync). Opsional
  // kecuali `PP_SYNC_REQUIRED=1`; token spent/invalid tidak pernah dicatat.
  proofs: z.array(z.string().min(1).max(1024)).max(20).optional(),
})

const refreshBodySchema = z.object({ token: tokenSchema })

const mailboxPostBodySchema = z.object({
  token: tokenSchema,
  items: z.array(z.object({
    kind: z.string().min(1).max(32),
    tag: z.string().min(1).max(64).optional(),
    payload: z.string().min(1).max(12000),
  })).min(1).max(32),
})

const mailboxPullBodySchema = z.object({
  token: tokenSchema,
  // `ISO|id` (komposit) atau ISO lama; diparse eksplisit di handler.
  cursor: z.string().min(1).max(96).optional(),
  limit: z.number().int().min(1).max(MAILBOX_MAX_ITEMS_PER_PULL).optional(),
})

const ppIssueBodySchema = z.object({
  groupToken: tokenSchema,
  memberToken: tokenSchema,
  blinded: z.array(z.string().min(1).max(1024)).min(1).max(PP_MAX_ISSUE_PER_REQUEST),
})

const ppRedeemBodySchema = z.object({
  conversationId: z.string().min(1).max(64),
  tokens: z.array(z.string().min(1).max(1024)).min(1).max(20),
})
const membershipBodySchema = z.object({ token: tokenSchema })

/**
 * Token grup sah = hash cocok DAN belum lewat `groupTokenExpiresAt`.
 * Expiry sengaja diperiksa terpisah dari hash: rotasi epoch mengubah hash,
 * sedangkan TTL bisa habis tanpa rotasi (klien offline lama).
 */
function credentialGroupTokenValid (
  conversation: { authSecret?: string | null; groupTokenExpiresAt?: Date | null },
  presented: string
): boolean {
  if (!groupTokenMatches(conversation.authSecret ?? null, presented)) return false
  const expiresAt = conversation.groupTokenExpiresAt ? new Date(conversation.groupTokenExpiresAt).getTime() : null
  if (expiresAt !== null && expiresAt <= Date.now()) return false
  return true
}

/** Batas per token (bukan per IP: jalur ini dirancang untuk OHTTP). */
async function tokenBucketAllows (token: string, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  return checkRateLimit(hashGroupToken(token), bucket, limit, windowSeconds)
}

router.post('/sync', zodValidate({ body: syncBodySchema }), async (req, res, next) => {
  try {
    const { tokens, proofs } = req.body as z.infer<typeof syncBodySchema>

    for (const token of tokens) {
      if (!await tokenBucketAllows(token, 'group_sync', SYNC_RATE.limit, SYNC_RATE.windowSeconds)) {
        incCounter(GROUP_SYNC, { result: 'rate_limited' })
        return res.status(429).json({ error: 'RATE_LIMITED' })
      }
    }

    const resolution = await resolveSyncMemberships(syncDb, tokens)
    incCounter(GROUP_SYNC, { result: resolution.stale > 0 ? 'stale' : 'ok' })

    // [docs/37 §37.3.3] Gate bukti Privacy Pass. Default (tanpa
    // `PP_SYNC_REQUIRED`) hanya menghabiskan bukti bila klien mengirimnya;
    // dengan flag itu, sync tanpa bukti sah ditolak fail-closed.
    const requiredProof = process.env.PP_SYNC_REQUIRED === '1'
    const submittedProofs = proofs ?? []
    if (submittedProofs.length > 0 || requiredProof) {
      const decision = await evaluateSyncProofs({
        proofs: submittedProofs,
        // Termasuk membership `stale`: bukti adalah anti-abuse, bukan izin
        // membaca. Klien bisa memegang bukti grup yang barisnya sudah stale
        // sementara token grup lain masih sah; menolak sync karena itu
        // mengunci discovery dengan `PP_SYNC_REQUIRED=1`.
        conversationIds: resolution.memberships.map((membership) => membership.conversationId),
        required: requiredProof,
        redeem: (conversationId, proof) =>
          ppRedeemToken(redisClient as unknown as Parameters<typeof ppRedeemToken>[0], conversationId, proof),
      })
      incCounter(PRIVACY_PASS, {
        route: 'sync',
        result: decision.accepted > 0 ? 'ok' : decision.ok ? 'skipped' : 'denied',
      })
      if (!decision.ok) return res.status(403).json({ error: 'PP_PROOF_REQUIRED' })
    }

    const conversations = resolution.conversations.map((conversation) => {
      const safe = toConversation(hoistConvoKeys(conversation as unknown as RawConversationData))
      safe.participants = []
      return safe
    })

    res.json({
      conversations,
      memberships: resolution.memberships.map((membership) => ({
        index: membership.index,
        status: membership.status,
        conversationId: membership.conversationId,
        epoch: membership.epoch,
        expiresAt: membership.expiresAt.toISOString(),
      })),
      unknown: resolution.unknown,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/token/refresh', zodValidate({ body: refreshBodySchema }), async (req, res, next) => {
  try {
    const { token } = req.body as z.infer<typeof refreshBodySchema>

    if (!await tokenBucketAllows(token, 'group_token_refresh', REFRESH_RATE.limit, REFRESH_RATE.windowSeconds)) {
      return res.status(429).json({ error: 'RATE_LIMITED' })
    }

    const tokenHash = hashGroupToken(token)
    const row = await groupDb.userHiddenConversation.findUnique({
      where: { tokenHash },
      select: { id: true, conversationId: true, tokenEpoch: true, expiresAt: true },
    })
    if (!row) return res.status(404).json({ error: 'TOKEN_UNKNOWN' })

    const conversation = await groupDb.conversation.findUnique({
      where: { id: row.conversationId },
      select: { id: true, groupEpoch: true },
    })
    if (!conversation) return res.status(404).json({ error: 'TOKEN_UNKNOWN' })

    const status = evaluateMemberToken(row, conversation.groupEpoch ?? 0)
    if (status === 'stale') return res.status(410).json({ error: 'TOKEN_STALE' })

    const { expiresAt } = await refreshMemberToken(groupDb, row.id)
    incCounter(GROUP_SYNC, { result: 'refreshed' })
    res.json({ expiresAt: expiresAt.toISOString(), epoch: conversation.groupEpoch ?? 0 })
  } catch (error) {
    next(error)
  }
})

/**
 * [docs/37 §37.3.3] Issuer Privacy Pass.
 *
 * Kunci publik boleh dilihat siapa pun (itu kunci verifikasi), kunci privat
 * hanya di server. `keyId` ikut dipublikasikan supaya rotasi kunci tidak
 * membuat klien menebak.
 */
router.get('/pp/issuer', async (_req, res, next) => {
  try {
    const keys = await loadPpIssuerKeys()
    res.json({ suite: PP_SUITE, keyId: keys.keyId, publicJwk: keys.publicJwk })
  } catch (error) {
    next(error)
  }
})

/**
 * Issuance: butuh bukti keanggotaan (group token era berjalan + member token
 * yang masih sah). Server menandatangani pesan ter-blind TANPA melihat isinya,
 * jadi ia tidak bisa menghubungkan token hasil dengan pemanggil issuance.
 */
router.post('/pp/issue', zodValidate({ body: ppIssueBodySchema }), async (req, res, next) => {
  try {
    const { groupToken, memberToken, blinded } = req.body as z.infer<typeof ppIssueBodySchema>

    if (!await tokenBucketAllows(memberToken, 'pp_issue', PP_ISSUE_LIMIT.limit, PP_ISSUE_LIMIT.windowSeconds)) {
      incCounter(PRIVACY_PASS, { route: 'issue', result: 'rate_limited' })
      return res.status(429).json({ error: 'RATE_LIMITED' })
    }

    const row = await groupDb.userHiddenConversation.findUnique({
      where: { tokenHash: hashGroupToken(memberToken) },
      select: { id: true, conversationId: true, tokenEpoch: true, expiresAt: true },
    })
    if (!row) return res.status(404).json({ error: 'TOKEN_UNKNOWN' })

    const conversation = await groupDb.conversation.findUnique({
      where: { id: row.conversationId },
      select: { id: true, authSecret: true, groupEpoch: true, groupTokenExpiresAt: true },
    })
    if (!conversation) return res.status(404).json({ error: 'TOKEN_UNKNOWN' })
    if (evaluateMemberToken(row, conversation.groupEpoch ?? 0) === 'stale') {
      return res.status(410).json({ error: 'TOKEN_STALE' })
    }
    if (!credentialGroupTokenValid(conversation, groupToken)) {
      incCounter(PRIVACY_PASS, { route: 'issue', result: 'denied' })
      return res.status(403).json({ error: 'GROUP_AUTH_REQUIRED' })
    }

    const signatures = await ppBlindSign(blinded)
    incCounter(PRIVACY_PASS, { route: 'issue', result: 'ok' })
    res.json({ signatures, suite: PP_SUITE, keyId: (await loadPpIssuerKeys()).keyId })
  } catch (error) {
    next(error)
  }
})

/**
 * Redemption: tanpa auth sama sekali (token = bukti). Satu token = satu sync.
 * Tidak ada log token/nonce; hanya hitungan.
 */
router.post('/pp/redeem', zodValidate({ body: ppRedeemBodySchema }), async (req, res, next) => {
  try {
    const { conversationId, tokens } = req.body as z.infer<typeof ppRedeemBodySchema>
    let accepted = 0
    let spent = 0
    let invalid = 0

    for (const token of tokens) {
      const result = await ppRedeemToken(
        redisClient as unknown as Parameters<typeof ppRedeemToken>[0],
        conversationId,
        token
      )
      if (result === 'ok') accepted += 1
      else if (result === 'spent') spent += 1
      else invalid += 1
    }

    incCounter(PRIVACY_PASS, {
      route: 'redeem',
      result: invalid > 0 ? 'invalid' : spent > 0 ? 'spent' : 'ok',
    })
    if (accepted === 0) return res.status(403).json({ error: 'PP_TOKEN_REJECTED', spent, invalid })
    res.json({ accepted, spent, invalid })
  } catch (error) {
    next(error)
  }
})

/**
 * [docs/37 §37.3.2] Post ke mailbox grup. Tanpa identitas pengirim: siapa pun
 * yang memegang token grup era berjalan boleh menulis, dan server tidak
 * menyimpan siapa penulisnya.
 */
router.post('/:id/mailbox', zodValidate({ body: mailboxPostBodySchema }), async (req, res, next) => {
  try {
    const conversationId = String(req.params.id)
    const { token, items } = req.body as z.infer<typeof mailboxPostBodySchema>

    if (!await tokenBucketAllows(token, 'group_mailbox_post', 30, 60)) {
      incCounter(GROUP_SYNC, { result: 'rate_limited' })
      return res.status(429).json({ error: 'RATE_LIMITED' })
    }

    const conversation = await groupDb.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, authSecret: true, groupEpoch: true, groupTokenExpiresAt: true },
    })
    if (!conversation) return res.status(404).json({ error: 'Not found' })
    if (!credentialGroupTokenValid(conversation, token)) {
      return res.status(403).json({ error: 'GROUP_AUTH_REQUIRED' })
    }

    const validated = validateMailboxItems(items)
    if (!validated.ok) return res.status(400).json({ error: 'MAILBOX_REJECTED', reason: validated.reason })

    const written = await postMailboxItems(prisma as unknown as MailboxDb, {
      conversationId,
      epoch: conversation.groupEpoch ?? 0,
      items: validated.items,
    })
    incCounter(GROUP_SYNC, { result: 'mailbox_post' })
    res.status(201).json({ written, epoch: conversation.groupEpoch ?? 0 })
  } catch (error) {
    next(error)
  }
})

/** Pull mailbox (cursor `createdAt`, hanya era berjalan, TTL dihormati). */
router.post('/:id/mailbox/pull', zodValidate({ body: mailboxPullBodySchema }), async (req, res, next) => {
  try {
    const conversationId = String(req.params.id)
    const { token, cursor: rawCursor, limit } = req.body as z.infer<typeof mailboxPullBodySchema>
    const cursor = rawCursor ? parseMailboxCursor(rawCursor) : undefined
    if (cursor === null) return res.status(400).json({ error: 'INVALID_CURSOR' })

    if (!await tokenBucketAllows(token, 'group_mailbox_pull', 120, 60)) {
      return res.status(429).json({ error: 'RATE_LIMITED' })
    }

    const conversation = await groupDb.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, authSecret: true, groupEpoch: true, groupTokenExpiresAt: true },
    })
    if (!conversation) return res.status(404).json({ error: 'Not found' })
    // [docs/37 §37.3.2] Pull menerima token grup era berjalan ATAU member token
    // era berjalan. Tanpa fallback ini, anggota offline yang tertinggal rotasi
    // tidak bisa mengambil KEY_ENVELOPE (token grup lama sudah mati) — deadlock.
    // Post tetap wajib token grup: member token hanya untuk membaca.
    if (!credentialGroupTokenValid(conversation, token)) {
      const member = await groupDb.userHiddenConversation.findUnique({
        where: { tokenHash: hashGroupToken(token) },
        select: { conversationId: true, tokenEpoch: true, expiresAt: true },
      })
      if (!member || member.conversationId !== conversationId) {
        return res.status(403).json({ error: 'GROUP_AUTH_REQUIRED' })
      }
      if (evaluateMemberToken(member, conversation.groupEpoch ?? 0) === 'stale') {
        return res.status(403).json({ error: 'GROUP_AUTH_REQUIRED' })
      }
    }

    const page = await pullMailboxItems(prisma as unknown as MailboxDb, {
      conversationId,
      epoch: conversation.groupEpoch ?? 0,
      cursor,
      limit,
    })
    incCounter(GROUP_SYNC, { result: 'mailbox_pull' })
    res.json({
      epoch: conversation.groupEpoch ?? 0,
      items: page.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        tag: item.tag ?? undefined,
        payload: item.payload,
        createdAt: new Date(item.createdAt).toISOString(),
      })),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * [docs/37 §37.3.6] Status era untuk keputusan rotasi PCS.
 *
 * Hanya admin (capability) yang boleh membaca: `messageSeq` adalah jumlah pesan
 * sepanjang hidup percakapan, bukan konten, tapi tetap tidak perlu dibagikan ke
 * pemegang token biasa. Klien memakai `rotatedAt` + `messageSeq` untuk memutuskan
 * rotasi terjadwal TANPA menyimpan counter sendiri.
 */
router.get('/:id/epoch', async (req, res, next) => {
  try {
    const conversationId = String(req.params.id)
    const gate = await requireAdminCapability(adminDb, conversationId, req.headers as Record<string, unknown>)
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error })

    const conversation = await groupDb.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, groupEpoch: true, epochRotatedAt: true, createdAt: true, messageSeq: true },
    })
    if (!conversation) return res.status(404).json({ error: 'Not found' })

    res.json({
      epoch: conversation.groupEpoch ?? 0,
      rotatedAt: conversation.epochRotatedAt ? conversation.epochRotatedAt.toISOString() : null,
      createdAt: conversation.createdAt ? conversation.createdAt.toISOString() : null,
      messageSeq: conversation.messageSeq ?? 0,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/:id/epoch', async (req, res, next) => {
  try {
    const conversationId = String(req.params.id)
    const gate = await requireAdminCapability(adminDb, conversationId, req.headers as Record<string, unknown>)
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error })

    // Satu transaksi: epoch + seluruh baris anggota harus berpindah bersama.
    const rotated = await prisma.$transaction((tx) =>
      rotateGroupToken(tx as unknown as GroupTokenDb, conversationId)
    )
    incCounter(GROUP_SYNC, { result: 'epoch_rotated' })
    // Token mentah dikembalikan HANYA ke admin (pemegang capability), untuk
    // didistribusikan ke anggota lewat mailbox. Server tidak menyimpannya.
    res.json({
      token: rotated.token,
      epoch: rotated.epoch,
      expiresAt: rotated.expiresAt.toISOString(),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * [docs/37 §37.3.5] Presentasi credential (body biner).
 *
 * Build ini TIDAK punya issuer/verifier terpasang: dengan allowlist kosong
 * (default) semua presentasi ditolak 403 — fail-closed, bukan 501 "belum
 * diimplementasikan" yang bisa disalahartikan sebagai fitur hidup.
 */
router.post(
  '/:id/credential/present',
  express.raw({ type: '*/*', limit: '8kb' }),
  async (req, res, next) => {
    try {
      const conversationId = String(req.params.id)
      const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0)
      if (body.length === 0) {
        incCounter(CREDENTIAL_PRESENT, { result: 'bad_lengths' })
        return res.status(400).json({ error: 'CREDENTIAL_REJECTED', reason: 'truncated' })
      }

      const conversation = await groupDb.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, isGroup: true, groupEpoch: true },
      })
      if (!conversation) return res.status(404).json({ error: 'Not found' })
      if (!conversation.isGroup) return res.status(400).json({ error: 'Not a group' })

      const result = await verifyCredentialPresentation(body, {
        groupId: conversationId,
        epoch: conversation.groupEpoch ?? 0,
        allowlist: parseSuiteAllowlist(process.env.CREDENTIAL_SUITE_ALLOWLIST),
      })

      if (!result.ok) {
        incCounter(CREDENTIAL_PRESENT, { result: result.reason })
        const status = result.reason === 'suite_not_allowed' || result.reason === 'no_verifier' ? 403 : 400
        return res.status(status).json({ error: 'CREDENTIAL_REJECTED', reason: result.reason })
      }

      incCounter(CREDENTIAL_PRESENT, { result: 'ok' })
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  }
)

router.delete('/:id/membership', zodValidate({ body: membershipBodySchema }), async (req, res, next) => {
  try {
    const conversationId = req.params.id
    const { token } = req.body as z.infer<typeof membershipBodySchema>
    const tokenHash = hashGroupToken(token)

    const row = await groupDb.userHiddenConversation.findUnique({
      where: { tokenHash },
      select: { id: true, conversationId: true },
    })
    // Token yang bukan milik percakapan ini tidak boleh menghapus apa pun.
    if (!row || row.conversationId !== conversationId) {
      return res.status(404).json({ error: 'TOKEN_UNKNOWN' })
    }

    await groupDb.userHiddenConversation.delete({ where: { id: row.id } })
    incCounter(GROUP_SYNC, { result: 'membership_revoked' })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

export default router
