import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mlDsaKeygen } from '@nyx/shared';

/**
 * [docs/42 WP8] Kunci ML-DSA-65 untuk stack E2E PIR.
 *
 * Menulis seed 32 byte per peran ke `<OUT_DIR>/<id>.key` (0600) dan mencetak
 * `{ "a": { "publicKey": "<base64url>", "file": "..." }, ... }`. Kunci dibuat
 * sekali per run, jadi tidak ada kunci privat yang di-commit.
 *
 * Seed DETERMINISTIK dari nama peran: Playwright memuat config di proses utama
 * (webServer) DAN di worker (spec memanggil `pir-snapshot.ts`), jadi seed acak
 * membuat kedua proses punya pasangan kunci berbeda — manifest ditandatangani
 * worker lalu ditolak API (`PIR_MANIFEST_INVALID`).
 */
const outDir = process.env.OUT_DIR;
if (!outDir) throw new Error('OUT_DIR wajib diisi');

mkdirSync(outDir, { recursive: true });
const result: Record<string, { publicKey: string; file: string }> = {};

for (const id of ['a', 'b']) {
  // Satu kunci untuk dua role: `keyId` (sha256 kunci publik) ikut dibandingkan
  // `pirManifestsAgree`, jadi dua kunci berbeda = `PIR_DESYNC` di klien. Klien
  // hanya boleh mengabaikan `keyId` bila kelak tiap operator punya kunci sendiri.
  const seed = createHash('sha256').update('nyx-pir-e2e-key').digest();
  const { publicKey } = mlDsaKeygen(seed);
  const file = path.join(outDir, `${id}.key`);
  writeFileSync(file, seed.toString('hex'), { mode: 0o600 });
  result[id] = { publicKey: Buffer.from(publicKey).toString('base64url'), file };
}

process.stdout.write(JSON.stringify(result));
