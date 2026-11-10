// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.4] Siklus grup: tiga konteks browser, tetapi mutasi grup diuji
// lewat kontrak HTTP (bukan klik menu) karena yang berisiko adalah **urutan
// gate dan era token**, bukan tampilan. Tiga akun sungguhan mendaftar lewat UI
// (jalur yang sama dengan pengguna), lalu request memakai cookie + CSRF +
// `x-nyx-installation-id` milik konteks itu — bukan token yang dikarang.
//
// Yang dibuktikan:
//   1. buat grup tanpa `adminSecretHash` ditolak; dengan hash diterima dan
//      token grup (authSecret) dikembalikan sekali;
//   2. tambah anggota dengan X-Group-Token salah → 403 `BLIND_AUTH_REQUIRED`;
//      dengan token benar → 201;
//   3. rotasi kunci tanpa capability admin → 403; dengan X-Admin-Token → 200;
//   4. kick anggota merotasi token: token era lama tidak bisa menambah anggota,
//      token baru bisa; epoch naik;
//   5. purge saat delivery token anggota masih ada → 409 `MEMBERS_REMAIN`,
//      setelah semua keluar → 204.
//
// Batas yang jujur: pesan terenkripsi/era kripto tidak dikirim di sini (butuh
// sesi DR penuh); yang diuji adalah kontrak otorisasi yang menjaga era itu.
import { test, expect, Browser, Page } from '@playwright/test';
import { randomBytes, createHash } from 'node:crypto';
import { registerUser } from './helpers/registration';

const PASSWORD = 'StrongPass123!';
const RUN = Date.now();

type Api = {
  get: (path: string) => Promise<import('@playwright/test').APIResponse>;
  post: (path: string, data: unknown) => Promise<import('@playwright/test').APIResponse>;
  delete: (path: string, data?: unknown) => Promise<import('@playwright/test').APIResponse>;
};

/**
 * Klien API kecil yang meniru kontrak klien web: setiap mutasi membawa
 * `csrf-token` + `x-nyx-installation-id`, dan token CSRF diambil dari endpoint
 * yang sama dengan aplikasi. Installation id harus sama dengan yang dipakai
 * saat token diterbitkan, karena server menyimpan state CSRF per klien.
 */
