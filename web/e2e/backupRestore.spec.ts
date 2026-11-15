// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §7.5] Backup/restore `.nyxbak` lewat UI nyata.
//
// Drill mingguan (`drills.yml`) sudah menguji skrip restore di atas dump
// Postgres, tetapi tidak ada satu pun spec Playwright yang menyentuh alur
// pengguna. Yang dibuktikan di sini:
//   1. Settings → "Buat Backup" menghasilkan berkas yang benar-benar terunduh,
//      magic `NYXB`, dan laporan jumlah catatan (bukan toast palsu);
//   2. berkas itu bisa dibuka kembali lewat Settings → "Restore" dengan
//      recovery phrase yang SAMA (phrase dibaca dari modal onboarding, bukan
//      dikarang), dan laporan "brankas dipulihkan" muncul;
//   3. setelah restore aplikasi kembali ke keadaan yang bisa dipakai (reload
//      dijalankan komponen) — bukan layar rusak.
//
// Batas yang jujur: spec ini tidak membandingkan isi pesan sebelum/sesudah
// restore (itu sudah dikunci unit test `backupRestore.test.ts` dengan arsip
// sungguhan). Yang tidak bisa diuji unit — wiring UI, unduhan, KDF dari phrase
// pengguna, dan reload — ada di sini.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { registerUserWithPhrase } from './helpers/registration';

test.describe('Backup & restore .nyxbak', () => {
  test.setTimeout(600000);

  test('ekspor dari Settings lalu restore dengan phrase yang sama', async ({ page }) => {
    const username = `backup_${Date.now()}`;
    const phrase = await registerUserWithPhrase(page, 'Backup User', username);
    expect(phrase.split(/\s+/).length, 'recovery phrase harus 12 kata').toBeGreaterThanOrEqual(12);

    // Navigasi lewat sidebar (SPA) supaya bootstrap/transport tidak diulang dari
    // nol; `goto('/settings')` langsung sempat mendarat di shell "Loading" dan
    // konten Settings belum ter-mount saat testid dicari (run pertama).
    await page.getByRole('link', { name: /settings/i }).first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 60000 });
    const exportButton = page.getByTestId('settings-export-backup');
    await expect(exportButton).toBeVisible({ timeout: 90000 });
    await exportButton.click();

    const createButton = page.getByTestId('backup-export-create');
    await expect(createButton).toBeVisible({ timeout: 15000 });

    // Argon2id 128 MB + frame seluruh vault: beri ruang, tetapi tetap dibatasi.
    const downloadPromise = page.waitForEvent('download', { timeout: 240000 });
    await createButton.click();
    const download = await downloadPromise;
    const filePath = test.info().outputPath(`nyx-backup-${Date.now()}.nyxbak`);
    await download.saveAs(filePath);

    const bytes = await readFile(filePath);
    expect(bytes.subarray(0, 4).toString('latin1'), 'magic arsip').toBe('NYXB');
    expect(bytes.length, 'arsip harus melebihi header 32 byte').toBeGreaterThan(32);

    // Laporan hasil membuktikan arsip dibangun dan diunduh, bukan hanya toast.
    await expect(page.getByTestId('backup-export-result')).toBeVisible({ timeout: 60000 });

    // Tutup modal ekspor (tombol Close setelah selesai).
    await page.getByRole('button', { name: /close|tutup/i }).last().click();
    await expect(createButton).toBeHidden({ timeout: 15000 });

    // Restore lewat pintu masuk yang sama (Settings), dengan berkas + phrase.
    await page.getByTestId('settings-restore-backup').click();
    await page.getByTestId('nyxbak-file-input').setInputFiles(filePath);
    await page.getByTestId('backup-restore-phrase').fill(phrase);
    await page.getByTestId('backup-restore-submit').click();

    // KDF 128 MB di worker + tulis ulang tabel: jangan memakai timeout default.
    await expect(page.getByText(/dipulihkan|restored/i).first()).toBeVisible({ timeout: 300000 });

    // Komponen melakukan reload ~1,5 dtk setelah sukses; app harus mendarat di
    // route yang bisa dipakai (login/chat), bukan halaman kosong/error.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 60000 })
      .toMatch(/^\/(chat|login|register)?$/);
  });
});
