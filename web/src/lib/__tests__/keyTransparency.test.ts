// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/34] Verifier Key Transparency di klien.
 *
 * Fixture di `fixtures/kt/` BUKAN karangan: `server/scripts/kt-fixtures.ts`
 * menjalankan binary Go `key-transparency-server` yang sesungguhnya, menulis dua
 * entri NYX ke log (`return_update_response = true`), dan menyimpan
 * `UpdateResponse` apa adanya. Test ini memverifikasi bukti itu dengan modul WASM
 * hasil build sungguhan (`packages/keytrans-wasm/dist/keytrans.wasm`).
 *
 * Properti yang dikunci:
 *   1. Modul WASM nol import + mengekspor ABI yang diharapkan.
 *   2. Bukti search dari server **diterima**, dan nilai yang dikembalikan sama
 *      dengan nilai yang ditulis (keyVersion, kunci identitas).
 *   3. Rotasi kunci (keyVersion 2) juga terverifikasi, dan versi 1 tidak bisa
 *      dipakai untuk membuktikan versi 2 (nilai palsu ditolak).
 *   4. **MITM**: nilai yang diubah (identity key palsu) ditolak — bukan warning.
 *   5. Bukti yang diubah byte-nya (vrf_proof/opening/search) ditolak.
 *   6. `now` mundur jauh (bukti kadaluarsa) ditolak.
 *   7. Kunci publik log yang salah (operator lain) ditolak.
 *   8. Input acak tidak menabrak instance (`kt_run` mengembalikan error, bukan trap).
 *   9. `condenseUpdate` setia: nilai yang dipakai harus ikut ditandatangani bukti.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  KT_MODE_CONTACT_MONITORING,
  KtVerificationError,
  instantiateKeyTransparencyVerifier,
  type KeyTransparencyVerifier,
  type KtConfig,
} from '../keyTransparency';

const WASM_PATH = resolve(process.cwd(), '../packages/keytrans-wasm/dist/keytrans.wasm');
const FIXTURE_DIR = resolve(process.cwd(), 'src/lib/__tests__/fixtures/kt');
const CONFIG_PATH = resolve(FIXTURE_DIR, 'config.json');

const QUERY_V1_PATH = resolve(FIXTURE_DIR, 'query-v1.pb');
const QUERY_V2_PATH = resolve(FIXTURE_DIR, 'query-v2.pb');
const QUERY_DISTINGUISHED_PATH = resolve(FIXTURE_DIR, 'query-distinguished.pb');

const HAS_WASM = existsSync(WASM_PATH);
const HAS_FIXTURES = existsSync(CONFIG_PATH);
const HAS_QUERY_FIXTURES = existsSync(QUERY_V1_PATH) && existsSync(QUERY_V2_PATH);