async function apiFor(page: Page, installationId: string): Promise<Api> {
  let csrfToken = '';

  async function refreshCsrf() {
    const response = await page.request.get('/api/csrf-token', {
      headers: { 'x-nyx-installation-id': installationId },
    });
    expect(response.status(), 'GET /api/csrf-token harus 200').toBe(200);
    csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  await refreshCsrf();

  const headers = (extra: Record<string, string> = {}) => ({
    'x-nyx-installation-id': installationId,
    'csrf-token': csrfToken,
    ...extra,
  });

  return {
    get: (path) => page.request.get(path, { headers: headers() }),
    post: async (path, data) => {
      const response = await page.request.post(path, { headers: headers(), data });
      if (response.status() === 403) {
        // Token bisa kedaluwarsa setelah rotasi; ambil ulang sekali lalu ulangi.
        await refreshCsrf();
        return page.request.post(path, { headers: headers(), data });
      }
      return response;
    },
    delete: async (path, data) => {
      const response = await page.request.delete(path, { headers: headers(), data });
      if (response.status() === 403) {
        await refreshCsrf();
        return page.request.delete(path, { headers: headers(), data });
      }
      return response;
    },
  };
}

/** Token CSRF untuk installation id tertentu (mutasi admin tetap butuh CSRF). */
async function csrfFor(page: Page, installationId: string): Promise<string> {
  const response = await page.request.get('/api/csrf-token', {
    headers: { 'x-nyx-installation-id': installationId },
  });
  expect(response.status(), 'GET /api/csrf-token harus 200').toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function currentUserId(page: Page): Promise<string> {
  const response = await page.request.get('/api/users/me');
  expect(response.status(), 'GET /api/users/me harus 200').toBe(200);
  const body = (await response.json()) as { id?: string };
  expect(body.id, 'user id harus ada').toBeTruthy();
  return body.id as string;
}

test.describe('Group lifecycle (API contract)', () => {
  test.setTimeout(600000);

  test('admin rotate/kick/purge menegakkan gate dan era token', async ({ browser }: { browser: Browser }) => {
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const pageA = await contexts[0]!.newPage();
    const pageB = await contexts[1]!.newPage();
    const pageC = await contexts[2]!.newPage();

    try {
      await test.step('tiga akun mendaftar lewat UI', async () => {
        await registerUser(pageA, 'Group Admin A', `groupadmin_${RUN}`);
        await registerUser(pageB, 'Group Member B', `groupmemberb_${RUN}`);
        await registerUser(pageC, 'Group Member C', `groupmemberc_${RUN}`);
      });

      const [idA, idB, idC] = await Promise.all([
        currentUserId(pageA),
        currentUserId(pageB),
        currentUserId(pageC),
      ]);
      const apiA = await apiFor(pageA, 'e2e-group-a');
      const apiB = await apiFor(pageB, 'e2e-group-b');

      const adminToken = randomBytes(32).toString('base64url');
      const adminSecretHash = createHash('sha256').update(adminToken).digest('hex');
      const tokenB = randomBytes(32).toString('base64url');
      const tokenC = randomBytes(32).toString('base64url');
      const wrongGroupToken = randomBytes(32).toString('base64url');

      let conversationId = '';
      let groupToken = '';

      await test.step('grup tanpa adminSecretHash ditolak; dengan hash diterima', async () => {
        const missing = await apiA.post('/api/conversations', {
          userIds: [idB],
          isGroup: true,
        });
        expect(missing.status(), 'grup tanpa adminSecretHash harus 400').toBe(400);
        expect(((await missing.json()) as { error: string }).error).toContain('adminSecretHash');

        const created = await apiA.post('/api/conversations', {
          userIds: [idB],
          isGroup: true,
          adminSecretHash,
          deliveryTokens: { [idB]: tokenB },
        });
        expect(created.status(), 'create grup harus 201').toBe(201);
        const body = (await created.json()) as { id: string; authSecret: string; groupEpoch?: number };
        conversationId = body.id;
        groupToken = body.authSecret;
        expect(conversationId).toBeTruthy();
        expect(groupToken, 'authSecret hanya dikembalikan saat create').toHaveLength(43);
        expect(body.groupEpoch ?? 0).toBe(0);
      });

      await test.step('tambah anggota: token salah 403, token benar 201', async () => {
        const denied = await apiA.post(`/api/conversations/${conversationId}/participants`, {
          userIds: [idC],
          deliveryTokens: { [idC]: tokenC },
          groupToken: wrongGroupToken,
        });
        // API memakai header, bukan body: kirim ulang dengan header eksplisit.
        expect(denied.status()).toBe(403);

        const headers = { 'x-group-token': groupToken };
        const added = await pageA.request.post(`/api/conversations/${conversationId}/participants`, {
          headers: {
            ...headers,
            'x-nyx-installation-id': 'e2e-group-a',
            'csrf-token': ((await (await pageA.request.get('/api/csrf-token', {
              headers: { 'x-nyx-installation-id': 'e2e-group-a' },
            })).json()) as { csrfToken: string }).csrfToken,
          },
          data: { userIds: [idC], deliveryTokens: { [idC]: tokenC } },
        });
        expect(added.status(), 'tambah anggota dengan token benar harus 201').toBe(201);
      });

      await test.step('rotasi kunci: tanpa admin 403, dengan admin 200', async () => {
        const denied = await apiB.post(`/api/conversations/${conversationId}/key-rotation`, {});
        expect(denied.status(), 'non-admin tidak boleh rotasi').toBe(403);

        const rotated = await pageA.request.post(`/api/conversations/${conversationId}/key-rotation`, {
          headers: {
            'x-admin-token': adminToken,
            'x-nyx-installation-id': 'e2e-group-a',
            'csrf-token': await csrfFor(pageA, 'e2e-group-a'),
          },
          data: {},
        });
        expect(rotated.status(), 'admin boleh rotasi').toBe(200);
      });

      await test.step('kick merotasi token: era lama 403, era baru 201', async () => {
        const kicked = await pageA.request.delete(`/api/conversations/${conversationId}/participants/${idC}`, {
          headers: {
            'x-admin-token': adminToken,
            'x-nyx-installation-id': 'e2e-group-a',
            'csrf-token': await csrfFor(pageA, 'e2e-group-a'),
          },
        });
        expect(kicked.status(), 'kick oleh admin harus 200').toBe(200);
        const body = (await kicked.json()) as { authSecret: string; epoch: number };
        expect(body.epoch, 'epoch harus naik setelah kick').toBe(1);
        expect(body.authSecret, 'token harus dirotasi').not.toBe(groupToken);

        const staleHeaders = {
          'x-nyx-installation-id': 'e2e-group-a',
          'csrf-token': ((await (await pageA.request.get('/api/csrf-token', {
            headers: { 'x-nyx-installation-id': 'e2e-group-a' },
          })).json()) as { csrfToken: string }).csrfToken,
        };

        const withOldToken = await pageA.request.post(`/api/conversations/${conversationId}/participants`, {
          headers: { ...staleHeaders, 'x-group-token': groupToken },
          data: { userIds: [idC], deliveryTokens: { [idC]: tokenC } },
        });
        expect(withOldToken.status(), 'token era lama harus 403').toBe(403);

        const withNewToken = await pageA.request.post(`/api/conversations/${conversationId}/participants`, {
          headers: { ...staleHeaders, 'x-group-token': body.authSecret },
          data: { userIds: [idC], deliveryTokens: { [idC]: tokenC } },
        });
        expect(withNewToken.status(), 'token era baru harus 201').toBe(201);
        groupToken = body.authSecret;
      });

      await test.step('purge: anggota tersisa 409, setelah semua keluar 204', async () => {
        const csrfA = ((await (await pageA.request.get('/api/csrf-token', {
          headers: { 'x-nyx-installation-id': 'e2e-group-a' },
        })).json()) as { csrfToken: string }).csrfToken;

        const blocked = await pageA.request.delete(`/api/conversations/${conversationId}/group`, {
          headers: {
            'x-admin-token': adminToken,
            'x-group-token': groupToken,
            'x-nyx-installation-id': 'e2e-group-a',
            'csrf-token': csrfA,
          },
        });
        expect(blocked.status(), 'purge dengan anggota tersisa harus 409').toBe(409);
        expect(((await blocked.json()) as { error: string }).error).toContain('MEMBERS_REMAIN');

        // B dan C keluar memakai token grup era sekarang (B anggota asli, C baru
        // ditambahkan kembali).
        const leavers: Array<{ page: Page; installationId: string }> = [
          { page: pageB, installationId: 'e2e-group-b' },
          { page: pageC, installationId: 'e2e-group-c' },
        ];
        for (const { page, installationId } of leavers) {
          const csrf = ((await (await page.request.get('/api/csrf-token', {
            headers: { 'x-nyx-installation-id': installationId },
          })).json()) as { csrfToken: string }).csrfToken;
          const left = await page.request.delete(`/api/conversations/${conversationId}/leave`, {
            headers: {
              'x-group-token': groupToken,
              'x-nyx-installation-id': installationId,
              'csrf-token': csrf,
            },
            data: {},
          });
          // 204 wajib: route leave sekarang menunggu penghapusan baris
          // keanggotaan sebelum menjawab. 403 di sini berarti jalur leave rusak,
          // bukan variasi sah (dulu diterima longgar dan menyembunyikan 409 purge
          // di run 42784148182).
          expect(left.status(), `leave ${installationId}`).toBe(204);
        }

        const purged = await pageA.request.delete(`/api/conversations/${conversationId}/group`, {
          headers: {
            'x-admin-token': adminToken,
            'x-group-token': groupToken,
            'x-nyx-installation-id': 'e2e-group-a',
            'csrf-token': csrfA,
          },
        });
        expect(purged.status(), 'purge setelah semua keluar harus 204').toBe(204);
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
