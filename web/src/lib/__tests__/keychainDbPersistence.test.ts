// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [PQ v4 Fase 1.5 — AUDIT 2026-10-20] Regresi kelas bug "field crypto hilang
 * diam-diam di lapisan persistensi".
 *
 * `keychainDb` menyimpan state ratchet grup dengan mapper field-by-field. Dulu
 * `signingKeyV2`/`senderKeyId` tidak ada di daftar itu, sehingga kunci
 * verifikasi ML-DSA yang sudah terikat saat distribusi kunci hilang setiap
 * state dibaca ulang → pesan/metadata grup `sigV:2` gagal dengan
 * "Missing sender signing key v2". Test ini mengunci round-trip penuh untuk
 * state penerima DAN pengirim (termasuk arsip multi-era).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id?: string; conversationId?: string; state: Record<string, unknown> };

const { kvRows, kvStore } = vi.hoisted(() => {
  const kvRows = new Map<string, { key: string; value: unknown }>();
  const kvStore = {
    // Seperti tabel Dexie: `get` mengembalikan record `{key, value}`;
    // `createDexieKvStore` yang membuka `.value` untuk `createKeyStore`.
    get: async (key: string) => kvRows.get(key),
    put: async (item: { key: string; value: unknown }) => { kvRows.set(item.key, item); },
    delete: async (key: string) => { kvRows.delete(key); },
    clear: async () => { kvRows.clear(); },
    where: () => ({ startsWith: () => ({ delete: async () => {} }) }),
    toCollection: () => ({ primaryKeys: async () => [...kvRows.keys()] }),
  };
  return { kvRows, kvStore };
});

vi.mock('../db', () => ({
  db: {
    kvStore,
    isOpen: () => true,
    close: () => {},
  },
  VaultEntry: {},
}));

// [audit D7] Penulisan at-rest fail-closed: tanpa masterSeed, `encryptValueAtRest`
// MELEMPAR (dulu nilai disimpan plaintext). Test ini karena itu menyediakan seed
// + stub crypto supaya mapper field diuji pada jalur yang sebenarnya dipakai.
vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ getMasterSeedIfUnlocked: () => new Uint8Array(32).fill(3) }),
  },
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
  // Simetris: seal = balik byte, open = balik lagi → round-trip mudah diperiksa.
  worker_encrypt_session_key: async (bytes: Uint8Array) => bytes.slice().reverse(),
  worker_decrypt_session_key: async (bytes: Uint8Array) => bytes.slice().reverse(),
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: async () => ({
    // Lingkungan test tidak punya 'base64url'; bentuk URL-safe disusun manual.
    to_base64: (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    from_base64: (value: string) =>
      new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  }),
}));

import {
  saveGroupReceiverState,
  getGroupReceiverState,
  listGroupReceiverStates,
  archiveGroupReceiverState,
  saveGroupSenderState,
  getGroupSenderState,
} from '../keychainDb';

const CONV = '11111111-2222-4333-8444-555555555555';
const SENDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const RECEIVER_STATE = {
  id: `${CONV}_device-key`,
  conversationId: CONV,
  senderId: SENDER,
  CK: 'chain-key-b64',
  N: 3,
  eraCK: 'era-ck-b64',
  chainId: 'era-chain',
  metadataKey: 'meta-key-b64',
  skippedKeys: { '1': 'mk-one', '2': 'mk-two' },
  signingKey: 'ed25519-pub-b64',
  signingKeyV2: 'ml-dsa-65-pub-b64',
  senderKeyId: 'sender-key-id-b64',
} as const;

const SENDER_STATE = {
  conversationId: CONV,
  CK: 'my-chain-key-b64',
  N: 7,
  initialCK: 'my-initial-ck-b64',
  chainId: 'my-era-chain',
  metadataKey: 'my-meta-key-b64',
  createdAt: 1_700_000_000_000,
  messageCount: 7,
  lastActivityTime: 1_700_000_100_000,
  requiresImmediateRotation: false,
  signingKeyV2: 'my-ml-dsa-65-pub-b64',
} as const;

beforeEach(() => {
  kvRows.clear();
});

