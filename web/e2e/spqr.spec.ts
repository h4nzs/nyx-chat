// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/33 §33.7 / docs/30 §30.8 WS-D] Spesifikasi E2E jalur ratchet **v2**
// (braid SPQR) — jalur versi paralel, dijalankan lewat server + dua klien nyata.
//
// Yang dibuktikan (tidak bisa dibuktikan unit test):
//   1. Pesan v1 tetap lewat lebih dulu: klien tidak pernah mengirim v2 sebelum
//      peer menyatakan mampu (`ackV` di payload ter-seal).
//   2. Setelah peer menyatakan mampu, pengiriman berikutnya benar-benar v2 —
//      dibuktikan dari **amplop yang tersimpan server** (`dr.v === 2`), bukan
//      dari asumsi.
//   3. Peer bisa MEMBACA pesan v2 itu (plaintext muncul di UI kedua sisi).
//   4. Urutan nyata (penerima/B2A yang mengirim v2 pertama) tetap sepakat.
//
// Prasyarat jalur v2 aktif di lingkungan ini — spec SKIP dengan alasan tertulis
// bila tidak:
//   - jalur WebTransport (project `chrome` + sidecar): sidecar mengiklankan
//     `spqr-ratchet` lewat HELLO bidi; ATAU
//   - jalur WSS (project `chromium` biasa, tanpa sidecar): gateway Node
//     mengiklankan `spqr-ratchet` lewat balasan event `capabilities`
//     (`server/src/realtime/gateway.ts` → `utils/transportCapability.ts`).
//     Inilah yang membuat spec ini berjalan TANPA WebTransport sekaligus
//     membuktikan paritas kedua transport.
//
// Spec hanya SKIP bila **deployment** mematikannya (kapabilitas dihapus dari
// `SERVER_CAPABILITIES`), atau `VITE_SPQR_FORCE_V1=1` (kill switch operator).
// Override uji `VITE_SPQR_FORCE_V2=1` masih dipakai, tetapi kini hanya untuk
// lingkungan yang tidak punya salah satu relay di atas.
import { test, expect, Page } from '@playwright/test';
import {
  registerUser,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';

type SpqrEnv = { enabled: boolean; override: boolean; caps: string[]; killSwitchKey: string };

/** Header DR satu pesan seperti yang tersimpan di server. */
interface WireHeader {
  v: unknown;
  hasKemPk: boolean;
  hasBraidFrames: boolean;
}

/**
 * Kunci kill switch runtime DEV — HARUS sama dengan
 * `spqrNegotiation.SPQR_RUNTIME_KILL_SWITCH_KEY`; test pertama membandingkannya
 * dengan konstanta aplikasi supaya keduanya tidak bisa menyimpang diam-diam.
 * (Konstanta tidak bisa diimpor langsung dari spec: modul aplikasi membaca
 * `import.meta.env`, yang tidak ada di proses Playwright.)
 */
const KILL_SWITCH_KEY = 'nyx_spqr_force_v1';

/**
 * Precondition jalur v2: baca konfigurasi dari origin aplikasi (modul Vite dev
 * hanya bisa diresolusi di sana, bukan di `about:blank`).
 */
async function readSpqrEnv(page: Page): Promise<SpqrEnv> {
  await page.goto('/');
  return (await page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const neg = await import('/src/lib/spqrNegotiation.ts');
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const tc = await import('/src/lib/transportClient.ts');
    return {
      enabled: neg.SPQR_INTEGRATION_ENABLED,
      override: neg.SPQR_CAPABILITY_OVERRIDE,
      caps: tc.getNegotiatedCapabilities(),
      killSwitchKey: neg.SPQR_RUNTIME_KILL_SWITCH_KEY,
    };
  })) as SpqrEnv;
}

/**
 * Kapabilitas hasil negosiasi SETELAH login.
 *
 * Kenapa harus menunggu: negosiasi berjalan di atas koneksi transport yang baru
 * ada setelah sesi terautentikasi, dan balasan gateway datang satu putaran
 * setelah `connect` (jalur WT: HELLO bidi). Membaca nilainya sebelum itu
 * membuat spec salah SKIP sendirinya — kegagalan yang tidak bisa dibedakan dari
 * "deployment memang mematikan jalur v2".
 */
