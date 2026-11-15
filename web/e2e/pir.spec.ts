// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/42 WP8] E2E PIR dua server sungguhan.
//
// Yang dibuktikan spec ini (bukan mock OHTTP):
//   1. dua sidecar `pir-service` (role a/b) memegang shard yang dibangun dari DB;
//   2. klien menghitung index OPRF lalu memanggil `pirSearch` → hit yang benar;
//   3. index yang tidak ada → `null` (record miss), bukan error;
//   4. selama pencarian tidak ada request ke `/api/users/search` (tidak ada
//      fallback ke pencarian biasa).
//
// Tamper/desync/unavailable sengaja TIDAK diulang di sini: ketiganya sudah
// dibuktikan di `web/src/lib/__tests__/pirClient.test.ts` (PIR_TAMPERED,
// PIR_DESYNC, PIR_UNAVAILABLE) dan di vektor lintas-implementasi
// (`server/tests/pirVectors.test.ts` + `pir.rs`). Menjalankan injeksi dari spec
// butuh mematikan/menghidupkan sidecar di tengah tes, yang membuat tes rapuh.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { registerUser } from './helpers/registration';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_HEX = /^[0-9a-f]{64}$/;

test.describe('PIR dua server (docs/42 WP8)', () => {
  test('mencari pengguna lewat XOR-PIR tanpa jalur pencarian biasa', async ({ page, context }) => {
    test.setTimeout(360_000);

    const stamp = Date.now();
    const peerName = `pirpeer_${stamp}`;

    // Pengguna yang dicari, didaftarkan di konteks terpisah supaya tidak ada
    // state sesi yang tercampur dengan klien pencari.
    const peerContext = await context.browser()!.newContext();
    const peerPage = await peerContext.newPage();
    await registerUser(peerPage, 'PIR Peer', peerName);
    await peerContext.close();

    const searcherName = `piruser_${stamp}`;
    await registerUser(page, 'PIR Searcher', searcherName);

    // Bangun shard dari DB lalu kirim ke kedua sidecar (hot-swap, tanpa restart).
    // Env PIR_* diwarisi dari `playwright.pir.config.ts`.
    execFileSync('pnpm', ['--filter', 'nyx-server', 'exec', 'tsx', 'scripts/pir-snapshot.ts'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'pipe',
      timeout: 120_000,
    });

    const paths: string[] = [];
    page.on('request', (request) => paths.push(new URL(request.url()).pathname));

    const index = await page.evaluate(async (username) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { hashUsername } = await import('/src/lib/crypto-worker-proxy.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { oprfSearchIndex } = await import('/src/lib/searchOprfClient.ts');
      return oprfSearchIndex(await hashUsername(username));
    }, peerName);
    expect(index).toMatch(INDEX_HEX);

    const hit = await page.evaluate(async (hex) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { pirSearch } = await import('/src/lib/pirClient.ts');
      return pirSearch(hex);
    }, index);

    expect(hit).not.toBeNull();
    expect(hit!.id).toMatch(/^[0-9a-f-]{36}$/);

    // Index acak tidak dimiliki siapa pun: tiga slot kandidat boleh berisi
    // record pengguna lain (`other`), tetapi tidak boleh ada yang `ok`.
    const unknown = await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { pirSearch } = await import('/src/lib/pirClient.ts');
      const hex = Array.from({ length: 64 }, (_, i) => ((i * 7 + 3) % 16).toString(16)).join('');
      return pirSearch(hex);
    });
    expect(unknown).toBeNull();

    // Tidak ada fallback: jalur pencarian biasa tidak pernah disentuh.
    expect(paths.filter((p) => p === '/api/users/search')).toHaveLength(0);
    // Bukti jalur PIR benar-benar dipakai: dua share per slot kandidat (3 slot)
    // dikirim sebagai amplop OHTTP — `/api/pir/<id>/query` ada DI DALAM amplop,
    // jadi yang terlihat di jaringan hanya relay. Minimal 12 = 6 share × 2
    // pencarian; manifest ringkasan/shard juga lewat relay (4 per pencarian
    // pertama) tetapi boleh di-cache, jadi angkanya tidak dipatok.
    expect(paths.filter((p) => p === '/api/ohttp/relay').length).toBeGreaterThanOrEqual(12);
  });
});