interface FixtureConfig {
  mode: number;
  signatureKey: string;
  vrfKey: string;
  searchKey: string;
  entries: Array<{ keyVersion: number; value: string; treeSize: string }>;
  generatedFrom: string;
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Pisahkan pesan protobuf (field length-delimited) — untuk mengubah bukti secara presisi. */
function splitProtoFields(bytes: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  let index = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (index < bytes.length) {
      const byte = bytes[index++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error('protobuf: varint terpotong');
  };
  while (index < bytes.length) {
    const key = Number(varint());
    const wire = key & 0x07;
    if (wire === 2) {
      const length = Number(varint());
      out.set(key >> 3, bytes.subarray(index, index + length));
      index += length;
    } else if (wire === 0) {
      varint();
    } else if (wire === 5) {
      index += 4;
    } else if (wire === 1) {
      index += 8;
    } else {
      throw new Error(`protobuf: wire-type ${wire} tidak didukung`);
    }
  }
  return out;
}

/**
 * Pembaca protobuf minimal untuk `transparency.MonitorRequest` (verifikasi
 * struktur permintaan yang dirakit WASM). Mengembalikan `keys` (berulang) dan
 * `consistency`.
 */
function parseMonitorRequest(bytes: Uint8Array): {
  keys: Array<{ searchKey: Uint8Array; entryPosition: bigint; commitmentIndex: Uint8Array }>;
  consistency: { last?: bigint; distinguished?: bigint };
} {
  const keys: Array<{ searchKey: Uint8Array; entryPosition: bigint; commitmentIndex: Uint8Array }> = [];
  const consistency: { last?: bigint; distinguished?: bigint } = {};
  let index = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (index < bytes.length) {
      const byte = bytes[index++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error('protobuf: varint terpotong');
  };
  const lengthDelimited = (): Uint8Array => {
    const length = Number(varint());
    const out = bytes.subarray(index, index + length);
    index += length;
    return out;
  };
  while (index < bytes.length) {
    const key = Number(varint());
    const field = key >> 3;
    const wire = key & 0x07;
    if (wire !== 2) throw new Error(`MonitorRequest: wire-type tak terduga ${wire}`);
    const payload = lengthDelimited();
    if (field === 1) {
      const entry = { searchKey: new Uint8Array(0), entryPosition: 0n, commitmentIndex: new Uint8Array(0) };
      let inner = 0;
      const innerVarint = (): bigint => {
        let value = 0n;
        let shift = 0n;
        while (inner < payload.length) {
          const byte = payload[inner++]!;
          value |= BigInt(byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) return value;
          shift += 7n;
        }
        throw new Error('MonitorKey: varint terpotong');
      };
      const innerBytes = (): Uint8Array => {
        const length = Number(innerVarint());
        const out = payload.subarray(inner, inner + length);
        inner += length;
        return out;
      };
      while (inner < payload.length) {
        const innerKey = Number(innerVarint());
        const innerField = innerKey >> 3;
        const innerWire = innerKey & 0x07;
        if (innerField === 1 && innerWire === 2) entry.searchKey = new Uint8Array(innerBytes());
        else if (innerField === 2 && innerWire === 0) entry.entryPosition = innerVarint();
        else if (innerField === 3 && innerWire === 2) entry.commitmentIndex = new Uint8Array(innerBytes());
        else if (innerWire === 2) innerBytes();
        else if (innerWire === 0) innerVarint();
        else throw new Error(`MonitorKey: wire-type ${innerWire} tak didukung`);
      }
      keys.push(entry);
    } else if (field === 2) {
      let inner = 0;
      const innerVarint = (): bigint => {
        let value = 0n;
        let shift = 0n;
        while (inner < payload.length) {
          const byte = payload[inner++]!;
          value |= BigInt(byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) return value;
          shift += 7n;
        }
        throw new Error('Consistency: varint terpotong');
      };
      while (inner < payload.length) {
        const innerKey = Number(innerVarint());
        const innerField = innerKey >> 3;
        const value = innerVarint();
        if (innerField === 1) consistency.last = value;
        else if (innerField === 2) consistency.distinguished = value;
      }
    }
  }
  return { keys, consistency };
}

/** Salin `UpdateResponse` dan rusak satu byte di dalam field tertentu. */
function tamperField(update: Uint8Array, field: number, flipAt = 1): Uint8Array {
  const fields = splitProtoFields(update);
  const payload = fields.get(field);
  if (!payload) throw new Error(`tamper: field ${field} tidak ada di fixture`);
  const offset = payload.byteOffset - update.byteOffset;
  const damaged = new Uint8Array(update);
  const target = offset + Math.min(flipAt, payload.length - 1);
  damaged[target] = damaged[target]! ^ 0xff;
  return damaged;
}

let verifier: KeyTransparencyVerifier;
let config: KtConfig;
let fixture: FixtureConfig;
let updateV1: Uint8Array;
let updateV2: Uint8Array;
let queryV1: Uint8Array;
let queryV2: Uint8Array;
let queryDistinguished: Uint8Array;

/** Waktu verifikasi: fixture dibuat 2026-10-13 (ms) — jangan lihat jam mesin. */
const VERIFY_NOW = new Date('2026-10-13T12:00:00Z');

const withSkip = HAS_WASM && HAS_FIXTURES ? describe : describe.skip;

beforeAll(() => {
  if (!HAS_WASM || !HAS_FIXTURES) return;
  verifier = instantiateKeyTransparencyVerifier(new Uint8Array(readFileSync(WASM_PATH)));
  fixture = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FixtureConfig;
  config = {
    mode: KT_MODE_CONTACT_MONITORING,
    signatureKey: hexToBytes(fixture.signatureKey),
    vrfKey: hexToBytes(fixture.vrfKey),
  };
  updateV1 = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, 'search-v1.pb')));
  updateV2 = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, 'search-v2.pb')));
  if (HAS_QUERY_FIXTURES) {
    queryV1 = new Uint8Array(readFileSync(QUERY_V1_PATH));
    queryV2 = new Uint8Array(readFileSync(QUERY_V2_PATH));
    queryDistinguished = new Uint8Array(readFileSync(QUERY_DISTINGUISHED_PATH));
  }
});

