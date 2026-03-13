import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Create a new story
router.post('/', requireAuth, async (req, res) => {
  try {
    const { encryptedPayload } = req.body;
    const userId = req.user!.id;

    if (!encryptedPayload) {
      return res.status(400).json({ error: 'encryptedPayload is required' });
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

// Get a specific story by ID (only if not expired)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id as string;
    const story = await prisma.story.findUnique({ where: { id } });

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    if (story.expiresAt < new Date()) {
      return res.status(410).json({ error: 'Story has expired' });
    }

    res.json(story);
  } catch (error) {
    console.error('[Stories] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

// Get all active stories for a specific user
router.get('/user/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
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

// Delete a story early
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id as string;
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
