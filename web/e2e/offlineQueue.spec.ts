// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.15.2 #7] Antrean offline di SQLite — satu-satunya penjagaan
 * perilaku "kirim saat putus, lalu terkirim saat reconnect" di level E2E.
 *
 * Yang dibuktikan:
 *   1. saat jaringan putus, mengirim pesan menulis baris `offlineQueue` ke
 *      SQLite (bukan state memori) — dibaca langsung lewat `appStorage`;
 *   2. reconnect memicu `processOfflineQueue` (dipanggil `socketListeners` saat
 *      `connect`) dan pesan sampai ke peer **tepat satu kali**;
 *   3. setelah reload kedua sisi, antrean tetap kosong dan pesan tidak
 *      terkirim ulang — bukti idempotensi drain, bukan hanya "sampai".
 *
 * Batas yang jujur: reload **saat offline** tidak diuji karena navigasi dev
 * server butuh jaringan (app shell SW tidak dijamin di dev); persistensi
 * dibuktikan langsung dari baris SQLite sebelum reconnect. Composer tetap bisa
 * diketik saat putus: teks masuk `offlineQueue`, sedangkan lampiran/voice,
 * edit pesan, dan burner tetap butuh koneksi karena tidak punya jalur antrean.
 * Jalur ini memakai WSS gateway bila WebTransport tidak ada, jadi tidak perlu
 * skip.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  registerUser,
  sendChatMessage,
  openDirectChatWith,
  expectPeerReceivesMessage,
} from './helpers/registration';

const RUN = Date.now();

/** Baris antrean langsung dari SQLite (prefix `offline:` lewat appStorage). */
async function queuedRows(page: Page): Promise<Array<{ tempId: number }>> {
  return page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const app = await import('/src/lib/storage/appStorage.ts');
    return (await app.listAppRows('offlineQueue')) as Array<{ tempId: number }>;
  });
}

/** Status transport dari store yang sama dengan yang dipakai aplikasi. */
async function connectionStatus(page: Page): Promise<string> {
  return page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { useConnectionStore } = await import('/src/store/connection.ts');
    return useConnectionStore.getState().status as string;
  });
}

async function waitForComposer(page: Page): Promise<void> {
  const composer = page.locator('main form input[type="text"], main form textarea').first();
  await expect(composer).toBeVisible({ timeout: 120000 });
  await expect(composer).toBeEnabled({ timeout: 120000 });
}

test.describe('Antrean offline (SQLite)', () => {
  test.setTimeout(420000);

  test('kirim saat offline → reconnect → tepat sekali', async ({ browser }: { browser: Browser }) => {
    const run = String(RUN);
    const text = `offline-queued-${run}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    pageA.setDefaultTimeout(60000);
    pageB.setDefaultTimeout(60000);

    try {
      await registerUser(pageA, 'Offline A', `offline_a_${run}`);
      await registerUser(pageB, 'Offline B', `offline_b_${run}`);

      // DM dibuat lewat jalur UI yang sama dengan pengguna (`transport.spec`
      // membuktikan pencarian tidak butuh upgrade PoW); DM hasil `POST` API
      // tanpa `encryptedMetadata` tidak pernah muncul di sidebar.
      await pageA.bringToFront();
      await openDirectChatWith(pageA, `offline_b_${run}`, 20000);
      await waitForComposer(pageA);
      const conversationId = new URL(pageA.url()).pathname.split('/').pop();
      if (!conversationId) throw new Error('URL /chat/:id harus memuat conversation id');

      // Satu pesan online dulu: membuka percakapan di sisi peer sekaligus
      // memastikan sesi DR terbentuk sebelum pesan diantrekan offline.
      await sendChatMessage(pageA, `priming-${run}`);
      await pageB.bringToFront();
      await expectPeerReceivesMessage(pageB, `priming-${run}`, 30000);
      await waitForComposer(pageB);
      await pageA.bringToFront();

      // Putuskan jaringan konteks pengirim: socket putus, HTTP gagal.
      await ctxA.setOffline(true);
      await expect
        .poll(() => connectionStatus(pageA), {
          timeout: 90000,
          message: 'transport pengirim tidak pernah melaporkan disconnected',
        })
        .toBe('disconnected');

      // Jalur pengguna: ketik dan kirim lewat composer meski transport putus.
      await sendChatMessage(pageA, text);

      // Persistensi: baris antrean harus ada di SQLite, bukan hanya di memori.
      await expect
        .poll(async () => (await queuedRows(pageA)).length, {
          timeout: 60000,
          message: 'pesan offline tidak masuk antrean SQLite',
        })
        .toBe(1);
      await expect(pageA.locator('main').getByText(text)).toHaveCount(1, { timeout: 30000 });

      // Reconnect: `socketListeners` memanggil processOfflineQueue saat connect.
      await ctxA.setOffline(false);
      await expect
        .poll(async () => (await queuedRows(pageA)).length, {
          timeout: 180000,
          message: 'antrean tidak terkuras setelah reconnect',
        })
        .toBe(0);
      await expect(pageB.locator('main').getByText(text)).toHaveCount(1, { timeout: 180000 });

      // Reload pengirim: antrean tetap kosong, pesan tidak terkirim ulang.
      await pageA.reload();
      await waitForComposer(pageA);
      await expect.poll(async () => (await queuedRows(pageA)).length, { timeout: 60000 }).toBe(0);
      await expect(pageA.locator('main').getByText(text)).toHaveCount(1, { timeout: 60000 });

      // Reload penerima: tetap tepat satu salinan.
      await pageB.reload();
      await waitForComposer(pageB);
      await expect(pageB.locator('main').getByText(text)).toHaveCount(1, { timeout: 60000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
