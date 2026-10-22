// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 §35.9 langkah 3–4] Gerbang rollout jalur kripto PQ v2 di dua klien
// nyata (server + browser sungguhan). Yang dibuktikan — hal yang tidak bisa
// dibuktikan unit test:
//   1. 1:1 benar-benar melakukan **X3DH v2** (`x3dh.handshakeVersion === 2` di
//      amplop yang tersimpan server, plus `initiatorSigningKeyV2`), dan peer
//      yang sama bisa membacanya.
//   2. Grup memakai **tanda tangan ML-DSA** (`sigV === 2` di amplop) dengan
//      `senderKeyId` 8 byte, dan anggota lain membacanya.
//   3. Burner melakukan init **PQ-only** — tidak ada kunci X25519 sama sekali
//      (`guestClassicalPk === ''`, `burnerVersion === 2` di store guest) — dan
//      host membaca pesannya.
//
// Precondition: build klien dengan `VITE_PQ_V2=1`. Bila gerbang mati (default),
// seluruh spec SKIP dengan alasan tertulis — bukan gagal, karena default mati
// memang perilaku yang benar sampai rollout.
//
// Recovery dan device-linking v2 tidak dijalankan di sini: keduanya sudah
// dikunci unit test (server + worker) dan alur UI-nya (frasa pemulihan,
// persetujuan perangkat) tidak menambah bukti wire di luar yang sudah ada.
import { test, expect, Page, BrowserContext } from '@playwright/test';
import {
  registerUser,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';

const GUEST_PLACEHOLDER = 'Type an ephemeral message...';

/** Baca gerbang dari origin aplikasi (modul Vite hanya bisa diresolusi di sana). */
async function readPqV2Enabled(page: Page): Promise<boolean> {
  await page.goto('/');
  return (await page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const pq = await import('/src/lib/pqCapability.ts');
    return pq.resolvePqV2Enabled() === true;
  })) as boolean;
}

interface DirectHandshake {
  handshakeVersion: unknown;
  hasV2SigningKey: boolean;
}

/** Handshake X3DH yang tersimpan server pada percakapan 1:1. */
async function readDirectHandshakes(page: Page): Promise<DirectHandshake[]> {
  return (await page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { useConversationStore } = await import('/src/store/conversation.ts');
    const conversations = useConversationStore.getState().conversations as {
      id: string;
      participants?: unknown[];
    }[];
    const conversation = conversations.find(
      (c) => !String(c.id).startsWith('burner_') && (c.participants?.length ?? 0) <= 2
    );
    if (!conversation) return [];

    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { api } = (await import('/src/lib/api.ts')) as {
      api: <T>(path: string) => Promise<T>;
    };
    let payload: unknown;
    try {
      payload = await api(`/api/messages/${conversation.id}?limit=100`);
    } catch {
      return [];
    }
    const list = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] }).items ?? []);

    return list.flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content !== 'string') return [];
      try {
        const parsed = JSON.parse(content) as {
          x3dh?: { handshakeVersion?: unknown; initiatorSigningKeyV2?: unknown };
        };
        if (!parsed.x3dh) return [];
        return [
          {
            handshakeVersion: parsed.x3dh.handshakeVersion ?? 1,
            hasV2SigningKey: typeof parsed.x3dh.initiatorSigningKeyV2 === 'string',
          },
        ];
      } catch {
        return [];
      }
    });
  })) as DirectHandshake[];
}

interface GroupEnvelopeWire {
  sigV: unknown;
  hasSenderKeyId: boolean;
  ciphertextLen: number;
}

/** Amplop pesan grup (wrapper v4) yang tersimpan server untuk judul tertentu. */
async function readGroupEnvelopes(page: Page, title: string): Promise<GroupEnvelopeWire[]> {
  return (await page.evaluate(async (groupTitle) => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { useConversationStore } = await import('/src/store/conversation.ts');
    const conversations = useConversationStore.getState().conversations as {
      id: string;
      name?: string;
      type?: string;
      isGroup?: boolean;
      participants?: unknown[];
    }[];
    // Grup 2 anggota (kreator + 1 undangan) TIDAK boleh disyaratkan >2 peserta:
    // metadata v2 bisa belum terbuka sehingga `name` juga kosong. Cukup pastikan
    // ini conversation grup (bukan burner/DM).
    const conversation =
      conversations.find((c) => c.name === groupTitle) ??
      conversations.find(
        (c) => (c.type === 'GROUP' || c.isGroup === true) && !String(c.id).startsWith('burner_')
      );
    if (!conversation) return [];

    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { api } = (await import('/src/lib/api.ts')) as {
      api: <T>(path: string) => Promise<T>;
    };
    let payload: unknown;
    try {
      payload = await api(`/api/messages/${conversation.id}?limit=100`);
    } catch {
      return [];
    }
    const list = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] }).items ?? []);

    return list.flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content !== 'string') return [];
      try {
        const parsed = JSON.parse(content) as {
          header?: unknown;
          ciphertext?: unknown;
          signature?: unknown;
          sigV?: unknown;
          senderKeyId?: unknown;
        };
        // Pesan grup = wrapper dengan header+ciphertext+signature; metadata
        // sistem tidak punya `header.n`.
        if (!parsed.header || typeof parsed.ciphertext !== 'string') return [];
        if (typeof parsed.signature !== 'string') return [];
        return [
          {
            sigV: parsed.sigV ?? 1,
            hasSenderKeyId: typeof parsed.senderKeyId === 'string',
            ciphertextLen: parsed.ciphertext.length,
          },
        ];
      } catch {
        return [];
      }
    });
  }, title)) as GroupEnvelopeWire[];
}

