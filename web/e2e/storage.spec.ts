import { expect, test, type Page } from '@playwright/test';

// Nama unik per run: database OPFS bertahan di profil browser, dan init skema
// tidak boleh mewarisi baris dari run sebelumnya.
const DB_NAME = `/nyx-e2e-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`;
const KEY = Array.from({ length: 32 }, (_, index) => index + 1);
const CONVERSATION = 'e2e-sqlite-c1';

type Row = {
  id: string;
  conversationId: string;
  orderBucketMs: number;
  content: string;
};

async function openHandle(page: Page): Promise<void> {
  // Fixture statis: halaman aplikasi bisa redirect ke /login setelah bootstrap,
  // dan navigasi itu menghancurkan handle yang baru dipasang di `window`.
  //
  // [Vite dep optimizer] Impor dinamis pertama memaksa Vite mengoptimalkan
  // dependensi baru lalu mengirim full-reload. `evaluate` yang sedang berjalan
  // mati dengan "Execution context was destroyed" — selalu terjadi saat cache
  // `.vite` dingin (CI / checkout baru). Memasang ulang handle sesudah reload
  // bukan melemahkan assertion: yang diuji tetap tab kedua melihat baris tab
  // pertama.
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/e2e/fixtures/storage.html');
    try {
      await page.evaluate(async ({ dbName, key }) => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { SqliteWorkerClient } = await import('/src/lib/storage/sqliteClient.ts');
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { initializeStorageSchema } = await import('/src/lib/storage/schema.ts');
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { createSqliteMessageStore } = await import('/src/lib/storage/sqliteStores.ts');

        const client = await SqliteWorkerClient.open({
          key: new Uint8Array(key),
          dbName,
        });
        await initializeStorageSchema(client);
        (window as unknown as { __nyxSqlite?: unknown }).__nyxSqlite = {
          client,
          store: createSqliteMessageStore(client),
        };
      }, { dbName: DB_NAME, key: KEY });
    } catch (error) {
      // Hanya kegagalan navigasi/reload yang diulang; error lain tetap naik.
      if (attempt >= 3 || !/Execution context was destroyed|navigat/i.test(String(error))) {
        throw error;
      }
      continue;
    }

    // Reload dari optimizer bisa mendarat SETELAH mount selesai, jadi tunggu
    // jaringan tenang dulu lalu pastikan handle masih ada.
    await page.waitForLoadState('networkidle');
    const mounted = await page.evaluate(
      () => Boolean((window as unknown as { __nyxSqlite?: unknown }).__nyxSqlite),
    );
    if (mounted) return;
    if (attempt >= 3) throw new Error('handle SQLite hilang setelah reload Vite');
  }
}

async function writeRow(page: Page, row: Row): Promise<void> {
  await page.evaluate(async (value) => {
    const handle = (
      window as unknown as {
        __nyxSqlite?: { store: { put(input: Row): Promise<void> } };
      }
    ).__nyxSqlite;
    if (!handle) throw new Error('SQLite handle belum dibuka');
    await handle.store.put(value);
  }, row);
}

async function readContents(page: Page, conversationId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const handle = (
      window as unknown as {
        __nyxSqlite?: {
          store: {
            listByConversation(input: string): Promise<Array<{ content?: string }>>;
          };
        };
      }
    ).__nyxSqlite;
    if (!handle) throw new Error('SQLite handle belum dibuka');
    const rows = await handle.store.listByConversation(id);
    return rows.map((row) => row.content ?? '');
  }, conversationId);
}

async function closeHandle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const handle = (
      window as unknown as {
        __nyxSqlite?: { client?: { close(): Promise<void> } };
      }
    ).__nyxSqlite;
    await handle?.client?.close();
    delete (window as unknown as { __nyxSqlite?: unknown }).__nyxSqlite;
  });
}

test.describe('SQLite OPFS lintas tab', () => {
  test.setTimeout(60_000);

  test('dua tab berbagi database dan saling melihat tulisan', async ({ page, context }) => {
    const second = await context.newPage();
    try {
      await openHandle(page);
      await openHandle(second);

      for (const tab of [page, second]) {
        await expect.poll(() => tab.evaluate(() => crossOriginIsolated)).toBe(true);
      }

      await writeRow(page, {
        id: 'm1',
        conversationId: CONVERSATION,
        orderBucketMs: 1_000,
        content: 'dari tab pertama',
      });

      // Tab kedua membuka database yang sama; kunci dan baris harus terlihat.
      await expect.poll(() => readContents(second, CONVERSATION)).toEqual([
        'dari tab pertama',
      ]);

      await writeRow(second, {
        id: 'm2',
        conversationId: CONVERSATION,
        orderBucketMs: 2_000,
        content: 'dari tab kedua',
      });
      await closeHandle(second);

      // Koneksi tab pertama tetap terbuka; tulisan tab kedua harus terlihat.
      await expect.poll(() => readContents(page, CONVERSATION)).toEqual([
        'dari tab pertama',
        'dari tab kedua',
      ]);
    } finally {
      await closeHandle(page).catch(() => {});
      await second.close();
    }
  });
});
