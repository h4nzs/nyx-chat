// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.4] Fault injection rotasi epoch grup.
//
// `groupEra.spec.ts` membuktikan jalur normal: pesan era lama tetap terbaca
// setelah epoch berputar. Spec ini menguji jalur yang GAGAL di tengah jalan,
// yang tidak bisa muncul di tes bahagia:
//
//   1. koneksi putus saat rotasi diklik (`context.setOffline(true)`) —
//      rotasi harus gagal dengan pesan jelas, dan grup harus tetap bisa
//      dipakai setelah jaringan kembali;
//   2. halaman di-reload saat rotasi berjalan — grup tidak boleh berakhir
//      setengah berputar (tak bisa kirim/baca lagi);
//   3. mailbox anggota ditahan saat distribusi era baru (`POST
//      /mailbox/pull` digantung) — pesan era baru tetap terbaca lewat jalur
//      cadangan, dan mailbox yang dilepas tidak boleh menggandakan pesan.
//
// Ketiga skenario memakai satu grup yang sama supaya biaya registrasi + kripto
// hanya dibayar sekali (suite chromium sudah mendekati batas job 40 menit).
//
// Jalankan terhadap stack dev hidup:
//   NYX_E2E_SKIP_RESET=1 npx playwright test e2e/groupFaults.spec.ts --project=chromium
import { test, expect, Browser } from '@playwright/test';
import { registerUser, sendChatMessage } from './helpers/registration';

const ROTATE_BUTTON = /Rotate Encryption Keys Now/i;
const ROTATED_TOAST = /Encryption keys rotated successfully/i;
const ROTATE_FAILED_TOAST = /Key rotation failed/i;

async function openGroup(page: import('@playwright/test').Page, groupName: string) {
  const inList = page.locator(`text=${groupName}`).first();
  await expect(inList).toBeVisible({ timeout: 120000 });
  // Nama grup di sidebar adalah <p> di dalam baris yang menangani klik; hit-test
  // Playwright jatuh ke div induk itu ("intercepts pointer events"), jadi klik
  // teksnya dipaksa — event tetap sampai ke handler baris lewat bubbling.
  await inList.click({ force: true });
  await expect(page.locator('main').getByText(groupName).first()).toBeVisible({ timeout: 30000 });
}

/** Buka panel info grup dan kembalikan tombol rotasi yang sudah terlihat. */
async function openRotateButton(page: import('@playwright/test').Page, groupName: string) {
  const identityPlate = page.locator('main').getByRole('button').filter({ hasText: groupName }).first();
  await expect(identityPlate).toBeVisible({ timeout: 30000 });
  await identityPlate.click();
  const rotate = page.getByRole('button', { name: ROTATE_BUTTON });
  await expect(rotate).toBeVisible({ timeout: 30000 });
  return rotate;
}

/**
 * Composer grup baru bisa dipakai setelah kunci era siap. Setelah offline atau
 * reload, `sendChatMessage` sendiri hanya menunggu 10 dtk — terlalu pendek
 * untuk reconnect socket + dekripsi metadata; kegagalan run sebelumnya justru
 * muncul di sini ("element is not visible" pada textarea). Tunggu eksplisit
 * dengan anggaran yang sama seperti langkah kripto lainnya.
 */
async function waitForComposer(page: import('@playwright/test').Page) {
  const composer = page.locator('textarea[placeholder*="essage"], input[placeholder*="essage"]').first();
  await expect(composer).toBeVisible({ timeout: 120000 });
  await expect(composer).toBeEnabled({ timeout: 120000 });
}

