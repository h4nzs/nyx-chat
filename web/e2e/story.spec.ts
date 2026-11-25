// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.15.2 #6] Story: satu spec untuk jalur yang paling mudah rusak
 * diam-diam — distribusi kunci, filter tanpa kunci, blocklist, dan expiry.
 *
 * Yang dibuktikan:
 *   1. A memposting story lewat UI (StoryTray → CreateStoryModal).
 *   2. B (kontak 1:1) menerima `STORY_KEY` silent, kuncinya tersimpan, dan
 *      story terdekripsi serta bisa dibuka di StoryViewer.
 *   3. C (bukan kontak, tanpa kunci) mendapat ciphertext dari API — server
 *      memang zero-knowledge — tetapi store klien membuangnya, jadi C tidak
 *      melihat story.
 *   4. A memblokir C → `GET /api/stories/user/:id` milik C 403 `STORY_BLOCKED`.
 *   5. Setelah `expiresAt` lewat, story hilang dari daftar dan `GET /:id` 410.
 *
 * Expiry 24 jam tidak bisa ditunggu, jadi spec memajukan satu baris `Story`
 * lewat `psql` (Postgres stack E2E; URL dari env atau `server/.env`). Itu
 * satuan-satunya intervensi di luar UI/API dan hanya menyentuh baris story
 * yang baru dibuat spec ini.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { apiFor } from './helpers/api';
import { registerUser, openDirectChatWith, sendChatMessage } from './helpers/registration';

const RUN = Date.now();

async function userId(page: Page): Promise<string> {
  const response = await page.request.get('/api/users/me');
  expect(response.status(), 'GET /api/users/me harus 200').toBe(200);
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error('user id tidak ada di /api/users/me');
  return body.id;
}

/** URL Postgres stack E2E: env CI dulu, lalu `server/.env` untuk run lokal. */
function databaseUrl(): string {
  const raw = (() => {
    // `NYX_E2E_DATABASE_URL` didahulukan: itu DB yang di-reset global setup dan
    // yang dipakai app di stack. `DATABASE_URL` di shell bisa kosong (mis.
    // `export A=... B="$A"` — ekspansi terjadi sebelum assignment), dan dulu
    // fallback ke `server/.env` membuat `psql` menembak DB dev lain tanpa
    // terlihat: UPDATE 0 baris, pesan errornya menyesatkan.
    if (process.env.NYX_E2E_DATABASE_URL) return process.env.NYX_E2E_DATABASE_URL;
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const envFile = readFileSync(resolve(process.cwd(), '../server/.env'), 'utf8');
    const line = envFile.split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
    if (!line) throw new Error('DATABASE_URL tidak ditemukan di env maupun server/.env');
    return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  })();
  // Prisma menambahkan `?schema=public`; psql menolaknya sebagai parameter URI.
  const url = new URL(raw);
  url.searchParams.delete('schema');
  return url.toString();
}

