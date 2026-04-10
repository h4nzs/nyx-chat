import { test, expect, Page } from '@playwright/test';

// ✅ Helper 1: Registrasi Akun dan Bypass Semua Modal Awal
async function registerUser(page: Page, displayName: string, username: string) {
  await page.goto('/register');
  
  await page.getByRole('textbox', { name: 'Display Name' }).fill(displayName);
  await page.getByRole('textbox', { name: 'Username (ID)' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill('StrongPass123!');
  await page.getByRole('button', { name: 'Initialize Identity' }).click();

  // 1. Bypass Biometric
  const skipBiometricBtn = page.locator('button:has-text("Skip"), button:has-text("Continue")').first();
  await expect(skipBiometricBtn).toBeVisible({ timeout: 30000 });
  await skipBiometricBtn.click();

  // 2. Bypass Recovery Modal
  await page.getByRole('button', { name: 'Acknowledge & Proceed' }).click();
  const closeRecoveryBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first();
  await expect(closeRecoveryBtn).toBeVisible({ timeout: 5000 });
  await closeRecoveryBtn.click();

  // 3. Bypass System Init Modal
  const skipSystemInitBtn = page.getByRole('button', { name: 'Skip for now' });
  
  // ✅ FIX: Gunakan waitFor() + try/catch agar Playwright BENAR-BENAR MENUNGGU modalnya
  try {
    // Menunggu maksimal 10 detik sampai modal selesai dirender
    await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await skipSystemInitBtn.click();
    await skipSystemInitBtn.waitFor({ state: 'hidden', timeout: 5000 });
  } catch (e) {
    // Abaikan jika modal tidak muncul dan lanjut ke step berikutnya
    console.log('System Init modal skipped or not found');
  }

  // Verifikasi mendarat di Dashboard
  await expect(page.getByRole('heading', { name: 'System Ready' })).toBeVisible({ timeout: 15000 });
}

// ✅ Helper 2: Eksekusi Upgrade Proof of Work di Settings
async function verifyUser(page: Page) {
  const settingsLink = page.locator('a[href="/settings"]').first();
  await settingsLink.click();

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
  const backToChatBtn = page.locator('a[href="/chat"], a[aria-label="Back"]').first();
  await backToChatBtn.click();
  await expect(page.getByRole('heading', { name: 'System Ready' })).toBeVisible({ timeout: 15000 });
}

test.describe('Chat Functionality', () => {
  // Naikkan timeout global karena kita melakukan Registrasi (x2) + Mining PoW (x1)
  test.setTimeout(120000); 

  test('Start a new conversation and send a message', async ({ page, context }) => {
    // 1. Register User A (Alice)
    const usernameA = `alice_${Date.now()}`;
    await registerUser(page, 'Alice', usernameA);

    // 2. Lakukan Upgrade PoW untuk User A agar bisa melakukan pencarian
    await verifyUser(page);

    // 3. Register User B (Bob) di konteks browser terpisah
    const pageB = await context.newPage();
    // ✅ FIX 1: Gunakan nama yang pendek dan pasti sesuai kriteria pencarian Blind Indexing
    const usernameB = `bob_test`; 
    await registerUser(pageB, 'Bob', usernameB);
    
    // (Opsional) Jika User B juga harus verified agar bisa dicari, uncomment baris di bawah:
    // await verifyUser(pageB);

    // 4. User A mencari User B dan memulai obrolan
    await page.bringToFront();
    
    // ✅ FIX 2: Tambahkan jeda 2 detik agar database/Redis menyelesaikan sinkronisasi Blind Indexing
    // sebelum Alice mencoba mencarinya.
    await page.waitForTimeout(5000);
    
    // Asumsi: Input pencarian berada di sidebar dengan placeholder "Search..."
    const searchInput = page.getByRole('textbox', { name: /search/i });
    
    await searchInput.click();
    await searchInput.clear();
    await searchInput.fill(usernameB);
    
    // ✅ FIX 2: Tekan ENTER untuk memicu kalkulasi Argon2 di Crypto Worker
    await searchInput.press('Enter');
    
    // Tunggu hasil pencarian muncul dan klik
    const searchResult = page.locator(`text=${usernameB}`).first();
    await expect(searchResult).toBeVisible({ timeout: 15000 }); // Waktu tunggu sedikit ditambah
    await searchResult.click();
    
    // 5. Kirim Pesan
    const testMessage = 'Hello Bob, this is a secure message from Alice!';
    
    // Cari input pesan di area chat (textbox / textarea)
    const messageInput = page.locator('textarea[placeholder*="message"], input[placeholder*="message"]').first();
    await messageInput.fill(testMessage);
    await messageInput.press('Enter');

    // Verifikasi pesan muncul di layar User A
    await expect(page.locator(`text=${testMessage}`)).toBeVisible();

    // 6. Verifikasi penerimaan pesan oleh User B (Real-time Socket.io check)
    await pageB.bringToFront();
    
    // User B mengklik obrolan yang masuk dari Alice
    const chatFromAlice = pageB.locator(`text=${usernameA}`).first();
    if (await chatFromAlice.isVisible()) {
      await chatFromAlice.click();
    }
    
    // Verifikasi pesan muncul di layar User B
    await expect(pageB.locator(`text=${testMessage}`)).toBeVisible();
  });
});
