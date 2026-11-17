import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { bucketTemporalArgs } from './temporalBuckets.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment variables.');
}

const env = process.env.NODE_ENV || 'development';

// Build final connection string with SSL encoded as URL parameter.
// This avoids passing a JavaScript Object (`ssl`) in the Pool config,
// which crashes pg-protocol's startup serialization (Buffer.byteLength
// throws on Object values in Node v24 when used with @prisma/adapter-pg).
//
// Untuk database REMOTE (mis. Aiven), kita tambahkan sslmode=require (TLS tanpa
// verifikasi cert). Untuk database LOKAL (localhost/127.0.0.1) JANGAN dipaksa
// TLS — PostgreSQL lokal pakai cert self-signed (snakeoil Debian) sehingga
// sslmode=require akan gagal dengan TlsConnectionError.
let finalUrl = connectionString;
const isLocalDb = /(^|@)(localhost|127\.0\.0\.1)(:|$|\/)/i.test(connectionString);
if (env !== 'development' && env !== 'test' && !isLocalDb) {
  finalUrl += `${connectionString.includes('?') ? '&' : '?'}sslmode=require`;
}

const pool = new Pool({ connectionString: finalUrl });
const adapter = new PrismaPg(pool);

const base = new PrismaClient({
  adapter,
  log: env === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * [docs/43 §43.16.3] Semua kolom temporal yang tidak dibutuhkan untuk urutan
 * presisi dipotong ke bucket sebelum ditulis (15 menit untuk aktivitas, harian
 * untuk langganan). Dipasang sebagai extension, bukan di 50+ titik tulis,
 * supaya model baru ikut aturan ini tanpa perlu diingat.
 *
 * Cast ke `PrismaClient` karena tipe hasil `$extends()` adalah tipe dinamis
 * yang tidak menyatu dengan `PrismaClient` yang dipakai di signature fungsi
 * (`network/realtimeHandlers.ts`). Runtime tetap klien hasil extension.
 */
export const prisma = base.$extends({
  name: 'temporalBuckets',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        return query(bucketTemporalArgs(model, operation, args) as typeof args);
      },
    },
  },
}) as unknown as PrismaClient;

export default prisma;