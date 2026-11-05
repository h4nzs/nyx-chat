// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

/**
 * [docs/39 §39.4b] Baris minimum untuk drill restore klien di CI terjadwal
 * (`.github/workflows/drills.yml`, job `client-restore`).
 *
 * Kenapa berkas ini ada: `scripts/client-restore-drill.sh` mengambil `pg_dump`
 * dari database sumber, lalu `web/scripts/client-restore-drill.ts` menuntut
 * (a) fixture berisi percakapan **dan** pesan, dan (b) setiap tabel backup punya
 * minimal satu baris. Database CI yang baru di-`prisma db push` kosong, jadi
 * drill tidak bisa dijalankan tanpa data — dan `prisma/seed.ts` legacy tidak
 * dipakai (docs/25 §25.3: masih merujuk kolom yang sudah dihapus).
 *
 * Yang ditulis sengaja sedikit tapi **berbentuk produksi**: 1 user, 2 perangkat
 * (v2, dengan kunci PQ), 1 percakapan 1:1, dan 2 pesan dengan kolom `ENC1:`
 * ter-seal. Nilai `ENC1:` penting: drill membuktikan nilai ter-seal itu **utuh**
 * setelah round-trip arsip — tanpa satu pun nilai ter-seal, bukti itu kosong.
 *
 * Bukan data pengguna sungguhan dan bukan kunci sungguhan: semua byte adalah
 * nilai tetap yang tidak bisa dipakai untuk apa pun. Idempoten — baris dengan id
 * tetap dihapus lebih dulu, jadi menjalankannya berulang tidak menumpuk data.
 *
 * Pemakaian (dari `server/`, DATABASE_URL sudah menunjuk DB sementara):
 *
 *   pnpm exec tsx scripts/client-drill-seed.ts
 */

import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL tidak diset — drill tidak punya sumber dump.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Id tetap: drill membandingkan id dump dengan id hasil restore, dan seed yang
// idempoten membuat re-run tidak menumpuk baris.
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_OLD_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_NEW_ID = '22222222-2222-4222-8222-222222222223';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ONE_ID = '44444444-4444-4444-8444-444444444441';
const MESSAGE_TWO_ID = '44444444-4444-4444-8444-444444444442';

const bytes = (size: number, fill: number): Uint8Array => new Uint8Array(size).fill(fill);
// Bentuk `ENC1:` yang sah untuk drill: prefix + base64url. Isinya tetap acak
// sintetis — yang dibuktikan drill adalah "tidak berubah", bukan "bisa dibuka".
const sealed = (suffix: string): string =>
  `ENC1:${Buffer.from(`nyx-client-drill-${suffix}`).toString('base64url')}`;

async function main(): Promise<void> {
  // Hapus anak dulu (FK), lalu induknya. Urutannya penting: Message → Device →
  // Conversation → User.
  await prisma.message.deleteMany({ where: { conversationId: CONVERSATION_ID } });
  await prisma.device.deleteMany({ where: { id: { in: [DEVICE_OLD_ID, DEVICE_NEW_ID] } } });
  await prisma.conversation.deleteMany({ where: { id: CONVERSATION_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });

  await prisma.user.create({
    data: {
      id: USER_ID,
      // Hash pengganti (bukan password siapa pun): kolomnya wajib ada, dan
      // drill tidak pernah memverifikasi kredensial.
      usernameHash: 'drill-user-hash',
      passwordHash: 'drill-password-hash',
      encryptedProfile: sealed('profile'),
      hasCompletedOnboarding: true,
      isVerified: true,
    },
  });

  for (const [id, marker] of [
    [DEVICE_OLD_ID, 1],
    [DEVICE_NEW_ID, 2],
  ] as const) {
    await prisma.device.create({
      data: {
        id,
        userId: USER_ID,
        nameSealed: sealed(`device-${marker}-name`),
        fingerprint: `drill-fingerprint-${marker}`,
        publicKey: bytes(32, marker),
        pqPublicKey: bytes(32, 0x40 + marker),
        signingKey: bytes(32, 0x80 + marker),
        signingKeyV2: bytes(32, 0xc0 + marker),
        encryptedPrivateKey: bytes(64, marker),
        cryptoVersion: 2,
      },
    });
  }

  await prisma.conversation.create({
    data: {
      id: CONVERSATION_ID,
      isGroup: false,
      encryptedMetadata: sealed('conversation-metadata'),
      messageSeq: 2,
      lastMessageAt: new Date('2026-01-01T00:00:01.000Z'),
    },
  });

  // Dua pesan (bukan satu): drill membandingkan urutan `seq`, jadi satu pesan
  // tidak membuktikan apa pun soal urutan.
  await prisma.message.createMany({
    data: [
      {
        id: MESSAGE_ONE_ID,
        conversationId: CONVERSATION_ID,
        senderId: null, // 1:1 memakai sealed sender — server tidak tahu pengirim.
        content: sealed('message-1'),
        seq: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: MESSAGE_TWO_ID,
        conversationId: CONVERSATION_ID,
        senderId: null,
        content: sealed('message-2'),
        seq: 2,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ],
  });

  const counts = {
    users: await prisma.user.count({ where: { id: USER_ID } }),
    devices: await prisma.device.count({ where: { userId: USER_ID } }),
    conversations: await prisma.conversation.count({ where: { id: CONVERSATION_ID } }),
    messages: await prisma.message.count({ where: { conversationId: CONVERSATION_ID } }),
  };
  console.log(
    `✅ seed drill: ${counts.users} user, ${counts.devices} perangkat, ` +
      `${counts.conversations} percakapan, ${counts.messages} pesan (semua bertanda ENC1:).`
  );
}

main()
  .catch((error) => {
    console.error('❌ seed drill gagal:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
