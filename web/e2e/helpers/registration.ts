// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/30 WS-G(7)] Helper E2E bersama. Sebelumnya `registerUser` disalin di 6
// spec (dan mulai menyimpang), sehingga perbaikan alur onboarding harus
// dilakukan berulang dan mudah tertinggal. Ada DUA varian karena onboarding
// memang berbeda:
//
//   - `registerUser`            — rantai Proof of Trust → Recovery → Secure
//                                 Phrase → Verify Sequence → System Init → Tour
//                                 (tour baru bisa ditutup setelah app mendarat di
//                                 /chat — lihat `dismissOnboardingTour`).
//   - `registerUserViaBiometric`— varian dengan langkah skip biometric lebih dulu
//                                 (dipakai spec Settings).
//
// Keduanya berakhir di dashboard (System Ready) dengan Quick Tour sudah tertutup.
//
// Tinggal di berkas ini juga: rantai "buka chat langsung + kirim pesan + peer
// menerima" yang dulu disalin di chat.spec, transport.spec (×2), dan probe
// WebTransport yang sempat punya dua nama berbeda (`supportsWebTransport` di
// regression.spec vs `webTransportSupported` di transport.spec).
import { expect, Page } from '@playwright/test';

/**
 * Tutup modal onboarding yang sedang tampil lewat tombol `×`-nya.
 *
 * `locator(...).first().click()` rapuh di sini: saat berpindah langkah, modal
 * lama masih ada di DOM dalam animasi keluar (`AnimatePresence`), jadi
 * Playwright bisa "menunggu stabil" atas elemen yang sedang hilang sampai test
 * timeout (`element is not stable` → `detached from the DOM, retrying`).
 * Solusinya: resolve ulang lokator tiap percobaan, mulai dari elemen paling
 * akhir (modal teratas), dan klik dengan `force` karena animasi framer-motion
 * membuat cek stabilitas gagal.
 *
 * Mengembalikan `true` bila ada tombol yang berhasil diklik.
 */
