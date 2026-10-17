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
import { credentialTokenMatches, hashCredentialToken } from '../utils/atRestSecrets.js'
// [docs/29 §7.1] Gate keanggotaan issuance + capability admin (bisa diuji
// dengan klien Prisma palsu; lihat tests/credentialAuth.test.ts).
import {
  DELIVERY_TOKEN_RE, authorizeCredentialIssuance, type CredentialAuthDb,
} from '../utils/credentialAuth.js'
import {
  authorizeMemberMutation, authorizeMemberLeave, authorizeDetailsWrite,
  authorizeKeyRotation, authorizeGroupPurge, type GroupAccessDb,
} from '../utils/groupAccess.js'
import {
  CREDENTIAL_INCR_LUA, CREDENTIAL_QUOTA_TTL_SECONDS, commitAllowed, credentialCommitKey,
  credentialDays, credentialIssuanceKey, exceedsIssuanceQuota,
} from '../utils/credentialIssuance.js'
// [docs/28 Tier 4] identitas at-rest: key Redis ber-tag + metadata grup tanpa userId penulis.
import { identityTag } from '../utils/redisIdentity.js'
import { sanitizeGroupMetadataBlob } from '../utils/groupMetadataBlob.js'
import { messageTimeBucket } from '../utils/temporalBucket.js'
import {
  upsertMembership, deleteMembership, type MembershipPrisma
} from '../utils/routingIdentity.js'
import type { Conversation } from '@nyx/shared'
// [BUGFIX 2026-10-16] Skema body pembuatan percakapan dipindah ke
// `utils/conversationSchemas.ts`: `zodValidate` mengganti `req.body` dengan
// hasil parse, dan skema lokal (non-passthrough) di sini dulu membuang
// `adminSecretHash` sebelum handler membacanya → SETIAP pembuatan grup 400.
import { createConversationBodySchema } from '../utils/conversationSchemas.js'

const router: Router = Router()
router.use(requireAuth)

// [docs/29 §7.1 / docs/30 WS-G] Otorisasi issuance credential dan capability
// admin kini tinggal di `utils/credentialAuth.ts` supaya keputusannya bisa
// diuji sebagai perilaku (klien Prisma palsu) — bukan hanya regex atas source.
const authDb = prisma as unknown as CredentialAuthDb

// [docs/30 WS-G(4) sisa] Jalur grup (anggota/leave/details/rotasi/purge) juga
// dipindah ke `utils/groupAccess.ts` — tes perilakunya di
// `tests/groupAccess.test.ts` mengunci urutan gate & kode status, bukan teks.
const groupDb = prisma as unknown as GroupAccessDb

// [26.8.1] Issuer public key — dibagikan bebas ke semua klien.
router.get('/credential-issuer-key', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { keyVersion, publicJwk } = await getIssuerPublicJwk()
    res.json({ suite: CREDENTIAL_SUITE, keyVersion, publicJwk })
  } catch (error) { next(error) }
})

