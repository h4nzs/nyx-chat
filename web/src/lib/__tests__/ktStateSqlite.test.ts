// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B2] State KT di KvStore SQLite.
 *
 * Dexie sengaja dibuat melempar supaya jalur SQLite tidak diam-diam menulis ke
 * dua tempat. Marker hidrasi sudah dipasang agar tes tidak mencoba membaca
 * Dexie untuk migrasi awal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvRows, authState } = vi.hoisted(() => ({
  kvRows: new Map<string, unknown>(),
  authState: { userId: 'user-kt-sqlite' as string | undefined },
}));

const kv = {
  get: async <T,>(key: string) => kvRows.get(key) as T | undefined,
  put: async (item: { key: string; value: unknown }) => {
    kvRows.set(item.key, item.value);
  },
  delete: async (key: string) => {
    kvRows.delete(key);
  },
  clear: async () => {
    kvRows.clear();
  },
  keys: async () => [...kvRows.keys()],
};

const dexieTouch = (table: string) => () => {
  throw new Error(`Dexie tidak boleh disentuh di jalur KT SQLite (${table})`);
};

vi.mock('../storage/sqliteMessages', () => ({
  openSqliteKvStore: async () => kv,
}));

vi.mock('../db', () => ({
  db: {
    get ktMonitoring() { return dexieTouch('ktMonitoring')(); },
    get ktConfig() { return dexieTouch('ktConfig')(); },
    get ktGossip() { return dexieTouch('ktGossip')(); },
  },
}));

vi.mock('../keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  deriveKtSearchIndexKey: async () => new Uint8Array(32).fill(1),
  encryptValueAtRest: async (value: string) => `ENC1:${value}`,
  decryptValueAtRest: async (value: string) =>
    value.startsWith('ENC1:') ? value.slice('ENC1:'.length) : value,
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: async () => ({
    crypto_generichash: () => new Uint8Array(32).fill(9),
  }),
}));

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: authState.userId ? { id: authState.userId } : null }),
  },
}));

vi.stubEnv('VITE_SQLITE_MESSAGES', '1');

const { loadKtStates, saveKtState } = await import('../ktMonitoring');
const { loadKtConfigPin, saveKtConfigPin } = await import('../ktConfigPin');
const {
  loadStoredAnchor,
  resetKtGossipForTests,
  storeAnchor,
} = await import('../ktGossip');

function seedMarkers(): void {
  kvRows.clear();
  kvRows.set('meta:kt:monitoring:hydrated:v1', true);
  kvRows.set('meta:kt:config:hydrated:v1', true);
  kvRows.set('meta:kt:gossip:hydrated:v1', true);
}

const installPin = {
  abiVersion: 2 as const,
  mode: 1,
  signatureKey: 'a'.repeat(3904),
  auditorKeys: [],
};

describe('state KT di KvStore SQLite', () => {
  beforeEach(() => {
    seedMarkers();
    authState.userId = 'user-kt-sqlite';
    resetKtGossipForTests();
  });

  it('monitoring: save/load membaca baris SQLite, bukan Dexie', async () => {
    const searchKey = Uint8Array.from([1, 2, 3]);
    await saveKtState({ searchKey, keyVersion: 7, treeSize: 123 });

    expect([...kvRows.keys()].some((key) => key.startsWith('kt:mon:'))).toBe(true);
    const states = await loadKtStates();
    expect(states).toHaveLength(1);
    expect(states[0]?.searchKey).toEqual(searchKey);
    expect(states[0]?.keyVersion).toBe(7);
    expect(states[0]?.treeSize).toBe(123);
  });

  it('config pin: save/load memakai prefix per akun di SQLite', async () => {
    await saveKtConfigPin(installPin);

    expect(kvRows.has('kt:config:kt-config:user-kt-sqlite')).toBe(true);
    const loaded = await loadKtConfigPin();
    expect(loaded).toEqual(installPin);
  });

  it('gossip: jangkar bertahan di SQLite tanpa menyentuh Dexie', async () => {
    const anchor = { root: 'a'.repeat(64), treeSize: 42 };
    await storeAnchor(anchor);

    expect(kvRows.has('kt:gossip:peers')).toBe(true);
    expect(await loadStoredAnchor()).toEqual(anchor);
  });
});
