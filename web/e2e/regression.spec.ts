import { test, expect, Page, BrowserContext } from '@playwright/test';
import path from 'node:path';
import { registerUser, supportsWebTransport, dismissOnboardingTour } from './helpers/registration';

const GUEST_PLACEHOLDER = 'Type an ephemeral message...';

// Helper: bikin link burner dari sidebar host, buka di konteks guest, kirim teks awal
async function openBurnerAsGuest(
  page: Page,
  context: BrowserContext
): Promise<{ guestPage: Page; roomId: string }> {
  // 1. Klik tombol burner di sidebar
  const burnerBtn = page.locator('button[title="Create burner conversation link"]').first();
  await expect(burnerBtn).toBeVisible({ timeout: 15000 });
  await burnerBtn.click();

  // 2. Ambil link dari modal
  const linkEl = page.locator('div', { hasText: /\/drop\/#/ }).first();
  await expect(linkEl).toBeVisible({ timeout: 10000 });
  const modalText = await linkEl.innerText();
  const hrefMatch = modalText.match(/https?:\/\/[^\s]+\/drop\/#(\S+)/);
  expect(hrefMatch).not.toBeNull();
  const link = hrefMatch![0]!;
  const roomId = hrefMatch![1]!.split(':')[0]!;
  expect(roomId.startsWith('burner_')).toBe(true);

  // 3. Klik COPY SECURE LINK → menambahkan conversation burner ke store host
  //    (ChatWindow host di /chat/<roomId> yang memuat MessageInput + Destroy).
  const copyBtn = page.getByRole('button', { name: /Copy Secure Link/i }).first();
  await expect(copyBtn).toBeVisible({ timeout: 10000 });
  await copyBtn.click();

  // 4. Tutup modal burner — kalau tidak, overlay `z-[100]`-nya menelan klik
  //    baris sidebar berikutnya. Backdrop-nya menutup on-click; diklik lewat
  //    `mouse.click` di pojok supaya tidak tersangkut cek "stable" framer-motion.
  if (await copyBtn.isVisible().catch(() => false)) {
    await page.mouse.click(5, 5);
  }
  await expect(page.getByRole('button', { name: /Copy Secure Link/i })).toHaveCount(0, { timeout: 10000 });

  // 5. Buka link di konteks guest terisolasi
  const guestPage = await context.newPage();
  await guestPage.goto(link);
  await sendBurnerMessage(guestPage, 'ping');

  return { guestPage, roomId };
}

/** Kirim satu pesan di halaman burner (/drop guest atau ChatWindow host). */
async function sendBurnerMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(GUEST_PLACEHOLDER).or(
    page.locator('textarea[placeholder*="essage"], input[placeholder*="essage"]')
  ).first();
  await expect(input).toBeVisible({ timeout: 30000 });
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.fill(text);
  await input.press('Enter');
}

/**
 * Host membuka percakapan burner-nya lewat baris sidebar (navigasi in-app).
 *
 * PENTING: state Double Ratchet host untuk burner hidup HANYA di RAM
 * (`useBurnerStore.activeSessions`). `page.goto('/chat/<roomId>')` me-reload
 * halaman dan menghapus state itu → komposer host terkunci di "Waiting for
 * guest to establish secure connection..." dan lampiran tak bisa dikirim.
 * Membuka lewat baris sidebar = perilaku user yang sebenarnya dan state tetap utuh
 * (pesan awal guest sudah menginisialisasi DR host via `burner:receive`).
 */
async function openBurnerChatOnHost(page: Page, roomId: string): Promise<void> {
  const burnerRow = page.locator('div.cursor-pointer').filter({ hasText: 'ping' }).first();
  await expect(burnerRow).toBeVisible({ timeout: 30000 });
  await burnerRow.click();

  await expect(page).toHaveURL(new RegExp(roomId));
  await expect(
    page.getByRole('button', { name: /Destroy Burner Session/i }).first()
  ).toBeVisible({ timeout: 30000 });
}

async function sendFileFromHost(page: Page, filePath: string) {
  // Komposer host terkunci selama DR burner belum ada (isWaitingForGuest) →
  // tunggu sampai placeholder "Waiting for guest..." hilang dulu.
  await expect(page.getByPlaceholder(/Waiting for guest/i)).toHaveCount(0, { timeout: 30000 });

  // MessageInput staging flow: pilih file → preview → klik tombol kirim
  // Input file sengaja disembunyikan (className="hidden") → tidak perlu visible.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 15000 });
  await fileInput.setInputFiles(filePath);

  // Staging muncul sebelum kirim: thumbnail untuk gambar, dan hanya lampiran
  // non-gambar yang menampilkan nama file → terima keduanya.
  const stagedName = filePath.split('/').pop()!;
  const staged = page
    .locator('img[alt="preview"]')
    .or(page.locator('text=' + stagedName))
    .first();
  await expect(staged).toBeVisible({ timeout: 15000 });

  const sendBtn = page.locator('form button[type="submit"]').first();
  await expect(sendBtn).toBeEnabled({ timeout: 10000 });
  await sendBtn.click();
}

// Cek WebTransport HARUS setelah navigasi ke origin app (di about:blank,
// `window.isSecureContext === false` → WebTransport undefined meski didukung) —
// opsi `navigateToAppOrigin` di helper.
test.describe('Regression: burner flows', () => {
  test.setTimeout(240000);

  test('host sends a photo → guest bubble shows a preview (regression: no preview on host→guest files)', async ({ page, browser }) => {
    const supported = await supportsWebTransport(page, { navigateToAppOrigin: true });
    test.skip(!supported, 'WebTransport tidak tersedia di environment ini');

    const hostName = `bh_${Date.now()}`;
    await registerUser(page, 'Burn Host', hostName);

    const context = await browser.newContext();
    const { guestPage, roomId } = await openBurnerAsGuest(page, context);

    // Host buka chat burner (in-app, tanpa reload) & kirim foto
    await openBurnerChatOnHost(page, roomId);

    const imgPath = path.resolve(process.cwd(), 'public', 'pwa-192x192.png');
    await sendFileFromHost(page, imgPath);

    // REGRESI: bubble guest harus menampilkan preview (gambar hasil dekripsi),
    // bukan kosong / waiting-for-key tanpa media.
    await expect(guestPage.locator('main img').first()).toBeVisible({ timeout: 45000 });
    await expect(guestPage.locator('text=Waiting for key').first()).toHaveCount(0);
  });

  test('burner conversation destroyed on host stays deleted after reload (regression: reappears)', async ({ page, browser }) => {
    const supported = await supportsWebTransport(page, { navigateToAppOrigin: true });
    test.skip(!supported, 'WebTransport tidak tersedia di environment ini');

    const hostName = `bd_${Date.now()}`;
    await registerUser(page, 'Burn Del', hostName);

    const context = await browser.newContext();
    const { roomId } = await openBurnerAsGuest(page, context);

    await openBurnerChatOnHost(page, roomId);

    // Destroy sesi dari ChatWindow host
    const destroyBtn = page.getByRole('button', { name: /Destroy Burner Session/i }).first();
    await expect(destroyBtn).toBeVisible({ timeout: 15000 });
    await destroyBtn.click();

    // Efek destroy asinkron (baris conversation dihapus dari IndexedDB lokal).
    // Reload terlalu cepat membatalkan penghapusan itu dan room tampak "kembali"
    // — jadi tunggu barisnya benar-benar hilang dulu (sekaligus asersi bahwa
    // destroy memang membersihkan UI tanpa reload).
    await expect(
      page.locator('div.cursor-pointer').filter({ hasText: /No messages yet|ping/ })
    ).toHaveCount(0, { timeout: 20000 });

    // Setelah destroy: reload penuh → room yang sudah dihancurkan tidak boleh
    // muncul kembali di daftar chat (regresi: conversation di-restore dari DB).
    await page.reload();
    // Quick Tour hanya ter-mount setelah bootstrap reload (isBootstrapping) →
    // kalau belum ditandai selesai ia menutupi sidebar dengan overlay fixed.
    await dismissOnboardingTour(page, 15000);
    await expect(page.getByRole('link', { name: /Settings/i })).toBeVisible({ timeout: 30000 });

    await expect(page.locator(`a[href*="${roomId}"]`)).toHaveCount(0);
    await expect(page.locator('div', { hasText: roomId }).first()).toHaveCount(0);
    // Host hanya punya satu percakapan (burner tadi) → daftar chat harus kosong.
    await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 30000 });
  });
});