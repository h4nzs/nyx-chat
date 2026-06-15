import { redisClient } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';

const CACHE_TTL = 3600; // 1 Hour

/**
 * Retrieves participant IDs for a conversation with Redis caching.
 * Used for real-time broadcasts and notification routing.
 */
export async function getParticipantIds(conversationId: string): Promise<string[]> {
  const cacheKey = `cache:participants:${conversationId}`;

  try {
    // 1. Try RAM/Redis Cache
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 2. Fetch from DB
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { select: { userId: true } } }
    });

    if (!conversation) return [];

    const participantIds = conversation.participants.map(p => p.userId);

    // 3. Populate Cache
    await redisClient.set(cacheKey, JSON.stringify(participantIds), { EX: CACHE_TTL });
    return participantIds;

  } catch (error) {
    console.error(`[Cache] Error fetching participants for ${conversationId}:`, error);
    // Fallback to DB directly if Redis fails
    const participants = await prisma.participant.findMany({
      where: { conversationId },
      select: { userId: true }
    });
    return participants.map(p => p.userId);
  }
}

/**
 * Invalidates the participant cache for a conversation.
 * MUST be called when members are added, removed, or leave.
 */
export async function invalidateParticipantCache(conversationId: string): Promise<void> {
  const cacheKey = `cache:participants:${conversationId}`;
  try {
    await redisClient.del(cacheKey);
  } catch (error) {
    console.error(`[Cache] Error invalidating participants for ${conversationId}:`, error);
  }
}