describe('GroupReceiverState persistence', () => {
  it('round-trip mempertahankan signingKeyV2 dan senderKeyId', async () => {
    await saveGroupReceiverState(RECEIVER_STATE as never);
    const loaded = await getGroupReceiverState(CONV, SENDER, 'device-key');

    expect(loaded).not.toBeNull();
    expect(loaded!.signingKeyV2).toBe(RECEIVER_STATE.signingKeyV2);
    expect(loaded!.senderKeyId).toBe(RECEIVER_STATE.senderKeyId);
  });

  it('round-trip mempertahankan seluruh field ratchet dan signing key v1', async () => {
    await saveGroupReceiverState(RECEIVER_STATE as never);
    const loaded = await getGroupReceiverState(CONV, SENDER, 'device-key');

    expect(loaded).toMatchObject({
      id: RECEIVER_STATE.id,
      conversationId: CONV,
      senderId: SENDER,
      CK: RECEIVER_STATE.CK,
      N: RECEIVER_STATE.N,
      eraCK: RECEIVER_STATE.eraCK,
      chainId: RECEIVER_STATE.chainId,
      metadataKey: RECEIVER_STATE.metadataKey,
      skippedKeys: RECEIVER_STATE.skippedKeys,
      signingKey: RECEIVER_STATE.signingKey,
      signingKeyV2: RECEIVER_STATE.signingKeyV2,
      senderKeyId: RECEIVER_STATE.senderKeyId,
    });
  });

  it('listGroupReceiverStates juga membawa kunci v2 (jalur routing era)', async () => {
    await saveGroupReceiverState(RECEIVER_STATE as never);
    const all = await listGroupReceiverStates(CONV);

    expect(all).toHaveLength(1);
    expect(all[0]!.signingKeyV2).toBe(RECEIVER_STATE.signingKeyV2);
    expect(all[0]!.senderKeyId).toBe(RECEIVER_STATE.senderKeyId);
  });

  it('nilai yang tersimpan benar-benar ter-seal (bukan plaintext) — [audit D7]', async () => {
    await saveGroupReceiverState(RECEIVER_STATE as never);
    const stored = kvRows.get(`gr:${RECEIVER_STATE.id}`)!.value as { v: string };
    const row = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(Buffer.from(stored.v.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    )) as Row;
    const state = row.state as Record<string, unknown>;

    expect(String(state.CK).startsWith('ENC1:')).toBe(true);
    expect(String(state.CK)).not.toContain(RECEIVER_STATE.CK);
    expect(String(state.metadataKey).startsWith('ENC1:')).toBe(true);
  });

  it('archiveGroupReceiverState tidak membuang kunci v2', async () => {
    await saveGroupReceiverState(RECEIVER_STATE as never);
    const active = await getGroupReceiverState(CONV, SENDER, 'device-key');
    await archiveGroupReceiverState(active!);

    const all = await listGroupReceiverStates(CONV);
    const archived = all.find(s => s.id.includes('#era_'));
    expect(archived).toBeDefined();
    expect(archived!.signingKeyV2).toBe(RECEIVER_STATE.signingKeyV2);
    expect(archived!.senderKeyId).toBe(RECEIVER_STATE.senderKeyId);
  });
});

describe('GroupSenderState persistence', () => {
  it('round-trip mempertahankan signingKeyV2', async () => {
    await saveGroupSenderState(SENDER_STATE as never);
    const loaded = await getGroupSenderState(CONV);

    expect(loaded).not.toBeNull();
    expect(loaded!.signingKeyV2).toBe(SENDER_STATE.signingKeyV2);
  });

  it('round-trip mempertahankan seluruh field ratchet pengirim', async () => {
    await saveGroupSenderState(SENDER_STATE as never);
    const loaded = await getGroupSenderState(CONV);

    expect(loaded).toMatchObject({
      conversationId: CONV,
      CK: SENDER_STATE.CK,
      N: SENDER_STATE.N,
      initialCK: SENDER_STATE.initialCK,
      chainId: SENDER_STATE.chainId,
      metadataKey: SENDER_STATE.metadataKey,
      createdAt: SENDER_STATE.createdAt,
      messageCount: SENDER_STATE.messageCount,
      lastActivityTime: SENDER_STATE.lastActivityTime,
      requiresImmediateRotation: SENDER_STATE.requiresImmediateRotation,
      signingKeyV2: SENDER_STATE.signingKeyV2,
    });
  });
});
