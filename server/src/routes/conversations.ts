import { Router } from 'express'
import crypto, { createHash } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { ApiError } from '../utils/errors.js'
import { z } from 'zod'
import { zodValidate, safeEqualStrings } from '../utils/validate.js'
import { emitEventToUsers, emitEventToUser } from '../network/redisBridge.js'
import { redisClient } from '../lib/redis.js'
import {
  blindSign, getIssuerPublicJwk, revokeCredentialsFor, recordIssuedCredential,
  verifyPresentation, SERIAL_HEX_LENGTH, CREDENTIAL_SUITE,
} from '../lib/groupCredentials.js'
import { hoistConvoKeys, toConversation, asConversationId, asUserId, type RawConversationData } from '../utils/mappers.js'
import type { Conversation } from '@nyx/shared'

const ConversationSchema = z.object({
  id: z.string().optional(),
  isGroup: z.boolean().optional(),
  encryptedMetadata: z.string().nullable().optional(),
})

// [T3b] Delivery tokens: creator issues one opaque token per invited member.
// Server stores (conversationId, token) — it cannot link token → identity
// beyond the routing-only row it is told to create. TOKEN-FIRST: discovery
// adalah possession token, bukan join userId (26.8.1 trigger #1 tertutup).
const DeliveryTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

const router: Router = Router()
router.use(requireAuth)

// [26.8.1] Issuer public key — dibagikan bebas ke semua klien.
router.get('/credential-issuer-key', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { keyVersion, publicJwk } = await getIssuerPublicJwk()
    res.json({ suite: CREDENTIAL_SUITE, keyVersion, publicJwk })
  } catch (error) { next(error) }
})

