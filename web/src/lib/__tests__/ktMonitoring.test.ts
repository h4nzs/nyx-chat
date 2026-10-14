// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.6 poin 2] State monitoring KT: penyimpanan ter-seal + satu
 * langkah monitor.
 *
 * Yang dikunci di sini:
 *   1. State bukti disimpan **ter-seal** (`ENC1:`), bukan plaintext — tree head
 *      mengungkap kontak mana yang dimonitor.
 *   2. Field yang tidak dikirim tidak menghapus nilai lama (search dan monitor
 *      menulis bagian yang berbeda).
 *   3. `buildMonitorRequest` dipanggil dengan state yang benar-benar tersimpan
 *      (bukan state karangan), sehingga `MonitorRequest` yang keluar valid.
 *   4. **Fail-closed**: bukti yang tidak bisa diverifikasi tidak boleh mengubah
 *      state tersimpan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  searchKeyHex: string;
  treeHead: string | null;
  monitoringData: string | null;
  distinguishedTreeHead: string | null;
  keyVersion: string | null;
  updatedAt: string;
}

const rows = new Map<string, Row>();

vi.mock('@lib/db', () => ({
  db: {
    ktMonitoring: {
      get: async (key: string) => rows.get(key),
      put: async (row: Row) => {
        rows.set(row.searchKeyHex, row);
      },
      toArray: async () => [...rows.values()],
      clear: async () => {
        rows.clear();
      },
    },
  },
}));

vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

const {
  clearKtStates,
  ktSearchKeyHex,
  loadKtStates,
  planKtMonitor,
  runKtMonitorOnce,
  saveKtState,
  startKtMonitorLoop,
} = await import('../ktMonitoring');
const { KT_MODE_CONTACT_MONITORING, instantiateKeyTransparencyVerifier } = await import('../keyTransparency');
type KtConfig = import('../keyTransparency').KtConfig;

const WASM_PATH = resolve(process.cwd(), '../packages/keytrans-wasm/dist/keytrans.wasm');
const FIXTURE_DIR = resolve(process.cwd(), 'src/lib/__tests__/fixtures/kt');
const CONFIG_PATH = resolve(FIXTURE_DIR, 'config.json');
const QUERY_V1_PATH = resolve(FIXTURE_DIR, 'query-v1.pb');
const QUERY_DISTINGUISHED_PATH = resolve(FIXTURE_DIR, 'query-distinguished.pb');

const HAS_FIXTURES = existsSync(WASM_PATH) && existsSync(CONFIG_PATH) && existsSync(QUERY_V1_PATH) && existsSync(QUERY_DISTINGUISHED_PATH);

interface FixtureConfig {
  signatureKey: string;
  vrfKey: string;
  searchKey: string;
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
};

function splitFrames(bytes: Uint8Array): [Uint8Array, Uint8Array] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstLength = view.getUint32(0, false);
  const secondOffset = 4 + firstLength;
  const secondLength = view.getUint32(secondOffset, false);
  return [bytes.subarray(4, secondOffset), bytes.subarray(secondOffset + 4, secondOffset + 4 + secondLength)];
}

let verifier: Awaited<ReturnType<typeof instantiateKeyTransparencyVerifier>>;
let config: KtConfig;
let fixture: FixtureConfig;

const VERIFY_NOW = new Date('2026-10-13T12:00:00Z');

beforeAll(() => {
  if (!HAS_FIXTURES) return;
  verifier = instantiateKeyTransparencyVerifier(new Uint8Array(readFileSync(WASM_PATH)));
  fixture = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FixtureConfig;
  config = {
    mode: KT_MODE_CONTACT_MONITORING,
    signatureKey: hexToBytes(fixture.signatureKey),
    vrfKey: hexToBytes(fixture.vrfKey),
  };
});

beforeEach(() => {
  rows.clear();
});

