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

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = createClient({ url: redisUrl });

/**
 * Hanya loopback yang boleh dihapus. Versi lama memakai `includes('postgres')`
 * sehingga URL eksternal apa pun (`postgres://user@db.prod/...`) LOLOS guard.
 * Parsing hostname juga membuat target yang akan dihapus tercetak tanpa
 * kredensial, sehingga operator bisa melihat DB mana yang kena sebelum data
 * hilang.
 */
function assertLoopback(raw: string | undefined, label: string): URL {
  if (!raw) {
    console.error(`❌ ${label} tidak diset — tidak ada yang dihapus.`);
    process.exit(1);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`❌ ${label} bukan URL yang bisa di-parse — tidak ada yang dihapus.`);
    process.exit(1);
  }
  const host = url.hostname;
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!isLoopback) {
    console.error(`❌ DANGER: ${label} menunjuk host non-loopback (${host}); wipe dibatalkan.`);
    process.exit(1);
  }
  return url;
}

async function reset() {
  // 🚨 CRITICAL GUARDRAIL: Production atau host eksternal tidak boleh dihapus.
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ DANGER: Attempted to wipe database in production environment!');
    process.exit(1);
  }
  const dbTarget = assertLoopback(process.env.DATABASE_URL, 'DATABASE_URL');
  const redisTarget = assertLoopback(redisUrl, 'REDIS_URL');

  // Cetak TARGET, bukan kredensial: operator selfhost harus bisa melihat bahwa
  // E2E akan menghapus DB aplikasi sebelum hal itu terjadi.
  console.log(
    `🔄 Resetting database "${dbTarget.pathname.replace(/^\//, '')}" on ${dbTarget.hostname} ` +
      `and Redis on ${redisTarget.hostname} for E2E tests...`
  );
  console.log(
    '   (pakai NYX_E2E_DATABASE_URL untuk mengarahkan E2E ke DB terpisah — lihat docs/11)'
  );
  try {
    await prisma.$transaction([
      prisma.messageStatus.deleteMany(),
      prisma.message.deleteMany(),
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
    
    if (!redisUrl.includes('localhost') && !redisUrl.includes('127.0.0.1')) {
      console.error('❌ DANGER: Redis URL is not local! Aborting wipe.');
      process.exit(1);
    }
    await redis.connect();
    await redis.flushDb();
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