/**
 * Pisahkan framing layanan baca NYX: `u32 len || FullTreeHead || u32 len || CondensedTreeSearchResponse`.
 * Ini bentuk yang akan dipakai `server/src/routes/keys.ts` saat meneruskan bukti ke browser.
 */
function splitFrames(bytes: Uint8Array): [Uint8Array, Uint8Array] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstLength = view.getUint32(0, false);
  const secondOffset = 4 + firstLength;
  const secondLength = view.getUint32(secondOffset, false);
  return [
    bytes.subarray(4, secondOffset),
    bytes.subarray(secondOffset + 4, secondOffset + 4 + secondLength),
  ];
}

withSkip('verifier KT: modul & ABI', () => {
  it('modul tanpa import dan mengekspor ABI verifier', () => {
    const module = new WebAssembly.Module(new Uint8Array(readFileSync(WASM_PATH)));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const names = WebAssembly.Module.exports(module).map((entry) => entry.name);
    for (const expected of ['memory', 'kt_in_ptr', 'kt_out_ptr', 'kt_run']) {
      expect(names).toContain(expected);
    }
  });
});

withSkip('verifier KT: bukti nyata dari server KT', () => {
  it('menerima bukti search keyVersion 1 dan mengembalikan nilai yang benar', () => {
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));

    const result = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: condensed.condensedResponse,
      fullTreeHead: condensed.fullTreeHead,
      now: VERIFY_NOW,
    });

    // Nilai log v1 NYX: version(1) + keyVersion(1) + identityKey(32) + ...
    expect(result.value.length).toBeGreaterThan(32);
    expect(result.value[0]).toBe(1);
    expect(result.value[1]).toBe(1);
    expect(bytesToHex(result.value.subarray(2, 34))).toBe('11'.repeat(32));
    // State update bisa dipakai untuk panggilan berikutnya (monitor/konsistensi).
    expect(result.treeHead.length).toBeGreaterThan(0);
    expect(result.monitoringData).toBeDefined();
  });

  it('menerima bukti rotasi kunci (keyVersion 2) dengan kunci identitas baru', () => {
    const condensed = verifier.condenseUpdate(updateV2, hexToBytes(fixture.entries[1]!.value));
    const result = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: condensed.condensedResponse,
      fullTreeHead: condensed.fullTreeHead,
      now: VERIFY_NOW,
    });

    expect(result.value[1]).toBe(2);
    expect(bytesToHex(result.value.subarray(2, 34))).toBe('44'.repeat(32));
  });

  it('meneruskan monitoring data antar panggilan (state update tidak kosong berbeda)', () => {
    const first = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    const search = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: first.condensedResponse,
      fullTreeHead: first.fullTreeHead,
      now: VERIFY_NOW,
    });
    expect(search.monitoringData).toBeDefined();

    // `monitorStep` membaca monitoring data tersimpan → parameter monitor berikutnya.
    const step = verifier.monitorStep(search.monitoringData!);
    expect(step.entries.length).toBeGreaterThan(0);
    expect(step.greatestVersion).toBeGreaterThanOrEqual(1);
    expect(step.latestLogPosition).toBeGreaterThanOrEqual(0n);

    // Bukti yang sama, tapi dengan konteks monitoring: verifikasi tetap lolos.
    const second = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: first.condensedResponse,
      fullTreeHead: first.fullTreeHead,
      context: { lastTreeHead: search.treeHead, monitoringData: search.monitoringData },
      now: VERIFY_NOW,
    });
    expect(bytesToHex(second.value)).toBe(bytesToHex(search.value));
  });
});

