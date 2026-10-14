import { test, expect, Page } from '@playwright/test';
import {
  registerUser,
  supportsWebTransport,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';


// Helper 2: Eksekusi Upgrade Proof of Work di Settings
async function verifyUser(page: Page) {
  const settingsLink = page.locator('a[href="/settings"]').first();
  await settingsLink.click();
  await page.waitForTimeout(1000);

  // Cari tombol/badge "SANDBOXED" dan klik untuk membuka modal upgrade
  const sandboxedBtn = page.locator('button', { hasText: /sandbox/i }).first();
  await expect(sandboxedBtn).toBeVisible({ timeout: 10000 });
  await sandboxedBtn.click();

  // Di dalam modal, klik opsi Proof of Work (Mencari kata mining/pow/proof)
  const powBtn = page.locator('button', { hasText: /mining|pow|proof/i }).first();
  await expect(powBtn).toBeVisible();
  await powBtn.click();

  // TUNGGU PROSES MINING SELESAI
  // Waktu tunggu diperpanjang (60 detik) karena Web Worker butuh waktu untuk kalkulasi PoW
  const verifiedBadge = page.locator('span', { hasText: /verified/i }).first();
  await expect(verifiedBadge).toBeVisible({ timeout: 60000 });

  // Setelah berhasil diverifikasi, kembali ke layar chat
  const chatLink = page.locator('a[href="/chat"], a[aria-label="Back"]').first();
  if (await chatLink.isVisible()) {
    await chatLink.click();
  } else {
    await page.goto('/chat');
  }
  await expect(page.getByRole('heading', { name: /System Ready/i })).toBeVisible({ timeout: 15000 });
}

test.describe('Chat Functionality', () => {
  // Naikkan timeout global karena kita melakukan Registrasi (x2) + Mining PoW (x1)
  test.setTimeout(240000); 

  test('Start a new conversation and send a message', async ({ page, browser }) => {
    // Membutuhkan WebTransport untuk penerimaan real-time — skip bila tak tersedia
    // (mis. chromium headless-shell di beberapa Linux build / CI tanpa QUIC).
    const supported = await supportsWebTransport(page, { navigateToAppOrigin: true });
    test.skip(!supported, 'WebTransport tidak tersedia di environment ini');

    // 1. Register User A (Alice)
    const usernameA = `alice_${Date.now()}`;
    await registerUser(page, 'Alice', usernameA);

    // 2. Lakukan Upgrade PoW untuk User A agar bisa melakukan pencarian
    await verifyUser(page);

    // 3. Register User B (Bob) di konteks browser terpisah
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const usernameB = `bob_${Date.now()}`; 
    await registerUser(pageB, 'Bob', usernameB);

    // 4. User A mencari User B dan memulai obrolan
    await page.bringToFront();
    
    // Tambahkan jeda agar database/Redis menyelesaikan sinkronisasi Blind Indexing
    await page.waitForTimeout(3000);
    
    // Cari input pencarian (helper: kadang harus klik tab "Search" atau ikon search dulu).
    await openDirectChatWith(page, usernameB, 10000);

    // 5. Kirim Pesan
    const testMessage = 'Hello Bob, this is a secure message from Alice!';
    await sendChatMessage(page, testMessage);

    // Verifikasi pesan muncul di layar User A
    await expect(page.locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 10000 });

    // 6. Verifikasi penerimaan pesan oleh User B (Real-time)
    await pageB.bringToFront();

    // Karena Bob belum memecahkan/dekripsi nama profil Alice, nama Alice mungkin muncul sebagai "Encrypted User"
    // atau "Alice" (jika dekripsi cepat). ID Mentah (alice_123) TIDAK ditampilkan di UI ChatList.
    // Oleh karena itu, cara paling stabil adalah menemukan obrolan yang memiliki "Preview Teks" dari pesan yang dikirim Alice.
    await expectPeerReceivesMessage(pageB, testMessage, 30000);
  });
});
