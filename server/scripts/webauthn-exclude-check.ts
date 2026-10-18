// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Diagnostik read-only (tanpa menulis apa pun): ambil SATU kredensial WebAuthn
 * dari DB, lalu jalankan `generateRegistrationOptions` dengan bentuk
 * `excludeCredentials` yang dipakai rute `/api/auth/webauthn/register/options`.
 *
 * Dipakai untuk memastikan bug 2026-10-18 (`TypeError: input.replace is not a
 * function` → 500) benar-benar hilang pada data NYATA, bukan hanya pada vektor
 * uji. Kembaran "sebelum" (Buffer) ikut dijalankan sebagai pembanding.
 *
 *   npx tsx scripts/webauthn-exclude-check.ts
 *
 * Exit 0 = bentuk baru lolos dan bentuk lama gagal (sesuai harapan).
 */
import { prisma } from '../src/lib/prisma.js';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { parseCredentialTransports, toBase64UrlCredentialId } from '../src/utils/webauthnCredentials.js';

const credentials = await prisma.authenticator.findMany({
  select: { credentialID: true, transports: true },
  take: 3,
});

if (credentials.length === 0) {
  console.log('Tidak ada Authenticator di DB — jalankan ini di instance yang punya kredensial.');
  process.exit(2);
}

for (const row of credentials) {
  const id = toBase64UrlCredentialId(row.credentialID);
  console.log(`\ncredentialID tersimpan : ${String(row.credentialID).slice(0, 12)}… (${String(row.credentialID).length} char)`);
  console.log(`setelah normalisasi    : ${id ? `${id.slice(0, 12)}…` : 'DITOLAK (null)'}`);
  console.log(`bentuk base64url sah   : ${id === row.credentialID}`);
  console.log(`transports             : ${JSON.stringify(parseCredentialTransports(row.transports))}`);

  if (!id) continue;

  // Jalur BARU (yang dipakai rute sekarang).
  const options = await generateRegistrationOptions({
    rpName: 'NYX',
    rpID: 'localhost',
    userID: new Uint8Array(16).fill(1),
    userName: 'diagnostic',
    attestationType: 'none',
    excludeCredentials: [{ id, transports: parseCredentialTransports(row.transports) }],
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
  });
  console.log(`BARU  → exclude=${options.excludeCredentials?.length} id utuh=${options.excludeCredentials?.[0]?.id === id}`);

  // Jalur LAMA (Buffer) — harus melempar TypeError; kalau tidak, asumsi kita salah.
  let oldFailed = false;
  try {
    await generateRegistrationOptions({
      rpName: 'NYX',
      rpID: 'localhost',
      userID: new Uint8Array(16).fill(1),
      userName: 'diagnostic',
      attestationType: 'none',
      excludeCredentials: [{ id: Buffer.from(id, 'base64url') as unknown as string }],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });
  } catch (e) {
    oldFailed = true;
    console.log(`LAMA  → melempar: ${(e as Error).name}: ${(e as Error).message}`);
  }
  if (!oldFailed) {
    console.error('LAMA  → TIDAK melempar; asumsi akar masalah salah, periksa ulang.');
    process.exit(1);
  }
}

await prisma.$disconnect();
console.log('\nOK: bentuk baru diterima, bentuk lama gagal (akar masalah terkonfirmasi).');
