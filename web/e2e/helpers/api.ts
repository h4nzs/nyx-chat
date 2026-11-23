// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Klien API kecil untuk spec E2E: request memakai cookie sesi milik
 * page/context, ditambah `csrf-token` + `x-nyx-installation-id` seperti
 * `web/src/lib/api.ts`. Diekstrak dari `groupLifecycle.spec.ts` supaya spec
 * lain (mis. antrean offline) tidak menyalin blok yang sama.
 */
import { expect, type APIResponse, type Page } from '@playwright/test';

export type Api = {
  get: (path: string) => Promise<APIResponse>;
  post: (path: string, data: unknown) => Promise<APIResponse>;
  delete: (path: string, data?: unknown) => Promise<APIResponse>;
};

/** Token CSRF untuk installation id tertentu (mutasi admin tetap butuh CSRF). */
export async function csrfFor(page: Page, installationId: string): Promise<string> {
  const response = await page.request.get('/api/csrf-token', {
    headers: { 'x-nyx-installation-id': installationId },
  });
  expect(response.status(), 'GET /api/csrf-token harus 200').toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

/**
 * Klien API yang meniru kontrak klien web: setiap mutasi membawa `csrf-token`
 * + `x-nyx-installation-id`, dan token CSRF diambil dari endpoint yang sama
 * dengan aplikasi. Installation id harus sama dengan yang dipakai saat token
 * diterbitkan, karena server menyimpan state CSRF per klien.
 */
export async function apiFor(page: Page, installationId: string): Promise<Api> {
  let csrfToken = '';

  async function refreshCsrf() {
    csrfToken = await csrfFor(page, installationId);
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
