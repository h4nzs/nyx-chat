import { db } from '../db';
import { base64UrlToBytes, bytesToBase64Url } from '../base64url';
import { decryptValueAtRest, encryptValueAtRest } from '../keychainDb';
import { createDexieKvStore } from './dexieStores';
import { createKeyStore } from './keyStore';
import type { KeyStore } from './types';

const DB_KEY_ID = 'keychain:sqlite-messages:key:v1';

let keyStore: KeyStore | null = null;

function getKeyStore(): KeyStore {
  if (!keyStore) {
    keyStore = createKeyStore(createDexieKvStore(db));
  }
  return keyStore;
}

/**
 * [docs/43 §43.11.6 B2] Kunci 32 byte untuk database SQLite pesan.
 *
 * Kunci disimpan di `kvStore` keychain sebagai byte dari envelope `ENC1:`
 * (masterSeed). Baris yang ada tetapi tidak bisa dibuka **tidak** diganti
 * dengan kunci baru: itu akan membuat database lama tampak kosong. Pemanggil
 * harus jatuh ke Dexie dan melaporkan error.
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
  const sealed = await encryptValueAtRest(bytesToBase64Url(key));
  await store.put(DB_KEY_ID, new TextEncoder().encode(sealed));
  return key;
}
