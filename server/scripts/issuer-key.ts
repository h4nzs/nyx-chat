// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0 — D1] Operasi issuer key blind RSA grup.
 *
 *   pnpm --filter nyx-server exec tsx scripts/issuer-key.ts generate
 *     → buat keypair baru, cetak baris .env (private key PKCS#8 base64).
 *
 *   pnpm --filter nyx-server exec tsx scripts/issuer-key.ts export
 *     → baca private key LAMA dari kolom DB `CredentialIssuerKey.privateKeyPkcs8`
 *       (jalur legacy) dan cetak sebagai baris .env. JALANKAN INI DULU sebelum
 *       `prisma db push` menghapus kolomnya, lalu simpan ke /root/nyx-app/.env.
 *
 * Private key keluaran script ini HANYA ditulis ke stdout — jangan commit,
 * jangan masukkan repo, jangan simpan di backup DB.
 */

import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const command = (process.argv[2] || 'generate').toLowerCase();

async function generate(): Promise<void> {
  const suite = RSABSSA.SHA384.PSS.Randomized();
  const kp = await suite.generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: 2048,
  });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);

  console.log('# --- Tempel ke .env (JANGAN commit) ---');
  console.log(`GROUP_ISSUER_KEY_PKCS8=${pkcs8}`);
  console.log(`GROUP_ISSUER_KEY_VERSION=${process.env.GROUP_ISSUER_KEY_VERSION || '1'}`);
  console.log('# public JWK (dibagikan ke klien oleh server, aman dicatat):');
  console.log(JSON.stringify(publicJwk));
  console.log('# Catatan: rotasi = naikkan GROUP_ISSUER_KEY_VERSION + restart pm2.');
  console.log('# Row publik di DB akan dibuat otomatis saat server start.');
}

async function exportLegacy(): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const { Pool } = await import('pg');
  const { PrismaPg } = await import('@prisma/adapter-pg');

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL / DIRECT_URL tidak diset.');

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ keyVersion: number; privateKeyPkcs8: string | null }>>(
      'SELECT "keyVersion", "privateKeyPkcs8" FROM "CredentialIssuerKey" ORDER BY "keyVersion" DESC'
    );
    const withKey = rows.filter((r) => !!r.privateKeyPkcs8);
    if (withKey.length === 0) {
      console.log('Tidak ada private key di DB (kolom kosong / sudah dimigrasi). Tidak ada yang perlu diekspor.');
      return;
    }
    console.log('# --- Private key LAMA dari DB (pindahkan ke .env lalu hapus kolomnya) ---');
    for (const row of withKey) {
      console.log(`# keyVersion ${row.keyVersion}`);
      console.log(`GROUP_ISSUER_KEY_PKCS8=${row.privateKeyPkcs8}`);
      console.log(`GROUP_ISSUER_KEY_VERSION=${row.keyVersion}`);
    }
    console.log('# Langkah berikutnya: simpan ke server/.env, restart, verifikasi grup bisa issue credential,');
    console.log('# BARU jalankan `prisma db push` yang menghapus kolom privateKeyPkcs8.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/privateKeyPkcs8/i.test(msg)) {
      console.log('Kolom privateKeyPkcs8 sudah tidak ada di DB (migrasi selesai). Tidak ada yang diekspor.');
      return;
    }
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

if (command === 'generate') {
  await generate();
} else if (command === 'export') {
  await exportLegacy();
} else {
  console.error(`Perintah tidak dikenal: ${command}. Pakai 'generate' atau 'export'.`);
  process.exit(1);
}
