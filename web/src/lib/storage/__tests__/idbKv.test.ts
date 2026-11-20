// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B3] Vault IDB mentah untuk kunci database SQLite.
 *
 * Dibuat khusus supaya kunci DB tidak lagi bergantung pada Dexie. Tes memakai
 * `fake-indexeddb` dan mengunci operasi yang dipakai `dbKey`/wipe.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { keyVault } from '../idbKv';

describe('keyVault (IndexedDB mentah)', () => {
  it('menyimpan, membaca, dan menghapus nilai', async () => {
    await keyVault.put({ key: 'a', value: new Uint8Array([1, 2, 3]) });
    const value = await keyVault.get<Uint8Array>('a');
    expect(Array.from(value ?? [])).toEqual([1, 2, 3]);
    expect(await keyVault.keys()).toContain('a');

    await keyVault.delete('a');
    expect(await keyVault.get('a')).toBeUndefined();
  });

  it('deleteByPrefix hanya menghapus kunci yang cocok', async () => {
    await keyVault.put({ key: 'keychain:x:1', value: 1 });
    await keyVault.put({ key: 'keychain:x:2', value: 2 });
    await keyVault.put({ key: 'lain', value: 3 });

    await keyVault.deleteByPrefix('keychain:x:');

    expect(await keyVault.keys()).toEqual(['lain']);
  });

  it('clear mengosongkan vault', async () => {
    await keyVault.put({ key: 'k', value: 'v' });
    await keyVault.clear();
    expect(await keyVault.keys()).toEqual([]);
  });
});