test.describe('Group era (fault injection)', () => {
  test.setTimeout(900000);

  test('rotasi gagal saat jaringan putus, reload di tengah rotasi, dan mailbox ditahan', async ({ browser }: { browser: Browser }) => {
    const run = Date.now();
    const adminUsername = `fault_admin_${run}`;
    const memberUsername = `fault_member_${run}`;
    const groupName = `Fault Group ${run}`;
    const era1 = `fault-era1-${run}`;
    const afterOffline = `fault-offline-${run}`;
    const afterReload = `fault-reload-${run}`;
    const afterKeyDelay = `fault-keydelay-${run}`;

    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const member = await memberCtx.newPage();
    // `playwright.config.ts` tidak menetapkan `actionTimeout`.
    admin.setDefaultTimeout(60000);
    member.setDefaultTimeout(60000);
    // Jalur koneksi realtime tidak terlihat dari DOM: composer hanya `disabled`
    // tanpa pesan. Hanya baris transport/auth yang dicatat — yang membedakan
    // "socket ditolak" dari "socket tidak pernah dicoba" saat skenario gagal
    // (bug 2026-11-15: `connectSocket()` tidak dipanggil sesudah reload).
    admin.on('console', (m) => {
      const text = m.text();
      if (/\[Transport\]|Refresh attempt|Bootstrap failed|GROUP_AUTH_REQUIRED/.test(text)) {
        console.log(`[admin console:${m.type()}] ${text.slice(0, 300)}`);
      }
    });

    try {
      // Persiapan: dua akun, satu grup, satu pesan yang sudah terbaca anggota.
      await registerUser(admin, 'Fault Admin', adminUsername);
      await registerUser(member, 'Fault Member', memberUsername);

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

      await sendChatMessage(admin, era1);
      await openGroup(member, groupName);
      await expect(member.locator(`text=${era1}`).first()).toBeVisible({ timeout: 120000 });

      // --- Skenario 1: jaringan putus tepat saat rotasi diklik. -------------
      // `setOffline` mematikan HTTP dan socket sekaligus, jadi `GET /:id/epoch`
      // gagal dan rotasi berhenti sebelum token era baru ditulis. Yang diuji:
      // kegagalan itu terlihat (bukan menggantung), dan grup tidak rusak.
      const rotateOffline = await openRotateButton(admin, groupName);
      await adminCtx.setOffline(true);
      await rotateOffline.click();
      await expect(admin.locator(`text=${ROTATE_FAILED_TOAST}`).first()).toBeVisible({ timeout: 120000 });
      await adminCtx.setOffline(false);
      await admin.waitForFunction(() => navigator.onLine, undefined, { timeout: 60000 });
      await admin.keyboard.press('Escape');
      await expect(rotateOffline).toBeHidden({ timeout: 30000 });

      // Grup masih memakai era lama: pesan baru harus tetap sampai ke anggota.
      await waitForComposer(admin);
      await sendChatMessage(admin, afterOffline);
      await expect(member.locator(`text=${afterOffline}`).first()).toBeVisible({ timeout: 180000 });

      // --- Skenario 2: reload di tengah rotasi. ----------------------------
      // Rotasi diklik lalu halaman langsung dimuat ulang, sehingga klien
      // kehilangan state di memori. Server boleh sudah menaikkan epoch; yang
      // tidak boleh terjadi adalah grup berakhir setengah berputar — pesan
      // berikutnya harus tetap terkirim dan terbaca.
      const rotateReload = await openRotateButton(admin, groupName);
      await rotateReload.click();
      await admin.reload();
      await openGroup(admin, groupName);
      // Arsip era lama harus tetap terbaca setelah reload.
      await expect(admin.locator(`text=${era1}`).first()).toBeVisible({ timeout: 180000 });

      await waitForComposer(admin);
      await sendChatMessage(admin, afterReload);
      await expect(member.locator(`text=${afterReload}`).first()).toBeVisible({ timeout: 180000 });

      // --- Skenario 3: mailbox ditahan saat distribusi era baru. ------------
      // Rotasi mengirim envelope era baru lewat mailbox (`postGroupKeyEnvelopes`
      // di `rotateGroupKey`), tetapi target yang mailbox-nya belum terkonfirmasi
      // juga dilayani jalur cadangan `group:fulfilled_key`→`session:new_key`.
      // Di grup ini anggota memang dapat jalur cadangan itu: menahan
      // `mailbox/pull` TIDAK membuat pesan hilang (run 10 membuktikannya —
      // pesan tetap terbaca), dan itu perilaku yang benar: distribusi kunci
      // redundan, mailbox bukan satu-satunya jalur. Yang diuji di sini karena
      // itu: (a) lever-nya hidup (pull benar-benar tertahan), (b) pesan era
      // baru tetap terbaca tanpa reload, (c) mailbox yang dilepas tidak
      // menggandakan pesan (replay era yang sama harus idempoten).
      let heldPulls = 0;
      let releasePull!: () => void;
      const pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
      await member.route('**/api/groups/*/mailbox/pull', async (route) => {
        heldPulls += 1;
        await pullGate;
        await route.continue();
      });

      const rotateDelay = await openRotateButton(admin, groupName);
      await rotateDelay.click();
      await expect(admin.locator(`text=${ROTATED_TOAST}`).first()).toBeVisible({ timeout: 180000 });
      await admin.keyboard.press('Escape');
      await expect(rotateDelay).toBeHidden({ timeout: 30000 });
      await waitForComposer(admin);
      await sendChatMessage(admin, afterKeyDelay);

      // Bukti lever-nya hidup: anggota memang mencoba pull dan tertahan.
      await expect.poll(() => heldPulls, { timeout: 60000 }).toBeGreaterThan(0);
      // Kunci tetap sampai lewat jalur cadangan, jadi pesan harus terbaca.
      await expect(member.locator('main').getByText(afterKeyDelay).first()).toBeVisible({ timeout: 120000 });
      releasePull();
      // Mailbox yang dilepas tidak boleh menggandakan pesan (era yang sama).
      await member.waitForTimeout(5000);
      await expect(member.locator('main').getByText(afterKeyDelay)).toHaveCount(1);
      await member.unroute('**/api/groups/*/mailbox/pull');

      // --- Pemulihan: rotasi berikutnya (jaringan sehat) harus berhasil. ----
      // Kalau reload meninggalkan state setengah berputar, klik ini gagal dan
      // pesan era baru tidak akan terbaca anggota.
      const rotateRecover = await openRotateButton(admin, groupName);
      await rotateRecover.click();
      await expect(admin.locator(`text=${ROTATED_TOAST}`).first()).toBeVisible({ timeout: 180000 });
    } finally {
      await Promise.all([adminCtx.close(), memberCtx.close()]);
    }
  });
});
