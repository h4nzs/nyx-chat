import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';

export class KVRepository {
  static async set(key: string, value: unknown): Promise<void> {
    const encrypted = await encryptField(JSON.stringify(value));
    await dbRequest('insert', 'kvStore', { key, value: encrypted });
  }

  static async get<T>(key: string): Promise<T | null> {
    const r = await dbRequest('get', 'kvStore', key);
    if (!r) return null;
    const decrypted = await decryptField(r.value);
    return JSON.parse(decrypted as string) as T;
  }

  static async delete(key: string): Promise<void> {
    await dbRequest('delete', 'kvStore', key);
  }
}
