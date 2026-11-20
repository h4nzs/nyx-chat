import { base64UrlToBytes, bytesToBase64Url } from '../base64url';
import { decryptValueAtRest, encryptValueAtRest } from '../keychainDb';
import { keyVault } from './idbKv';
import { createKeyStore } from './keyStore';
import type { KeyStore } from './types';

const DB_KEY_ID = 'keychain:sqlite-messages:key:v1';

let keyStore: KeyStore | null = null;

function getKeyStore(): KeyStore {
  if (!keyStore) {
    keyStore = createKeyStore(keyVault);
  }
  return keyStore;
}

/**
 * [docs/43 §43.11.6 B3] Kunci 32 byte untuk database SQLite pesan.
 *
 * Disimpan di IndexedDB mentah (`nyx-key-vault`), **bukan** di database SQLite
 * yang dibuka oleh kunci ini dan bukan lagi di `kvStore` Dexie: lokasi lama
 * membuat Dexie tidak bisa dihapus. Nilainya tetap ter-seal `ENC1:` dengan
 * masterSeed, jadi bootstrap hanya boleh terjadi setelah vault terbuka.
 *
 * Baris yang ada tetapi tidak bisa dibuka **tidak** diganti dengan kunci baru:
 * itu akan membuat database lama tampak kosong. Pemanggil harus jatuh ke Dexie
 * dan melaporkan error.
 */
export async function getSqliteMessagesKey(): Promise<Uint8Array> {
  const store = getKeyStore();
  const sealedBytes = await store.get(DB_KEY_ID);

  if (sealedBytes) {
    const sealed = new TextDecoder().decode(sealedBytes);
    const plain = await decryptValueAtRest(sealed);
    if (!plain) {
      throw new Error('Kunci database SQLite tidak dapat dibuka (vault terkunci atau rusak)');
    }
    const key = base64UrlToBytes(plain);
    if (key.length !== 32) {
      throw new Error('Kunci database SQLite tidak valid');
    }
    return key;
  }

  const key = crypto.getRandomValues(new Uint8Array(32));
  await persistSqliteMessagesKey(key);
  return key;
}

/**
 * Simpan kunci DB (dipakai restore: database baru memakai kunci dari arsip).
 * Melempar bila vault terkunci — restore tidak boleh lanjut dengan kunci yang
 * tidak bisa dibuka lagi setelah reload.
 */
export async function persistSqliteMessagesKey(key: Uint8Array): Promise<void> {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error('Kunci database SQLite tidak valid');
  }
  const sealed = await encryptValueAtRest(bytesToBase64Url(key));
  await getKeyStore().put(DB_KEY_ID, new TextEncoder().encode(sealed));
}

/** Wipe/panic: kunci ikut hilang bersama database SQLite-nya. */
export async function clearSqliteMessagesKey(): Promise<void> {
  await getKeyStore().delete(DB_KEY_ID);
}