// [26.8.1] Credential issuance — klien mengirim (conversationId, preparedMsg)
// yang sudah di-blind. Server hanya melihat blinded message; TIDAK bisa
// mengaitkannya dengan user/anggota. Kontrak kepercayaan: klien hanya meminta
// satu credential per keanggotaannya; server mencatat serial untuk dedupe &
// revocation (serial = hash prepared message, tidak bisa di-link balik).
router.post('/credential-issuance', zodValidate({
  body: z.object({
    conversationId: z.string().min(1).max(64),
    blindedMsg: z.string().min(1).max(1024), // base64url dari blinded message
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId, blindedMsg } = req.body as { conversationId: string; blindedMsg: string }

    // Per-user quota anti-abuse: satu issuance per (user, conversation) per hari.
    // Grup nyata tidak perlu lebih — credential tidak berubah kecuali re-join.
    const today = new Date().toISOString().split('T')[0];
    const count = Number(await redisClient.eval(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`, { keys: [`cred:issue:${req.user.id}:${conversationId}:${today}`], arguments: ['86400'] }));
    if (count > 3) {
      return res.status(429).json({ error: 'CREDENTIAL_QUOTA: Too many issuance requests.' });
    }

    const blinded = Buffer.from(blindedMsg, 'base64url')
    if (blinded.length === 0 || blinded.length > 512) {
      return res.status(400).json({ error: 'Invalid blinded message size' });
    }

    // Blind message TIDAK bisa diverifikasi isi → serial dibangun dari blind
    // message (bukan prepared). Dedupe berbasis blind-message-hash: blind yang
    // sama (retry) → serial sama; blind berbeda (re-issuance jahat) → tetap
    // tercatat tapi quota per (user, conversation) membatasinya.
    const serial = createHash('sha384').update(blinded).digest('hex');
    const already = await prisma.groupCredential.findUnique({ where: { serial }, select: { id: true } });
    if (already) {
      // Retry: blindSign ulang memberi blind signature berbeda? TIDAK — blind
      // signature deterministik atas (sk, blinded). Aman untuk blindSign ulang;
      // klien finalize dengan inv miliknya.
    }

    const { blindSig, keyVersion } = await blindSign(new Uint8Array(blinded));

    // Catatan: serial prepared-message belum bisa dihitung server (prepared
    // disembunyikan). Row dibuat saat klien submit serial (finalize) — lihat
    // POST /credential-commit. Untuk revocation berbasis conversation, serial
    // prepared dikaitkan di commit; row di sini hanya blind-hash untuk dedupe.
    res.json({ blindSig: Buffer.from(blindSig).toString('base64url'), keyVersion })
  } catch (error) { next(error) }
})

// [26.8.1] Credential commit — setelah finalize, klien mengirim serial
// prepared-message + conversationId agar server mengaitkannya untuk verifikasi
// & revocation. Server tidak bisa memverifikasi klaim ini saat commit —
// integritas dijaga oleh verifikasi saat presentasi (serial hanya lolos bila
// tanda tangannya valid untuk conversationId yang diklaim).
router.post('/credential-commit', zodValidate({
  body: z.object({
    conversationId: z.string().min(1).max(64),
    keyVersion: z.number().int().min(1),
    serial: z.string().length(SERIAL_HEX_LENGTH),
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId, keyVersion, serial } = req.body as { conversationId: string; keyVersion: number; serial: string }
    await recordIssuedCredential(serial, conversationId, keyVersion)
    res.status(201).json({ ok: true })
  } catch (error) { next(error) }
})

// [26.8.1] Revocation via credential — kick/leave menghapus serial milik
// anggota. Klien yang men-kick tidak tahu serial (anonim); yang melakukannya:
// server menghapus SEMUA credential serial untuk conversation yang tidak lagi
// valid — tapi serial terikat conversation, bukan identitas. Karena revocation
// per-anggota butuh pemetaan serial↔anggota yang hanya klien tahu, kick
// menyertakan serials yang di-revoke di body (dari encrypted metadata).
router.post('/:id/credential-revoke', zodValidate({
  body: z.object({ serials: z.array(z.string().length(SERIAL_HEX_LENGTH)).max(500) })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const { serials } = req.body as { serials: string[] }
    const gt = req.headers['x-group-token'];
    const groupToken = typeof gt === 'string' ? gt : Array.isArray(gt) ? (gt[0] ?? '') : '';
    const conversation = await prisma.conversation.findUnique({ where: { id: String(id) }, select: { authSecret: true } }) as { authSecret: string | null } | null;
    if (!conversation || !safeEqualStrings(conversation.authSecret, groupToken)) {
      return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token' });
    }
    await revokeCredentialsFor(String(id), serials)
    res.json({ ok: true })
  } catch (error) { next(error) }
})

// GET conversations by IDs (Inbox sync for Opaque Mailbox)
// For new users with no local IDs, discovers conversations from UserHiddenConversation
// [T3b TOKEN-FIRST] Discovery = possession of a delivery token — NO userId
// join. Klien mengirim token miliknya via `X-Delivery-Tokens` (base64url,
// 22-char, cap 500). Ketiga sumber lain (ids eksplisit dari klien, backfill
// SessionKey) tetap ada karena bersifat client-supplied, bukan identity join.
// Ini menutup trigger condition #1 upgrade 26.8.1 (token-only endpoints).
router.get('/sync', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    
    const ids = String(req.query.ids ?? '');
    let conversationIds: string[] = ids ? ids.split(',') : [];

    // Token-presented conversations: exact-match against deliveryToken
    // (unique index). Timing-safe not required — tokens are random 128-bit
    // values looked up by unique index; a wrong guess is just a miss.
    const tokenHeader = req.headers['x-delivery-tokens'];
    if (typeof tokenHeader === 'string' && tokenHeader.length > 0) {
      const tokens = tokenHeader.split(',').map(t => t.trim()).filter(t => /^[A-Za-z0-9_-]{22}$/.test(t)).slice(0, 500);
      if (tokens.length > 0) {
        const tokenRows = await prisma.userHiddenConversation.findMany({
          where: { deliveryToken: { in: tokens } },
          select: { conversationId: true }
        });
        conversationIds.push(...tokenRows.map(r => r.conversationId));
      }
    }

    // [26.8.1] Credential presentations: header X-Group-Credentials memuat
    // (keyVersion, conversationId, preparedMsg, signature) base64url — server
    // memverifikasi tanda tangan issuer + serial terdaftar. Tidak ada identitas
    // di dalamnya; kepemilikan (msg, sig) = bukti keanggotaan.
    const credHeader = req.headers['x-group-credentials'];
    const credRaw = typeof credHeader === 'string' ? credHeader : (Array.isArray(credHeader) ? credHeader[0] : undefined);
    if (typeof credRaw === 'string' && credRaw.length > 0) {
      const presentations = credRaw.split('~').slice(0, 100);
      for (const p of presentations) {
        try {
          const [kvRaw, convId, msgB64, sigB64] = p.split(':');
          const keyVersion = parseInt(kvRaw ?? '', 10);
          if (!Number.isInteger(keyVersion) || !convId || !msgB64 || !sigB64) continue;
          const preparedMsg = Buffer.from(msgB64, 'base64url');
          const signature = Buffer.from(sigB64, 'base64url');
          if (preparedMsg.length === 0 || preparedMsg.length > 512) continue;
          if (await verifyPresentation(convId, keyVersion, preparedMsg, signature)) {
            conversationIds.push(convId);
          }
        } catch {
          // Presentasi malformed → skip (bukan error request)
        }
      }
    }

    // [T3b TOKEN-FIRST] userId join DIHAPUS — membership tidak didiscovery
    // dari identitas akun. Backfill SessionKey (per-device, client-derived)
    // dipertahankan sebagai jalur pemulihan 1:1.
    let backfillIds: string[] = [];
    if (conversationIds.length === 0) {
      try {
        const userDevices = await prisma.device.findMany({
          where: { userId: req.user.id },
          select: { id: true }
        });
        const deviceIds = userDevices.map(d => d.id);
        if (deviceIds.length > 0) {
          const sessionKeys = await prisma.sessionKey.findMany({
            where: { deviceId: { in: deviceIds } },
            select: { conversationId: true },
            distinct: ['conversationId']
          });
          backfillIds = sessionKeys.map(sk => sk.conversationId);
        }
      } catch (e) {
        console.warn('[Sync] SessionKey backfill failed:', e);
      }
    }
    
    // Merge known IDs with discovered IDs + backfill, deduplicate
    const allIds = [...new Set([...conversationIds, ...backfillIds])];
    
    if (allIds.length === 0) return res.json([]);

    const conversations = await prisma.conversation.findMany({
      where: {
        id: { in: allIds }
      },
      orderBy: { lastMessageAt: 'desc' }
    })

    const safeConversations = conversations.map(c => {
       const conv = toConversation(hoistConvoKeys(c as RawConversationData));
       conv.participants = []; // Participants are stored locally in Opaque Mailbox
       return conv;
    });

    res.json(safeConversations.map(c => ({...c, unreadCount: 0})))
  } catch (error) {
    next(error)
  }
})

// CREATE a new conversation (Opaque Mailbox)
const initialSessionSchema = z.object({
  sessionId: z.string(),
  initialKeysPerDevice: z.record(z.string(), z.string()), 
  initiatorCiphertextsPerDevice: z.record(z.string(), z.string()) 
});

router.post('/', zodValidate({
  body: ConversationSchema.pick({ isGroup: true, encryptedMetadata: true }).extend({
    userIds: z.array(z.string()).min(1),
    initialSession: initialSessionSchema.optional(),
    // [T3b] Map userId -> delivery token, issued client-side by the creator.
    deliveryTokens: z.record(DeliveryTokenSchema, DeliveryTokenSchema).optional(),
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const creatorId = req.user.id
    const { userIds, isGroup, encryptedMetadata, initialSession, deliveryTokens } = req.body as {
      userIds: string[]; isGroup?: boolean; encryptedMetadata?: string | null;
      initialSession?: { sessionId: string; initialKeysPerDevice: Record<string, string>; initiatorCiphertextsPerDevice: Record<string, string> };
      deliveryTokens?: Record<string, string>;
    }

    const today = new Date().toISOString().split('T')[0];
    // INCR+EXPIRE atomik (Lua) — mencegah key hidup selamanya bila proses mati di antaranya
    const sandboxCount = Number(await redisClient.eval(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`, { keys: [`sandbox:newchat:${creatorId}:${today}`], arguments: ['86400'] }));

    const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { isVerified: true } });
    if (!creator?.isVerified && sandboxCount > 3) {
      return res.status(403).json({ error: 'SANDBOX_LIMIT: Unverified users can only create 3 new chats per day.' });
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]))
    
    const authSecret = crypto.randomBytes(32).toString('hex');
    
    let newConversation;
    try {
      newConversation = await prisma.$transaction(async (tx) => {
        const convo = await tx.conversation.create({
          data: {
            isGroup: isGroup === true,
            encryptedMetadata: isGroup ? encryptedMetadata : null,
            authSecret
          }
        });

        if (initialSession) {
          const { sessionId, initialKeysPerDevice, initiatorCiphertextsPerDevice } = initialSession;
          const keyRecords = [];
          for (const deviceId in initialKeysPerDevice) {
            const encryptedKey = initialKeysPerDevice[deviceId];
            const initiatorCiphertext = initiatorCiphertextsPerDevice[deviceId];
            if (typeof encryptedKey !== 'string' || typeof initiatorCiphertext !== 'string') continue;
            keyRecords.push({
              conversationId: convo.id,
              deviceId,
              sessionId,
              encryptedKey: Buffer.from(encryptedKey, 'base64'),
              initiatorCiphertext: Buffer.from(initiatorCiphertext, 'base64')
            });
          }
          if (keyRecords.length > 0) {
            await tx.sessionKey.createMany({ data: keyRecords });
          }
        }
        return convo;
      });
    } catch (dbError) {
      if (!creator?.isVerified) {
        try { await redisClient.decr(`sandbox:newchat:${creatorId}:${today}`); } catch (_e) { }
      }
      throw dbError;
    }

    const safeConversation = toConversation(hoistConvoKeys(newConversation as RawConversationData)) as Conversation;
    safeConversation.participants = []; 
    safeConversation.authSecret = authSecret; // Sharing with creator so they can put it in encryptedMetadata

    // PUSH creation event to userIds passed in the body
    await emitEventToUsers(allUserIds.filter(uid => uid !== creatorId), 'conversation:new', safeConversation);
    
    // Register membership rows for offline recipients.
    // [T3b TOKEN-FIRST] Baris keanggotaan kunci POSISI TOKEN; userId hanya
    // routing-only. Anggota tanpa token (klien lama) TIDAK didaftarkan —
    // mereka menemukan percakapan via pesan relay berikutnya yang membawa
    // token (handleChatMessage targetDeliveryTokens).
    for (const uid of allUserIds.filter(uid => uid !== creatorId)) {
        const token = deliveryTokens?.[uid];
        if (!token) continue;
        prisma.userHiddenConversation.upsert({
            where: { userId_conversationId: { userId: uid, conversationId: newConversation.id } },
            create: { userId: uid, conversationId: newConversation.id, deliveryToken: token },
            update: { deliveryToken: token }
        }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
    }
    
    res.status(201).json({ ...safeConversation, unreadCount: 0 })
  } catch (error) {
    next(error)
  }
})

