import * as dotenv from 'dotenv';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPirSnapshot,
  parsePirEpoch,
  parsePirRecordBytes,
  type PirRecordSource,
} from '../src/pir/snapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');
  try {
    const recordBytes = parsePirRecordBytes(process.env.PIR_RECORD_BYTES);
    const epoch = parsePirEpoch(process.env.PIR_EPOCH);
    const output = process.env.PIR_SNAPSHOT_PATH
      ? path.resolve(process.env.PIR_SNAPSHOT_PATH)
      : path.resolve(__dirname, '../pir-snapshot.json');

    const users = await prisma.user.findMany({
      where: { oprfIndex: { not: null } },
      select: {
        id: true,
        encryptedProfile: true,
        isVerified: true,
        hasCompletedOnboarding: true,
        oprfIndex: true,
        devices: {
          orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
          take: 1,
          select: { publicKey: true, pqPublicKey: true, signingKey: true },
        },
      },
    });

    const sources: PirRecordSource[] = users.map((user) => ({
      id: user.id,
      encryptedProfile: user.encryptedProfile,
      isVerified: user.isVerified,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      oprfIndex: user.oprfIndex,
      device: user.devices[0] ?? null,
    }));
    const snapshot = buildPirSnapshot(sources, recordBytes, epoch);

    await mkdir(path.dirname(output), { recursive: true });
    const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temp, output);

    console.log(
      `PIR snapshot: epoch=${snapshot.epoch} entries=${snapshot.entries.length} ` +
        `recordBytes=${snapshot.recordBytes} path=${output}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('PIR snapshot gagal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