export async function dismissModalCloseButton(page: Page, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttons = page.locator(
      'button[aria-label="Close modal"], button[aria-label="Close"], button:has-text("×")'
    );
    const count = await buttons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const btn = buttons.nth(index);
      if (!(await btn.isVisible().catch(() => false))) continue;
      try {
        await btn.click({ force: true, timeout: 1500 });
        await page.waitForTimeout(350);
        return true;
      } catch {
        // Elemen ter-detach saat animasi — coba lokator berikutnya / ulangi.
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Tutup Quick Tour (onboarding) milik akun yang baru mendaftar.
 *
 * Tour dirender `Chat.tsx` dan hanya terbuka bila `user.hasCompletedOnboarding
 * === false`. PENTING: ia muncul di halaman /chat, BUKAN di /register — routing
 * `/chat` baru terjadi ~100 ms setelah layar sukses registrasi (`Register.tsx`),
 * jadi mencarinya sebelum mendarat di /chat selalu gagal ("Quick Tour modal
 * skipped or not found") dan overlay `fixed inset-0`-nya lalu menolak klik
 * berikutnya dengan `subtree intercepts pointer events`.
 *
 * Klik `×` memicu `handleFinish` → `POST /api/users/me/complete-onboarding`,
 * jadi tour tidak muncul lagi setelah reload/navigasi berikutnya. Akun lama
 * (flag sudah true) dilewati tanpa error. (URL harus sudah di /chat.)
 */
export async function dismissOnboardingTour(page: Page, timeoutMs = 20000): Promise<void> {
  const tour = page.getByRole('dialog').filter({ hasText: /Quick Tour/i }).first();
  try {
    await tour.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return; // bukan akun baru / tour sudah ditutup sebelumnya
  }
  await tour.getByRole('button', { name: /Close modal/i }).first().click({ force: true });
  // Modal baru lepas dari DOM setelah POST complete-onboarding selesai — kalau
  // overlay masih terpasang, klik pengguna berikutnya akan ditolak lagi.
  await expect(tour).toBeHidden({ timeout: 15000 });
}

/**
 * Isi field lalu BUKTIKAN nilainya sudah ter-commit sebelum event berikutnya.
 *
 * Flake 2026-11-05: `fill` tiga field lalu klik submit bisa tiba di handler
 * dengan state nama masih kosong ("Name is required" padahal field sempat
 * terisi) ketika form baru saja remount/hydrate — username & password lolos,
 * nama tidak. Membaca ulang nilai lewat `toHaveValue` (auto-retry) memaksa
 * React menyelesaikan update; kalau field di-reset oleh remount, nilainya diisi
 * ulang, bukan dibiarkan kosong.
 */
async function fillStable(locator: import('@playwright/test').Locator, value: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await locator.fill(value);
    try {
      await expect(locator).toHaveValue(value, { timeout: 3000 });
      return;
    } catch {
      // Field ter-reset oleh render ulang — ulangi, jangan klik dengan nilai kosong.
    }
  }
  await expect(locator).toHaveValue(value, { timeout: 5000 });
}

/** Registrasi akun + bypass seluruh modal onboarding (rantai standar). */
export async function registerUser(page: Page, displayName: string, username: string): Promise<void> {
  await walkOnboarding(page, displayName, username, false);
}

/**
 * Registrasi yang sekaligus mengembalikan recovery phrase (12 kata).
 *
 * Dipakai spec backup/restore (`docs/41 §7.5`): berkas `.nyxbak` hanya bisa
 * dibuka dengan phrase yang sama, jadi spec harus membacanya dari modal Secure
 * Phrase — bukan mengarang kata. Reveal dilakukan sebelum "Sequence Recorded",
 * lalu rantai modal diteruskan seperti `registerUser` (verifikasi kata ditutup
 * lewat ×, sama seperti pengguna yang mencatat phrase di luar layar).
 */
export async function registerUserWithPhrase(
  page: Page,
  displayName: string,
  username: string
): Promise<string> {
  return walkOnboarding(page, displayName, username, true);
}

async function walkOnboarding(
  page: Page,
  displayName: string,
  username: string,
  capturePhrase: boolean
): Promise<string> {
  let phrase = '';
  await page.goto('/register');
  // Tunggu form benar-benar siap (i18n/hydration selesai) sebelum mengisi.
  await expect(page.getByRole('button', { name: /Initialize Identity/i })).toBeEnabled({ timeout: 30000 });

  await fillStable(page.getByRole('textbox', { name: /Display Name/i }), displayName);
  await fillStable(page.getByRole('textbox', { name: /Username/i }), username);
  await fillStable(page.getByRole('textbox', { name: /Password/i }), 'StrongPass123!');
  await page.getByRole('button', { name: /Initialize Identity/i }).click();

  // 1. Trust level verification (muncul setelah registrasi selesai, ~15-20 dtk di
  //    mesin idle). Di mesin dev ini rantai registrasi terukur 40-70 dtk saat box
  //    sedang sibuk (Argon2 di worker), dan anggaran 60 dtk membuat spec mana pun
  //    yang kebetulan berjalan paling lambat gagal di sini — gejalanya "Skip for
  //    now tidak muncul" yang mudah disalahartikan sebagai bug registrasi. Beri
  //    ruang untuk rentang yang terukur, bukan untuk hang tanpa batas.
  await page.getByRole('button', { name: /Skip for now/i }).waitFor({ state: 'visible', timeout: 90000 });
  await page.getByRole('button', { name: /Skip for now/i }).click();

  // 2. Protocol: Recovery
  await page.getByRole('button', { name: /Acknowledge/i }).waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /Acknowledge/i }).click();

  // 3. Secure Phrase — rekam phrase SEBELUM lanjut (mask harus dibuka dulu).
  if (capturePhrase) {
    await page.getByTestId('recovery-reveal').click();
    const words = page.getByTestId('recovery-phrase-word');
    await expect(words.first()).toBeVisible({ timeout: 15000 });
    const count = await words.count();
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push((await words.nth(i).innerText()).trim());
    phrase = parts.join(' ');
  }
  await page.getByRole('button', { name: /Sequence Recorded/i }).waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /Sequence Recorded/i }).click();

  // 4. Verify Sequence — tutup modal (mungkin perlu dua kali bila kata ter-regenerasi).
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await dismissModalCloseButton(page, 15000))) break;
    await page.waitForTimeout(500);
  }

  // 5. System Init modal (opsional di sebagian alur).
  const skipSystemInitBtn = page.getByRole('button', { name: /Skip for now/i });
  try {
    await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 15000 });
    await skipSystemInitBtn.click();
    await skipSystemInitBtn.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    console.log('System Init modal skipped or not found');
  }

  // 6. Quick Tour (opsional — muncul di /chat, setelah System Ready).
  const closeTourBtn = page.getByRole('button', { name: /Close modal/i });
  try {
    await closeTourBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeTourBtn.click();
  } catch {
    console.log('Quick Tour modal skipped or not found');
  }

  await expect(page.getByRole('heading', { name: /System Ready/i })).toBeVisible({ timeout: 30000 });

  // 7. Tutup Quick Tour SETELAH mendarat di /chat (di /register tour belum ada).
  await dismissOnboardingTour(page);
  return phrase;
}

