// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.3.2] E2E jalur ratchet braid SPQR v2 — satu-satunya bentuk wire,
// dijalankan lewat server + dua klien nyata.
//
// Yang dibuktikan (tidak bisa dibuktikan unit test):
//   1. Pesan pertama SUDAH v2 — tidak ada fase negosiasi/ackV lagi.
//   2. Amplop yang tersimpan server memuat `dr.v === 2` dengan frame braid dan
//      TANPA `kemPk`/`ct` jalur lama.
//   3. Peer bisa MEMBACA pesan v2 itu (plaintext muncul di UI kedua sisi).
//   4. Dua arah sepakat (A2B/B2A) pada sesi yang sama.
//
// Prasyarat: relay mengiklankan `spqr-ratchet` (sidecar WebTransport lewat HELLO
// bidi, atau gateway WSS lewat balasan `capabilities`). Spec SKIP dengan alasan
// tertulis bila deployment benar-benar mematikan kapabilitas itu.
import { test, expect, Page } from '@playwright/test';
import {
  registerUser,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';

/** Header DR satu pesan seperti yang tersimpan di server. */
interface WireHeader {
  v: unknown;
  hasKemPk: boolean;
  hasBraidFrames: boolean;
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
async function waitForCapabilities(page: Page, timeoutMs = 30000): Promise<string[]> {
  // Sinyal siap adalah `isCapabilityNegotiationDone()`, bukan "daftarnya tidak
  // kosong": jalur legacy (HELLO tidak dijawab dalam 5 dtk) juga menutup
  // negosiasi dengan daftar kosong. Membedakan keduanya penting supaya spec
  // tidak SKIP sendiri saat sidecar lambat menjawab.
  for (let attempt = 0; attempt < 2; attempt++) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = (await page.evaluate(async () => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const tc = await import('/src/lib/transportClient.ts');
        return { done: tc.isCapabilityNegotiationDone(), caps: tc.getNegotiatedCapabilities() };
      })) as { done: boolean; caps: string[] };
      if (state.done) {
        if (state.caps.length > 0) return state.caps;
        break;
      }
      await page.waitForTimeout(250);
    }
    // Negosiasi ditutup tanpa kapabilitas: koneksi kedua hampir selalu
    // dinegosiasikan normal. Satu muat ulang; kalau tetap kosong, biarkan
    // `test.skip` di bawah yang memutuskan (deployment memang mematikannya).
    if (attempt === 0) await page.reload({ waitUntil: 'domcontentloaded' });
  }
  return [];
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

  test('semua pesan v2 dan kedua sisi bisa membacanya', async ({ page, browser }) => {
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
      !caps.includes('spqr-ratchet'),
      `relay tidak mengiklankan spqr-ratchet (ternegosiasi: ${JSON.stringify(caps)})`
    );

    // Alice membuka percakapan dengan Bob (username persis → lolos gerbang
    // pencarian sandbox tanpa PoW).
    await page.bringToFront();
    await page.waitForTimeout(3000);
    await openDirectChatWith(page, usernameB, 20000);

    // --- 1. Pesan pertama Alice sudah v2 (braid A2B dari nol) --------------
    const messageA1 = `SPQR-a1-${Date.now()}`;
    await sendChatMessage(page, messageA1);
    await expect(page.locator(`text=${messageA1}`).first()).toBeVisible({ timeout: 20000 });

    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, messageA1, 40000);

    // --- 2. Balasan Bob juga v2 (braid B2A) --------------------------------
    const messageB1 = `SPQR-b1-${Date.now()}`;
    await sendChatMessage(pageB, messageB1);
    await expect(pageB.locator(`text=${messageB1}`).first()).toBeVisible({ timeout: 20000 });

    await page.bringToFront();
    await expectPeerReceivesMessage(page, messageB1, 40000);

    // --- 3. Bukti wire: SEMUA header di server adalah v2 -------------------
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
    })) as { error: string | null; headers: WireHeader[] };

    expect(wire.error, `gagal membaca amplop: ${wire.error}`).toBeNull();
    expect(wire.headers.length).toBeGreaterThanOrEqual(2);

    for (const header of wire.headers) {
      expect(header, 'header bukan v2 — jalur v1 tidak boleh ditulis lagi').toMatchObject({
        v: 2,
        hasBraidFrames: true,
        hasKemPk: false,
      });
    }

    await contextB.close();
  });
});
