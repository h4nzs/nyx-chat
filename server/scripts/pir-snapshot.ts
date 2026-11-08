import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPirRefreshConfig, refreshPirSnapshot } from '../src/jobs/pirSnapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Build manual: bangun shard PIR dari DB, tulis ke `PIR_SHARD_DIR`, dan kirim ke
 * kedua sidecar. Dipakai setelah restore/migrasi, atau saat ingin memastikan
 * isi shard tanpa menunggu cron 3 menit.
 */
async function main(): Promise<void> {
  const config = loadPirRefreshConfig();
  if (!config) {
    throw new Error('PIR tidak aktif: butuh PIR_ENABLED=1, PIR_SERVERS, dan PIR_ADMIN_TOKEN');
  }
  const { prisma } = await import('../src/lib/prisma.js');
  try {
    const result = await refreshPirSnapshot(config);
    console.log(
      `PIR shard: epoch=${result.epoch} entries=${result.entries} shards=${result.shards} ` +
        `dir=${config.shardDir ?? '-'}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('PIR shard gagal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