describe('penyimpanan state KT', () => {
  it('round-trip: nilai bytes kembali utuh dan tersimpan ter-seal (ENC1:)', async () => {
    const searchKey = hexToBytes('aa'.repeat(33));
    const treeHead = new Uint8Array([1, 2, 3, 4, 5]);
    const monitoringData = new Uint8Array([9, 8, 7]);

    await saveKtState({ searchKey, treeHead, monitoringData, keyVersion: 1 });

    const stored = rows.get(ktSearchKeyHex(searchKey))!;
    expect(stored).toBeDefined();
    // Nilai bukti TIDAK plaintext — hanya envelope ENC1:
    expect(stored.treeHead!.startsWith('ENC1:')).toBe(true);
    expect(stored.monitoringData!.startsWith('ENC1:')).toBe(true);
    expect(stored.keyVersion!.startsWith('ENC1:')).toBe(true);
    expect(stored.updatedAt.startsWith('ENC1:')).toBe(true);
    // Search key sendiri sudah hash 32 byte → boleh jadi kunci baris (plaintext).
    expect(stored.searchKeyHex).toBe('aa'.repeat(33));

    const [loaded] = await loadKtStates();
    expect(loaded!.treeHead).toEqual(treeHead);
    expect(loaded!.monitoringData).toEqual(monitoringData);
    expect(loaded!.keyVersion).toBe(1);
  });

  it('update parsial tidak menghapus nilai lama', async () => {
    const searchKey = hexToBytes('bb'.repeat(32));
    await saveKtState({ searchKey, treeHead: new Uint8Array([7]), monitoringData: new Uint8Array([6]), keyVersion: 2 });

    // Monitor hanya menulis monitoring data + tree head (tanpa distinguished).
    await saveKtState({ searchKey, monitoringData: new Uint8Array([6, 5]) });

    const [loaded] = await loadKtStates();
    expect(loaded!.treeHead).toEqual(new Uint8Array([7]));
    expect(loaded!.keyVersion).toBe(2);
    expect(loaded!.monitoringData).toEqual(new Uint8Array([6, 5]));
  });

  it('clearKtStates mengosongkan semua baris', async () => {
    await saveKtState({ searchKey: hexToBytes('cc'.repeat(32)), treeHead: new Uint8Array([1]) });
    await clearKtStates();
    expect(await loadKtStates()).toEqual([]);
  });
});

describe('planKtMonitor', () => {
  it('null bila tidak ada baris yang punya monitoring data + anchor', () => {
    expect(planKtMonitor([])).toBeNull();
    expect(planKtMonitor([{ searchKey: new Uint8Array(32) }])).toBeNull();

    // Ada monitoring data tapi anchor distinguished belum ada → belum bisa monitor.
    expect(
      planKtMonitor([{ searchKey: new Uint8Array(32), monitoringData: new Uint8Array([1]) }])
    ).toBeNull();
  });

  it('memilih hanya baris yang siap dan memakai anchor-nya', () => {
    const ready = { searchKey: new Uint8Array(32).fill(1), monitoringData: new Uint8Array([1]), distinguishedTreeHead: new Uint8Array([2]) };
    const notReady = { searchKey: new Uint8Array(32).fill(3) };
    const plan = planKtMonitor([notReady, ready]);
    expect(plan).not.toBeNull();
    expect(plan!.states).toHaveLength(1);
    expect(plan!.distinguishedTreeHead).toEqual(new Uint8Array([2]));
  });
});

describe('runKtMonitorOnce', () => {
  it('tanpa state siap → tidak memanggil server', async () => {
    const fetchMonitor = vi.fn(async () => new Uint8Array([1]));
    const outcome = await runKtMonitorOnce({ verifier, config, fetchMonitor, states: [] });
    expect(outcome).toEqual({ checked: 0, changed: [] });
    expect(fetchMonitor).not.toHaveBeenCalled();
  });

  it.skipIf(!HAS_FIXTURES)(
    'merakit MonitorRequest dari state tersimpan dan fail-closed saat bukti tidak sah',
    async () => {
      // 1. State nyata: verifikasi bukti search + anchor distinguished (fixture jalur produksi).
      const [searchHead, searchCondensed] = splitFrames(new Uint8Array(readFileSync(QUERY_V1_PATH)));
      const search = verifier.verifySearch({
        config,
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: searchCondensed,
        fullTreeHead: searchHead,
        now: VERIFY_NOW,
      });
      const [distHead, distCondensed] = splitFrames(new Uint8Array(readFileSync(QUERY_DISTINGUISHED_PATH)));
      const distinguished = verifier.verifySearch({
        config,
        searchKey: new TextEncoder().encode('distinguished'),
        condensedResponse: distCondensed,
        fullTreeHead: distHead,
        now: VERIFY_NOW,
      });

      await saveKtState({
        searchKey: hexToBytes(fixture.searchKey),
        treeHead: search.treeHead,
        monitoringData: search.monitoringData,
        distinguishedTreeHead: distinguished.treeHead,
        keyVersion: 1,
      });

      // 2. Bukti tidak sah → verifikasi gagal dan state TIDAK berubah.
      const before = rows.get(fixture.searchKey)!;
      const captured: Uint8Array[] = [];
      await expect(
        runKtMonitorOnce({
          verifier,
          config,
          states: await loadKtStates(),
          fetchMonitor: async (request) => {
            captured.push(request);
            return new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
          },
          now: VERIFY_NOW,
        })
      ).rejects.toThrow();

      expect(captured).toHaveLength(1);
      expect(captured[0]!.length).toBeGreaterThan(0);
      // Fail-closed: baris tersimpan identik dengan sebelumnya.
      expect(rows.get(fixture.searchKey)).toEqual(before);
    }
  );
});

