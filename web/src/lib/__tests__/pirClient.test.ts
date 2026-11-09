import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PIR_MANIFEST_DOMAIN,
  PIR_SUITE,
  encodePirRecord,
  mlDsaKeygen,
  mlDsaSign,
  pirManifestMessage,
  pirRecordCandidates,
  pirShareLen,
  type PirManifest,
} from '@nyx/shared';

vi.mock('../ohttpClient', () => ({
  ohttpEnabled: vi.fn(() => true),
  ohttpFetch: vi.fn(),
}));

import { ohttpFetch, type OhttpHttpResult } from '../ohttpClient';
import { PirError, pirSearch } from '../pirClient';
import { _resetPirManifestCacheForTests } from '../pirManifest';

const RECORD_BYTES = 256;
const SLOT_COUNT = 8;
const INDEX_HEX = 'ab'.repeat(32);

const KEY_A = mlDsaKeygen(new Uint8Array(32).fill(7));
const KEY_B = mlDsaKeygen(new Uint8Array(32).fill(9));

function manifest(
  operator: string,
  overrides: Partial<PirManifest> = {},
): PirManifest {
  return {
    suite: PIR_SUITE,
    shard: 0,
    shardCount: 1,
    slotCount: SLOT_COUNT,
    recordBytes: RECORD_BYTES,
    epoch: 1,
    entryCount: 1,
    dbRoot: 'a'.repeat(64),
    operator,
    keyId: 'b'.repeat(64),
    ...overrides,
  };
}

function signed(value: PirManifest, key = KEY_A): string {
  return btoa(String.fromCharCode(...mlDsaSign(pirManifestMessage(value), key.secretKey, PIR_MANIFEST_DOMAIN)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function indexBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let offset = 0; offset < 32; offset += 1) {
    bytes[offset] = Number.parseInt(INDEX_HEX.slice(offset * 2, offset * 2 + 2), 16);
  }
  return bytes;
}

function record(): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: 'user-1', encryptedProfile: 'cipher', isVerified: true }),
  );
  return encodePirRecord({ oprfIndex: indexBytes(), body, recordBytes: RECORD_BYTES });
}

/** Jawaban jujur: XOR record yang bit share-nya 1. */
function answer(slots: Uint8Array[], share: Uint8Array): Uint8Array {
  const out = new Uint8Array(RECORD_BYTES);
  for (let slot = 0; slot < slots.length; slot += 1) {
    if (share[slot >> 3]! & (1 << (slot & 7))) {
      const value = slots[slot]!;
      for (let index = 0; index < RECORD_BYTES; index += 1) out[index]! ^= value[index]!;
    }
  }
  return out;
}

interface Harness {
  slots: Uint8Array[];
  tamper?: boolean;
  failServer?: string;
  manifestFor: (server: string) => PirManifest;
  summaryFor?: (server: string) => { shardCount: number; epoch: number };
}

function json(value: unknown): OhttpHttpResult {
  return { status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(value)) };
}