/** Buat link burner dari sidebar host dan kembalikan { link, roomId }. */
async function createBurnerLink(page: Page): Promise<{ link: string; roomId: string }> {
  const burnerBtn = page.locator('button[title="Create burner conversation link"]').first();
  await expect(burnerBtn).toBeVisible({ timeout: 15000 });
  await burnerBtn.click();

  const linkEl = page.locator('div', { hasText: /\/drop\/#/ }).first();
  await expect(linkEl).toBeVisible({ timeout: 10000 });
  const modalText = await linkEl.innerText();
  const hrefMatch = modalText.match(/https?:\/\/[^\s]+\/drop\/#(\S+)/);
  expect(hrefMatch).not.toBeNull();
  const link = hrefMatch![0]!;
  const roomId = hrefMatch![1]!.split(':')[0]!;
  expect(roomId.startsWith('burner_')).toBe(true);

  const copyBtn = page.getByRole('button', { name: /Copy Secure Link/i }).first();
  await expect(copyBtn).toBeVisible({ timeout: 10000 });
  await copyBtn.click();
  if (await copyBtn.isVisible().catch(() => false)) {
    await page.mouse.click(5, 5);
  }
  await expect(page.getByRole('button', { name: /Copy Secure Link/i })).toHaveCount(0, {
    timeout: 10000,
  });

  return { link, roomId };
}

/** Kirim satu pesan di halaman burner (/drop guest atau ChatWindow host). */
async function sendBurnerMessage(page: Page, text: string): Promise<void> {
  const input = page
    .getByPlaceholder(GUEST_PLACEHOLDER)
    .or(page.locator('textarea[placeholder*="essage"], input[placeholder*="essage"]'))
    .first();
  await expect(input).toBeVisible({ timeout: 30000 });
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.fill(text);
  await input.press('Enter');
}

/** State burner guest: versi init dan apakah kunci klasik benar-benar absen. */
async function readGuestBurnerState(
  page: Page,
  roomId: string
): Promise<{ burnerVersion: unknown; guestClassicalPk: unknown }> {
  return (await page.evaluate(async (id) => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { useBurnerStore } = await import('/src/store/burner.ts');
    const session = useBurnerStore.getState().activeSessions[id] as
      | { burnerVersion?: unknown; guestClassicalPk?: unknown }
      | undefined;
    return {
      burnerVersion: session?.burnerVersion ?? null,
      guestClassicalPk: session?.guestClassicalPk ?? null,
    };
  }, roomId)) as { burnerVersion: unknown; guestClassicalPk: unknown };
}

test.describe('PQ v2 (X3DH/grup/burner) — gerbang VITE_PQ_V2', () => {
  test.setTimeout(300000);

  test('1:1 memakai X3DH v2 di wire dan peer bisa membacanya', async ({ page, browser }) => {
    const enabled = await readPqV2Enabled(page);
    test.skip(
      !enabled,
      'VITE_PQ_V2 tidak aktif (jalankan dev server dengan VITE_PQ_V2=1) — gerbang v2 default mati'
    );

    const usernameA = `pqa_${Date.now()}`;
    const usernameB = `pqb_${Date.now()}`;
    await registerUser(page, 'Alice PQ', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob PQ', usernameB);

    await page.bringToFront();
    await page.waitForTimeout(3000);
    await openDirectChatWith(page, usernameB, 20000);

    const message = `PQ-v2-1to1-${Date.now()}`;
    await sendChatMessage(page, message);
    await expect(page.locator('main').getByText(message).first()).toBeVisible({ timeout: 20000 });

    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, message, 40000);

    await page.bringToFront();
    const handshakes = await readDirectHandshakes(page);
    expect(handshakes.length, 'tidak ada handshake X3DH di amplop server').toBeGreaterThan(0);
    const v2 = handshakes.filter((h) => h.handshakeVersion === 2 && h.hasV2SigningKey);
    expect(v2.length, `tidak ada handshake v2 di wire: ${JSON.stringify(handshakes)}`).toBeGreaterThan(0);
    // Kill switch hanya menghentikan pengiriman v2: pesan v1 lama tetap terbaca.
    expect(handshakes.every((h) => h.handshakeVersion === 1 || h.handshakeVersion === 2)).toBe(true);

    await contextB.close();
  });

  test('grup memakai tanda tangan ML-DSA (sigV=2 + senderKeyId)', async ({ page, browser }) => {
    const enabled = await readPqV2Enabled(page);
    test.skip(
      !enabled,
      'VITE_PQ_V2 tidak aktif (jalankan dev server dengan VITE_PQ_V2=1) — gerbang v2 default mati'
    );

    const usernameA = `pqga_${Date.now()}`;
    const usernameB = `pqgb_${Date.now()}`;
    const groupTitle = `PQ Group ${Date.now()}`;

    await registerUser(page, 'Alice PQG', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob PQG', usernameB);

    // Bob harus sudah dikenal (search by username tetap jalan), lalu buat grup.
    await page.bringToFront();
    await page.waitForTimeout(3000);
    await page.locator('button[aria-label="New Group"]').first().click();

    await page.getByPlaceholder('Group Name').fill(groupTitle);
    const userSearch = page.getByPlaceholder('Search users...').first();
    await expect(userSearch).toBeVisible({ timeout: 15000 });
    await userSearch.fill(usernameB);
    await userSearch.press('Enter');
    const result = page.locator(`text=@${usernameB}`).first();
    await expect(result).toBeVisible({ timeout: 30000 });
    await result.click();

    await page.getByRole('button', { name: 'Create Group', exact: true }).first().click();
    await expect(page.getByPlaceholder('Group Name')).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByText(groupTitle).first()).toBeVisible({ timeout: 30000 });

    const message = `PQ-v2-group-${Date.now()}`;
    await sendChatMessage(page, message);
    await expect(page.locator('main').getByText(message).first()).toBeVisible({ timeout: 20000 });

    // Anggota lain menerima dan membuka grupnya dari daftar chat.
    await pageB.bringToFront();
    const groupRow = pageB.locator('div').filter({ hasText: groupTitle }).first();
    await expect(groupRow).toBeVisible({ timeout: 60000 });
    await groupRow.click();
    await expect(pageB.locator('main').getByText(message).first()).toBeVisible({ timeout: 60000 });

    // Wire: wrapper grup v4 di server — `sigV: 2` + `senderKeyId` 8 byte.
    await page.bringToFront();
    const envelopes = await readGroupEnvelopes(page, groupTitle);
    expect(envelopes.length, 'tidak ada pesan grup di amplop server').toBeGreaterThan(0);
    const v4 = envelopes.filter((e) => e.sigV === 2 && e.hasSenderKeyId);
    expect(v4.length, `tidak ada pesan grup v4: ${JSON.stringify(envelopes)}`).toBeGreaterThan(0);

    await contextB.close();
  });

  test('burner init PQ-only tanpa kunci X25519', async ({ page, browser }) => {
    const enabled = await readPqV2Enabled(page);
    test.skip(
      !enabled,
      'VITE_PQ_V2 tidak aktif (jalankan dev server dengan VITE_PQ_V2=1) — gerbang v2 default mati'
    );
    // Init burner PQ-only memakai handshake DR yang hanya ada di jalur
    // WebTransport; fallback WSS sengaja no-op. Job E2E Chromium memaksa WSS
    // (tanpa sidecar), jadi tes ini dijalankan di job `e2e-chrome`.
    test.skip(
      process.env.VITE_FORCE_WSS === '1',
      'WebTransport/uplink sidecar tidak tersedia (burner PQ-only butuh WT)'
    );

    await registerUser(page, 'Alice Burner PQ', `pqburn_${Date.now()}`);

    const { link, roomId } = await createBurnerLink(page);

    const guestContext: BrowserContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(link);
    await sendBurnerMessage(guestPage, 'pq-ping');

    const state = await readGuestBurnerState(guestPage, roomId);
    expect(state.burnerVersion, `init burner bukan v2: ${JSON.stringify(state)}`).toBe(2);
    expect(state.guestClassicalPk, 'burner v2 masih membawa kunci klasik').toBe('');

    // Host membuka burner dari sidebar (state DR hidup di RAM) dan membaca pesan guest.
    await page.bringToFront();
    const burnerRow = page.locator('div.cursor-pointer').filter({ hasText: 'pq-ping' }).first();
    await expect(burnerRow).toBeVisible({ timeout: 30000 });
    await burnerRow.click();
    await expect(page).toHaveURL(new RegExp(roomId));
    await expect(
      page.getByRole('button', { name: /Destroy Burner Session/i }).first()
    ).toBeVisible({ timeout: 30000 });
    await expect(page.locator('main').getByText('pq-ping').first()).toBeVisible({ timeout: 30000 });

    await guestContext.close();
  });
});
