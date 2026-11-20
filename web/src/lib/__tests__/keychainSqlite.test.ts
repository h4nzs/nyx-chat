// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B2] Keychain bertipe di KeyStore SQLite/OPFS.
 *
 * Yang dikunci di sini: saat `openSqliteKeyStore()` tersedia, lima kelompok
 * kunci hot path memakai KeyStore (bukan Dexie) dan semantik lamanya tetap:
 * sesi terbaru = nama terbesar, arsip ratchet FIFO 3 slot, cap LRU 200 untuk
 * skipped key, dan prefix antar tabel tidak saling menabrak.
 *
 * Dexie sengaja di-mock agar SETIAP akses tabel melempar — jalur SQLite yang
 * diam-diam menyentuh Dexie harus terlihat sebagai kegagalan, bukan lolos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KvStore, KeyStore } from '../storage/types';
import { createKeyStore } from '../storage/keyStore';

const dexieTouch = (table: string) => () => {
  throw new Error(`Dexie tidak boleh disentuh di jalur KeyStore (${table})`);
};

vi.mock('@lib/db', () => ({
  db: {
    get sessionKeys() { return dexieTouch('sessionKeys')(); },
    get groupKeys() { return dexieTouch('groupKeys')(); },
    get ratchetSessions() { return dexieTouch('ratchetSessions')(); },
    get skippedKeys() { return dexieTouch('skippedKeys')(); },
    get groupSkippedKeys() { return dexieTouch('groupSkippedKeys')(); },
  },
  VaultEntry: class {},
}));

let keyStore: KeyStore | null = null;

vi.mock('@lib/storage/sqliteMessages', () => ({
  openSqliteKeyStore: async () => keyStore,
}));

const {
  addSessionKey,
  getSessionKey,
  getLatestSessionKey,
  deleteSessionKeys,
  storeGroupKey,
  getGroupKey,
  deleteGroupKey,
  storeRatchetSession,
  getRatchetSession,
  getArchivedRatchetSessions,
  deleteRatchetSession,
  storeSkippedKey,
  getSkippedKey,
  getGroupSkippedKey,
  deleteGroupSkippedKey,
} = await import('../keychainDb');

function memoryKv(): KvStore {
  const rows = new Map<string, unknown>();
  return {
    get: async <T,>(key: string) => rows.get(key) as T | undefined,
    put: async (item) => { rows.set(item.key, item.value); },
    delete: async (key) => { rows.delete(key); },
    deleteByPrefix: async (prefix) => {
      for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key);
    },
    clear: async () => { rows.clear(); },
    keys: async () => [...rows.keys()],
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
/** Byte dari realm tes (bukan `TextEncoder` jsdom) supaya `instanceof` KeyStore berlaku. */
const utf8 = (value: string) => Uint8Array.from(new TextEncoder().encode(value));

describe('keychain di KeyStore SQLite', () => {
  beforeEach(() => {
    keyStore = createKeyStore(memoryKv());
  });

  afterEach(() => {
    keyStore = null;
  });

  it('session key: get, latest = nama terbesar, dan delete per percakapan', async () => {
    await addSessionKey('c1', 's2', bytes(2));
    await addSessionKey('c1', 's1', bytes(1));
    await addSessionKey('c1', 's10', bytes(10));
    await addSessionKey('c2', 's1', bytes(9));

    expect(await getSessionKey('c1', 's1')).toEqual(bytes(1));
    expect(await getSessionKey('c1', 'tidak-ada')).toBeNull();

    const latest = await getLatestSessionKey('c1');
    expect(latest?.sessionId).toBe('s2');
    expect(latest?.key).toEqual(bytes(2));

    // Group key untuk percakapan yang sama tidak boleh ikut terhapus: prefix
    // `sess:` dan `gkey:` memisahkan keduanya di satu KeyStore.
    await storeGroupKey('c1', bytes(7));
    await deleteSessionKeys('c1');
    expect(await getSessionKey('c1', 's1')).toBeNull();
    expect(await getGroupKey('c1')).toEqual(bytes(7));
    expect(await getSessionKey('c2', 's1')).toEqual(bytes(9));
  });

  it('group key: simpan, baca, hapus', async () => {
    await storeGroupKey('g1', bytes(1, 2, 3));
    expect(await getGroupKey('g1')).toEqual(bytes(1, 2, 3));
    await deleteGroupKey('g1');
    expect(await getGroupKey('g1')).toBeNull();
  });

  it('ratchet: state aktif + arsip FIFO 3 slot, dan hapus membersihkan semuanya', async () => {
    await storeRatchetSession('r1', bytes(1));
    await storeRatchetSession('r1', bytes(2));
    await storeRatchetSession('r1', bytes(3));
    await storeRatchetSession('r1', bytes(4));

    expect(await getRatchetSession('r1')).toEqual(bytes(4));
    const archived = await getArchivedRatchetSessions('r1');
    expect(archived.map(text)).toEqual([text(bytes(3)), text(bytes(2)), text(bytes(1))]);

    // FIFO: state tertua (1) keluar setelah penulisan ke-5.
    await storeRatchetSession('r1', bytes(5));
    expect((await getArchivedRatchetSessions('r1')).map(text)).toEqual([
      text(bytes(4)),
      text(bytes(3)),
      text(bytes(2)),
    ]);

    await deleteRatchetSession('r1');
    expect(await getRatchetSession('r1')).toBeNull();
    expect(await getArchivedRatchetSessions('r1')).toEqual([]);
  });

  it('skipped key: cap 200 per percakapan, yang tertua dibuang', async () => {
    for (let index = 0; index < 205; index += 1) {
      await storeSkippedKey(`sk1_dev_${index}`, bytes(index % 256));
    }

    expect(await getSkippedKey('sk1_dev_204')).toEqual(bytes(204 % 256));
    expect(await getSkippedKey('sk1_dev_0')).toBeNull();
    expect(await getSkippedKey('sk1_dev_4')).toBeNull();
    expect(await getSkippedKey('sk1_dev_5')).not.toBeNull();
  });

  it('group skipped key: exact, fallback tanpa keyId, scan suffix, dan hapus', async () => {
    await keyStore!.put('gskip:c1_sender_dev1_7', utf8('mk-exact'));

    expect(await getGroupSkippedKey('c1', 'sender', 'dev1', 7)).toBe('mk-exact');
    expect(await getGroupSkippedKey('c1', 'sender', 'dev1', 7, 'k9')).toBe('mk-exact');
    expect(await getGroupSkippedKey('c1', 'sender', undefined, 7)).toBe('mk-exact');
    expect(await getGroupSkippedKey('c1', 'sender', 'dev2', 7)).toBeNull();

    await deleteGroupSkippedKey('c1', 'sender', 'dev1', 7);
    expect(await getGroupSkippedKey('c1', 'sender', 'dev1', 7)).toBeNull();
  });
});