/** Satu-satunya penulisan DB: majukan expiry baris ini. `psql` ada di CI. */
function expireStory(storyId: string): void {
  const id = storyId.replace(/'/g, "''");
  // Kolomnya `timestamp` tanpa zona: `now()` mentah memakai TZ sesi psql
  // (Asia/Jakarta di mesin ini) dan menyimpan waktu 7 jam ke depan. Paksa UTC,
  // lalu RETURNING memastikan baris yang dimaksud benar-benar tersentuh.
  const out = execFileSync(
    'psql',
    [
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      databaseUrl(),
      '-c',
      `UPDATE "Story" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = '${id}' RETURNING id`,
    ],
    { stdio: 'pipe' }
  )
    .toString()
    .trim();
  if (!out.includes(storyId)) throw new Error(`expiry tidak menyentuh baris story ${storyId}`);
}

test.describe('Story', () => {
  test.setTimeout(600000);

  test('posting, penerima kunci, tanpa kunci, blokir, expiry', async ({ browser }: { browser: Browser }) => {
    const run = String(RUN);
    const storyText = `story-${run}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();
    for (const page of [pageA, pageB, pageC]) page.setDefaultTimeout(60000);

    try {
      // 1. Tiga akun: A (penulis), B (kontak), C (orang luar).
      await registerUser(pageA, 'Story Author', `story_a_${run}`);
      await registerUser(pageB, 'Bob Viewer', `story_b_${run}`);
      await registerUser(pageC, 'Story Outsider', `story_c_${run}`);

      const idA = await userId(pageA);
      const idC = await userId(pageC);

      // 2. A ↔ B jadi kontak lewat DM sungguhan; ini sumber fan-out STORY_KEY.
      await pageA.bringToFront();
      await openDirectChatWith(pageA, `story_b_${run}`, 20000);
      await sendChatMessage(pageA, `prime-${run}`);
      await pageB.bringToFront();
      const chatFromA = pageB.locator('div').filter({ hasText: `prime-${run}` }).first();
      await expect(chatFromA).toBeVisible({ timeout: 30000 });
      await chatFromA.click();

      // 3. A posting story teks lewat tray (own-story ring = tombol buat).
      await pageA.bringToFront();
      // Span "Your Story" ada DI LUAR tombol; klik tombol avatar-nya
      // (div pembungkus: tombol avatar, tombol plus, lalu span).
      await pageA
        .locator('aside')
        .getByText('Your Story', { exact: true })
        .locator('..')
        .locator('button')
        .first()
        .click();
      const storyTextarea = pageA.locator('textarea[placeholder*="mind"]');
      await expect(storyTextarea).toBeVisible({ timeout: 15000 });
      await storyTextarea.fill(storyText);
      await pageA.getByRole('button', { name: /Post Story/i }).click();
      await expect(pageA.getByText('Story posted!')).toBeVisible({ timeout: 120000 });

      const storyId = await pageA.evaluate(async (uid) => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { useStoryStore } = await import('/src/store/story.ts');
        const list = useStoryStore.getState().stories[uid] || [];
        return list.length > 0 ? list[list.length - 1].id : null;
      }, idA);
      if (!storyId) throw new Error('story baru tidak masuk store penulis');

      // 4. B menerima kunci silent, lalu tray memuat & mendekripsi story-nya.
      await expect
        .poll(
          () =>
            pageB.evaluate(async (id) => {
              // @ts-ignore — path absolut Vite dev server (runtime-only)
              const { getStoryKey } = await import('/src/lib/shadowVaultDb.ts');
              return !!(await getStoryKey(id));
            }, storyId),
          { timeout: 90000, message: 'B tidak pernah menerima STORY_KEY' }
        )
        .toBe(true);

      await pageB.reload();
      await expect
        .poll(
          () =>
            pageB.evaluate(async (uid) => {
              // @ts-ignore — path absolut Vite dev server (runtime-only)
              const { useStoryStore } = await import('/src/store/story.ts');
              const list = useStoryStore.getState().stories[uid] || [];
              return list[0]?.decryptedData?.text ?? null;
            }, idA),
          { timeout: 90000, message: 'story B tidak terdekripsi setelah reload' }
        )
        .toBe(storyText);

      // Ring teman memakai nama depan penulis ("Story"); span-nya di dalam
      // tombol, jadi klik span = buka StoryViewer.
      await pageB.locator('aside span').filter({ hasText: /^Story$/ }).first().click();
      await expect(pageB.getByText(storyText).first()).toBeVisible({ timeout: 30000 });

      // 5. C tanpa kunci: API tetap mengirim ciphertext (zero-knowledge), tapi
      // store klien membuangnya karena `getStoryKey` kosong.
      const apiC = await apiFor(pageC, 'e2e-story-c');
      const rawForC = await apiC.get(`/api/stories/user/${idA}`);
      expect(rawForC.status()).toBe(200);
      expect(((await rawForC.json()) as unknown[]).length, 'server tidak boleh tahu siapa yang dikecualikan').toBe(1);

      const cVisible = await pageC.evaluate(async (uid) => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { useStoryStore } = await import('/src/store/story.ts');
        await useStoryStore.getState().fetchActiveStories(uid);
        return (useStoryStore.getState().stories[uid] || []).length;
      }, idA);
      expect(cVisible, 'C tidak punya kunci, story harus tersaring di klien').toBe(0);

      // 6. Blocklist: A memblokir C → C ditolak 403 di endpoint story.
      const apiA = await apiFor(pageA, 'e2e-story-a');
      const blocked = await apiA.post(`/api/users/${idC}/block`, {});
      expect(blocked.status(), 'block C harus 200').toBe(200);
      const afterBlock = await apiC.get(`/api/stories/user/${idA}`);
      expect(afterBlock.status()).toBe(403);
      expect(((await afterBlock.json()) as { error?: string }).error).toBe('STORY_BLOCKED');

      // 7. Expiry: majukan expiresAt, lalu daftar kosong dan GET by-id 410.
      expireStory(storyId);
      const expiredList = await apiA.get(`/api/stories/user/${idA}`);
      expect(expiredList.status()).toBe(200);
      expect(((await expiredList.json()) as unknown[]).length).toBe(0);
      const expiredById = await apiA.get(`/api/stories/${storyId}`);
      expect(expiredById.status()).toBe(410);
    } finally {
      await ctxA.close();
      await ctxB.close();
      await ctxC.close();
    }
  });
});
