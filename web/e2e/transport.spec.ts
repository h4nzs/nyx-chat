// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// Spesifikasi jalur real-time (WebTransport). Secara otomatis SKIP bila
// browser environment tidak menyediakan WebTransport (mis. chromium
// headless-shell di beberapa Linux build, atau CI tanpa QUIC).
//
// Jalankan di environment yang mendukung: browser desktop normal / CI
// dengan Chrome penuh. Butuh sidecar WebTransport + server + DB + Redis.
import { test, expect } from '@playwright/test';
import {
  registerUser,
  supportsWebTransport,
  openDirectChatWith,
  sendChatMessage,
  expectPeerReceivesMessage,
} from './helpers/registration';


test.describe('Real-time Transport (WebTransport)', () => {
  test.setTimeout(300000);

  test('kirim pesan → terima di peer (latency end-to-end)', async ({ page, browser }) => {
    test.skip(!(await supportsWebTransport(page, { navigateToAppOrigin: true })), 'WebTransport tidak tersedia di environment ini');

    const usernameA = `wta_${Date.now()}`;
    const usernameB = `wtb_${Date.now()}`;
    await registerUser(page, 'Alice WT', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob WT', usernameB);

    // Alice mencari Bob & membuka chat
    await page.bringToFront();
    await openDirectChatWith(page, usernameB);

    const testMessage = `WT-latency-${Date.now()}`;
    const t0 = Date.now();
    await sendChatMessage(page, testMessage);

    // Optimistic bubble tampil cepat
    await expect(page.locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 5000 });
    const optimisticMs = Date.now() - t0;
    console.log(`[perf] optimistic bubble: ${optimisticMs}ms`);

    // Peer menerima via WebTransport real-time
    await pageB.bringToFront();
    await expectPeerReceivesMessage(pageB, testMessage);
    const endToEndMs = Date.now() - t0;
    console.log(`[perf] end-to-end receive: ${endToEndMs}ms`);

    // Regresi performa kasar: < 8 detik end-to-end di localhost (sangat longgar;
    // p95 asli diukur via instrumentasi dev [perf:transport]).
    expect(endToEndMs).toBeLessThan(8000);

    await contextB.close();
  });

  test('unsend: pengirim menghapus → pesan hilang di kedua sisi', async ({ page, browser }) => {
    test.skip(!(await supportsWebTransport(page, { navigateToAppOrigin: true })), 'WebTransport tidak tersedia di environment ini');

    const usernameA = `wuc_${Date.now()}`;
    const usernameB = `wud_${Date.now()}`;
    await registerUser(page, 'Alice U', usernameA);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await registerUser(pageB, 'Bob U', usernameB);

    await page.bringToFront();
    await openDirectChatWith(page, usernameB);

    const testMessage = `WT-unsend-${Date.now()}`;
    await sendChatMessage(page, testMessage);
    await expect(page.locator(`text=${testMessage}`).first()).toBeVisible({ timeout: 10000 });

    // Peer melihat pesan
    await pageB.bringToFront();
    const chatFromAlice = pageB.locator('div').filter({ hasText: testMessage }).first();
    await expect(chatFromAlice).toBeVisible({ timeout: 15000 });
    await chatFromAlice.click();

    // Pengirim unsend via store API (mengirim deleteSecret — server memverifikasi ownership)
    await page.bringToFront();
    const unsendResult = await page.evaluate(async (msgText) => {
      try {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { useMessageStore } = await import('/src/store/message.ts');
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { useConversationStore } = await import('/src/store/conversation.ts');
        const convs = useConversationStore.getState().conversations as { id: string }[];
        if (convs.length === 0) return 'NO_CONVERSATION';
        const conv = convs[0];
        if (!conv) return 'NO_CONVERSATION';
        const state = useMessageStore.getState();
        const target = ((state.messages as Record<string, { content: string | null; id: string }[]>)[conv.id] || []).find((m) => m.content === msgText);
        if (!target) return 'MESSAGE_NOT_FOUND';
        await state.sendMessage(conv.id, { content: JSON.stringify({ type: 'UNSEND', targetMessageId: target.id }), isSilent: true });
        return 'UNSEND_SENT';
      } catch (e) {
        return 'ERR: ' + (e instanceof Error ? e.message : String(e));
      }
    }, testMessage);
    console.log('unsend result:', unsendResult);

    // Kedua sisi menunjukkan tombstone "message deleted"
    await expect(page.getByText(/message deleted|deleted message/i).first()).toBeVisible({ timeout: 15000 });
    await pageB.bringToFront();
    await expect(pageB.getByText(/message deleted|deleted message/i).first()).toBeVisible({ timeout: 15000 });

    await contextB.close();
  });
});
