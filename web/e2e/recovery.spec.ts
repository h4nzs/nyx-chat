// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 Fase 8 residual] E2E pemulihan akun di browser sungguhan.
//
// Alur yang dibuktikan: frasa pemulihan diambil dari vault (jalur
// `/settings/keys` → prompt password → reveal), lalu `/restore` memakai frasa
// itu untuk menurunkan ulang identitas dan mengirim bukti ke server.
//
// Yang khusus PQ dan tidak bisa dibuktikan unit test: request
// `POST /api/auth/recover` membawa `signatureV2`/`signingKeyV2` (ML-DSA-65,
// domain RECOVERY) dan server menerimanya (200). Tanda tangan v2 selalu dibuat
// `recoverAccountWithSignature` — tidak bergantung gerbang `VITE_PQ_V2` — jadi
// spec ini berjalan juga pada build default (gate mati).
import { test, expect, Page } from '@playwright/test';
import { dismissModalCloseButton, registerUser } from './helpers/registration';
import { openSettingsSection } from './helpers/navigation';

const PASSWORD = 'StrongPass123!';

/**
 * Buka frasa pemulihan lewat Settings → Keys (satu-satunya jalur UI yang
 * menampilkan frasa setelah registrasi). Modal dimulai di langkah peringatan,
 * lalu "Reveal Data" menampilkan kata-kata asli.
 */
async function revealRecoveryPhrase(page: Page): Promise<string> {
  await openSettingsSection(page, /Encryption Keys/i);
  await expect(page).toHaveURL(/\/settings\/keys$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Reveal Phrase/i }).first().click();

  const passwordInput = page.getByPlaceholder(/Enter access code/i);
  await expect(passwordInput).toBeVisible({ timeout: 15000 });
  await passwordInput.fill(PASSWORD);
  await page.getByRole('button', { name: /^UNLOCK$/i }).click();

  // Modal frasa dirender sendiri (bukan ModalBase), jadi tidak punya role
  // dialog — lokasikan lewat tombol/langkahnya, bukan `getByRole('dialog')`.
  const acknowledge = page.getByRole('button', { name: /Acknowledge & Proceed/i });
  await expect(acknowledge).toBeVisible({ timeout: 30000 });
  await acknowledge.click();
  await page.getByRole('button', { name: /Reveal Data/i }).click();

  const wordCells = page.locator('span.select-all');
  await expect(wordCells.first()).toBeVisible({ timeout: 15000 });
  const words = (await wordCells.allTextContents())
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  expect(words.length, 'frasa pemulihan harus terdiri dari 12/24 kata').toBeGreaterThanOrEqual(12);

  expect(await dismissModalCloseButton(page), 'modal frasa harus bisa ditutup').toBe(true);
  return words.join(' ');
}

test.describe('Pemulihan akun (recovery v2)', () => {
  test.setTimeout(420_000);

  test('frasa memulihkan akun dan server menerima tanda tangan ML-DSA', async ({ page, browser }) => {
    const username = `recover${Date.now()}`;
    await registerUser(page, 'Recovery Owner', username);
    const phrase = await revealRecoveryPhrase(page);

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto('/restore');

    await freshPage.getByPlaceholder(/USERNAME_OR_HASH_ID/i).fill(username);
    await freshPage.getByPlaceholder(/SEED_PHRASE/i).fill(phrase);
    await freshPage.getByPlaceholder(/SET_NEW_PASSWORD/i).fill(PASSWORD);

    const requestPromise = freshPage.waitForRequest(
      (request) =>
        request.url().includes('/api/auth/recover') && request.method() === 'POST',
      { timeout: 120000 }
    );
    const responsePromise = freshPage.waitForResponse(
      (response) =>
        response.url().includes('/api/auth/recover') &&
        response.request().method() === 'POST',
      { timeout: 120000 }
    );

    await freshPage.getByRole('button', { name: /RECOVER_ACCOUNT/i }).click();

    const recoverRequest = await requestPromise;
    const payload = recoverRequest.postDataJSON() as {
      signatureV2?: unknown;
      signingKeyV2?: unknown;
    };
    expect(payload.signatureV2, 'pemulihan harus membawa tanda tangan ML-DSA').toBeTruthy();
    expect(payload.signingKeyV2, 'kunci verifikasi ML-DSA harus ikut dikirim').toBeTruthy();

    const recoverResponse = await responsePromise;
    expect(
      recoverResponse.status(),
      `server menolak pemulihan v2: ${await recoverResponse.text()}`
    ).toBe(200);

    // Login otomatis setelah recovery: routing mengikuti hasRestoredKeys.
    await expect(freshPage).toHaveURL(/\/chat/, { timeout: 60000 });
    await expect(
      freshPage.getByRole('textbox', { name: /search/i }).first()
    ).toBeVisible({ timeout: 30000 });

    await freshContext.close();
  });
});