/** Registrasi varian spec Settings: skip biometric dulu, lalu recovery/init/tour. */
export async function registerUserViaBiometric(page: Page, displayName: string, username: string) {
  await page.goto('/register');
  await expect(page.getByRole('button', { name: /Initialize Identity/i })).toBeEnabled({ timeout: 30000 });

  await fillStable(page.getByRole('textbox', { name: /Display Name/i }), displayName);
  await fillStable(page.getByRole('textbox', { name: /Username/i }), username);
  await fillStable(page.getByRole('textbox', { name: /Password/i }), 'StrongPass123!');
  await page.getByRole('button', { name: /Initialize Identity/i }).click();

  // 1. Bypass biometric BILA prompt-nya muncul. WebKit headless tidak selalu
  //    punya platform authenticator, dan alur registrasi melewati langkah ini
  //    ketika WebAuthn tidak tersedia — menunggu 30 dtk untuk tombol yang memang
  //    tidak akan ada adalah kegagalan harness (run 42362200951), bukan produk.
  const skipBiometricBtn = page.locator('button:has-text("Skip"), button:has-text("Continue")').first();
  try {
    await expect(skipBiometricBtn).toBeVisible({ timeout: 8000 });
    await skipBiometricBtn.click();
  } catch {
    console.log('Biometric prompt skipped or not found');
  }

  // 2. Bypass recovery modal (acknowledge + tutup).
  await page.getByRole('button', { name: /Acknowledge/i }).click();
  const closeRecoveryBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first();
  await expect(closeRecoveryBtn).toBeVisible({ timeout: 5000 });
  await closeRecoveryBtn.click();

  // 3. System Init modal.
  const skipSystemInitBtn = page.getByRole('button', { name: /Skip for now/i });
  try {
    await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await skipSystemInitBtn.click();
    await skipSystemInitBtn.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    console.log('System Init modal skipped or not found');
  }

  // 4. Quick Tour (opsional).
  const closeTourBtn = page.getByRole('button', { name: /Close modal/i });
  try {
    await closeTourBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeTourBtn.click();
  } catch {
    console.log('Quick Tour modal skipped or not found');
  }

  await expect(page.getByRole('heading', { name: /System Ready/i })).toBeVisible({ timeout: 15000 });

  // 5. Tutup Quick Tour SETELAH mendarat di /chat (di /register tour belum ada).
  await dismissOnboardingTour(page);
}

/**
 * Probe dukungan WebTransport.
 *
 * WAJIB `navigateToAppOrigin: true` untuk spec yang men-skip diri sendiri:
 * di `about:blank` (halaman awal Playwright) `window.isSecureContext` bisa
 * `false`, sehingga `WebTransport` terlihat tidak didukung padahal Chrome
 * penuh mendukungnya → spec transport/chat SELALU skip, termasuk di CI
 * `e2e-chrome` yang justru dibangun untuk menjalankannya.
 * Default `false` hanya untuk pemanggil yang sudah berada di origin app.
 */
export async function supportsWebTransport(
  page: Page,
  { navigateToAppOrigin = false }: { navigateToAppOrigin?: boolean } = {}
): Promise<boolean> {
  if (navigateToAppOrigin) {
    await page.goto('/');
  }
  return page.evaluate(() => typeof WebTransport !== 'undefined');
}

/**
 * Host mencari peer lewat kolom pencarian, lalu membuka percakapan.
 * (Duplikat sebelumnya ada di chat.spec dan transport.spec ×2.)
 */
export async function openDirectChatWith(
  page: Page,
  peerUsername: string,
  searchTimeoutMs = 15000
): Promise<void> {
  const searchInput = page.getByRole('textbox', { name: /search/i }).first();
  await searchInput.waitFor({ state: 'visible', timeout: searchTimeoutMs });
  await searchInput.click();
  await searchInput.fill(peerUsername);
  // ENTER memicu kalkulasi Argon2 blind index di Crypto Worker.
  await searchInput.press('Enter');

  const searchResult = page.locator(`text=${peerUsername}`).first();
  await expect(searchResult).toBeVisible({ timeout: 30000 });
  await searchResult.click();
}

/**
 * Kirim pesan ke percakapan yang sedang terbuka (fill + Enter saja).
 * Asersi kemunculan bubble & pengukuran latency tetap di spec masing-masing.
 */
export async function sendChatMessage(page: Page, text: string): Promise<void> {
  const messageInput = page.locator('textarea[placeholder*="essage"], input[placeholder*="essage"]').first();
  await expect(messageInput).toBeVisible({ timeout: 10000 });
  await messageInput.fill(text);
  await messageInput.press('Enter');
}

/**
 * Peer (Bob) membuka percakapan dari chat list — dicari lewat preview teks pesan
 * karena nama pengirim bisa belum terdekripsi ("Encrypted User") — lalu
 * memastikan pesan terlihat di chat window.
 */
export async function expectPeerReceivesMessage(
  page: Page,
  text: string,
  timeoutMs = 15000
): Promise<void> {
  const chatFromPeer = page.locator('div').filter({ hasText: text }).first();
  await expect(chatFromPeer).toBeVisible({ timeout: timeoutMs });
  await chatFromPeer.click();
  await expect(page.locator(`text=${text}`).first()).toBeVisible({ timeout: timeoutMs });
}
