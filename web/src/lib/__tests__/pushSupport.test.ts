// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUG 2026-11-12] Di build dev tidak ada `sw.js`, dan menyentuh
 * `navigator.serviceWorker` MEMBEKUKAN main thread WebKit — `logout()` dan
 * `/settings` menggantung sampai smoke nightly mati (run 43015446345).
 * Dua test ini mengunci perbaikannya: gerbangnya mati di build non-produksi,
 * dan tidak ada jalur yang kembali memakai cek mentah `'PushManager' in window`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPushSupported } from '../pushSupport';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(path.join(here, relative), 'utf8');

describe('pushSupport', () => {
  it('build dev/test tidak pernah membuka jalur push', () => {
    expect(import.meta.env.PROD).toBe(false);
    expect(isPushSupported()).toBe(false);
  });

  it('logout dan halaman settings memakai gerbang yang sama, bukan cek mentah', () => {
    const auth = read('../../store/auth.ts');
    const hook = read('../../hooks/usePushNotifications.ts');

    // Cek mentah lama menghadap `navigator.serviceWorker` langsung; itulah yang
    // membekukan WebKit sebelum batas waktu mana pun sempat berbunyi.
    expect(auth).not.toMatch(/'PushManager' in window/);
    expect(hook).not.toMatch(/'PushManager' in window/);

    // `logout()` dan `emergencyLogout()` sama-sama harus lewat gerbang.
    expect((auth.match(/isPushSupported\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(hook).toMatch(/isPushSupported\(\)/);
  });

  it('registrasi SW dan wipe hanya menyentuh service worker di build produksi', () => {
    const registration = read('../serviceWorkerRegistration.ts');
    const nuke = read('../nukeProtocol.ts');

    // Dev: Vite menjawab /sw.js dengan index.html → SecurityError; WebKit beku.
    expect(registration).toMatch(/if \(!import\.meta\.env\.PROD\) return;/);
    // Wipe dev tidak punya SW untuk dicabut, jadi jangan menyentuhnya sama sekali.
    expect(nuke).toMatch(/import\.meta\.env\.PROD && 'serviceWorker' in navigator/);
  });
});
