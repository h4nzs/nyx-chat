// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.15.4 langkah 2] Ukur kesiapan `oprfIndex` sebelum PIR menyala.
//
// Baca-saja: tidak menulis baris, tidak memicu rebuild, dan tidak mencetak
// identitas. Akun tanpa index hanya bisa diperbaiki lewat login berikutnya —
// `User.usernameHash` sudah HMAC ber-pepper sehingga identifier Argon2 mentah
// tidak tersedia untuk backfill server-side.
//
// Pemakaian (dari `server/`):
//   pnpm run oprf:readiness
//   pnpm run oprf:readiness -- --require-ready   # exit 1 bila belum siap
import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oprfReadinessVerdict } from '../src/utils/oprfReadiness.js';
import { isSearchOprfEnabled } from '../src/utils/searchOprf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  const requireReady = process.argv.includes('--require-ready');
  const { prisma } = await import('../src/lib/prisma.js');
  try {
    const [total, indexed, malformedRows] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { oprfIndex: { not: null } } }),
      prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "User"
        WHERE "oprfIndex" IS NOT NULL AND "oprfIndex" !~ '^[0-9a-f]{64}$'
      `,
    ]);

    const verdict = oprfReadinessVerdict(
      { total, indexed, malformed: malformedRows[0]?.count ?? 0 },
      { requireReady, oprfEnabled: isSearchOprfEnabled() }
    );
    for (const line of verdict.lines) console.log(line);
    process.exitCode = verdict.code;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('OPRF readiness gagal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
