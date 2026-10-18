// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] `sendDeliveryReceipts` — receipt pesan yang BARU TIBA /
 * ter-sinkron harus `DELIVERED`, bukan `READ`.
 *
 * Kontrak yang dikunci di sini:
 *   1. Pesan yang tidak punya id/pengirim tidak ikut di-receipt (tanpa
 *      `targets` server tidak tahu ke siapa notifikasi dikirim).
 *   2. `targets` memetakan messageId → pengirim ASLI (senderId hasil dekripsi;
 *      wire 1:1 sealed-sender menyimpan NULL, jadi peta ini wajib).
 *   3. Dibatasi `RECEIPT_CHUNK_SIZE` per event = batas batch di server, dan
 *      pesan ganda tidak dihitung dua kali.
 *   4. Tidak ada yang layak → tidak ada event sama sekali (0), supaya jalur
 *      sinkronisasi tanpa pesan baru tidak mengirim batch kosong.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DELIVERY_RECEIPT_EVENT,
  RECEIPT_CHUNK_SIZE,
  sendDeliveryReceipts,
  type ReceiptEmitter,
} from '../deliveryReceipts';

function makeEmitter() {
  const calls: { event: string; data: unknown }[] = [];
  const emitter: ReceiptEmitter = {
    sendEvent: (event, data) => calls.push({ event, data }),
  };
  return { emitter, calls };
}

const msg = (id: string, senderId: string | null | undefined) => ({ id, senderId });

describe('sendDeliveryReceipts (receipt pesan tiba = DELIVERED)', () => {
  it('mengirim satu batch dengan targets messageId → pengirim', () => {
    const { emitter, calls } = makeEmitter();
    const sent = sendDeliveryReceipts(emitter, 'c1', [
      msg('m1', 'u1'),
      msg('m2', 'u2'),
    ]);

    expect(sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event).toBe(DELIVERY_RECEIPT_EVENT);
    expect(calls[0]!.data).toEqual({
      conversationId: 'c1',
      messageIds: ['m1', 'm2'],
      targets: { m1: 'u1', m2: 'u2' },
      readerPseudonym: undefined,
    });
  });

  it('membawa pseudonym pembaca bila diberikan', () => {
    const { emitter, calls } = makeEmitter();
    sendDeliveryReceipts(emitter, 'c1', [msg('m1', 'u1')], 'pseudo-1');
    expect((calls[0]!.data as { readerPseudonym?: string }).readerPseudonym).toBe('pseudo-1');
  });

  it('melewati pesan tanpa id / tanpa pengirim dan tidak mengirim apa pun bila kosong', () => {
    const { emitter, calls } = makeEmitter();
    const sent = sendDeliveryReceipts(emitter, 'c1', [
      msg('', 'u1'),
      msg('m1', null),
      msg('m2', undefined),
    ]);

    expect(sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('mendeduplikasi id yang sama (kiriman ulang) dalam satu batch', () => {
    const { emitter, calls } = makeEmitter();
    const sent = sendDeliveryReceipts(emitter, 'c1', [
      msg('m1', 'u1'),
      msg('m1', 'u1'),
    ]);

    expect(sent).toBe(1);
    expect((calls[0]!.data as { messageIds: string[] }).messageIds).toEqual(['m1']);
  });

  it('memecah menjadi beberapa chunk sesuai batas server', () => {
    const { emitter, calls } = makeEmitter();
    const total = RECEIPT_CHUNK_SIZE + 5;
    const messages = Array.from({ length: total }, (_, i) => msg(`m${i}`, 'u1'));

    const sent = sendDeliveryReceipts(emitter, 'c1', messages);

    expect(sent).toBe(2);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.data as { messageIds: string[] }).messageIds).toHaveLength(RECEIPT_CHUNK_SIZE);
    expect((calls[1]!.data as { messageIds: string[] }).messageIds).toHaveLength(5);
  });

  it('tidak pernah memakai nama event READ', () => {
    const sendEvent = vi.fn();
    sendDeliveryReceipts({ sendEvent }, 'c1', [msg('m1', 'u1')]);
    expect(sendEvent).toHaveBeenCalledWith('messages:mark_delivered', expect.anything());
    expect(sendEvent).not.toHaveBeenCalledWith('messages:mark_as_read', expect.anything());
  });
});
