// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.2] Mailbox grup — kontrak klien.
 *
 * Yang dikunci di sini:
 *   1. Tag alamat = HMAC-SHA256(member token) → 43 char base64url (regex server),
 *      deterministik dan berbeda per token.
 *   2. Envelope dikirim per penerima dengan tag-nya + hint perangkat (satu user,
 *      beberapa device → tag sama, envelope berbeda).
 *   3. Batch yang hanya tertulis sebagian TIDAK dianggap terkirim (pemanggil
 *      harus fallback, kalau tidak kunci hilang tanpa gejala).
 *   4. Penerima hanya memproses item ber-tag miliknya dan meneruskannya ke
 *      `storeReceivedSessionKey` dengan field yang benar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const groupToken = { value: 'GROUP_TOKEN' as string | undefined };
const deliveryTokens: { value: Record<string, string> | undefined } = { value: undefined };
const myDeliveryToken = { value: 'MY_TOKEN' as string | undefined };

type ApiCall = [string, { method?: string; body?: string; anonymous?: boolean }];
const apiMock = vi.fn<(...args: ApiCall) => Promise<unknown>>();

vi.mock('@lib/api', () => ({
  api: (...args: unknown[]) => (apiMock as unknown as (...inner: unknown[]) => Promise<unknown>)(...args),
}));
vi.mock('@lib/groupPseudonyms', () => ({
  getMyGroupToken: () => groupToken.value,
  getDeliveryTokenMap: () => deliveryTokens.value,
  getMyDeliveryToken: () => myDeliveryToken.value,
}));

const storeReceivedSessionKey = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('@utils/crypto', () => ({
  storeReceivedSessionKey: (...args: unknown[]) => storeReceivedSessionKey(...args),
  getMyEncryptionKeyPair: async () => ({ publicKey: new Uint8Array(32) }),
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: async () => ({
    base64_variants: { URLSAFE_NO_PADDING: 0 },
    to_base64: () => 'MY_DEVICE_KEY',
  }),
}));

const {
  MAILBOX_TAG_LABEL,
  decodeMailboxPayload,
  deriveMailboxTag,
  encodeMailboxPayload,
  postGroupKeyEnvelopes,
  processGroupMailbox,
  pullGroupMailbox,
  resetGroupMailboxStateForTests,
  startGroupMailboxLoop,
} = await import('@lib/groupMailbox');

beforeEach(() => {
  apiMock.mockReset();
  storeReceivedSessionKey.mockClear();
  groupToken.value = 'GROUP_TOKEN';
  deliveryTokens.value = undefined;
  myDeliveryToken.value = 'MY_TOKEN';
  resetGroupMailboxStateForTests();
});