// [26.8.1] Credential issuance — klien mengirim (conversationId, blindedMsg)
// yang sudah di-blind. Server hanya melihat blinded message; TIDAK bisa
// mengaitkannya dengan user/anggota. Kontrak kepercayaan: klien hanya meminta
// satu credential per keanggotaannya; server mencatat serial untuk dedupe &
// revocation (serial = hash prepared message, tidak bisa di-link balik).
// [docs/29 §7.1] WAJIB membawa bukti keanggotaan (X-Group-Token atau delivery
// token) — lihat authorizeCredentialIssuance.
router.post('/credential-issuance', zodValidate({
  body: z.object({
    conversationId: z.string().min(1).max(64),
    blindedMsg: z.string().min(1).max(1024), // base64url dari blinded message
    // Alternatif bukti keanggotaan untuk klien yang belum bisa mengirim header
    // (mis. token undangan sudah didapat, metadata belum ter-dekripsi).
    deliveryToken: z.string().regex(DELIVERY_TOKEN_RE).optional(),
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId, blindedMsg, deliveryToken } = req.body as {
      conversationId: string; blindedMsg: string; deliveryToken?: string
    }

    if (!(await authorizeCredentialIssuance(authDb, conversationId, req.headers as unknown as Record<string, unknown>, deliveryToken))) {
      return res.status(403).json({ error: 'MEMBERSHIP_PROOF_REQUIRED: Valid X-Group-Token or delivery token required.' });
    }

    // Per-user quota anti-abuse: satu issuance per (user, conversation) per hari.
    // Grup nyata tidak perlu lebih — credential tidak berubah kecuali re-join.
    // [docs/29 §7.1] key memakai identityTag (bukan userId mentah): Redis
    // persisten = artefak setara dump, jadi kunci tidak boleh memuat identitas.
    // Counter yang sama juga berfungsi sebagai TIKET yang dibatasi di commit.
    const [today] = credentialDays();
    const issueKey = credentialIssuanceKey(req.user.id, conversationId, today!);
    const count = Number(await redisClient.eval(CREDENTIAL_INCR_LUA, {
      keys: [issueKey], arguments: [String(CREDENTIAL_QUOTA_TTL_SECONDS)],
    }));
    if (exceedsIssuanceQuota(count)) {
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
// & revocation.
//
// Integritas isi dijaga saat PRESENTASI (serial hanya lolos bila tanda tangan
// valid untuk conversationId yang diklaim + binding konteks cocok). Di sini
// yang ditegakkan: (a) bukti keanggotaan yang sama seperti issuance, (b) commit
// tidak boleh melebihi jumlah issuance hari itu — tanpa ini siapa pun bisa
// menyuntikkan serial 96-hex sembarang tanpa batas (spam tabel GroupCredential).
router.post('/credential-commit', zodValidate({
  body: z.object({
    conversationId: z.string().min(1).max(64),
    keyVersion: z.number().int().min(1),
    serial: z.string().length(SERIAL_HEX_LENGTH),
    deliveryToken: z.string().regex(DELIVERY_TOKEN_RE).optional(),
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId, keyVersion, serial, deliveryToken } = req.body as {
      conversationId: string; keyVersion: number; serial: string; deliveryToken?: string
    }

    if (!(await authorizeCredentialIssuance(authDb, conversationId, req.headers as unknown as Record<string, unknown>, deliveryToken))) {
      return res.status(403).json({ error: 'MEMBERSHIP_PROOF_REQUIRED: Valid X-Group-Token or delivery token required.' });
    }

    // Ticket check: issuance di hari ini ATAU kemarin (grace tengah malam).
    const days = credentialDays();
    const issuedCounts = await Promise.all(days.map(day =>
      redisClient.get(credentialIssuanceKey(req.user.id, conversationId, day!))
    ));
    const issued = issuedCounts.reduce((max, raw) => Math.max(max, Number(raw ?? 0)), 0);

    const [today] = days;
    const commitKey = credentialCommitKey(req.user.id, conversationId, today!);
    const committed = Number(await redisClient.eval(CREDENTIAL_INCR_LUA, {
      keys: [commitKey], arguments: [String(CREDENTIAL_QUOTA_TTL_SECONDS)],
    }));
    if (!commitAllowed(committed, issued)) {
      return res.status(403).json({ error: 'CREDENTIAL_COMMIT_WITHOUT_ISSUANCE: No issuance ticket for this credential.' });
    }

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
    if (!conversation || !credentialTokenMatches(conversation.authSecret, groupToken)) {
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
      // [docs/28 Tier 2 — B3] `lastMessageAt` kini di-bucket (15 menit) → tie-break
      // deterministik supaya urutan daftar chat tidak flip saat seri bucket.
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }]
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
router.post('/', zodValidate({ body: createConversationBodySchema }), async (req, res, next) => {
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
`, { keys: [`sandbox:newchat:${identityTag(creatorId)}:${today}`], arguments: ['86400'] }));

    const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { isVerified: true } });
    if (!creator?.isVerified && sandboxCount > 3) {
      return res.status(403).json({ error: 'SANDBOX_LIMIT: Unverified users can only create 3 new chats per day.' });
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]))
    
    // [docs/28 Tier 0 — D3] Token grup tetap dibuat & dikirim ke pembuat (dia
    // menyimpannya di encryptedMetadata), tapi server HANYA menyimpan hash-nya
    // (pola adminSecretHash) — dump DB tidak bisa lagi dipakai untuk ikut bicara
    // di grup. Bandingkan lewat credentialTokenMatches (hash-only).
    const authSecret = crypto.randomBytes(32).toString('hex');
    // [26.9 RBAC] Creator-generated admin capability token dikirim sebagai HASH
    // (SHA-256 hex) — token asli tidak pernah menyentuh server; ia di-seal
    // pairwise ke device creator + admin lain oleh klien.
    // [2026-10 legacy purge] WAJIB untuk grup: dulu boleh null (grup pra-RBAC
    // memakai bypass di isAdminTokenValid), dan celah itu membuat grup tanpa
    // proteksi admin bisa lahir. Klien sekarang selalu mengirimnya pada create.
    const rawAdminSecretHash = req.body.adminSecretHash;
    if (isGroup === true && typeof rawAdminSecretHash !== 'string') {
      return res.status(400).json({ error: 'adminSecretHash required for groups' });
    }
    const adminSecretHash = typeof rawAdminSecretHash === 'string' && isGroup === true
      ? rawAdminSecretHash
      : null;
    if (adminSecretHash !== null && !/^[a-f0-9]{64}$/.test(adminSecretHash)) {
      return res.status(400).json({ error: 'Invalid adminSecretHash format' });
    }
    
    let newConversation;
    try {
      newConversation = await prisma.$transaction(async (tx) => {
        const convo = await tx.conversation.create({
          data: {
            isGroup: isGroup === true,
            // [docs/28 Tier 4] buang `senderId` (userId penulis) dari wrapper
            // metadata v2 — reader tidak memakainya.
            encryptedMetadata: isGroup ? sanitizeGroupMetadataBlob(encryptedMetadata) : null,
            authSecret: hashCredentialToken(authSecret),
            adminSecretHash,
            // [docs/28 Tier 4 / B3] createdAt grup dipotong 15 menit: presisi
            // penuh memberi urutan/tebakan kapan grup dibuat.
            createdAt: messageTimeBucket()
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
        try { await redisClient.decr(`sandbox:newchat:${identityTag(creatorId)}:${today}`); } catch (_e) { }
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
        // [docs/28 Tier 1.2] kolom userId berisi routing identity ter-seal.
        upsertMembership(prisma as unknown as MembershipPrisma, {
            userId: uid, conversationId: newConversation.id, deliveryToken: token
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

    // [docs/30 WS-G(4)] Gate token grup + capability admin (urutan & kode status
    // sama seperti sebelumnya; lihat `authorizeDetailsWrite`).
    const accessGate = await authorizeDetailsWrite(groupDb, id, req.headers as Record<string, unknown>)
    if (!accessGate.ok) return res.status(accessGate.status).json({ error: accessGate.error })

    // [docs/28 Tier 4] sanitasi SEBELUM simpan supaya blob (dan event relay) bebas userId penulis.
    const sanitizedMetadata = sanitizeGroupMetadataBlob(encryptedMetadata)
    const updatedConversation = await prisma.conversation.update({ where: { id }, data: { encryptedMetadata: sanitizedMetadata } })
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

  // [docs/30 WS-G(4)] 404 conversation hilang → 403 tanpa/salah X-Group-Token.
  const memberGate = await authorizeMemberMutation(groupDb, conversationId, req.headers as Record<string, unknown>);
  if (!memberGate.ok) return res.status(memberGate.status).json({ error: memberGate.error });
  // [BUGFIX 2026-10-01] JANGAN pass record parsial (select: authSecret saja) ke
  // toConversation — Date.toISOString(undefined) meledak "Invalid time value"
  // → 500 saat add participant. Broadcast pakai payload minimal (Opaque
  // Mailbox: klien mengisi roster dari metadata terenkripsi) + sertakan
  // encryptedMetadata TERKINI agar anggota baru langsung bisa decrypt tanpa
  // fetch ulang (dulu kosong → "Unknown Group" sampai offline sync).
  const currentConv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { encryptedMetadata: true } });
  const safeConv = toConversation({ id: conversationId, isGroup: true, encryptedMetadata: currentConv?.encryptedMetadata ?? undefined, createdAt: new Date(), updatedAt: new Date() } as unknown as RawConversationData);
  safeConv.participants = [];

  // [T3b TOKEN-FIRST] Membership rows for the NEW members: token-keyed
  // (inviter-issued), userId routing-only. Same contract as POST /conversations.
  const deliveryTokens = req.body.deliveryTokens as Record<string, string> | undefined;
  if (Array.isArray(userIds)) {
    for (const uid of userIds) {
      const token = deliveryTokens?.[uid];
      if (!token) continue;
      // [docs/28 Tier 1.2] kolom userId berisi routing identity ter-seal.
      upsertMembership(prisma as unknown as MembershipPrisma, {
        userId: uid, conversationId, deliveryToken: token
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

  // [docs/30 WS-G(4)] Kick = mutasi anggota; gate yang sama dengan add.
  const kickGate = await authorizeMemberMutation(groupDb, conversationId, req.headers as Record<string, unknown>);
  if (!kickGate.ok) return res.status(kickGate.status).json({ error: kickGate.error });

  // Opaque Mailbox: notify explicit targetRecipients passed from client
  const removeRecipients = req.body.targetRecipients as string[] | undefined;
  if (Array.isArray(removeRecipients) && removeRecipients.length > 0) {
    await emitEventToUsers(removeRecipients, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) });
    await emitEventToUsers(removeRecipients, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
  }
  // [T3b] Token revocation = delete row (doc 26.2): kicked member's delivery
  // token dies — they can no longer discover the conversation via sync.
  deleteMembership(prisma as unknown as MembershipPrisma, { userId, conversationId })
    .catch((e: unknown) => console.warn('[T3b] Failed to revoke delivery token:', e));
  await emitEventToUser(userId, 'conversation:deleted', { id: asConversationId(conversationId) });
  res.status(204).end();
});

router.delete('/:id/leave', async (req, res, next) => {
  const { id: conversationId } = req.params;
  const userId = req.user!.id;

  // [BUGFIX 2026-10-02 — LEAVE TANPA METADATA, dipertahankan] Anggota yang
  // metadata-nya belum ter-decrypt tidak punya authSecret (authSecret hidup di
  // dalam metadata) → sebelumnya leave SELALU 403. Jalur kedua: baris
  // delivery-token milik user sendiri (lihat `authorizeMemberLeave`).
  const leaveGate = await authorizeMemberLeave(groupDb, conversationId, req.headers as Record<string, unknown>, userId);
  if (!leaveGate.ok) return res.status(leaveGate.status).json({ error: leaveGate.error });

  // Opaque Mailbox: notify explicit targetRecipients passed from client
  const leaveRecipients = req.body.targetRecipients as string[] | undefined;
  if (Array.isArray(leaveRecipients) && leaveRecipients.length > 0) {
    await emitEventToUsers(leaveRecipients, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) });
    await emitEventToUsers(leaveRecipients, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
  }
  // [T3b] Leave = revoke own delivery token.
  deleteMembership(prisma as unknown as MembershipPrisma, { userId, conversationId })
    .catch((e: unknown) => console.warn('[T3b] Failed to revoke delivery token:', e));
  res.status(204).end();
});

// [26.9 SOLO-LEAVE] DELETE grup PERMANEN — hanya diizinkan bila TIDAK ADA
// anggota tersisa (guard: nol delivery token). Client memanggil ini SETELAH
// /leave sukses (leave menghapus row token milik sendiri). Anggota lain yang
// masih punya delivery token membuat endpoint ini menolak (409) — grup tidak
// bisa dihancurkan di belakang punggung anggota aktif. Purge: GroupCredential
// dihapus manual (tanpa FK), sisanya cascade (messages, sessionKeys, hiddenBy).
router.delete('/:id/group', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params

    // [26.9 RBAC] Purge grup permanen = operasi admin; urutan gate (404 → 400 →
    // 403 token → admin → 409 MEMBERS_REMAIN) diuji di `tests/groupAccess.test.ts`.
    const purgeGate = await authorizeGroupPurge(groupDb, id, req.headers as Record<string, unknown>)
    if (!purgeGate.ok) return res.status(purgeGate.status).json({ error: purgeGate.error })

    await prisma.groupCredential.deleteMany({ where: { conversationId: id } })
    await prisma.conversation.delete({ where: { id } })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

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

    // [26.9 RBAC] Rotasi kunci = operasi admin (non-admin tetap bisa lazy-rotate
    // lokal via ensureGroupSession saat kirim pesan — endpoint ini hanya untuk
    // rotasi AKTIF oleh pengelola grup).
    const rotateGate = await authorizeKeyRotation(groupDb, id, req.headers as Record<string, unknown>)
    if (!rotateGate.ok) return res.status(rotateGate.status).json({ error: rotateGate.error })

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