/**
 * Penjadwal loop. Timer disuntik (bukan `vi.useFakeTimers`) supaya urutan
 * "langkah selesai dulu, baru dijadwalkan ulang" bisa diperiksa langsung.
 */
describe('startKtMonitorLoop', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('menjalankan langkah pertama setelah jeda awal, lalu berulang', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const run = vi.fn(async () => ({ checked: 1, changed: [] }));

    const stop = startKtMonitorLoop({
      run,
      intervalMs: 100,
      initialDelayMs: 5,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    expect(run).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(5);

    timers[0]!.fn();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    // Langkah berikutnya dijadwalkan dengan interval penuh setelah selesai.
    expect(timers).toHaveLength(2);
    expect(timers[1]!.ms).toBe(100);

    stop();
    timers[1]!.fn();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('melaporkan perubahan keyVersion dan tidak berhenti saat langkah gagal', async () => {
    const timers: { fn: () => void }[] = [];
    const onChanged = vi.fn();
    const onError = vi.fn();
    const run = vi
      .fn<() => Promise<{ checked: number; changed: unknown[] }>>()
      .mockRejectedValueOnce(new Error('KT mati'))
      .mockResolvedValue({ checked: 1, changed: [{ searchKey: new Uint8Array([1]), previousVersion: 1, newVersion: 2 }] });

    startKtMonitorLoop({
      run: run as never,
      intervalMs: 100,
      initialDelayMs: 0,
      onChanged: onChanged as never,
      onError,
      setTimer: (fn) => {
        timers.push({ fn });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    timers[0]!.fn();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(timers.length).toBe(2); // tetap dijadwalkan ulang

    timers[1]!.fn();
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('tidak ada timer yang menumpuk selama langkah berjalan (satu langkah pada satu waktu)', async () => {
    const timers: { fn: () => void }[] = [];
    let release: (() => void) | null = null;
    const run = vi.fn(
      () =>
        new Promise<{ checked: number; changed: never[] }>((resolve) => {
          release = () => resolve({ checked: 0, changed: [] });
        })
    );

    startKtMonitorLoop({
      run,
      intervalMs: 10,
      initialDelayMs: 0,
      setTimer: (fn) => {
        timers.push({ fn });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });

    expect(timers).toHaveLength(1);
    timers[0]!.fn();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // Langkah belum selesai → belum ada timer berikutnya (jadi tidak mungkin
    // ada dua langkah paralel yang menulis state yang sama).
    expect(timers).toHaveLength(1);

    release!();
    await flush();
    expect(timers).toHaveLength(2);
    timers[1]!.fn();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

/**
 * Jembatan ke jaringan (`monitorKeyTransparency`): memastikan ia benar-benar
 * memakai state tersimpan + config yang diberikan, dan **tidak** memanggil
 * layanan KT saat belum ada yang dimonitor.
 */
describe('monitorKeyTransparency', () => {
  it.skipIf(!HAS_FIXTURES)('tanpa state siap → tidak memanggil jaringan', async () => {
    const { monitorKeyTransparency, resetKtBundleProofCaches } = await import('../ktBundleProof');
    resetKtBundleProofCaches();

    const fetchMonitor = vi.fn(async () => new Uint8Array([1]));
    const outcome = await monitorKeyTransparency({
      verifier,
      fetchConfig: async () => ({
        mode: config.mode,
        signatureKey: fixture.signatureKey,
        vrfKey: fixture.vrfKey,
      }),
      fetchMonitor,
      states: [],
    });

    expect(outcome).toEqual({ checked: 0, changed: [] });
    expect(fetchMonitor).not.toHaveBeenCalled();
  });
});
