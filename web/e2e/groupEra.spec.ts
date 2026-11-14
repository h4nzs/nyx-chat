// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.4] Era kripto grup lewat UI sungguhan.
//
// `groupLifecycle.spec.ts` membuktikan **kontrak HTTP** (gate token/admin dan
// era token) tanpa kripto. Spec ini melanjutkannya ke bagian yang tidak bisa
// dibuktikan endpoint: kunci era benar-benar dipakai untuk pesan, dan pesan
// era lama tetap terbaca setelah epoch berputar (arsip), termasuk setelah
// halaman di-reload.
//
// Kenapa dua konteks browser, bukan request: distribusi kunci era baru lewat
// mailbox (`docs/37 §37.3.2`) dan baru terjadi setelah klien anggota hidup —
// memakai request saja tidak akan pernah menguji jalur itu.
//
// [2026-11-14] Grup dibuat TEPAT setelah registrasi, sebelum navigasi apa pun.
// Versi pertama spec ini mengklik `New Group` 100 ms setelah membuka direct
// chat; modal sempat terbuka lalu di-unmount oleh navigasi yang masih
// berjalan, dan `fill` pada input modal — tanpa `actionTimeout` di
// `playwright.config.ts` — menggantung sampai anggaran tes 15 menit habis
// (trace: "element was detached from the DOM", lalu senyap). Karena itu setiap
// halaman di sini memakai `setDefaultTimeout(60_000)` supaya kegagalan muncul
// dalam semenit, dan modal ditunggu eksplisit sebelum diisi.
//
// Jalankan terhadap stack dev hidup (API + Vite), contoh:
//   NYX_E2E_SKIP_RESET=1 npx playwright test e2e/groupEra.spec.ts --project=chromium
import { test, expect, Browser } from '@playwright/test';
import { registerUser, sendChatMessage } from './helpers/registration';

const ROTATE_BUTTON = /Rotate Encryption Keys Now/i;
const ROTATED_TOAST = /Encryption keys rotated successfully/i;

/**
 * Buka percakapan grup dari daftar chat. Dicari lewat nama grup karena id
 * percakapan berisi token acak yang tidak diketahui spec.
 */
async function openGroup(page: import('@playwright/test').Page, groupName: string) {
  const inList = page.locator(`text=${groupName}`).first();
  await expect(inList).toBeVisible({ timeout: 120000 });
  // Nama grup di sidebar adalah <p> di dalam baris yang menangani klik; hit-test
  // Playwright jatuh ke div induk itu ("intercepts pointer events"), jadi klik
  // teksnya dipaksa — event tetap sampai ke handler baris lewat bubbling.
  await inList.click({ force: true });
  // Header memuat nama grup; kalau klik pertama hanya menyorot, klik sekali lagi.
  const header = page.locator('main').getByText(groupName).first();
  await expect(header).toBeVisible({ timeout: 30000 });
}

test.describe('Group era (kripto UI)', () => {
  test.setTimeout(900000);

  test('pesan era lama tetap terbaca setelah rotasi epoch', async ({ browser }: { browser: Browser }) => {
    const run = Date.now();
    const adminUsername = `era_admin_${run}`;
    const memberUsername = `era_member_${run}`;
    const groupName = `Era Group ${run}`;
    const era1 = `era1-${run}`;
    const era2 = `era2-${run}`;

    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const member = await memberCtx.newPage();
    // `playwright.config.ts` tidak menetapkan `actionTimeout`, jadi aksi lokator
    // tanpa batas. Batasi per halaman supaya regresi selector gagal cepat.
    admin.setDefaultTimeout(60000);
    member.setDefaultTimeout(60000);

    try {
      // 1. Dua akun sungguhan (jalur yang sama dengan pengguna).
      await registerUser(admin, 'Era Admin', adminUsername);
      await registerUser(member, 'Era Member', memberUsername);

      // 2. Admin membuat grup lewat modal yang sama dengan UI. Langkah ini
      //    sengaja dilakukan SEBELUM membuka percakapan apa pun: klik `New
      //    Group` saat navigasi percakapan masih berjalan membuat modal
      //    ter-unmount (lihat catatan di kepala berkas).
      const newGroup = admin.getByRole('button', { name: 'New Group' });
      await expect(newGroup).toBeVisible({ timeout: 60000 });
      await newGroup.click();

      const groupNameInput = admin.getByPlaceholder(/Group Name/i);
      await expect(groupNameInput).toBeVisible({ timeout: 60000 });
      await groupNameInput.fill(groupName);

      await admin.getByPlaceholder(/Search users/i).fill(memberUsername);
      const candidate = admin.locator(`text=${memberUsername}`).first();
      await expect(candidate).toBeVisible({ timeout: 60000 });
      await candidate.click();
      await admin.getByRole('button', { name: /^Create Group$/ }).click();
      await expect(admin.locator('main').getByText(groupName).first()).toBeVisible({ timeout: 120000 });

      // 3. Pesan era pertama: kunci era awal harus benar-benar dipakai.
      await sendChatMessage(admin, era1);
      await expect(admin.locator(`text=${era1}`).first()).toBeVisible({ timeout: 60000 });

      // 4. Anggota menerima pesan era pertama → distribusi kunci awal bekerja.
      await openGroup(member, groupName);
      await expect(member.locator(`text=${era1}`).first()).toBeVisible({ timeout: 120000 });

      // 5. Rotasi epoch dari panel info grup (POST /:id/epoch + rotateGroupKey
      //    + distribusi era baru). Bukan request langsung: yang diuji adalah
      //    jalur klien yang menyimpan token baru sebelum metadata ditulis.
      const identityPlate = admin.locator('main').getByRole('button').filter({ hasText: groupName }).first();
      await expect(identityPlate).toBeVisible({ timeout: 30000 });
      await identityPlate.click();
      const rotate = admin.getByRole('button', { name: ROTATE_BUTTON });
      await expect(rotate).toBeVisible({ timeout: 30000 });
      await rotate.click();
      await expect(admin.locator(`text=${ROTATED_TOAST}`).first()).toBeVisible({ timeout: 180000 });

      // Panel info menutupi seluruh layar (`fixed inset-0`), jadi tutup dulu
      // lewat Escape (`useGlobalEscape(handleClose)` di GroupInfoPanel).
      await admin.keyboard.press('Escape');
      await expect(rotate).toBeHidden({ timeout: 30000 });

      // 6. Pesan era kedua: anggota harus bisa membaca era baru, dan admin
      //    tetap bisa membaca era lama setelah kunci berganti.
      await sendChatMessage(admin, era2);
      await expect(admin.locator(`text=${era1}`).first()).toBeVisible({ timeout: 30000 });
      await expect(member.locator(`text=${era2}`).first()).toBeVisible({ timeout: 180000 });

      // 7. Arsip era lama: setelah reload, pesan era pertama tetap terdekripsi
      //    (kunci era lama tersimpan, bukan hanya di memori).
      await member.reload();
      await openGroup(member, groupName);
      await expect(member.locator(`text=${era1}`).first()).toBeVisible({ timeout: 180000 });
      await expect(member.locator(`text=${era2}`).first()).toBeVisible({ timeout: 60000 });

      await admin.reload();
      await openGroup(admin, groupName);
      await expect(admin.locator(`text=${era1}`).first()).toBeVisible({ timeout: 180000 });
    } finally {
      await Promise.all([adminCtx.close(), memberCtx.close()]);
    }
  });
});
