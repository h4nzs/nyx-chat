// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 3.2] Dump simulator — bukti privasi at-rest, bukan sekadar argumen.
 *
 * Alur: seed DB LOKAL dengan skenario 1:1 + grup (memakai helper penulisan yang
 * SAMA dengan jalur produksi: `sealAtRest`, `routingIdentity`,
 * `conversationScopedTag`, `messageTimeBucket`) → `pg_dump --data-only` → audit
 * teks dump dengan `utils/dumpAudit.ts` → bersihkan baris seed.
 *
 * Pemakaian:
 *   # bukti penuh (butuh Postgres lokal + Redis lokal):
 *   pnpm --filter nyx-server exec tsx scripts/privacy-dump-audit.ts
 *
 *   # offline: audit dump yang sudah ada (tanpa DB), rahasia dari JSON:
 *   tsx scripts/privacy-dump-audit.ts --dump dump.sql --secrets secrets.json
 *
 * Jalur live menolak jalan di production atau bila DATABASE_URL bukan host lokal
 * (guard yang sama dengan scripts/reset-test-env.ts). Script HANYA membuat baris
 * miliknya sendiri (`runId`) dan menghapusnya kembali — tidak menyentuh data
 * pengguna yang sudah ada, dan tidak pernah menjalankan `db push`.
 */

import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import {
  auditDumpForIdentityLeaks,
  auditPassed,
  auditRedisArtifacts,
  columnValues,
  formatAuditReport,
  parseCopySections,
  type DumpAuditContext,
} from '../src/utils/dumpAudit.js';
import { conversationScopedTag, deviceInstallationTag, sealAtRest } from '../src/utils/atRestSecrets.js';
import { routingIdentity } from '../src/utils/routingIdentity.js';
import { hashGroupToken } from '../src/utils/groupTokens.js';
import { messageTimeBucket } from '../src/utils/temporalBucket.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/** Buang parameter khusus Prisma (`?schema=public`) yang ditolak libpq/pg_dump. */
function toLibpqUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('schema');
    return url.toString();
  } catch {
    return raw;
  }
}

function assertLocalDatabase(connectionString: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Ditolak: NODE_ENV=production. Dump simulator hanya untuk DB pengembangan.');
  }
  if (!/localhost|127\.0\.0\.1/.test(connectionString)) {
    throw new Error(
      `Ditolak: DATABASE_URL bukan host lokal (${connectionString.replace(/:[^:@/]+@/, ':***@')}). ` +
      'Dump simulator hanya boleh menyentuh DB pengembangan.'
    );
  }
}

// ---------------------------------------------------------------------------
// Mode offline: audit dump file yang sudah ada.
// ---------------------------------------------------------------------------