function install(harness: Harness): void {
  vi.mocked(ohttpFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const server = /\/api\/pir\/([a-z0-9_-]+)\//.exec(url)?.[1] ?? 'a';
    if (harness.failServer === server) throw new Error('relay mati');
    const manifestValue = harness.manifestFor(server);
    if (url.includes('/manifest')) {
      const shard = /shard=(\d+)/.exec(url)?.[1];
      if (shard === undefined) {
        const summary = harness.summaryFor?.(server) ?? manifestValue;
        return json({
          suite: manifestValue.suite,
          shardCount: summary.shardCount,
          epoch: summary.epoch,
        });
      }
      const key = server === 'a' ? KEY_A : KEY_B;
      return json({ manifest: manifestValue, signature: signed(manifestValue, key) });
    }
    const share = new Uint8Array(init?.body as Uint8Array);
    const bytes = answer(harness.slots, share);
    // Dusta satu server saja: menambal byte yang sama di kedua jawaban akan
    // saling meniadakan saat XOR, jadi tamper harus asimetris.
    if (harness.tamper && server === 'b') bytes[0]! ^= 0xff;
    return { status: 200, headers: [], body: bytes };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  _resetPirManifestCacheForTests();
  vi.stubEnv('VITE_PIR_ENABLED', '1');
  vi.stubEnv(
    'VITE_PIR_MANIFEST_KEYS',
    JSON.stringify({
      a: btoa(String.fromCharCode(...KEY_A.publicKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      b: btoa(String.fromCharCode(...KEY_B.publicKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    }),
  );
  vi.stubEnv('VITE_PIR_RELAYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function slotsWithRecord(): Uint8Array[] {
  const slots: Uint8Array[] = Array.from({ length: SLOT_COUNT }, () => new Uint8Array(RECORD_BYTES));
  const candidate = pirRecordCandidates(indexBytes(), SLOT_COUNT)[1]!;
  slots[candidate] = record();
  return slots;
}

describe('pirSearch (xor-pir-v1)', () => {
  it('memulihkan record dari slot kandidat lewat dua server', async () => {
    install({ slots: slotsWithRecord(), manifestFor: (server) => manifest(`nyx-${server}`) });
    const hit = await pirSearch(INDEX_HEX);
    expect(hit).toEqual({ id: 'user-1', encryptedProfile: 'cipher', isVerified: true });
    // 2 ringkasan + 2 manifest + 2 kandidat (slot kedua yang berisi record) × 2 server.
    expect(vi.mocked(ohttpFetch)).toHaveBeenCalledTimes(2 + 2 + 2 * 2);
  });

  it('mengembalikan null bila ketiga slot kosong', async () => {
    install({
      slots: Array.from({ length: SLOT_COUNT }, () => new Uint8Array(RECORD_BYTES)),
      manifestFor: (server) => manifest(`nyx-${server}`),
    });
    expect(await pirSearch(INDEX_HEX)).toBeNull();
  });

  it('melewati slot berisi record sah milik kunci lain lalu menemukan slot sendiri', async () => {
    const slots = slotsWithRecord();
    const body = new TextEncoder().encode(JSON.stringify({ id: 'user-lain' }));
    const foreign = encodePirRecord({
      oprfIndex: new Uint8Array(32).fill(3),
      body,
      recordBytes: RECORD_BYTES,
    });
    // Slot kandidat pertama milik kunci lain; slot kedua milik kunci yang dicari.
    slots[pirRecordCandidates(indexBytes(), SLOT_COUNT)[0]!] = foreign;
    install({ slots, manifestFor: (server) => manifest(`nyx-${server}`) });
    expect(await pirSearch(INDEX_HEX)).toMatchObject({ id: 'user-1' });
  });

  it('menolak perubahan shardCount di antara ringkasan dan manifest', async () => {
    install({
      slots: slotsWithRecord(),
      manifestFor: (server) => manifest(`nyx-${server}`, { shardCount: 2 }),
      summaryFor: () => ({ shardCount: 1, epoch: 1 }),
    });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_DESYNC' });
  });

  it('menolak record yang checksum-nya rusak sebagai PIR_TAMPERED', async () => {
    install({
      slots: slotsWithRecord(),
      tamper: true,
      manifestFor: (server) => manifest(`nyx-${server}`),
    });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_TAMPERED' });
  });

  it('menolak manifest yang berbeda antar-server sebagai PIR_DESYNC', async () => {
    install({
      slots: slotsWithRecord(),
      manifestFor: (server) => manifest(`nyx-${server}`, server === 'b' ? { epoch: 2 } : {}),
    });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_DESYNC' });
  });

  it('menolak tanda tangan manifest yang salah', async () => {
    vi.mocked(ohttpFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/manifest')) {
        const manifestValue = manifest('nyx-a');
        return json({ manifest: manifestValue, signature: signed(manifestValue, KEY_B) });
      }
      return { status: 200, headers: [], body: new Uint8Array(pirShareLen(SLOT_COUNT)) };
    });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_MANIFEST_INVALID' });
  });

  it('menolak epoch yang turun (PIR_ROLLBACK)', async () => {
    localStorage.setItem('nyx_pir_epoch:0', '5');
    install({ slots: slotsWithRecord(), manifestFor: (server) => manifest(`nyx-${server}`) });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_ROLLBACK' });
  });

  it('gagal tertutup bila satu server tidak terjangkau', async () => {
    install({
      slots: slotsWithRecord(),
      failServer: 'b',
      manifestFor: (server) => manifest(`nyx-${server}`),
    });
    await expect(pirSearch(INDEX_HEX)).rejects.toMatchObject({ code: 'PIR_UNAVAILABLE' });
  });

  it('menolak indeks yang bukan hex 32 byte', async () => {
    await expect(pirSearch('zz')).rejects.toBeInstanceOf(PirError);
  });
});