async function waitForCapabilities(page: Page, timeoutMs = 15000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let caps: string[] = [];
  while (Date.now() < deadline) {
    caps = (await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const tc = await import('/src/lib/transportClient.ts');
      return tc.getNegotiatedCapabilities();
    })) as string[];
    if (caps.length > 0) return caps;
    await page.waitForTimeout(250);
  }
  return caps;
}

/**
 * Amplop pesan percakapan pertama dari server, urut lama → baru (endpoint
 * mengembalikan `items` menaik), jadi elemen terakhir = pesan terbaru.
 * Pesan SYSTEM / tanpa `dr` dilewati.
 */
async function readEnvelope(page: Page): Promise<WireHeader[]> {
  return (await page.evaluate(async () => {
    // @ts-ignore — path absolut Vite dev server (runtime-only)
    const { useConversationStore } = await import('/src/store/conversation.ts');
    const conversations = useConversationStore.getState().conversations as { id: string }[];
    const conversation = conversations[0];
    if (!conversation) return [];

    const response = await fetch(`/api/messages/${conversation.id}?limit=100`, {
      credentials: 'include',
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as unknown;
    const list = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] }).items ?? []);

    return list.flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content !== 'string') return [];
      try {
        const parsed = JSON.parse(content) as { dr?: { v?: unknown; kemPk?: unknown; b?: unknown } };
        const dr = parsed.dr;
        if (!dr) return [];
        return [
          {
            v: dr.v ?? null,
            hasKemPk: typeof dr.kemPk === 'string',
            hasBraidFrames: Array.isArray(dr.b),
          },
        ];
      } catch {
        return [];
      }
    });
  })) as WireHeader[];
}

