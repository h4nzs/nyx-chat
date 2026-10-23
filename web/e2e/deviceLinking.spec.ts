// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 Fase 8 residual] E2E tautan perangkat (device linking) di browser.
//
// Membuktikan rantai nyata yang tidak tercakup unit test:
//   1. Perangkat lama meminta token tautan lewat relay (`auth:request_linking_qr`)
//      dan menampilkan URL `/link?t=…` (QR + teks manual).
//   2. Perangkat baru membuka URL itu, membuat kunci device baru, dan mengklaim
//      token (POST /api/auth/link/claim).
//   3. Perangkat lama menerima event permintaan lalu menyetujui
//      (POST /api/auth/link/approve).
//   4. Perangkat baru menyelesaikan tautan (POST /api/auth/link/complete),
//      menyimpan kunci, lalu login lewat jalur sesi yang sama dan mendarat di
//      /chat. Satu akun satu device aktif: perangkat lama akan keluar.
//
// Butuh relay WSS/WebTransport aktif (`transportClient.connected`), karena
// token QR dikirim sebagai event — sama seperti produksi.
import { test, expect, Page } from '@playwright/test';
import { registerUser } from './helpers/registration';
import { openSettingsSection } from './helpers/navigation';

const PASSWORD = 'StrongPass123!';

async function waitForTransport(page: Page, timeoutMs = 60000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          // @ts-ignore — path absolut Vite dev server (runtime-only)
          const { transportClient } = await import('/src/lib/transportClient.ts');
          return Boolean((transportClient as { connected?: boolean } | null)?.connected);
        }),
      { timeout: timeoutMs, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

test.describe('Tautan perangkat (QR)', () => {
  test.setTimeout(480_000);

  test('perangkat baru ditautkan lewat QR dan disetujui perangkat lama', async ({
    page,
    browser,
  }) => {
    const username = `link${Date.now()}`;
    await registerUser(page, 'Link Owner', username);
    await waitForTransport(page);

    await openSettingsSection(page, /Active Sessions/i);
    await expect(page).toHaveURL(/\/settings\/sessions$/, { timeout: 20000 });
    await page.getByRole('button', { name: /Link a device/i }).first().click();

    const linkCode = page.locator('code').filter({ hasText: /\/link\?t=/ }).first();
    await expect(linkCode).toBeVisible({ timeout: 30000 });
    const linkUrl = (await linkCode.innerText()).trim();
    expect(linkUrl).toContain('/link?t=');

    const newDeviceContext = await browser.newContext();
    const newDevice = await newDeviceContext.newPage();
    await newDevice.goto(linkUrl);

    await newDevice.locator('#link-password').fill(PASSWORD);
    await newDevice.locator('#link-password-confirm').fill(PASSWORD);
    await newDevice.getByRole('button', { name: /^Link device$/i }).click();

    // Perangkat lama menerima `auth:linking_request` → tombol approve muncul.
    const approveButton = page.getByRole('button', { name: /Approve device/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 90000 });
    await approveButton.click();

    // Perangkat baru menyelesaikan tautan lalu login (polling status 2 dtk).
    await expect(newDevice).toHaveURL(/\/chat/, { timeout: 150000 });
    await expect(
      newDevice.getByRole('textbox', { name: /search/i }).first()
    ).toBeVisible({ timeout: 30000 });

    await newDeviceContext.close();
  });
});
