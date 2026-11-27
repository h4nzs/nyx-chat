// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.4.1] Gate Fase E: sync grup anonim dengan Privacy Pass.
//
// `playwright.ohttp.config.ts` dan stack simulasi E2E
// (`deploy/sim/docker-compose.e2e.yml`) menyalakan `PP_SYNC_REQUIRED=1`.
// Spec ini memakai request TANPA cookie untuk sync (persis transport
// yang dipakai klien: OHTTP POST tanpa sesi), lalu membuktikan:
//   1. sync tanpa bukti ditolak 403 `PP_PROOF_REQUIRED` — gate benar-benar hidup;
//   2. token yang diterbitkan lewat komitmen diterima dan mengembalikan grup;
//   3. token yang sama ditolak pada sync kedua (sekali pakai, bukan bearer token).
//
// Pembuatan akun tetap lewat UI supaya sesi/CSRF yang dipakai untuk membuat
// grup adalah sesi nyata, bukan token yang dikarang.
import { test, expect, Browser } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { registerUser } from './helpers/registration';
import { apiFor } from './helpers/api';

async function currentUserId(page: import('@playwright/test').Page): Promise<string> {
  const response = await page.request.get('/api/users/me');
  expect(response.status(), 'GET /api/users/me harus 200').toBe(200);
  const body = (await response.json()) as { id?: string };
  expect(body.id, 'user id harus ada').toBeTruthy();
  return body.id as string;
}

test.describe('Group sync anonim (Privacy Pass)', () => {
  test.setTimeout(600_000);

  test('PP_SYNC_REQUIRED menolak sync tanpa bukti dan menerima token sekali pakai tanpa cookie', async ({
    browser,
    request,
  }: {
    browser: Browser;
    request: import('@playwright/test').APIRequestContext;
  }) => {
    // Gate `PP_SYNC_REQUIRED` adalah konfigurasi PRODUK, bukan harness: build ini
    // membiarkannya kosong (docs/43 §43.14 — sync tanpa bukti masih diterima,
    // jadi jangan disebut "wajib"), sedangkan `playwright.ohttp.config.ts` dan
    // override E2E stack simulasi (`deploy/sim/docker-compose.e2e.yml`)
    // menyalakannya. Probe dulu: sync tanpa bukti yang dijawab 200 berarti gate
    // mati, dan asersi 403 di bawah akan gagal karena alasan yang salah.
    const gateProbe = await request.post('/api/groups/sync', {
      data: { tokens: [randomBytes(32).toString('base64url')] },
    });
    const gateOn = gateProbe.status() === 403;
    test.skip(!gateOn, 'PP_SYNC_REQUIRED tidak aktif di stack ini (jalankan test:e2e:ohttp untuk gate Privacy Pass)');

    const run = Date.now();
    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const member = await memberCtx.newPage();

    try {
      await registerUser(admin, 'PP Admin', `pp_admin_${run}`);
      await registerUser(member, 'PP Member', `pp_member_${run}`);
      const [adminId, memberId] = await Promise.all([currentUserId(admin), currentUserId(member)]);

      const adminToken = randomBytes(32).toString('base64url');
      const adminSecretHash = createHash('sha256').update(adminToken).digest('hex');
      const memberToken = randomBytes(32).toString('base64url');

      const api = await apiFor(admin, 'e2e-pp-admin');
      const created = await api.post('/api/conversations', {
        userIds: [memberId],
        isGroup: true,
        adminSecretHash,
        deliveryTokens: { [memberId]: memberToken },
      });
      expect(created.status(), 'create grup harus 201').toBe(201);
      const group = (await created.json()) as { id: string; authSecret: string };
      expect(group.id).toBeTruthy();
      expect(group.authSecret, 'token grup hanya dikembalikan saat create').toHaveLength(43);

      // Token dibuat klien; server hanya menerima komitmen SHA-256 saat issue.
      const proof = randomBytes(32).toString('base64url');
      const commitment = createHash('sha256')
        .update(Buffer.from(proof, 'base64url'))
        .digest('base64url');
      const issued = await request.post('/api/groups/pp/issue', {
        data: { groupToken: group.authSecret, memberToken, commitments: [commitment] },
      });
      expect(issued.status(), 'issue komitmen harus 200').toBe(200);
      expect(await issued.json()).toMatchObject({ accepted: 1 });

      // Request ini tidak membawa cookie sesi: route sync memang anonim.
      const syncBody = { tokens: [memberToken] };
      const denied = await request.post('/api/groups/sync', { data: syncBody });
      expect(denied.status(), 'sync tanpa bukti saat gate hidup harus 403').toBe(403);
      expect(((await denied.json()) as { error: string }).error).toBe('PP_PROOF_REQUIRED');

      const accepted = await request.post('/api/groups/sync', {
        data: { ...syncBody, proofs: [proof] },
      });
      expect(accepted.status(), 'sync dengan bukti harus 200').toBe(200);
      const acceptedBody = (await accepted.json()) as {
        conversations: Array<{ id: string }>;
        memberships: Array<{ conversationId: string }>;
      };
      expect(acceptedBody.conversations.map((conversation) => conversation.id)).toContain(group.id);
      expect(acceptedBody.memberships.map((membership) => membership.conversationId)).toContain(group.id);

      // Bukti yang sama tidak boleh dipakai dua kali (SET NX di server).
      const replay = await request.post('/api/groups/sync', {
        data: { ...syncBody, proofs: [proof] },
      });
      expect(replay.status(), 'bukti yang sudah spent harus 403').toBe(403);

      // Sesi admin tetap hidup; ini memastikan request anonim di atas memang
      // tidak memakai cookie, bukan karena seluruh stack kehilangan auth.
      const stillAuthed = await admin.request.get('/api/users/me');
      expect(stillAuthed.status()).toBe(200);
    } finally {
      await Promise.all([adminCtx.close(), memberCtx.close()]);
    }
  });
});