test.describe('Ratchet v2 (braid SPQR)', () => {
  test.setTimeout(300000);

  test('upgrade ke v2 setelah deklarasi peer, dan peer bisa membacanya', async ({ page, browser }) => {
    // Precondition jujur: jalur v2 butuh kapabilitas relay (atau override DEV) —
    // lihat `readSpqrEnv`.
    const env = await readSpqrEnv(page);
    // Penjaga sinkronisasi: kunci kill switch di spec ini harus sama dengan
    // konstanta aplikasi (kill switch runtime DEV tidak bisa diimpor di sini).
    expect(env.killSwitchKey).toBe(KILL_SWITCH_KEY);
    test.skip(!env.enabled, `integrasi jalur v2 dimatikan (${JSON.stringify(env)})`);

    const usernameA = `sqra_${Date.now()}`;
    const usernameB = `sqrb_${Date.now()}`;

    await registerUser(page, 'Alice SPQR', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob SPQR', usernameB);

    // Kapabilitas baru bisa dibaca setelah sesi hidup: jalur WT lewat HELLO
    // sidecar, jalur WSS lewat balasan gateway (dua-duanya asinkron).
    const caps = await waitForCapabilities(page);
    test.skip(
      !(env.override || caps.includes('spqr-ratchet')),
      `relay tidak mengiklankan spqr-ratchet (ternegosiasi: ${JSON.stringify(caps)})`
    );

    // Alice membuka percakapan dengan Bob (username persis → lolos gerbang
    // pencarian sandbox tanpa PoW).
    await page.bringToFront();
    await page.waitForTimeout(3000);
    await openDirectChatWith(page, usernameB, 20000);

    // --- 1. Pesan pertama: v1 (Bob belum menyatakan mampu v2) --------------
    const messageV1 = `SPQR-v1-${Date.now()}`;
    await sendChatMessage(page, messageV1);
    await expect(page.locator(`text=${messageV1}`).first()).toBeVisible({ timeout: 20000 });

    // Bob membacanya → jalur v1 tetap utuh di tengah jalur v2 baru.
    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageV1, 40000);

    // --- 2. Bob membalas: pengiriman v2 pertamanya (braid B2A dari nol) ----
    const messageV2First = `SPQR-v2-bob-${Date.now()}`;
    await sendChatMessage(pageB, messageV2First);
    await expect(pageB.locator(`text=${messageV2First}`).first()).toBeVisible({ timeout: 20000 });

    // Alice harus bisa membacanya → braid A2B/B2A sepakat di jalur nyata.
    await page.bringToFront();
    await expectPeerReceivesMessage(page, messageV2First, 40000);

    // --- 3. Alice mengirim lagi: kini gilirannya memakai v2 -----------------
    const messageV2Second = `SPQR-v2-alice-${Date.now()}`;
    await sendChatMessage(page, messageV2Second);
    await expect(page.locator(`text=${messageV2Second}`).first()).toBeVisible({ timeout: 20000 });

    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageV2Second, 40000);

    // --- 4. Bukti wire: amplop di server memuat header v1 DAN v2 -----------
    await page.bringToFront();
    const wire = (await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { useConversationStore } = await import('/src/store/conversation.ts');
      const conversations = useConversationStore.getState().conversations as { id: string }[];
      const conversation = conversations[0];
      if (!conversation) return { error: 'NO_CONVERSATION' as const, headers: [] };

      const response = await fetch(`/api/messages/${conversation.id}?limit=50`, {
        credentials: 'include',
      });
      if (!response.ok) return { error: `HTTP ${response.status}` as const, headers: [] };

      // Bentuk balikan endpoint: `{ items, hasMore, nextCursor }`.
      const payload = (await response.json()) as unknown;
      const list = Array.isArray(payload)
        ? payload
        : ((payload as { items?: unknown[] }).items ?? []);

      const headers = list.flatMap((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content !== 'string') return [];
        try {
          const parsed = JSON.parse(content) as { dr?: { v?: unknown; kemPk?: unknown; b?: unknown } };
          const dr = parsed.dr;
          if (!dr) return [];
          return [{ v: dr.v ?? null, hasKemPk: typeof dr.kemPk === 'string', hasBraidFrames: Array.isArray(dr.b) }];
        } catch {
          return [];
        }
      });

      return { error: null, headers };
    })) as { error: string | null; headers: { v: unknown; hasKemPk: boolean; hasBraidFrames: boolean }[] };

    expect(wire.error, `gagal membaca amplop: ${wire.error}`).toBeNull();
    expect(wire.headers.length).toBeGreaterThanOrEqual(3);

    const v2Headers = wire.headers.filter((header) => header.v === 2);
    expect(v2Headers.length, 'tidak ada pesan v2 di amplop server').toBeGreaterThan(0);
    // Header v2 = frame braid, TIDAK membawa `kemPk`/`ct` 1120 byte jalur v1.
    for (const header of v2Headers) {
      expect(header.hasBraidFrames).toBe(true);
      expect(header.hasKemPk).toBe(false);
    }
    // Dan jalur v1 tetap terpakai sebelum deklarasi peer (bukan "semua v2").
    expect(wire.headers.some((header) => header.hasKemPk && header.v === null)).toBe(true);

    await contextB.close();
  });

  // [docs/33 §33.8 / §33.10] Rollback operator pada SATU klien di tengah sesi
  // v2. Tidak bisa diuji lewat `VITE_SPQR_FORCE_V1` (env build-time → semua klien
  // dari satu build bernilai sama), jadi memakai kill switch runtime DEV.
  //
  // Yang dibuktikan dari amplop nyata di server + UI kedua klien:
  //   1. Klien yang di-rollback benar-benar MENGIRIM v1 lagi (`kemPk`, tanpa `v`)
  //      → rollback terjadi di wire, bukan hanya di logika.
  //   2. Peer (sesi v2) tetap bisa membacanya → state v1 tidak pernah ditimpa v2.
  //   3. Pesan v2 dari peer TETAP terbaca di klien yang di-rollback → state braid
  //      dipertahankan, sehingga tindakan operator tidak mengubah pesan yang sudah
  //      dikirim menjadi tak terbaca.
  test('kill switch satu klien: kirim balik ke v1, pesan v2 tetap terbaca', async ({ page, browser }) => {
    test.setTimeout(300000);

    const env = await readSpqrEnv(page);
    expect(env.killSwitchKey).toBe(KILL_SWITCH_KEY);
    test.skip(
      !env.enabled || !(env.override || env.caps.includes('spqr-ratchet')),
      `jalur v2 tidak aktif di lingkungan ini (${JSON.stringify(env)})`
    );

    const usernameA = `rolla_${Date.now()}`;
    const usernameB = `rollb_${Date.now()}`;

    await registerUser(page, 'Alice Rollback', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob Rollback', usernameB);

    await page.bringToFront();
    await page.waitForTimeout(3000);
    await openDirectChatWith(page, usernameB, 20000);

    // --- 1. Sesi v2 berdiri di kedua arah (seperti spec di atas) -----------
    const messageV1 = `ROLL-v1-${Date.now()}`;
    await sendChatMessage(page, messageV1);
    await expect(page.locator(`text=${messageV1}`).first()).toBeVisible({ timeout: 20000 });
    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageV1, 40000);

    const messageBobV2 = `ROLL-v2-bob-${Date.now()}`;
    await sendChatMessage(pageB, messageBobV2);
    await page.bringToFront();
    await expectPeerReceivesMessage(page, messageBobV2, 40000);

    const messageAliceV2 = `ROLL-v2-alice-${Date.now()}`;
    await sendChatMessage(page, messageAliceV2);
    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageAliceV2, 40000);

    const beforeRollback = await readEnvelope(page);
    expect(
      beforeRollback.filter((header) => header.v === 2).length,
      'sesi v2 belum berdiri, rollback tidak bisa diuji'
    ).toBeGreaterThanOrEqual(2);

    // --- 2. Rollback klien B (kill switch runtime, tanpa reload) -----------
    await pageB.evaluate((key) => localStorage.setItem(key, '1'), KILL_SWITCH_KEY);

    // 3. Pesan v2 berikutnya dari A harus TETAP terbaca di B.
    const messageAliceV2After = `ROLL-v2-alice-after-${Date.now()}`;
    await page.bringToFront();
    await sendChatMessage(page, messageAliceV2After);
    await expect(page.locator(`text=${messageAliceV2After}`).first()).toBeVisible({ timeout: 20000 });

    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageAliceV2After, 40000);

    // Pesan harus benar-benar TERSIMPAN di server sebelum diperiksa: penerimaan
    // di UI bersifat optimistis, sedangkan POST-nya asinkron (tanpa poll di sini,
    // "pesan terbaru" masih pesan sebelumnya).
    await expect
      .poll(async () => (await readEnvelope(pageB)).length, { timeout: 20000 })
      .toBeGreaterThan(beforeRollback.length);
    const envelopeAfterAlice = await readEnvelope(pageB);
    expect(
      envelopeAfterAlice[envelopeAfterAlice.length - 1],
      'pesan A setelah rollback peer seharusnya masih v2 (deklarasi peer sticky)'
    ).toMatchObject({ v: 2, hasBraidFrames: true, hasKemPk: false });

    // 4. Pengiriman B setelah rollback: header v1 (bukan v2).
    const messageBobV1 = `ROLL-v1-bob-${Date.now()}`;
    await sendChatMessage(pageB, messageBobV1);
    await expect(pageB.locator(`text=${messageBobV1}`).first()).toBeVisible({ timeout: 20000 });

    await expect
      .poll(async () => (await readEnvelope(pageB)).length, { timeout: 20000 })
      .toBeGreaterThan(envelopeAfterAlice.length);
    const envelopeAfterBob = await readEnvelope(pageB);
    expect(
      envelopeAfterBob[envelopeAfterBob.length - 1],
      'klien yang di-rollback seharusnya MENGIRIM v1 lagi'
    ).toMatchObject({ v: null, hasKemPk: true, hasBraidFrames: false });

    // 5. A (sesi v2) membaca pesan v1 dari B → state v1 tidak pernah ditimpa.
    await page.bringToFront();
    await expectPeerReceivesMessage(page, messageBobV1, 40000);

    // 6. Rollback mempertahankan state braid (tidak menghapus apa pun).
    const braidState = await pageB.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const spqrState = await import('/src/lib/spqrState.ts');
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const { useConversationStore } = await import('/src/store/conversation.ts');
      const conversations = useConversationStore.getState().conversations as { id: string }[];
      const conversation = conversations[0];
      if (!conversation) return { found: false, version: null as string | null };
      const record = await spqrState.loadSpqrState(conversation.id);
      return { found: !!record, version: record?.version ?? null };
    }) as { found: boolean; version: string | null };
    expect(braidState.found, 'state braid terhapus oleh rollback').toBe(true);
    expect(braidState.version).toBe('v2');

    await contextB.close();
  });
});