// GET a single conversation by ID
router.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id }
    })

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    const safeConversation = toConversation(hoistConvoKeys(conversation as RawConversationData));
    safeConversation.participants = [];
    res.json(safeConversation)
  } catch (error) {
    next(error)
  }
})

// UPDATE group conversation details (Opaque)
router.put('/:id/details', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const { encryptedMetadata } = req.body
    const groupToken = req.headers['x-group-token']

    const conversation = await prisma.conversation.findUnique({ where: { id }, select: { authSecret: true } }) as { authSecret: string | null } | null;
    if (!conversation || !safeEqualStrings(conversation.authSecret, typeof groupToken === 'string' ? groupToken : '')) {
        return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token' });
    }

    const updatedConversation = await prisma.conversation.update({ where: { id }, data: { encryptedMetadata } })
    // Opaque Mailbox: notify explicit targetRecipients passed from client
    const targetRecipients = req.body.targetRecipients as string[] | undefined;
    if (Array.isArray(targetRecipients) && targetRecipients.length > 0) {
      await emitEventToUsers(targetRecipients, 'conversation:updated', { id: asConversationId(id), encryptedMetadata: updatedConversation.encryptedMetadata ?? undefined });
    }
    res.json(updatedConversation)
  } catch (error) {
    next(error)
  }
})