describe('deriveMailboxTag', () => {
  it('menghasilkan 43 char base64url yang deterministik', async () => {
    const a = await deriveMailboxTag('token-a');
    const b = await deriveMailboxTag('token-a');
    const c = await deriveMailboxTag('token-b');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('tidak punya tag tanpa member token', async () => {
    expect(await deriveMailboxTag(undefined)).toBeUndefined();
    expect(await deriveMailboxTag(null)).toBeUndefined();
  });

  it('memakai label yang sama dengan dokumentasi server', () => {
    expect(MAILBOX_TAG_LABEL).toBe('nyx-mailbox-v1');
  });
});

describe('payload base64url', () => {
  it('roundtrip JSON dan menolak payload di atas 8 KB', () => {
    const encoded = encodeMailboxPayload({ k: 'cipher', t: 'dev' });
    expect(encoded).toBeTruthy();
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMailboxPayload(encoded as string)).toEqual({ k: 'cipher', t: 'dev' });

    const tooBig = encodeMailboxPayload({ k: 'x'.repeat(9 * 1024) });
    expect(tooBig).toBeNull();
    expect(decodeMailboxPayload('%%%')).toBeNull();
    expect(decodeMailboxPayload('')).toBeNull();
  });
});

describe('postGroupKeyEnvelopes', () => {
  it('memakai mailbox per penerima dengan tag + hint perangkat', async () => {
    deliveryTokens.value = { userA: 'token-a', userB: 'token-b' };
    apiMock.mockResolvedValue({ written: 2 });

    const delivered = await postGroupKeyEnvelopes('conv-1', [
      { userId: 'userA', key: 'sealed-a', targetDeviceKey: 'dev-a', senderId: 'pseudo-me', senderDeviceKey: 'my-dev' },
      { userId: 'userB', key: 'sealed-b', targetDeviceKey: 'dev-b', senderId: 'pseudo-me', senderDeviceKey: 'my-dev' },
    ]);

    expect([...delivered].sort()).toEqual(['userA', 'userB']);
    expect(storeReceivedSessionKey).not.toHaveBeenCalled();

    const [path, options] = apiMock.mock.calls[0]!;
    expect(path).toBe('/api/groups/conv-1/mailbox');
    expect(options.method).toBe('POST');
    expect(options.anonymous).toBe(true);

    const body = JSON.parse(options.body as string) as { token: string; items: Array<{ kind: string; tag?: string; payload: string }> };
    expect(body.token).toBe('GROUP_TOKEN');
    expect(body.items).toHaveLength(2);
    expect(body.items.map(item => item.kind)).toEqual(['KEY_ENVELOPE', 'KEY_ENVELOPE']);
    expect(body.items[0]!.tag).toBe(await deriveMailboxTag('token-a'));
    expect(decodeMailboxPayload(body.items[0]!.payload)).toMatchObject({
      k: 'sealed-a', t: 'dev-a', sp: 'pseudo-me', sd: 'my-dev',
    });
  });

  it('penerima yang dipaksa lewat realtime tidak dialamatkan/dianggap terkirim', async () => {
    deliveryTokens.value = { userA: 'token-a', userB: 'token-b' };
    apiMock.mockResolvedValue({ written: 1 });

    const delivered = await postGroupKeyEnvelopes('conv-1', [
      { userId: 'userA', key: 'sealed-a' },
      { userId: 'userB', key: 'sealed-b' },
    ], new Set(['userB']));

    expect([...delivered]).toEqual(['userA']);
    const body = JSON.parse(apiMock.mock.calls[0]![1].body as string) as { items: Array<{ tag?: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.tag).toBe(await deriveMailboxTag('token-a'));
  });

  it('tidak mengirim apa pun tanpa peta token / group token', async () => {
    deliveryTokens.value = undefined;
    expect((await postGroupKeyEnvelopes('conv-1', [{ userId: 'userA', key: 'k' }])).size).toBe(0);
    expect(apiMock).not.toHaveBeenCalled();

    deliveryTokens.value = { userA: 'token-a' };
    groupToken.value = undefined;
    expect((await postGroupKeyEnvelopes('conv-1', [{ userId: 'userA', key: 'k' }])).size).toBe(0);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('batch yang tertulis sebagian dianggap GAGAL (supaya fallback jalan)', async () => {
    deliveryTokens.value = { userA: 'token-a', userB: 'token-b' };
    apiMock.mockResolvedValue({ written: 1 });

    const delivered = await postGroupKeyEnvelopes('conv-1', [
      { userId: 'userA', key: 'sealed-a' },
      { userId: 'userB', key: 'sealed-b' },
    ]);
    expect(delivered.size).toBe(0);
  });

  it('error server tidak melempar ke jalur kirim', async () => {
    deliveryTokens.value = { userA: 'token-a' };
    apiMock.mockRejectedValue(new Error('403 GROUP_AUTH_REQUIRED'));

    const delivered = await postGroupKeyEnvelopes('conv-1', [{ userId: 'userA', key: 'sealed-a' }]);
    expect(delivered.size).toBe(0);
  });
});

describe('processGroupMailbox', () => {
  function envelopePayload (target?: string) {
    return encodeMailboxPayload({
      k: 'sealed-key',
      ...(target ? { t: target } : {}),
      sp: 'sender-pseudonym',
      sd: 'sender-device',
      ss: 'sender-signing',
      ss2: 'sender-signing-v2',
    }) as string;
  }

  it('hanya memproses envelope ber-tag milik saya dan meneruskannya ke store', async () => {
    const myTag = await deriveMailboxTag('MY_TOKEN');
    apiMock.mockResolvedValue({
      epoch: 3,
      items: [
        { id: 'item-1', kind: 'KEY_ENVELOPE', tag: myTag, payload: envelopePayload('MY_DEVICE_KEY'), createdAt: '2026-10-24T00:00:00.000Z' },
        { id: 'item-2', kind: 'KEY_ENVELOPE', tag: 'OTHER_TAG_OTHER_TAG_OTHER_TAG_OTHER_TAG_1', payload: envelopePayload(), createdAt: '2026-10-24T00:00:01.000Z' },
        { id: 'item-3', kind: 'KEY_ENVELOPE', tag: myTag, payload: envelopePayload('OTHER_DEVICE'), createdAt: '2026-10-24T00:00:02.000Z' },
        { id: 'item-4', kind: 'META', tag: myTag, payload: envelopePayload(), createdAt: '2026-10-24T00:00:03.000Z' },
      ],
      nextCursor: '2026-10-24T00:00:03.000Z',
      truncated: false,
    });

    const handled = await processGroupMailbox('conv-1');

    expect(handled).toBe(1);
    expect(storeReceivedSessionKey).toHaveBeenCalledTimes(1);
    expect(storeReceivedSessionKey).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      encryptedKey: 'sealed-key',
      type: 'GROUP_KEY',
      senderId: 'sender-pseudonym',
      senderDeviceKey: 'sender-device',
      senderSigningKey: 'sender-signing',
      senderSigningKeyV2: 'sender-signing-v2',
    });

    const [, options] = apiMock.mock.calls[0]!;
    expect(JSON.parse(options.body as string)).toEqual({ token: 'GROUP_TOKEN' });
  });

  it('memakai cursor halaman sebelumnya dan tidak memproses ulang item', async () => {
    apiMock.mockResolvedValue({
      epoch: 0,
      items: [{ id: 'item-1', kind: 'COVER', payload: 'e30', createdAt: '2026-10-24T00:00:00.000Z' }],
      nextCursor: 'CURSOR-1',
      truncated: false,
    });

    await processGroupMailbox('conv-1');
    await processGroupMailbox('conv-1');

    const secondBody = JSON.parse(apiMock.mock.calls[1]![1].body as string);
    expect(secondBody).toEqual({ token: 'GROUP_TOKEN', cursor: 'CURSOR-1' });
  });

  it('tanpa group token maupun member token tidak memanggil server', async () => {
    groupToken.value = undefined;
    myDeliveryToken.value = undefined;
    expect(await processGroupMailbox('conv-1')).toBe(0);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('pull memakai member token saat group token sudah mati (rotasi)', async () => {
    groupToken.value = undefined;
    apiMock.mockResolvedValue({ epoch: 2, items: [], nextCursor: null, truncated: false });

    await pullGroupMailbox('conv-1');

    const [, options] = apiMock.mock.calls[0]!;
    expect(options.anonymous).toBe(true);
    expect(JSON.parse(options.body as string)).toEqual({ token: 'MY_TOKEN' });
  });

  it('pullGroupMailbox menormalkan halaman yang tidak lengkap', async () => {
    apiMock.mockResolvedValue({});
    expect(await pullGroupMailbox('conv-1')).toEqual({ epoch: 0, items: [], nextCursor: null, truncated: false });
  });

  it('token era lama (403) bukan kegagalan yang perlu dilaporkan', async () => {
    apiMock.mockRejectedValue(Object.assign(new Error('GROUP_AUTH_REQUIRED'), { status: 403 }));
    expect(await processGroupMailbox('conv-1')).toBe(0);

    // Kegagalan lain tetap naik supaya loop bisa mencatatnya.
    apiMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(processGroupMailbox('conv-1')).rejects.toThrow('boom');
  });
});

describe('startGroupMailboxLoop', () => {
  it('memproses tiap grup dan berhenti saat stop() dipanggil', async () => {
    vi.useFakeTimers();
    try {
      const process = vi.fn<(conversationId: string) => Promise<number>>(async () => 0);
      const stop = startGroupMailboxLoop({
        intervalMs: 5_000,
        listGroups: () => ['conv-1', 'conv-2'],
        process,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.mock.calls.map(call => call[0])).toEqual(['conv-1', 'conv-2']);

      stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(process).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gagal di satu grup tidak menghentikan grup berikutnya', async () => {
    vi.useFakeTimers();
    try {
      const process = vi.fn<(conversationId: string) => Promise<void>>(async (conversationId: string) => {
        if (conversationId === 'conv-1') throw new Error('boom');
      });
      const stop = startGroupMailboxLoop({
        intervalMs: 5_000,
        listGroups: () => ['conv-1', 'conv-2'],
        process,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.mock.calls.map(call => call[0])).toEqual(['conv-1', 'conv-2']);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
