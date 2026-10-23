// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8 residual] Audit READ-ONLY sisa jalur v1.
 *
 * `scripts/pq-only-exceptions.json` baru boleh dikosongkan (denylist legacy
 * menjadi literal 0) setelah tidak ada data/sesi v1 yang masih perlu dibaca.
 * Tanpa pengukuran, "menunggu sesi/pesan v1 habis" hanya asumsi. Skrip ini
 * menghitung artefak yang bisa diamati dari server:
 *
 *   - Device yang belum punya kunci verifikasi ML-DSA (`cryptoVersion` < 2)
 *   - PreKeyBundle tanpa `signatureV2`
 *   - OneTimePreKey klasik (tanpa `pqPublicKey`)
 *   - GroupCredential bersuite legacy (`suite` NULL)
 *   - Amplop pesan 1:1 X3DH v1 dan pesan grup `sigV` v1
 *
 * Hanya agregat yang dicetak — tidak ada id, username, atau isi pesan. Bila
 * sebuah angka > 0, berkas exception terkait belum boleh dihapus (lihat
 * `removalGate` di manifest).
 *
 * Pakai:
 *   pnpm --filter nyx-server exec tsx scripts/audit-v1-residuals.ts
 *   pnpm --filter nyx-server exec tsx scripts/audit-v1-residuals.ts --json
 *   pnpm --filter nyx-server exec tsx scripts/audit-v1-residuals.ts --check
 *
 * `--check` keluar dengan kode 1 bila masih ada sisa v1 (cocok untuk operator
 * yang ingin gate otomatis di selfhost; TIDAK dipasang di CI karena saat ini
 * memang masih ada).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  addEnvelope,
  classifyEnvelope,
  emptyEnvelopeCounts,
} from '../src/utils/v1ResidualAudit.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL tidak diset — jalankan dari server/ dengan .env yang benar.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const PAGE_SIZE = 500;

interface Report {
  devices: { total: number; legacy: number };
  preKeyBundles: { total: number; legacy: number };
  oneTimePreKeys: { total: number; classicalOnly: number };
  groupCredentials: { total: number; legacySuite: number };
  messages: ReturnType<typeof emptyEnvelopeCounts>;
}

async function countMessages(messages: Report['messages']): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.message.findMany({
      select: { id: true, content: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) addEnvelope(messages, classifyEnvelope(row.content));
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

async function buildReport(): Promise<Report> {
  const [
    devicesTotal,
    devicesLegacy,
    bundlesTotal,
    bundlesLegacy,
    otpkTotal,
    otpkClassical,
    credentialsTotal,
    credentialsLegacy,
  ] = await Promise.all([
    prisma.device.count(),
    prisma.device.count({
      where: { OR: [{ cryptoVersion: { lt: 2 } }, { signingKeyV2: null }] },
    }),
    prisma.preKeyBundle.count(),
    prisma.preKeyBundle.count({ where: { signatureV2: null } }),
    prisma.oneTimePreKey.count(),
    prisma.oneTimePreKey.count({ where: { pqPublicKey: null } }),
    prisma.groupCredential.count(),
    prisma.groupCredential.count({ where: { suite: null } }),
  ]);

  const messages = emptyEnvelopeCounts();
  await countMessages(messages);

  return {
    devices: { total: devicesTotal, legacy: devicesLegacy },
    preKeyBundles: { total: bundlesTotal, legacy: bundlesLegacy },
    oneTimePreKeys: { total: otpkTotal, classicalOnly: otpkClassical },
    groupCredentials: { total: credentialsTotal, legacySuite: credentialsLegacy },
    messages,
  };
}

function blockersOf(report: Report): Array<[string, number]> {
  return [
    ['Device v1 (cryptoVersion<2 / tanpa signingKeyV2)', report.devices.legacy],
    ['PreKeyBundle tanpa signatureV2', report.preKeyBundles.legacy],
    ['OneTimePreKey klasik (tanpa pqPublicKey)', report.oneTimePreKeys.classicalOnly],
    ['GroupCredential suite legacy (NULL)', report.groupCredentials.legacySuite],
    ['Pesan 1:1 X3DH v1', report.messages['direct-v1']],
    ['Pesan grup sigV v1', report.messages['group-v1']],
  ];
}

async function main(): Promise<void> {
  const report = await buildReport();
  const blockers = blockersOf(report);
  const blockingTotal = blockers.reduce((sum, [, value]) => sum + value, 0);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...report, blockingTotal }, null, 2));
  } else {
    console.log('V1 residual audit (read-only)');
    console.log(`  Device            : ${report.devices.legacy}/${report.devices.total} masih v1`);
    console.log(`  PreKeyBundle      : ${report.preKeyBundles.legacy}/${report.preKeyBundles.total} tanpa signatureV2`);
    console.log(`  OneTimePreKey     : ${report.oneTimePreKeys.classicalOnly}/${report.oneTimePreKeys.total} klasik`);
    console.log(`  GroupCredential   : ${report.groupCredentials.legacySuite}/${report.groupCredentials.total} suite legacy`);
    console.log(
      `  Pesan 1:1         : ${report.messages['direct-v1']} v1, ${report.messages['direct-v2']} v2, ` +
        `${report.messages.other} lain`
    );
    console.log(
      `  Pesan grup        : ${report.messages['group-v1']} v1, ${report.messages['group-v2']} v2`
    );
    console.log(`  Total pesan       : ${report.messages.total}`);
    console.log('');
    if (blockingTotal === 0) {
      console.log('Denylist legacy: CLEAR — tidak ada artefak v1 yang terdeteksi.');
    } else {
      console.log(`Denylist legacy: BLOCKED — ${blockingTotal} artefak v1 masih ada:`);
      for (const [label, value] of blockers) {
        if (value > 0) console.log(`  - ${label}: ${value}`);
      }
      console.log('Jangan hapus entri exception terkait sampai angkanya 0.');
    }
  }

  if (process.argv.includes('--check') && blockingTotal > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Audit v1 gagal:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