// OPAQUE MAILBOX: Member management is handled P2P by clients via encrypted messages.
// These endpoints now just broadcast the intent to the room.

router.post('/:id/participants', async (req, res, next) => {
  const { id: conversationId } = req.params;
  const { userIds } = req.body;
  const groupToken = req.headers['x-group-token'];

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { authSecret: true } }) as { authSecret: string | null } | null;
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!safeEqualStrings(conversation.authSecret, typeof groupToken === 'string' ? groupToken : '')) {
      return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token' });
  }    const safeConv = toConversation(hoistConvoKeys(conversation as unknown as RawConversationData));
  safeConv.participants = [];

  // [T3b TOKEN-FIRST] Membership rows for the NEW members: token-keyed
  // (inviter-issued), userId routing-only. Same contract as POST /conversations.
  const deliveryTokens = req.body.deliveryTokens as Record<string, string> | undefined;
  if (Array.isArray(userIds)) {
    for (const uid of userIds) {
      const token = deliveryTokens?.[uid];
      if (!token) continue;
      prisma.userHiddenConversation.upsert({
        where: { userId_conversationId: { userId: uid, conversationId } },
        create: { userId: uid, conversationId, deliveryToken: token },
        update: { deliveryToken: token }
      }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
    }
  }

  for (const uid of userIds) {
      await emitEventToUser(uid, 'conversation:new', safeConv);
  }
  
  // Opaque Mailbox: notify explicit targetRecipients passed from client
  const addRecipients = req.body.targetRecipients as string[] | undefined;
  if (Array.isArray(addRecipients) && addRecipients.length > 0) {
    await emitEventToUsers(addRecipients, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
  }
  res.status(201).json([]);
});

