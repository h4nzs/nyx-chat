import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { redisClient } from '../lib/redis.js';

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
  const block = await prisma.blockedUser.findUnique({
    where: { blockerId_blockedId: { blockerId: targetId, blockedId: requesterId } },
    select: { blockerId: true }
  });
  if (block) return 'blocked';
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `rl:story-view:${requesterId}:${targetId}:${hourBucket}`;
  try {
    const count = Number(await redisClient.eval(RATE_LIMIT_LUA, { keys: [key], arguments: ['3600'] }));
    if (count > STORY_VIEW_PER_HOUR) return 'rate_limited';
  } catch (_e) {
    // Redis down → fail-open (ketersediaan > pembatasan metadata)
  }
  return 'ok';
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
        senderId: userId,
        encryptedPayload,
        expiresAt,
      },
    });

    res.status(201).json(story);
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
        senderId: userId,
        expiresAt: { gt: new Date() }, // Only active stories
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(stories);
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
    if (story.senderId !== req.user.id) {
      const verdict = await isStoryViewAllowed(req.user.id, story.senderId);
      if (verdict === 'blocked') return res.status(403).json({ error: 'STORY_BLOCKED' });
      if (verdict === 'rate_limited') return res.status(429).json({ error: 'STORY_VIEW_RATE_LIMIT' });
    }

    res.json(story);
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

    if (story.senderId !== userId) {
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
