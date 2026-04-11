import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Muat variabel lingkungan
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ✅ FIX: Inisialisasi Prisma dengan pg adapter secara eksplisit
// Persis seperti yang dilakukan di server/src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from 'redis';

// Atur koneksi pool PostgreSQL
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set in the environment variables.");
}
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });

async function reset() {
  // 🚨 CRITICAL GUARDRAIL: Mencegah eksekusi tidak sengaja di Production atau DB eksternal
  if (
    process.env.NODE_ENV === 'production' || 
    (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1') && !process.env.DATABASE_URL.includes('postgres'))
  ) {
    console.error('❌ DANGER: Attempted to wipe database in non-local/production environment!');
    process.exit(1);
  }

  console.log('🔄 Resetting database and redis for E2E tests...');
  try {
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
    // Pastikan pool ditutup agar script bisa berhenti dengan sempurna
    await pool.end();
  }
}

reset();