async function runOffline(dumpFile: string, secretsFile: string | undefined): Promise<number> {
  const dump = await readFile(dumpFile, 'utf8');
  let ctx: DumpAuditContext = {};
  if (secretsFile) {
    ctx = JSON.parse(await readFile(secretsFile, 'utf8')) as DumpAuditContext;
  }
  const findings = auditDumpForIdentityLeaks(dump, ctx);
  console.log(`\n=== Audit dump (${dumpFile}) ===`);
  console.log(formatAuditReport(findings));
  return auditPassed(findings) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Mode live: seed → pg_dump → audit → cleanup.
// ---------------------------------------------------------------------------

async function runLive(): Promise<number> {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL / DIRECT_URL tidak diset.');
  assertLocalDatabase(connectionString);

  const { PrismaClient } = await import('@prisma/client');
  const { Pool } = await import('pg');
  const { PrismaPg } = await import('@prisma/adapter-pg');

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const runId = randomUUID().slice(0, 8);
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const carolId = randomUUID();
  const tenantId = randomUUID();
  const convId = randomUUID();
  const msgId = randomUUID();
  const deviceId = randomUUID();
  const externalId = `b2b-customer-${runId}`;
  const deviceName = `Chrome on macOS (${runId})`;
  const installRaw = `install-anchor-${runId}`;
  const pushEndpoint = `https://fcm.googleapis.com/fcm/send/${runId}`;
  const messageIds = [msgId];

  const seededUserIds = [aliceId, bobId, carolId];
  const dumpFile = path.join(tmpdir(), `nyx-privacy-dump-${runId}.sql`);

  try {
    console.log(`\n=== Seed skenario privasi (run ${runId}) ===`);
    await prisma.tenant.create({
      data: { id: tenantId, name: `tenant-${runId}`, apiKey: `sealed-key-${runId}`, allowedDomains: [] },
    });

    await prisma.user.createMany({
      data: seededUserIds.map((id) => ({
        id,
        usernameHash: `hash-${id}`,
        passwordHash: 'argon2-not-a-real-hash',
        lastActiveDay: messageTimeBucket(new Date()),
      })),
    });
    // Identitas B2B ter-seal (jalur engine.ts).
    await prisma.user.update({
      where: { id: aliceId },
      data: { tenantId, externalIdSealed: await sealAtRest(externalId) },
    });

    await prisma.device.create({
      data: {
        id: deviceId,
        userId: aliceId,
        nameSealed: await sealAtRest(deviceName),
        fingerprint: 'peppered-fingerprint-placeholder',
        installationTag: deviceInstallationTag(installRaw),
        publicKey: Buffer.from('identity-key'),
        signingKey: Buffer.from('signing-key'),
      },
    });
    await prisma.pushSubscription.create({
      data: {
        endpointSealed: await sealAtRest(pushEndpoint),
        p256dh: 'p256dh-placeholder',
        auth: 'auth-placeholder',
        deviceId,
      },
    });

    // Percakapan grup dengan authSecret (harus hash) + keanggotaan ter-seal.
    await prisma.conversation.create({
      data: {
        id: convId,
        isGroup: true,
        encryptedMetadata: 'opaque-client-blob',
        authSecret: 'a'.repeat(64),
        lastMessageAt: messageTimeBucket(new Date()),
        tenantId,
      },
    });
    for (const uid of [aliceId, bobId]) {
      await prisma.userHiddenConversation.create({
        data: {
          userId: await routingIdentity(uid),
          conversationId: convId,
          tokenHash: hashGroupToken(`token-${uid}-${runId}`),
          tokenEpoch: 0,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        },
      });
    }

    // Pesan 1:1: senderId NULL (sealed sender) + receipt tag opaque.
    await prisma.message.create({
      data: {
        id: msgId,
        conversationId: convId,
        senderId: null,
        content: 'opaque-ciphertext',
        seq: 1,
        createdAt: messageTimeBucket(new Date()),
        deleteSecret: 'b'.repeat(64),
        repliedToId: await sealAtRest('parent-message-id'),
      },
    });
    await prisma.messageStatus.create({
      data: {
        messageId: msgId,
        userId: conversationScopedTag(convId, bobId),
        status: 'READ',
        updatedAt: messageTimeBucket(new Date()),
      },
    });

    await prisma.story.create({
      data: { authorTag: await routingIdentity(aliceId), encryptedPayload: 'opaque-story', expiresAt: new Date(Date.now() + 86400_000) },
    });
    await prisma.blockedUser.create({
      data: { blockerTag: await routingIdentity(aliceId), blockedTag: await routingIdentity(carolId) },
    });

    // --- Redis: tulis artefak dengan helper produksi (tag, bukan userId) ---
    const redis = await import('redis');
    const redisClient = redis.createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    let redisKeys: string[] = [];
    let redisMembers: string[] = [];
    let redisScanned = false;
    try {
      await redisClient.connect();
      const { identityKey, identityTag, sealIdentity } = await import('../src/utils/redisIdentity.js');
      await redisClient.set(identityKey('active_device', aliceId), deviceId, { EX: 60 });
      await redisClient.set(identityKey('is_migrating', bobId), '1', { EX: 60 });
      await redisClient.sAdd('online_users', identityTag(aliceId));
      await redisClient.sAdd(`burner:room:${convId}`, await sealIdentity(aliceId));
      await redisClient.set(`linking_token:${runId}`, await sealAtRest(JSON.stringify({ userId: aliceId, deviceId })), { EX: 60 });

      const cursorWalk = async (): Promise<string[]> => {
        const found: string[] = [];
        let cursor = '0';
        do {
          const reply = await redisClient.scan(cursor, { COUNT: 100 });
          cursor = String(reply.cursor);
          found.push(...reply.keys);
        } while (cursor !== '0');
        return found;
      };
      redisKeys = await cursorWalk();
      const memberSources = ['online_users', ...redisKeys.filter((k) => /^(burner|migration):room:/.test(k))];
      for (const key of memberSources) {
        redisMembers.push(...await redisClient.sMembers(key));
      }
      redisScanned = true;
    } finally {
      await redisClient.quit().catch(() => {});
    }

    // --- pg_dump ---
    console.log('=== pg_dump (data-only) ===');
    const { stdout } = await execFileAsync('pg_dump', ['--data-only', '--no-owner', '--no-privileges', toLibpqUrl(connectionString)], {
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? '' },
    });
    await writeFile(dumpFile, stdout, 'utf8');
    console.log(`dump tersimpan sementara: ${dumpFile} (${stdout.length} byte)`);

    // --- Audit teks dump ---
    const ctx: DumpAuditContext = {
      userIds: seededUserIds,
      messageIds,
      deviceNames: [deviceName, installRaw],
      externalIds: [externalId],
      pushEndpoints: [pushEndpoint],
    };
    const findings = auditDumpForIdentityLeaks(stdout, ctx);

    // Kontrol positif: pastikan audit tidak lulus hanya karena tabel kosong.
    const sections = parseCopySections(stdout);
    const sealedAlice = await sealAtRest(aliceId);
    const membershipValues = columnValues(sections, 'UserHiddenConversation', 'userId');
    findings.push({
      rule: 'positive-control.sealed-membership-present',
      ok: membershipValues.includes(sealedAlice),
      detail: membershipValues.length === 0
        ? 'tidak ada baris keanggotaan di dump → audit akan vakum'
        : 'keanggotaan tersimpan dalam bentuk ter-seal (bukan userId asli)',
    });

    if (redisScanned) {
      console.log('=== Audit Redis (SCAN) ===');
      findings.push(...auditRedisArtifacts(redisKeys, redisMembers, seededUserIds));
    } else {
      console.log('⚠️  Redis tidak tersedia — audit artefak Redis dilewati.');
    }

    console.log('\n=== Hasil ===');
    console.log(formatAuditReport(findings));

    const secretsFile = path.join(tmpdir(), `nyx-privacy-secrets-${runId}.json`);
    await writeFile(secretsFile, JSON.stringify(ctx, null, 2), 'utf8');
    console.log(`\n(rahasia seed untuk mode offline ditulis ke ${secretsFile} — aman: DB lokal)`);

    return auditPassed(findings) ? 0 : 1;
  } finally {
    await unlink(dumpFile).catch(() => {});
    // Cleanup: hapus HANYA baris milik run ini (FK order).
    await prisma.messageStatus.deleteMany({ where: { messageId: msgId } }).catch(() => {});
    await prisma.message.deleteMany({ where: { id: msgId } }).catch(() => {});
    await prisma.userHiddenConversation.deleteMany({ where: { conversationId: convId } }).catch(() => {});
    await prisma.story.deleteMany({ where: { authorTag: await routingIdentity(aliceId) } }).catch(() => {});
    await prisma.blockedUser.deleteMany({ where: { blockerTag: await routingIdentity(aliceId) } }).catch(() => {});
    await prisma.pushSubscription.deleteMany({ where: { deviceId } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: convId } }).catch(() => {});
    await prisma.device.deleteMany({ where: { id: deviceId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: seededUserIds } } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

const dumpFile = argValue('--dump');
if (dumpFile) {
  process.exitCode = await runOffline(dumpFile, argValue('--secrets'));
} else {
  process.exitCode = await runLive();
}
