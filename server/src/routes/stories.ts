import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { redisClient } from '../lib/redis.js';
import { storyAuthorTag, tagCandidates, resolveRoutingUser } from '../utils/routingIdentity.js';
// [docs/28 Tier 4] key Redis rate-limit tidak menyematkan userId asli.
import { identityTag } from '../utils/redisIdentity.js';

const router = express.Router();

// ============================================================================
// [P3 2026-10-05] Enforcement story:
//  • Blocklist: story pengirim yang MEMBLOKIR requester tidak dapat dibaca
//    (403). Data relasi sudah server-side (BlockedUser) dan kedua pihak
//    authenticated — zero-knowledge isi pesan tidak tersentuh; requester hanya
//    tahu "tidak diizinkan". Dulu endpoint GET /user/:userId menerima siapa pun
//    (metadata polling: jam post, ukuran payload) — audit temuan #8.
//  • Rate limit per (requester, target): atomik Lua INCR+EXPIRE (pola
//    redisBridge — JANGAN incr-then-expire, ada race proses mati).
// ============================================================================
const STORY_VIEW_PER_HOUR = 120;
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

async function isStoryViewAllowed(requesterId: string, targetId: string): Promise<'ok' | 'blocked' | 'rate_limited'> {
  // Pengirim yang memblokir requester → tolak.
  // [docs/28 Tier 1.3 — D9] relasi block kini disimpan sebagai pasangan tag
  // ter-seal (deterministik), jadi pengecekannya tetap satu lookup.
  const block = await prisma.blockedUser.findFirst({
    // [docs/37 §37.4 P6] `in` kandidat supaya baris lama (kunci id 0) dan baru
    // (ENC2) sama-sama terbaca selama rotasi kunci at-rest.
    where: {
      blockerTag: { in: await tagCandidates(targetId) },
      blockedTag: { in: await tagCandidates(requesterId) },
    },
    select: { id: true }
  });
  if (block) return 'blocked';
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  // [docs/28 Tier 4] dua sisi di-tag: dump Redis tidak lagi memetakan "siapa melihat story siapa".
  const key = `rl:story-view:${identityTag(requesterId)}:${identityTag(targetId)}:${hourBucket}`;
  try {
    const count = Number(await redisClient.eval(RATE_LIMIT_LUA, { keys: [key], arguments: ['3600'] }));
    if (count > STORY_VIEW_PER_HOUR) return 'rate_limited';
  } catch (_e) {
    // Redis down → fail-open (ketersediaan > pembatasan metadata)
  }
  return 'ok';
}

/**
 * Whitelist field yang boleh keluar ke klien.
 *
 * [docs/28 D8 — JANGAN dihapus] `authorTag` TIDAK boleh dikirim: nilai ter-seal
 * yang sama juga dipakai di kolom lain (`UHC.userId`, `blockerTag/blockedTag`).
 * Kalau ia bocor ke klien, penyerang yang punya dump bisa memetakan tag → user
 * (dump + observasi API) dan seluruh proteksi ter-seal itu runtuh. Klien cukup
 * menerima `senderId` asli yang di-resolve server saat request.
 */
function toClientStory(
  story: { id: string; encryptedPayload: string; createdAt: Date; expiresAt: Date },
  senderId: string
) {
  return {
    id: story.id,
    encryptedPayload: story.encryptedPayload,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    senderId,
  };
}

// Create a new story
router.post('/', requireAuth, async (req, res) => {
  try {
    const { encryptedPayload } = req.body;
    const userId = req.user!.id;

    if (typeof encryptedPayload !== 'string') {
      return res.status(400).json({ error: 'encryptedPayload must be a string' });
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

    const story = await prisma.story.create({
      data: {
        // [docs/28 D8] penulis disimpan ter-seal, bukan FK userId.
        authorTag: await storyAuthorTag(userId),
        encryptedPayload,
        expiresAt,
      },
    });

    // Kontrak klien TIDAK berubah: `senderId` tetap dikirim (di-resolve server).
    res.status(201).json(toClientStory(story, userId));
  } catch (error) {
    console.error('[Stories] Create error:', error);
    res.status(500).json({ error: 'Failed to create story' });
  }
});

// Get all active stories for a specific user
router.get('/user/:userId', requireAuth, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const requesterId = req.user.id;
    const userId = String(req.params.userId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    // [P3] Blocklist + rate limit (lihat header enforcement di atas).
    if (userId !== requesterId) {
      const verdict = await isStoryViewAllowed(requesterId, userId);
      if (verdict === 'blocked') return res.status(403).json({ error: 'STORY_BLOCKED' });
      if (verdict === 'rate_limited') return res.status(429).json({ error: 'STORY_VIEW_RATE_LIMIT' });
    }
    const stories = await prisma.story.findMany({
      where: {
        // [docs/28 D8] lookup by tag ter-seal (deterministik) — bukan kolom identitas.
        // [docs/37 P6] `in` = kandidat kunci aktif + legacy selama re-seal.
        authorTag: { in: await tagCandidates(userId) },
        expiresAt: { gt: new Date() }, // Only active stories
      },
      orderBy: { createdAt: 'asc' },
    });

    // `senderId` = userId yang diminta (server tahu dari request) → kontrak lama.
    res.json(stories.map(s => toClientStory(s, userId)));
  } catch (error) {
    console.error('[Stories] Get active error:', error);
    res.status(500).json({ error: 'Failed to fetch active stories' });
  }
});

// Get a specific story by ID (only if not expired)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const id = String(req.params.id);
    const story = await prisma.story.findUnique({ where: { id } });

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    if (story.expiresAt < new Date()) {
      return res.status(410).json({ error: 'Story has expired' });
    }

    // [P3] Konsistensi blocklist juga di jalur by-id (pemegang kunci story
    // dari percakapan lama tetap tidak boleh memantau story pengirim yang
    // memblokirnya).
    // [docs/28 D8] penulis dibuka dari tag ter-seal.
    const authorId = await resolveRoutingUser(story.authorTag);
    if (!authorId) return res.status(404).json({ error: 'Story not found' });

    if (authorId !== req.user.id) {
      const verdict = await isStoryViewAllowed(req.user.id, authorId);
      if (verdict === 'blocked') return res.status(403).json({ error: 'STORY_BLOCKED' });
      if (verdict === 'rate_limited') return res.status(429).json({ error: 'STORY_VIEW_RATE_LIMIT' });
    }

    res.json(toClientStory(story, authorId));
  } catch (error) {
    console.error('[Stories] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

// Delete a story early
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const userId = req.user!.id;

    const story = await prisma.story.findUnique({ where: { id } });

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // [docs/28 D8] kepemilikan = tag ter-seal cocok.
    // [2026-10 legacy purge] Cabang pembandingan plaintext (tag = userId) dibuang.
    const myTags = await tagCandidates(userId);
    const isOwner = myTags.includes(story.authorTag);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized to delete this story' });
    }

    await prisma.story.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('[Stories] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

export default router;
