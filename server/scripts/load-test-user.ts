// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.15 WS-G(3)] Penyiapan akun + percakapan untuk load test k6.
 *
 * Kenapa perlu skrip ini: `scripts/load/relay.k6.js` butuh (a) `usernameHash`
 * yang **identik dengan nilai klien** (Argon2id, salt statis "NYX_BLIND_IDX_V1",
 * m=64MB/t=3/p=1 → base64url) dan (b) satu `conversationId` nyata. Keduanya
 * tidak bisa dihitung di dalam runtime k6 (Argon2id tidak tersedia di sana).
 *
 * Akun ini HANYA untuk beban lokal: password di-hash dengan `hashPassword` yang
 * sama dengan produksi, dan `usernameHash` dihitung dengan parameter klien yang
 * sama supaya jalur login yang diukur benar-benar jalur nyata (bukan pintasan).
 *
 * Pemakaian (dari root repo):
 *   pnpm --filter nyx-server exec tsx scripts/load-test-user.ts
 *   # lalu:
 *   eval "$(pnpm --filter nyx-server exec tsx scripts/load-test-user.ts --exports)"
 *
 * Pengaman: menolak jalan bila `DATABASE_URL` bukan host lokal — skrip ini
 * membuat baris di DB.
 */

import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import argon2 from 'argon2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from '../src/utils/password.js';
import { randomBytes } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set.');
if (
  process.env.NODE_ENV === 'production' ||
  (!connectionString.includes('localhost') &&
    !connectionString.includes('127.0.0.1') &&
    !connectionString.includes('postgres'))
) {
  console.error('❌ DANGER: load-test-user hanya untuk DB lokal (bukan produksi/eksternal).');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** Id percakapan tetap untuk load test (idempoten, mudah dikenali di DB lokal). */
const LOAD_CONVERSATION_ID = process.env.NYX_LOAD_CONVERSATION_ID || '4b1b1b1b-1c1c-4d4d-8e8e-000000000001';
/** Id perangkat tetap milik akun load test (dikirim k6 sebagai `deviceId`). */
const LOAD_DEVICE_ID = process.env.NYX_LOAD_DEVICE_ID || '4b1b1b1b-1c1c-4d4d-8e8e-000000000002';

const USERNAME = process.env.NYX_LOAD_USER || 'k6load';
const PASSWORD = process.env.NYX_LOAD_PASS || 'k6-load-test-pass-123!';
const PEER = process.env.NYX_LOAD_PEER || 'k6peer';

/**
 * `usernameHash` klien: Argon2id(username.toLowerCase(), "NYX_BLIND_IDX_V1",
 * m=64MB, t=3, p=1, out=32) → base64url tanpa padding. Parameter HARUS sama
 * dengan `ARGON_INDEX_CONFIG` di `web/src/workers/crypto.worker.ts`
 * (`hashUsername`); kalau tidak, login akan tampak gagal karena hash tidak
 * ketemu — bukan karena server bermasalah.
 */
async function clientUsernameHash(username: string): Promise<string> {
  const raw = await argon2.hash(username.toLowerCase(), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
    salt: Buffer.from('NYX_BLIND_IDX_V1'),
    raw: true,
  });
  return raw.toString('base64url');
}

async function main() {
  const usernameHash = await clientUsernameHash(USERNAME);
  const passwordHash = await hashPassword(PASSWORD);

  const user = await prisma.user.upsert({
    where: { usernameHash },
    update: { passwordHash },
    create: { usernameHash, passwordHash, hasCompletedOnboarding: true },
    select: { id: true },
  });

  // Perangkat milik akun load test. WAJIB ada: `/api/auth/login` menolak
  // (404 "No device found") bila user belum punya perangkat — dan itu jalur
  // pemulihan, bukan jalur yang ingin diukur. `fingerprint`/`installationTag`
  // sengaja NULL supaya binding hardware tidak memaksa alur recovery saat k6
  // memakai satu device id untuk semua VU (device ini memang bukan perangkat
  // nyata; tidak ada kunci privat yang bisa dipakai — nilainya hanya bentuk).
  // Id-nya TETAP supaya k6 bisa mengirim `deviceId` di body login.
  const loadDevice = await prisma.device.upsert({
    where: { id: LOAD_DEVICE_ID },
    update: { lastActiveAt: new Date() },
    create: {
      id: LOAD_DEVICE_ID,
      userId: user.id,
      publicKey: randomBytes(32),
      signingKey: randomBytes(32),
      pqPublicKey: null,
      encryptedPrivateKey: Buffer.from('k6-load-test-no-private-key', 'utf8'),
    },
    select: { id: true },
  });

  // Peer opsional: memberi percakapan dua sisi supaya jalur relay/pengiriman
  // ke penerima (bila `targetRecipients` dipakai) punya tujuan nyata.
  const peerHash = await clientUsernameHash(PEER);
  const peer = await prisma.user.upsert({
    where: { usernameHash: peerHash },
    update: {},
    create: { usernameHash: peerHash, passwordHash, hasCompletedOnboarding: true },
    select: { id: true },
  });

  // Percakapan milik akun load test, dengan id TETAP supaya skrip idempoten
  // (dijalankan berkali-kali tidak menumpuk percakapan).
  //
  // `Conversation` tidak punya relasi `participants` lagi dan baris
  // `UserHiddenConversation` mensyaratkan `deliveryToken` (unik, diterbitkan
  // klien) + `userId` TER-SEAL — jadi roster sengaja TIDAK dibuat di sini: jalur
  // relay yang diukur tidak membacanya (`POST/GET /api/messages` = opaque
  // mailbox). Kalau kelak load test menyentuh discovery/membership, roster harus
  // dibuat lewat jalur klien yang menyegel identitas (`utils/routingIdentity.ts`).
  const conversation = await prisma.conversation.upsert({
    where: { id: LOAD_CONVERSATION_ID },
    update: {},
    create: { id: LOAD_CONVERSATION_ID, isGroup: false },
    select: { id: true },
  });

  const summary = {
    userId: user.id,
    peerId: peer.id,
    deviceId: loadDevice.id,
    conversationId: conversation.id,
    usernameHash,
  };

  if (process.argv.includes('--exports')) {
    process.stdout.write(
      [
        `export NYX_USER='${USERNAME}'`,
        `export NYX_PASS='${PASSWORD}'`,
        `export NYX_USERNAME_HASH='${usernameHash}'`,
        `export NYX_CONVERSATION_ID='${conversation.id}'`,
        `export NYX_DEVICE_ID='${loadDevice.id}'`,
        '',
      ].join('\n')
    );
  } else {
    console.log('✅ Akun + percakapan load test siap:');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nJalankan load test dengan:');
    console.log('  eval "$(pnpm --filter nyx-server exec tsx scripts/load-test-user.ts --exports)"');
    console.log('  k6 run scripts/load/relay.k6.js');
    console.log('atau tanpa eval:');
    console.log(`  NYX_USER='${USERNAME}' NYX_PASS='${PASSWORD}' \\`);
    console.log(`  NYX_USERNAME_HASH='${usernameHash}' NYX_CONVERSATION_ID='${conversation.id}' \\`);
    console.log(`  NYX_DEVICE_ID='${loadDevice.id}' \\`);
    console.log('  k6 run scripts/load/relay.k6.js');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
