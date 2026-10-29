/**
 * [docs/40 §40.7] Proyeksi pesan untuk arsip riwayat perangkat hasil link.
 *
 * Arsip ini TIDAK menyalin baris Dexie: isinya objek `Message` hasil
 * `decodeMessageRecord` (pembaca yang sama dengan tampilan chat). Yang dikunci
 * di sini adalah aturan "apa yang ikut dan apa yang dibuang":
 *   - pesan kedaluwarsa, view-once, dan `waiting_for_key` tidak dipindahkan,
 *   - tombstone tetap ikut (supaya "dihapus" tidak menghidupkan pesan di
 *     perangkat baru),
 *   - `seq`/`createdAt` dipertahankan (kursor paginasi server),
 *   - `statuses` dikosongkan (impor tidak boleh mengirim centang baca palsu).
 *
 * Dexie, crypto worker, dan lapis at-rest di-stub — konvensi repo; yang diuji
 * adalah logika proyeksi, bukan IndexedDB atau primitif kripto.
 */
import { describe, it, expect, vi } from 'vitest';

const NOW = Date.now();
const B64 = (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64');

type Row = {
  id: string;
  conversationId: string;
  content: string | null;
  createdAt: string | number | null;
  senderId?: string;
  senderName?: string;
  seq?: number;
  expiresAt?: number | null;
  isViewOnce?: boolean;
  isDeletedLocal?: boolean;
  statuses?: string | null;
};

const rows: Row[] = [
  {
    id: 'm-plain',
    conversationId: 'conv-1',
    content: 'VAULT:' + Buffer.from('hello world', 'utf8').toString('base64'),
    createdAt: new Date(NOW - 60_000).toISOString(),
    senderId: 'peer-a',
    senderName: 'VAULT:' + Buffer.from('Alice', 'utf8').toString('base64'),
    seq: 42,
    expiresAt: NOW + 60 * 60 * 1000,
    statuses: B64(
      JSON.stringify([{ userId: 'peer-a', status: 'READ', messageId: 'm-plain' }])
    ),
  },
  {
    id: 'm-expired',
    conversationId: 'conv-1',
    content: 'VAULT:' + Buffer.from('gone', 'utf8').toString('base64'),
    createdAt: new Date(NOW - 120_000).toISOString(),
    senderId: 'peer-a',
    expiresAt: NOW - 1_000,
  },
  {
    id: 'm-view-once',
    conversationId: 'conv-1',
    content: 'VAULT:' + Buffer.from('secret media', 'utf8').toString('base64'),
    createdAt: new Date(NOW - 180_000).toISOString(),
    senderId: 'peer-a',
    isViewOnce: true,
  },
  {
    id: 'm-waiting',
    conversationId: 'conv-1',
    content: 'VAULT:' + Buffer.from('waiting_for_key', 'utf8').toString('base64'),
    createdAt: new Date(NOW - 240_000).toISOString(),
    senderId: 'peer-a',
  },
  {
    id: 'm-tombstone',
    conversationId: 'conv-1',
    content: null,
    createdAt: new Date(NOW - 300_000).toISOString(),
    senderId: 'peer-a',
    isDeletedLocal: true,
  },
];

vi.mock('../db', () => ({
  db: {
    messages: {
      toArray: async () => rows,
    },
  },
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    crypto_generichash: () => new Uint8Array(32),
    to_base64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  })),
}));

vi.mock('@utils/crypto', () => ({
  getMyEncryptionKeyPair: vi.fn(async () => ({ privateKey: new Uint8Array(32) })),
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
  workerXChaChaSeal: vi.fn(async (_key: string, text: string) => 'VAULT:' + text),
  workerXChaChaOpen: vi.fn(async (_key: string, encrypted: string) =>
    encrypted.startsWith('VAULT:')
      ? Buffer.from(encrypted.slice(6), 'base64').toString('utf8')
      : null
  ),
}));

vi.mock('../localAtRest', () => ({
  AT_REST_PREFIX: 'ENC1:',
  LOCAL_TIME_BUCKET_MS: 15 * 60 * 1000,
  bucketLocalTimestamp: (value: string | Date | null | undefined) =>
    value === null || value === undefined || value === '' ? null : new Date(value).toISOString(),
  sealLocalNumber: vi.fn(async (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? B64(String(value)) : null
  ),
  openLocalNumber: vi.fn(async (raw: number | string | null | undefined) => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string' || !raw.startsWith('ENC1:')) return null;
    const parsed = Number(Buffer.from(raw.slice(5), 'base64').toString('utf8'));
    return Number.isFinite(parsed) ? parsed : null;
  }),
  sealLocalText: vi.fn(async (value: string | null | undefined) =>
    typeof value === 'string' && value.length > 0 ? B64(value) : null
  ),
  openLocalText: vi.fn(async (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!raw.startsWith('ENC1:')) return raw;
    const payload = Buffer.from(raw.slice(5), 'base64').toString('utf8');
    return payload.length > 0 ? payload : null;
  }),
  sealLocalFlag: vi.fn(async (value: boolean | null | undefined) =>
    typeof value === 'boolean' ? B64(value ? 'true' : 'false') : null
  ),
  openLocalFlag: vi.fn(async (raw: unknown) => {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const payload = raw.startsWith('ENC1:')
      ? Buffer.from(raw.slice(5), 'base64').toString('utf8')
      : raw;
    if (payload === 'true') return true;
    if (payload === 'false') return false;
    return null;
  }),
}));

vi.mock('../localOrderKey', () => ({
  ensureOrderFields: async (row: unknown) => row,
  hasIndexableOrder: () => true,
  openOrderInstant: async (row: { createdAt?: string | number | null }) => {
    const value = row?.createdAt;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  },
  orderBucketOf: () => 0,
  pickOlderPage: (page: unknown[]) => ({ page }),
  previousOrderBucket: () => null,
  resolveOrderInstants: async () => [],
}));

import { shadowVault } from '../shadowVaultDb';

describe('arsip riwayat: proyeksi pesan', () => {
  it('membawa pesan yang bisa ditampilkan sebagai objek domain terdekripsi', async () => {
    const messages = await shadowVault.getMessagesForExport();
    const plain = messages.find((m) => m.id === 'm-plain');

    expect(plain?.content).toBe('hello world');
    expect(plain?.sender?.name).toBe('Alice');
    // Kursor paginasi server tetap presisi di perangkat baru.
    expect(plain?.seq).toBe(42);
    expect(plain?.createdAt).toBe(new Date(NOW - 60_000).toISOString());
    // Centang baca tidak ikut: impor tidak boleh mengirim receipt palsu.
    expect(plain?.statuses).toBeUndefined();
  });

  it('membuang pesan kedaluwarsa, view-once, dan waiting_for_key', async () => {
    const messages = await shadowVault.getMessagesForExport();
    const ids = messages.map((m) => m.id);

    expect(ids).toEqual(['m-plain', 'm-tombstone']);
  });

  it('mempertahankan tombstone supaya pesan terhapus tidak hidup lagi', async () => {
    const messages = await shadowVault.getMessagesForExport();
    const tombstone = messages.find((m) => m.id === 'm-tombstone');

    expect(tombstone?.content).toBeNull();
    expect(tombstone?.isDeletedLocal).toBe(true);
  });
});
