import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';

const prisma = new PrismaClient();
const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });

async function reset() {
  console.log('🔄 Resetting database and redis for E2E tests...');
  try {
    // Delete in reverse dependency order or let Prisma handle the cascading deletes where appropriate.
    // Since we're using deleteMany, deleting User will cascade to many relations if set up with onDelete: Cascade.
    // But it's safer to delete specific root tables first.
    await prisma.$transaction([
      prisma.messageStatus.deleteMany(),
      prisma.message.deleteMany(),
      prisma.participant.deleteMany(),
      prisma.userHiddenConversation.deleteMany(),
      prisma.conversation.deleteMany(),
      prisma.story.deleteMany(),
      prisma.sessionKey.deleteMany(),
      prisma.oneTimePreKey.deleteMany(),
      prisma.preKeyBundle.deleteMany(),
      prisma.refreshToken.deleteMany(),
      prisma.pushSubscription.deleteMany(),
      prisma.device.deleteMany(),
      prisma.authenticator.deleteMany(),
      prisma.blockedUser.deleteMany(),
      prisma.user.deleteMany(),
    ]);
    
    await redis.connect();
    await redis.flushAll();
    await redis.quit();

    console.log('✅ Test environment reset successful.');
  } catch (error) {
    console.error('❌ Failed to reset test environment:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

reset();
