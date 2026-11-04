import { test, expect } from '@playwright/test';
// [docs/30 WS-G(7)] Rantai onboarding tinggal di satu tempat
// (`helpers/registration.ts`) — sebelumnya disalin di sini dan mulai menyimpang.
import { registerUser } from './helpers/registration';

test.describe('Authentication & Onboarding', () => {
  test.setTimeout(180000);

  test('Register with Proof of Work', async ({ page }) => {
    await page.route('**/api/auth/pow/challenge', async route => {
      await route.fulfill({ status: 200, json: { challenge: 'mock_challenge', difficulty: 1 } });
    });
    await page.route('**/api/auth/pow/verify', async route => {
      await route.fulfill({
        status: 201,
        json: { message: 'Registered successfully', user: { id: 'mock_id', username: 'testuser_pow' }, tokens: { access: 'token', refresh: 'token' } }
      });
    });
    await registerUser(page, 'Test User', 'testuser_pow');
  });

  // [E2E FLAKE 2026-11-04] Tes ini pernah gagal di CI (`e2e-chrome`, run
  // 41820476193) dengan `locator.fill: Test timeout of 180000ms exceeded` saat
  // menunggu kolom Username, TANPA petunjuk apa pun di artifact.
  //
  // Sebabnya pola, bukan kebetulan: logout dipanggil `.catch(() => {})` di dalam
  // `page.evaluate`, dan `useAuthStore.logout()` sendiri juga menelan error
  // `api('/api/auth/logout')` (`.catch(() => {})`). Jadi bila request logout
  // gagal, cookie refresh HttpOnly (`rt`) tetap hidup, sementara sisi klien sudah
  // mengosongkan localStorage/IndexedDB. Halaman baru lalu menjalankan bootstrap
  // sesi dari cookie itu, dan efek di `pages/Login.tsx`
  // (`if (accessToken && user && hasRestoredKeys) navigate('/chat')`) melempar
  // `/login` ke `/chat` — form login tidak pernah dirender, tes menggantung
  // sampai timeout, dan pesan galatnya berbunyi seolah selector yang salah.
  //
  // Sekarang: logout dicoba ulang bila perlu, keberhasilannya DIBUKTIKAN dari
  // cookie context (bukan dari promise yang menelan error), lalu halaman login
  // harus benar-benar berada di `/login` sebelum selektor apa pun dipakai —
  // gagal dalam hitungan detik dengan sebab yang tertulis, bukan 180 detik
  // tanpa bukti.
  test('Login with correct password', async ({ page }) => {
    // Registrasi di runner CI bisa memakan >90 s dari budget 180 s; beri ruang
    // agar kegagalan yang tersisa benar-benar soal login, bukan budget habis.
    test.setTimeout(240000);

    const username = `loginuser_${Date.now()}`;
    const hasRefreshCookie = async () =>
      (await page.context().cookies()).some((c) => c.name === 'rt');

    // Halaman login dibuat di awal supaya listener konsol/`pageerror`-nya sudah
    // terpasang sebelum navigasi pertama (kalau dibuat di dalam step, error yang
    // terjadi saat bootstrap halaman tidak tercatat).
    const loginPage = await page.context().newPage();
    loginPage.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[auth.spec][login page console] ${msg.text()}`);
    });
    loginPage.on('pageerror', (err) => console.log(`[auth.spec][login page pageerror] ${err.message}`));

    await test.step('registrasi akun uji', async () => {
      await registerUser(page, 'Test Login User', username);
    });

    await test.step('logout benar-benar memutus sesi server', async () => {
      const attempts: Array<{ attempt: number; ok: boolean; error?: string }> = [];

      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await page.evaluate(async () => {
          try {
            // @ts-ignore — path absolut Vite dev server (runtime-only)
            const { useAuthStore } = await import('/src/store/auth.ts');
            await useAuthStore.getState().logout();
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        });
        attempts.push({ attempt, ...result });

        // Bukti yang dipakai adalah cookie, bukan hasil promise: `logout()`
        // menelan kegagalan `api()` di dalamnya, jadi `ok: true` tidak berarti
        // sesi benar-benar dicabut di server.
        const stillLoggedIn = await hasRefreshCookie();
        console.log(
          `[auth.spec] logout percobaan ${attempt}: ${stillLoggedIn ? 'cookie rt MASIH ADA' : 'cookie rt hilang'}` +
            (result.ok ? '' : ` (store melempar: ${result.error})`)
        );
        if (!stillLoggedIn) break;
        await page.waitForTimeout(1000);
      }

      const refreshCookie = (await page.context().cookies()).find((c) => c.name === 'rt');
      expect(
        refreshCookie,
        'logout tidak memutus sesi di server (cookie refresh HttpOnly `rt` masih ada setelah 2 percobaan). ' +
          'Halaman /login akan langsung dialihkan ke /chat dan form login tidak pernah dirender. ' +
          `Percobaan: ${JSON.stringify(attempts)}`
      ).toBeUndefined();
    });

    await test.step('kosongkan state lokal (localStorage/sessionStorage/IndexedDB)', async () => {
      const localState = await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach((c) => {
          const name = c.split('=')[0]?.trim();
          if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`;
        });
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
        return {
          localStorageKeys: localStorage.length,
          sessionStorageKeys: sessionStorage.length,
          databases: dbs.map((d) => d.name ?? '(tanpa nama)'),
        };
      });
      console.log(`[auth.spec] state lokal dibersihkan: ${JSON.stringify(localState)}`);
      expect(localState.localStorageKeys, 'localStorage harus kosong sebelum login ulang').toBe(0);
      expect(localState.sessionStorageKeys, 'sessionStorage harus kosong sebelum login ulang').toBe(0);
    });

    // 3. Halaman BARU di context yang sama — bukan `page.reload()`.
    // Logout memicu navigasi keras; reload yang berbarengan dengannya bisa
    // dijawab `net::ERR_ABORTED`. Halaman baru tetap berbagi IndexedDB dan
    // localStorage yang sudah dibersihkan, jadi bukti "state lokal hilang"
    // tidak berubah, tanpa berebut dengan navigasi yang sedang berjalan.
    await test.step('halaman /login merender form (gagal cepat bila sesi masih hidup)', async () => {
      await loginPage.goto('/login');

      // Pemeriksaan URL lebih dulu: bila sesi ternyata masih hidup, `/login`
      // dialihkan ke `/chat` dan menunggu selector hanya menghasilkan timeout
      // tanpa sebab. Ini yang membuat kegagalan berikutnya bisa didiagnosis
      // dari satu baris pesan.
      await expect(
        loginPage,
        '/login tidak mempertahankan URL-nya — kemungkinan besar sesi belum benar-benar logout sehingga dialihkan ke /chat'
      ).toHaveURL(/\/login(\?|$)/, { timeout: 20000 });
      await expect(loginPage.getByRole('textbox', { name: /Username/i })).toBeVisible({ timeout: 20000 });
    });

    await test.step('login dengan password yang benar', async () => {
      await loginPage.getByRole('textbox', { name: /Username/i }).fill(username);
      await loginPage.getByRole('textbox', { name: /Password/i }).fill('StrongPass123!');
      await loginPage.getByRole('button', { name: /Login/i }).click();
    });

    // 5. Asersi Login berhasil: modal "New Device Detected" muncul (bukti sesi aktif
    //    tapi kunci lokal terhapus — recovery flow), modal bisa ditutup dan TIDAK reopen.
    await test.step('modal New Device Detected muncul dan bisa ditutup', async () => {
      await expect(loginPage.getByRole('heading', { name: /New Device Detected/i })).toBeVisible({ timeout: 30000 });
      const closeNewDeviceBtn = loginPage.getByRole('button', { name: /Close modal/i });
      await closeNewDeviceBtn.click();
      await expect(loginPage.getByRole('heading', { name: /New Device Detected/i })).toBeHidden({ timeout: 10000 });
      // Tidak boleh ada error server di form
      await expect(loginPage.getByText('Internal server error')).toBeHidden();
    });

    await test.step('lewati modal System Init / Quick Tour', async () => {
      const skipSystemInitBtn = loginPage.getByRole('button', { name: /Skip for now/i });
      try {
        await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 5000 });
        await skipSystemInitBtn.click();
      } catch (e) {
        console.log('[auth.spec] modal System Init tidak muncul (boleh dilewati)');
      }

      const closeTourBtn = loginPage.getByRole('button', { name: /Close modal/i });
      try {
        await closeTourBtn.waitFor({ state: 'visible', timeout: 5000 });
        await closeTourBtn.click();
      } catch (e) {
        console.log('[auth.spec] modal Quick Tour tidak muncul (boleh dilewati)');
      }
    });
  });

  test('Fail login with incorrect password', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('textbox', { name: /Username/i }).fill('nonexistent_user');
    await page.getByRole('textbox', { name: /Password/i }).fill('WrongPassword123!');
    await page.getByRole('button', { name: /Login/i }).click();

    await expect(page.getByText('Invalid credentials')).toBeVisible({ timeout: 15000 });
  });
});