router.delete('/:id/participants/:userId', async (req, res, next) => {
  const { id: conversationId, userId } = req.params;
  const groupToken = req.headers['x-group-token'];

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { authSecret: true } }) as { authSecret: string | null } | null;
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!safeEqualStrings(conversation.authSecret, typeof groupToken === 'string' ? groupToken : '')) {
      return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token' });
  }

  // Opaque Mailbox: notify explicit targetRecipients passed from client
  const removeRecipients = req.body.targetRecipients as string[] | undefined;
  if (Array.isArray(removeRecipients) && removeRecipients.length > 0) {
    await emitEventToUsers(removeRecipients, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) });
    await emitEventToUsers(removeRecipients, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
  }
  // [T3b] Token revocation = delete row (doc 26.2): kicked member's delivery
  // token dies — they can no longer discover the conversation via sync.
  prisma.userHiddenConversation.delete({
    where: { userId_conversationId: { userId, conversationId } }
  }).catch((e: unknown) => console.warn('[T3b] Failed to revoke delivery token:', e));
  await emitEventToUser(userId, 'conversation:deleted', { id: asConversationId(conversationId) });
  res.status(204).end();
});

router.delete('/:id/leave', async (req, res, next) => {
  const { id: conversationId } = req.params;
  const userId = req.user!.id;
  const groupToken = req.headers['x-group-token'];

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { authSecret: true } }) as { authSecret: string | null } | null;
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  if (!safeEqualStrings(conversation.authSecret, typeof groupToken === 'string' ? groupToken : '')) {
      return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid or missing X-Group-Token' });
  }

  // Opaque Mailbox: notify explicit targetRecipients passed from client
  const leaveRecipients = req.body.targetRecipients as string[] | undefined;
  if (Array.isArray(leaveRecipients) && leaveRecipients.length > 0) {
    await emitEventToUsers(leaveRecipients, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) });
    await emitEventToUsers(leaveRecipients, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
  }
  // [T3b] Leave = revoke own delivery token.
  prisma.userHiddenConversation.delete({
    where: { userId_conversationId: { userId, conversationId } }
  }).catch((e: unknown) => console.warn('[T3b] Failed to revoke delivery token:', e));
  res.status(204).end();
});

// DELETE a conversation (Hidden locally)
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const userId = req.user.id
    
    await emitEventToUser(userId, 'conversation:deleted', { id: asConversationId(id) });
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// PIN conversation (Handled locally in Opaque Mailbox)
router.post('/:id/pin', async (req, res, next) => {
    res.json({ isPinned: true }); 
})

// ROTATE group key (Update updatedAt)
router.post('/:id/key-rotation', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() }
    })

    const safeConv = toConversation(hoistConvoKeys(updatedConversation as RawConversationData));
    safeConv.participants = [];
    res.json({ 
        success: true, 
        message: 'Key rotation recorded successfully', 
        conversation: safeConv 
    })
  } catch (error) { next(error) }
})

export default router
