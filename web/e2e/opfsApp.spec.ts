import { expect, test } from '@playwright/test';
import { registerUser } from './helpers/registration';

// [docs/43 §43.11.3] Spec ini hanya dikumpulkan saat `NYX_E2E_OPFS_APP=1`
// (lihat `playwright.config.ts`). Tujuannya bukan menguji worker secara
// terisolasi, melainkan memastikan header COEP tidak memblokir aset aplikasi
// nyata dan jalur baca SQLite benar-benar terbuka setelah akun di-unlock.
test.describe('Aplikasi di bawah COOP/COEP', () => {
  test.setTimeout(300_000);

  test('registrasi, aset, dan SQLite tetap berjalan', async ({ page }) => {
    const blocked: string[] = [];

    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? '';
      if (/ERR_BLOCKED_BY_RESPONSE|COEP/i.test(error)) {
        blocked.push(`${request.url()} (${error})`);
      }
    });
    page.on('console', (message) => {
      const text = message.text();
      if (/Cross-Origin-Embedder-Policy|ERR_BLOCKED_BY_RESPONSE|blocked by COEP/i.test(text)) {
        blocked.push(text);
      }
    });

    await page.goto('/login');
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    await registerUser(page, 'OPFS Smoke', `opfs_${Date.now()}`);
    await expect(page).toHaveURL(/\/chat/, { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    const storage = await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const mod = await import('/src/lib/storage/sqliteMessages.ts');
      const rows = await mod.readSqliteMessages('opfs-app-smoke', 10);
      return {
        enabled: mod.isSqliteMessagesEnabled(),
        available: rows !== null,
        count: rows?.length ?? -1,
      };
    });

    expect(storage).toEqual({ enabled: true, available: true, count: 0 });

    const contactId = `opfs-peer-${Date.now()}`;
    const contact = await page.evaluate(async (id) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { upsertContact, getContact } = await import('/src/lib/contactStore.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { openSqliteKvStore } = await import('/src/lib/storage/sqliteMessages.ts');
      await upsertContact({ userId: id, conversationId: 'opfs-app-smoke' });
      const row = await getContact(id);
      const kv = await openSqliteKvStore();
      const stored = (await kv?.get(`contacts:${id}`)) as { data?: string } | undefined;
      return { userId: row?.userId ?? null, stored: Boolean(stored?.data) };
    }, contactId);
    expect(contact).toEqual({ userId: contactId, stored: true });

    const keychainBefore = await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const keychain = await import('/src/lib/keychainDb.ts');
      await keychain.storeOneTimePreKey(99, Uint8Array.from([1, 2, 3, 250]), 'pq-public');
      await keychain.storeMessageKey('opfs-msg-key', Uint8Array.from([4, 5, 6]));
      await keychain.savePeerIdentityKey('opfs-keychain-peer', 'pub-key');
      return {
        preKey: Array.from((await keychain.getOneTimePreKey(99)) ?? []),
        messageKey: Array.from((await keychain.getMessageKey('opfs-msg-key')) ?? []),
        peerKey: (await keychain.getPeerIdentityKey('opfs-keychain-peer')) ?? null,
      };
    });
    expect(keychainBefore).toEqual({
      preKey: [1, 2, 3, 250],
      messageKey: [4, 5, 6],
      peerKey: 'pub-key',
    });

    const ktBefore = await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { saveKtState, loadKtStates } = await import('/src/lib/ktMonitoring.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { saveKtConfigPin, loadKtConfigPin } = await import('/src/lib/ktConfigPin.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { storeAnchor, loadStoredAnchor } = await import('/src/lib/ktGossip.ts');

      const searchKey = Uint8Array.from([1, 2, 3]);
      await saveKtState({ searchKey, keyVersion: 7, treeSize: 10 });
      await saveKtConfigPin({
        abiVersion: 2,
        mode: 1,
        signatureKey: 'a'.repeat(3904),
        auditorKeys: [],
      });
      await storeAnchor({ root: 'b'.repeat(64), treeSize: 10 });

      const states = await loadKtStates();
      return {
        keyVersion: states[0]?.keyVersion ?? null,
        treeSize: states[0]?.treeSize ?? null,
        pinMode: (await loadKtConfigPin())?.mode ?? null,
        anchor: await loadStoredAnchor(),
      };
    });
    expect(ktBefore).toEqual({
      keyVersion: 7,
      treeSize: 10,
      pinMode: 1,
      anchor: { root: 'b'.repeat(64), treeSize: 10 },
    });

    // Reload membuktikan kontak, keychain residual, dan state KT bertahan di SQLite.
    await page.reload();
    await expect(page).toHaveURL(/\/chat/, { timeout: 60_000 });
    await expect.poll(async () => page.evaluate(async (id) => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { getContact } = await import('/src/lib/contactStore.ts');
      return (await getContact(id))?.userId ?? null;
    }, contactId), { timeout: 60_000 }).toBe(contactId);
    await expect.poll(async () => page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const keychain = await import('/src/lib/keychainDb.ts');
      return {
        preKey: Array.from((await keychain.getOneTimePreKey(99)) ?? []),
        messageKey: Array.from((await keychain.getMessageKey('opfs-msg-key')) ?? []),
        peerKey: (await keychain.getPeerIdentityKey('opfs-keychain-peer')) ?? null,
      };
    }), { timeout: 60_000 }).toEqual({
      preKey: [1, 2, 3, 250],
      messageKey: [4, 5, 6],
      peerKey: 'pub-key',
    });
    await expect.poll(async () => page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { loadKtStates } = await import('/src/lib/ktMonitoring.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { loadKtConfigPin } = await import('/src/lib/ktConfigPin.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { loadStoredAnchor } = await import('/src/lib/ktGossip.ts');
      const states = await loadKtStates();
      return {
        keyVersion: states[0]?.keyVersion ?? null,
        treeSize: states[0]?.treeSize ?? null,
        pinMode: (await loadKtConfigPin())?.mode ?? null,
        anchor: await loadStoredAnchor(),
      };
    }), { timeout: 60_000 }).toEqual({
      keyVersion: 7,
      treeSize: 10,
      pinMode: 1,
      anchor: { root: 'b'.repeat(64), treeSize: 10 },
    });

    expect(blocked, `Request/console terblokir COEP:\n${blocked.join('\n')}`).toEqual([]);
  });
});
