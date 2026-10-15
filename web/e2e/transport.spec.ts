// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// Spesifikasi jalur real-time (WebTransport). Secara otomatis SKIP bila
// browser environment tidak menyediakan WebTransport (mis. chromium
// headless-shell di beberapa Linux build, atau CI tanpa QUIC).
//
// Jalankan di environment yang mendukung: browser desktop normal / CI
// dengan Chrome penuh. Butuh sidecar WebTransport + server + DB + Redis.
import { test, expect } from '@playwright/test';
import {
  registerUser,
  supportsWebTransport,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';


test.describe('Real-time Transport (WebTransport)', () => {
  test.setTimeout(300000);

  test('kirim pesan → terima di peer (latency end-to-end)', async ({ page, browser }) => {
    test.skip(!(await supportsWebTransport(page, { navigateToAppOrigin: true })), 'WebTransport tidak tersedia di environment ini');

    const usernameA = `wta_${Date.now()}`;
    const usernameB = `wtb_${Date.now()}`;
    await registerUser(page, 'Alice WT', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob WT', usernameB);

    // Alice mencari Bob & membuka chat
    await page.bringToFront();
    await openDirectChatWith(page, usernameB);

    const testMessage = `WT-latency-${Date.now()}`;
    const t0 = Date.now();
    await sendChatMessage(page, testMessage);

    // Optimistic bubble tampil cepat
    await expect(page.locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 5000 });
    const optimisticMs = Date.now() - t0;
    const tOptimistic = Date.now();
    console.log(`[perf] optimistic bubble: ${optimisticMs}ms`);

    // Peer menerima via WebTransport real-time
    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, testMessage);
    const transportLegMs = Date.now() - tOptimistic;
    console.log(`[perf] end-to-end receive: ${Date.now() - t0}ms (optimistic ${optimisticMs}ms, relay+decrypt ${transportLegMs}ms)`);

    // Regresi performa kasar pada jalur yang MEMANG milik protokol ini.
    //
    // Angka end-to-end mentah sudah dicoba lebih dulu (2026-10-15) dan tidak bisa
    // dipakai sebagai gate: ia didominasi jalur kripto LOKAL pengirim (Argon2 +
    // penyiapan sesi DR di worker, terukur 1,8–4,5 detik pada mesin yang sama) dan
    // oleh klik baris sidebar di klien peer. Akibatnya assertion yang sama
    // melaporkan 10,5–17,2 detik untuk kode yang tidak berubah — flaky, dan
    // sebaliknya regresi transport yang nyata bisa tersembunyi di balik anggaran
    // itu. Karena itu yang diasersikan adalah **kaki relay**: mulai dari saat bubble
    // optimistis muncul di pengirim sampai bubble peer terbaca — inilah bagian yang
    // dijalankan WebTransport, dengan anggaran 8 detik yang tetap ketat.
    expect(transportLegMs).toBeLessThan(8000);

    await contextB.close();
  });

  // CATATAN (2026-10-15) — kenapa test ini ditulis ulang.
  //
  // Versi sebelumnya selalu SKIP (chromium headless tanpa WebTransport), dan saat
  // akhirnya dijalankan sungguhan di Chrome ia gagal — bukan karena aplikasinya,
  // tapi karena test-nya salah di dua hal:
  //   1. assertion-nya mencari teks /message deleted|deleted message/, sedangkan
  //      terjemahan sebenarnya "This message was deleted" (en) — tidak pernah cocok;
  //   2. ia memanggil `sendMessage({type:'UNSEND'})` langsung dari store, sehingga
  //      melewati `handleDelete` yang justru melakukan penghapusan lokal di sisi
  //      pengirim. Yang diuji jadi jalur yang tidak pernah dipakai pengguna.
  // Sekarang test menempuh UI sungguhan (menu konteks → Delete → konfirmasi) dan
  // memeriksa perilaku yang benar-benar dijanjikan judulnya: pesan **hilang** di
  // kedua sisi. Tombstone (`data-testid="message-tombstone"`) hanya muncul di
  // jalur riwayat/DB (`applySilentMetadata`), jadi tidak diperiksa di sini.
  test('unsend: pengirim menghapus → pesan hilang di kedua sisi', async ({ page, browser }) => {
    test.skip(!(await supportsWebTransport(page, { navigateToAppOrigin: true })), 'WebTransport tidak tersedia di environment ini');

    const usernameA = `wuc_${Date.now()}`;
    const usernameB = `wud_${Date.now()}`;

    // `test.step` dipakai supaya laporan menunjukkan TAHAP yang menggantung, bukan
    // hanya "test timeout" — pelajaran dari percobaan pertama menjalankan test ini.
    let contextB: Awaited<ReturnType<typeof browser.newContext>> | undefined;

    await test.step('daftarkan dua pengguna', async () => {
      await registerUser(page, 'Alice U', usernameA);
      contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await registerUser(pageB, 'Bob U', usernameB);
    });

    const contextBReady = contextB!;
    const pageB = contextBReady.pages()[0]!;

    const testMessage = `WT-unsend-${Date.now()}`;

    // Teks pesan muncul DUA kali di layar: bubble di panel chat dan preview di
    // daftar percakapan (sidebar). Semua pencarian karena itu di-scope ke `main`
    // supaya yang diperiksa bubble-nya — versi tanpa scope pernah memilih preview
    // sidebar yang tertutup elemen lain dan menggantung sampai timeout.
    const inChat = (target: typeof page) => target.locator('main');

    await test.step('kirim pesan dan pastikan peer menerimanya', async () => {
      await page.bringToFront();
      await openDirectChatWith(page, usernameB);
      await sendChatMessage(page, testMessage);
      await expect(inChat(page).locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 10000 });
      await pageB.bringToFront();
      await expect(inChat(pageB).locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 15000 });
    });

    await test.step('pengirim menghapus lewat UI (menu konteks → Delete → Confirm)', async () => {
      await page.bringToFront();
      await inChat(page).locator(`text=${testMessage}`).first().click({ button: 'right', timeout: 15000 });
      const deleteItem = page.getByRole('button', { name: 'Delete', exact: true }).last();
      await expect(deleteItem).toBeVisible({ timeout: 10000 });
      await deleteItem.click({ timeout: 15000 });
      const confirmButton = page.getByRole('button', { name: 'Confirm', exact: true }).last();
      await expect(confirmButton).toBeVisible({ timeout: 10000 });
      await confirmButton.click({ timeout: 15000 });
    });

    await test.step('pesan hilang di pengirim', async () => {
      await expect(inChat(page).locator(`text=${testMessage}`)).toHaveCount(0, { timeout: 15000 });
    });

    await test.step('pesan hilang di peer (sinyal UNSEND lewat WebTransport)', async () => {
      await pageB.bringToFront();
      await expect(inChat(pageB).locator(`text=${testMessage}`)).toHaveCount(0, { timeout: 20000 });
    });

    await contextBReady.close();
  });
});