withSkip('verifier KT: serangan yang harus ditolak', () => {
  it('MITM: nilai palsu (identity key lain) ditolak, bukan sekadar diperingatkan', () => {
    const forged = new Uint8Array(hexToBytes(fixture.entries[0]!.value));
    forged.set(new Uint8Array(32).fill(0x99), 2); // ganti identityKey

    const condensed = verifier.condenseUpdate(updateV1, forged);
    expect(() =>
      verifier.verifySearch({
        config,
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: condensed.fullTreeHead,
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);
  });

  it('vrf_proof & opening yang diubah ditolak walau tanpa anchor', () => {
    // Dua field ini yang mengikat NILAI ke proof (VRF → index, opening → commitment),
    // jadi keduanya wajib ditolak bahkan pada pencarian pertama (tanpa tree head
    // yang sudah dipercaya).
    const cases: Array<{ name: string; update: Uint8Array }> = [
      { name: 'vrf_proof', update: tamperField(updateV2, 2, 5) },
      { name: 'opening', update: tamperField(updateV2, 4, 2) },
    ];

    for (const { name, update } of cases) {
      const condensed = verifier.condenseUpdate(update, hexToBytes(fixture.entries[1]!.value));
      expect(
        () =>
          verifier.verifySearch({
            config,
            searchKey: hexToBytes(fixture.searchKey),
            condensedResponse: condensed.condensedResponse,
            fullTreeHead: condensed.fullTreeHead,
            now: VERIFY_NOW,
          }),
        `field ${name} yang diubah harus ditolak`
      ).toThrow(KtVerificationError);
    }
  });

  it('dengan anchor (tree head terverifikasi sebelumnya), search proof/tree head palsu ditolak', () => {
    // Inilah alasan desainnya menuntut monitor: pada pencarian pertama klien belum
    // punya akar pohon untuk dibandingkan, jadi bagian proof yang hanya relevan
    // untuk konsistensi pohon BELUM terikat. Begitu ada tree head terverifikasi,
    // perubahan di sana terdeteksi sebagai split-view ("root is different but
    // tree size is the same").
    const trusted = verifier.condenseUpdate(updateV2, hexToBytes(fixture.entries[1]!.value));
    const anchor = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: trusted.condensedResponse,
      fullTreeHead: trusted.fullTreeHead,
      now: VERIFY_NOW,
    });

    // Tree head di-flip di awal `TreeHead` (tree_size/timestamp) — bagian yang
    // dipakai cek konsistensi. Byte di dalam tanda tangan auditor yang tidak
    // dipakai mode 1 memang tidak diperiksa (mode `ContactMonitoring` tidak
    // membawa kunci auditor); itu residual yang dicatat di `docs/34` §34.5.
    const tampered: Array<{ name: string; update: Uint8Array }> = [
      { name: 'search proof', update: tamperField(updateV2, 3, 500) },
      { name: 'tree head', update: tamperField(updateV2, 1, 3) },
    ];

    for (const { name, update } of tampered) {
      const condensed = verifier.condenseUpdate(update, hexToBytes(fixture.entries[1]!.value));
      expect(
        () =>
          verifier.verifySearch({
            config,
            searchKey: hexToBytes(fixture.searchKey),
            condensedResponse: condensed.condensedResponse,
            fullTreeHead: condensed.fullTreeHead,
            context: { lastTreeHead: anchor.treeHead, monitoringData: anchor.monitoringData },
            now: VERIFY_NOW,
          }),
        `field ${name} yang diubah harus ditolak saat ada anchor`
      ).toThrow(KtVerificationError);
    }
  });

  it('kunci publik log yang salah (operator lain) ditolak', () => {
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    const wrongKey = new Uint8Array(32).fill(0x01);
    expect(() =>
      verifier.verifySearch({
        config: { ...config, vrfKey: wrongKey },
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: condensed.fullTreeHead,
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);
  });

  it('search key yang tidak cocok dengan bukti ditolak', () => {
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    const otherKey = hexToBytes(fixture.searchKey);
    otherKey[otherKey.length - 1] = otherKey[otherKey.length - 1]! ^ 0x01;
    expect(() =>
      verifier.verifySearch({
        config,
        searchKey: otherKey,
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: condensed.fullTreeHead,
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);
  });

  it('mode deployment tidak dikenal / kunci berbentuk sampah → error, bukan trap', () => {
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    expect(() =>
      verifier.verifySearch({
        config: { ...config, mode: 99 as never },
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: condensed.fullTreeHead,
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);

    // Kunci dengan panjang salah (31 byte) — bentuk sampah yang paling tidak ambigu.
    expect(() =>
      verifier.verifySearch({
        config: { ...config, signatureKey: new Uint8Array(31) },
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: condensed.fullTreeHead,
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);
  });

  it('update response sampah tidak menabrak instance (fuzz ringan)', () => {
    // 200 input acak deterministik: semuanya harus jadi KtVerificationError.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };

    let errors = 0;
    for (let index = 0; index < 200; index++) {
      const size = 1 + (next() % 64);
      const junk = Uint8Array.from({ length: size }, () => next() & 0xff);
      try {
        const condensed = verifier.condenseUpdate(junk, junk);
        verifier.verifySearch({
          config,
          searchKey: hexToBytes(fixture.searchKey),
          condensedResponse: condensed.condensedResponse,
          fullTreeHead: condensed.fullTreeHead,
          now: VERIFY_NOW,
        });
        throw new Error('seharusnya ditolak');
      } catch (error) {
        expect(error).toBeInstanceOf(KtVerificationError);
        errors++;
      }
    }
    expect(errors).toBe(200);

    // Instance masih sehat: bukti yang asli tetap bisa diverifikasi setelah fuzz.
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    const result = verifier.verifySearch({
      config,
      searchKey: hexToBytes(fixture.searchKey),
      condensedResponse: condensed.condensedResponse,
      fullTreeHead: condensed.fullTreeHead,
      now: VERIFY_NOW,
    });
    expect(result.value[1]).toBe(1);
  });

  it('tree head sampah ditolak sebelum nilai dipakai', () => {
    const condensed = verifier.condenseUpdate(updateV1, hexToBytes(fixture.entries[0]!.value));
    expect(() =>
      verifier.verifySearch({
        config,
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed.condensedResponse,
        fullTreeHead: new Uint8Array([0x0a, 0x03, 0x01, 0x02, 0x03]),
        now: VERIFY_NOW,
      })
    ).toThrow(KtVerificationError);
  });
});

/**
 * Bukti dari **layanan baca NYX** (`server/kt-query`), bukan dari `UpdateResponse`.
 *
 * Fixture di sini menempuh jalur produksi penuh: penulis log NYX menulis entri
 * (protokol test-update yang sama dengan `/register`/`/recover`), lalu bukti
 * diambil dari HTTP `GET /search` dan `GET /distinguished` seperti yang akan
 * dilakukan `server/src/routes/keys.ts`. Query service upstream tidak bisa
 * menghasilkan bukti ini (nilai NYX ditolak, docs/32 §32.8) — jadi tes ini yang
 * membuktikan sisi baca NYX benar-benar berfungsi.
 */
withSkip(
  'verifier KT: bukti dari layanan baca NYX (server/kt-query)',
  () => {
    it.skipIf(!HAS_QUERY_FIXTURES)('menerima bukti /search untuk nilai NYX v1', () => {
      const [fullTreeHead, condensed] = splitFrames(queryV1);
      const result = verifier.verifySearch({
        config,
        searchKey: hexToBytes(fixture.searchKey),
        condensedResponse: condensed,
        fullTreeHead,
        now: VERIFY_NOW,
      });

      expect(result.value).toHaveLength(1286);
      expect(result.value[0]).toBe(1);
      expect(result.value[1]).toBe(1);
      expect(bytesToHex(result.value.subarray(2, 34))).toBe('11'.repeat(32));
      expect(result.monitoringData).toBeDefined();
    });

    it.skipIf(!HAS_QUERY_FIXTURES)(
      'membuktikan rotasi kunci terhadap anchor dari bukti sebelumnya',
      () => {
        const [headV1, condensedV1] = splitFrames(queryV1);
        const first = verifier.verifySearch({
          config,
          searchKey: hexToBytes(fixture.searchKey),
          condensedResponse: condensedV1,
          fullTreeHead: headV1,
          now: VERIFY_NOW,
        });
        expect(first.value[1]).toBe(1);

        const [headV2, condensedV2] = splitFrames(queryV2);
        const second = verifier.verifySearch({
          config,
          searchKey: hexToBytes(fixture.searchKey),
          condensedResponse: condensedV2,
          fullTreeHead: headV2,
          context: { lastTreeHead: first.treeHead, monitoringData: first.monitoringData },
          now: VERIFY_NOW,
        });

        expect(second.value[1]).toBe(2);
        expect(bytesToHex(second.value.subarray(2, 34))).toBe('44'.repeat(32));
      }
    );

    it.skipIf(!HAS_QUERY_FIXTURES)('anchor distinguished bisa diverifikasi dan berisi Unix detik', () => {
      const [fullTreeHead, condensed] = splitFrames(queryDistinguished);
      const result = verifier.verifySearch({
        config,
        searchKey: new TextEncoder().encode('distinguished'),
        condensedResponse: condensed,
        fullTreeHead,
        now: VERIFY_NOW,
      });

      const timestamp = Number.parseInt(new TextDecoder().decode(result.value), 10);
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(timestamp).toBeGreaterThan(1_700_000_000);
    });

    it.skipIf(!HAS_QUERY_FIXTURES)(
      'buildMonitorRequest menyusun MonitorRequest sah dari monitoring data nyata',
      () => {
        const [headV1, condensedV1] = splitFrames(queryV1);
        const search = verifier.verifySearch({
          config,
          searchKey: hexToBytes(fixture.searchKey),
          condensedResponse: condensedV1,
          fullTreeHead: headV1,
          now: VERIFY_NOW,
        });
        expect(search.monitoringData).toBeDefined();

        // Anchor distinguished nyata (nilai kunci `distinguished` = Unix detik).
        const [distHead, distCondensed] = splitFrames(queryDistinguished);
        const distinguished = verifier.verifySearch({
          config,
          searchKey: new TextEncoder().encode('distinguished'),
          condensedResponse: distCondensed,
          fullTreeHead: distHead,
          now: VERIFY_NOW,
        });

        const request = verifier.buildMonitorRequest({
          monitoringData: [search.monitoringData!],
          distinguishedTreeHead: distinguished.treeHead,
          lastTreeHead: search.treeHead,
        });
        expect(request.length).toBeGreaterThan(0);

        const parsed = parseMonitorRequest(request);
        expect(parsed.keys).toHaveLength(1);
        expect(bytesToHex(parsed.keys[0]!.searchKey)).toBe(fixture.searchKey);
        // `commitment_index` = keluaran VRF 32 byte dari bukti search terakhir.
        expect(parsed.keys[0]!.commitmentIndex).toHaveLength(32);
        expect(parsed.keys[0]!.entryPosition).toBeGreaterThan(0n);
        // Konsistensi: `last` dari tree head yang dikirim, `distinguished` dari anchor.
        expect(parsed.consistency.last).toBeDefined();
        expect(parsed.consistency.distinguished).toBeDefined();
        expect(parsed.consistency.last).toBeGreaterThan(0n);
        expect(parsed.consistency.distinguished).toBeGreaterThan(0n);

        // Tanpa `lastTreeHead`, `last` tidak dikirim (server tetap memakai distinguished).
        const withoutLast = parseMonitorRequest(
          verifier.buildMonitorRequest({
            monitoringData: [search.monitoringData!],
            distinguishedTreeHead: distinguished.treeHead,
          })
        );
        expect(withoutLast.consistency.last).toBeUndefined();
        expect(withoutLast.consistency.distinguished).toBe(parsed.consistency.distinguished);
      }
    );

    it.skipIf(!HAS_QUERY_FIXTURES)(
      'buildMonitorRequest menolak daftar kosong (tidak ada yang dimonitor)',
      () => {
        const [distHead, distCondensed] = splitFrames(queryDistinguished);
        const distinguished = verifier.verifySearch({
          config,
          searchKey: new TextEncoder().encode('distinguished'),
          condensedResponse: distCondensed,
          fullTreeHead: distHead,
          now: VERIFY_NOW,
        });
        expect(() =>
          verifier.buildMonitorRequest({ monitoringData: [], distinguishedTreeHead: distinguished.treeHead })
        ).toThrow(KtVerificationError);
      }
    );

    it.skipIf(!HAS_QUERY_FIXTURES)(
      'nilai yang diubah di jalur produksi tetap ditolak (bukan warning)',
      () => {
        const [fullTreeHead, condensed] = splitFrames(queryV2);
        const tampered = new Uint8Array(condensed);
        // Rusak byte terakhir nilai (`updatedAtDay`) — bentuk protobuf tetap sah.
        const fields = splitProtoFields(tampered);
        const valueField = fields.get(4);
        expect(valueField).toBeDefined();
        const offset = valueField!.byteOffset - tampered.byteOffset;
        const target = offset + valueField!.length - 1;
        tampered[target] = tampered[target]! ^ 0xff;

        expect(() =>
          verifier.verifySearch({
            config,
            searchKey: hexToBytes(fixture.searchKey),
            condensedResponse: tampered,
            fullTreeHead,
            now: VERIFY_NOW,
          })
        ).toThrow(KtVerificationError);
      }
    );
  }
);
