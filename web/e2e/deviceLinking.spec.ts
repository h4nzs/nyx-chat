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

    // [LINK 2026-10-29] Simulasi blob kontak yang disegel identitas LAMA (byte
    // apa pun yang bukan milik perangkat baru). Setelah link, perangkat baru
    // WAJIB menggantinya dengan blob identitasnya sendiri — kalau tidak,
    // restore kontak di perangkat baru selalu gagal dengan "Bundle korup".
    const OLD_IDENTITY_BLOB = 'SEALED-WITH-OLD-IDENTITY';
    // [docs/40] Satu kontak nyata di perangkat lama supaya opsi "sertakan
    // riwayat" aktif dan pipeline ekspor→R2→impor benar-benar berjalan.
    const HISTORY_PEER = 'peer-history-e2e';
    const HISTORY_CONV = 'conv-history-e2e';
    await page.evaluate(async ({ peerId, conversationId }) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { upsertContact } = await import('/src/lib/contactStore.ts');
      await upsertContact({ userId: peerId, conversationId });

      // [docs/40 §40.7] Tiga pesan nyata di vault perangkat lama (disegel kunci
      // identitas LAMA). Arsip harus membawanya sebagai objek terdekripsi dan
      // menyegel ulang dengan kunci identitas BARU di perangkat baru.
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { shadowVault } = await import('/src/lib/shadowVaultDb.ts');
      await shadowVault.saveConversation({
        id: conversationId,
        isGroup: false,
        participants: [{ id: peerId }],
        lastMessageAt: null,
        unreadCount: 0,
        encryptionMode: 'SENDER_KEY',
        lastMessage: null,
      });
      const now = Date.now();
      await shadowVault.upsertMessages(
        ['halo lama 1', 'halo lama 2', 'halo lama 3'].map((content, index) => ({
          id: `${conversationId}-msg-${index}`,
          conversationId,
          content,
          senderId: peerId,
          sender: { id: peerId, name: 'Peer History' },
          createdAt: new Date(now - (3 - index) * 60_000).toISOString(),
          status: 'SENT',
          seq: 900 + index,
        }))
      );
    }, { peerId: HISTORY_PEER, conversationId: HISTORY_CONV });

    const seeded = await page.evaluate(async (blob) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { authFetch } = await import('/src/lib/api.ts');
      await authFetch('/api/users/me/contact-bundle', {
        method: 'PUT',
        body: JSON.stringify({ encryptedBundle: blob, version: 123 }),
      });
      // Tanpa type-arg: import dinamis tidak bertipe (TS2347).
      const back = (await authFetch('/api/users/me/contact-bundle')) as {
        encryptedBundle: string | null;
      };
      return back?.encryptedBundle ?? null;
    }, OLD_IDENTITY_BLOB);
    expect(seeded).toBe(OLD_IDENTITY_BLOB);

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

    // Blob identitas lama sudah diganti oleh push identitas BARU. `version`
    // 123 sengaja dipakai sebagai nilai yang mustahil dihasilkan klien (ia hash
    // 31-bit isi bundle), jadi berubahnya version = benar-benar PUT baru.
    const afterLink = await newDevice.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { authFetch } = await import('/src/lib/api.ts');
      return (await authFetch('/api/users/me/contact-bundle')) as {
        encryptedBundle: string | null;
        version: number | null;
      };
    });
    expect(afterLink?.encryptedBundle).toBeTruthy();
    expect(afterLink?.encryptedBundle).not.toBe(OLD_IDENTITY_BLOB);
    expect(afterLink?.version).not.toBe(123);
    // Envelope `encryptVaultText` = base64url(nonce‖ct), bukan teks biasa.
    expect(afterLink?.encryptedBundle).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // [docs/40] Arsip riwayat benar-benar sampai: kontak yang diekspor perangkat
    // lama terbaca di perangkat baru (berarti sudah disegel ulang dengan kunci
    // vault identitas baru), dan state server sudah dikonsumsi (sekali pakai).
    const historyAfterLink = await newDevice.evaluate(async ({ peerId, conversationId }) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { getAllContacts } = await import('/src/lib/contactStore.ts');
      // @ts-ignore
      const { authFetch } = await import('/src/lib/api.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { shadowVault } = await import('/src/lib/shadowVaultDb.ts');
      const contacts = (await getAllContacts()) as Array<{ userId: string }>;
      const status = (await authFetch('/api/auth/link/history')) as { state: string };
      // Dibaca lewat pembaca chat yang sama: kalau penyegelan ulang salah,
      // `content` kembali `null` (dekripsi gagal senyap) dan assertion di bawah
      // menangkapnya.
      const messages = (await shadowVault.getMessagesByConversation(conversationId, 10)) as Array<{
        content: string | null;
        seq?: number;
      }>;
      const conversations = (await shadowVault.getAllConversations()) as Array<{ id: string }>;
      return {
        hasPeer: contacts.some((c) => c.userId === peerId),
        historyState: status?.state,
        contents: messages.map((m) => m.content).filter(Boolean).sort(),
        hasConversation: conversations.some((c) => c.id === conversationId),
      };
    }, { peerId: HISTORY_PEER, conversationId: HISTORY_CONV });
    expect(historyAfterLink.hasPeer).toBe(true);
    expect(historyAfterLink.historyState).toBe('none');
    expect(historyAfterLink.hasConversation).toBe(true);
    expect(historyAfterLink.contents).toEqual(['halo lama 1', 'halo lama 2', 'halo lama 3']);

    await newDeviceContext.close();
  });
});
