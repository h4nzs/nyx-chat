// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.7 Fase 7] Verifier Key Transparency **v2** di klien.
 *
 * Membungkus `packages/keytrans-wasm-v2/dist/keytrans-v2.wasm` (kompilasi
 * fork NYX `libsignal-keytrans-v2`: ML-DSA-65 tree head, indeks SHA-256
 * terdomanisir, tanpa EC-VRF). Modul itu **raw WASM tanpa import**
 * dan ABI-nya primitif: host menulis satu frame ke scratch, memanggil `kt_run`,
 * lalu membaca frame hasil. Protobuf di-encode/decode di dalam Rust, jadi file
 * ini tidak butuh parser protobuf sama sekali.
 *
 * Kenapa penting: sebelum ini NYX hanya **menulis** log KT (`server/src/utils/keyTransparency.ts`).
 * Tanpa verifier, server masih bisa menyajikan bundle kunci palsu yang konsisten
 * dengan dirinya sendiri. Verifier ini menutup itu: `search proof`, `monitor
 * proof`, dan konsistensi `distinguished` tree head diperiksa terhadap kunci
 * publik log — server tidak bisa berbohong tanpa membuktikan dirinya sendiri
 * bersalah.
 *
 * ABI v2 (lihat `packages/keytrans-wasm-v2/src/lib.rs`): byte versi setelah op,
 * kunci ML-DSA **length-prefixed**, dan tidak ada kunci VRF. Frame v1 ditolak
 * oleh modul, jadi klien v1 dan v2 tidak bisa tertukar.
 */

/** Kode status frame hasil (harus sama dengan `packages/keytrans-wasm-v2/src/lib.rs`). */
const ABI_VERSION = 2;
export const KT_OK = 0;
export const KT_ERR = 1;

/** Mode deployment log (sama dengan `DeploymentMode` di libsignal). */
export const KT_MODE_CONTACT_MONITORING = 1;
export const KT_MODE_THIRD_PARTY_MANAGEMENT = 2;
export const KT_MODE_THIRD_PARTY_AUDITING = 3;

export type KtMode =
  | typeof KT_MODE_CONTACT_MONITORING
  | typeof KT_MODE_THIRD_PARTY_MANAGEMENT
  | typeof KT_MODE_THIRD_PARTY_AUDITING;

const OP_VERIFY_SEARCH = 1;
const OP_VERIFY_MONITOR = 2;
const OP_VERIFY_DISTINGUISHED = 3;
const OP_MONITOR_NEXT = 4;
const OP_CONDENSE_UPDATE = 5;
const OP_MONITOR_BUILD = 6;

/** `SlimSearchRequest.version` = tanpa batas versi. */
const NO_VERSION = 0xffffffff;

/** Ukuran scratch buffer di modul WASM (byte). */
export const KT_SCRATCH_BYTES = 512 * 1024;

export interface KtConfig {
  mode: KtMode;
  /** Kunci publik ML-DSA-65 operator log (1952 byte). */
  signatureKey: Uint8Array;
  /** Kunci publik ML-DSA-65 auditor (1952 byte masing-masing) untuk mode 2/3. */
  auditorKeys?: Uint8Array[];
}

/** Monitoring data ter-seal (protobuf `StoredMonitoringData`) yang dipakai ulang. */
export type KtMonitoringData = Uint8Array;
/** Tree head tersimpan (protobuf `StoredTreeHead`). */
export type KtStoredTreeHead = Uint8Array;

export interface KtSearchContext {
  lastTreeHead?: KtStoredTreeHead;
  lastDistinguishedTreeHead?: KtStoredTreeHead;
  monitoringData?: KtMonitoringData;
}

export interface KtVerifySearchInput {
  config: KtConfig;
  searchKey: Uint8Array;
  /** Batas versi minimum yang diminta (opsional). */
  version?: number;
  /** `CondensedTreeSearchResponse` (protobuf) dari server/penulis log. */
  condensedResponse: Uint8Array;
  /** `FullTreeHead` (protobuf) dari server/penulis log. */
  fullTreeHead: Uint8Array;
  context?: KtSearchContext;
  /** Paksa langkah monitor (mis. saat menaikkan versi kunci). */
  forceMonitor?: boolean;
  /** Jam host; default `Date.now()`. */
  now?: Date | number;
}

export interface KtVerifySearchResult {
  /** Nilai log yang sudah terverifikasi — hanya boleh dipakai setelah ini. */
  value: Uint8Array;
  treeHead: KtStoredTreeHead;
  monitoringData?: KtMonitoringData;
}

export interface KtMonitorContext {
  lastTreeHead?: KtStoredTreeHead;
  /** Wajib: tree head distinguished terakhir yang sudah diverifikasi. */
  lastDistinguishedTreeHead: KtStoredTreeHead;
  /** Monitoring data per search key (search_key → data). */
  data?: Map<Uint8Array | string, KtMonitoringData>;
}

export interface KtVerifyMonitorInput {
  config: KtConfig;
  request: Uint8Array;
  response: Uint8Array;
  context: KtMonitorContext;
  now?: Date | number;
}

export interface KtVerifyMonitorResult {
  treeHead: KtStoredTreeHead;
  monitoringData: Map<string, KtMonitoringData>;
}

export interface KtBuildMonitorRequestInput {
  /** Monitoring data tersimpan (`StoredMonitoringData` protobuf), satu per kunci. */
  monitoringData: KtMonitoringData[];
  /** Tree head distinguished terakhir yang dipercaya — anchor monitoring (wajib). */
  distinguishedTreeHead: KtStoredTreeHead;
  /** Tree head terakhir yang dipercaya (opsional; menyalakan bukti konsistensi). */
  lastTreeHead?: KtStoredTreeHead;
}

export class KtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KtVerificationError';
  }
}

export interface KtMonitorStep {
  /** Posisi berikutnya yang layak dimonitor. */
  nextMonitor: bigint;
  latestLogPosition: bigint;
  greatestVersion: number;
  entries: bigint[];
}

export interface KeyTransparencyVerifier {
  /** `UpdateResponse` + nilai yang ditulis → (FullTreeHead, CondensedTreeSearchResponse). */
  condenseUpdate(updateResponse: Uint8Array, value: Uint8Array): {
    fullTreeHead: Uint8Array;
    condensedResponse: Uint8Array;
  };
  verifySearch(input: KtVerifySearchInput): KtVerifySearchResult;
  verifyMonitor(input: KtVerifyMonitorInput): KtVerifyMonitorResult;
  verifyDistinguished(input: {
    config: KtConfig;
    fullTreeHead: Uint8Array;
    lastTreeHead?: KtStoredTreeHead;
    lastDistinguishedTreeHead: KtStoredTreeHead;
  }): void;
  /** `next_monitor`/entries/versi terbesar dari monitoring data tersimpan. */
  monitorStep(monitoringData: KtMonitoringData): KtMonitorStep;
  /**
   * Susun `transparency.MonitorRequest` (protobuf) dari monitoring data + tree
   * head yang sudah dimiliki klien. Permintaan dirakit di Rust, jadi klien tidak
   * butuh parser protobuf (`docs/34` §34.6 poin 2).
   */
  buildMonitorRequest(input: KtBuildMonitorRequestInput): Uint8Array;
}

interface KtExports {
  memory: WebAssembly.Memory;
  kt_in_ptr(): number;
  kt_out_ptr(): number;
  kt_run(inputLength: number): number;
}

class FrameWriter {
  private parts: Uint8Array[] = [];

  u8(value: number): this {
    this.parts.push(new Uint8Array([value & 0xff]));
    return this;
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, false);
    this.parts.push(out);
    return this;
  }

  u64(value: bigint | number): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
    this.parts.push(out);
    return this;
  }

  bytes(bytes: Uint8Array | undefined): this {
    const value = bytes ?? new Uint8Array(0);
    this.u32(value.length);
    this.parts.push(value);
    return this;
  }

  build(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

class FrameReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  u8(): number {
    return this.take(1)[0] ?? 0;
  }

  u32(): number {
    const bytes = this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  }

  u64(): bigint {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
  }

  bytes(): Uint8Array {
    const length = this.u32();
    return this.take(length).slice();
  }

  private take(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new KtVerificationError('kt: frame hasil terpotong');
    }
    const out = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return out;
  }
}

const toMillis = (now: Date | number | undefined): bigint => {
  if (now === undefined) return BigInt(Date.now());
  const value = typeof now === 'number' ? now : now.getTime();
  return BigInt(Math.trunc(value));
};

/**
 * Instansiasi modul verifier. `bytes` = isi `packages/keytrans-wasm/dist/keytrans.wasm`.
 */
export function instantiateKeyTransparencyVerifier(
  // `Uint8Array<ArrayBuffer>` karena `WebAssembly.Module` menolak buffer yang
  // mungkin `SharedArrayBuffer`.
  bytes: Uint8Array<ArrayBuffer>
): KeyTransparencyVerifier {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    // Guardrail: modul yang kita bangun tidak boleh menarik host function apa pun.
    throw new KtVerificationError(`kt: modul WASM punya ${imports.length} import (diharapkan 0)`);
  }

  const instance = new WebAssembly.Instance(module, {});
  const wasm = instance.exports as unknown as KtExports;
  if (!wasm.memory || typeof wasm.kt_run !== 'function') {
    throw new KtVerificationError('kt: modul WASM tidak mengekspor ABI yang diharapkan');
  }

  // `kt_in_ptr()` / `kt_out_ptr()` dulu, `memory.buffer` paling akhir: alokasi
  // pertama di Rust (dan kenaikan heap berikutnya) memicu `memory.grow`, dan grow
  // MELEPAS ArrayBuffer yang sudah dipegang. Baca buffer sebelum getter → error
  // "detached ArrayBuffer" (bug yang sama pernah terjadi di pembungkus SPQR).
  const inputView = (length: number) => {
    const pointer = wasm.kt_in_ptr();
    return new Uint8Array(wasm.memory.buffer, pointer, length);
  };
  const outputBytes = () => {
    const pointer = wasm.kt_out_ptr();
    return new Uint8Array(wasm.memory.buffer, pointer, KT_SCRATCH_BYTES).slice();
  };

  /**
   * Jalankan satu operasi. Reader yang dikembalikan sudah berada tepat setelah
   * byte status, jadi pemanggil membaca slot hasil **berikut panjangnya**
   * (sesuai framing di Rust).
   */
  const run = (frame: Uint8Array): FrameReader => {
    if (frame.length > KT_SCRATCH_BYTES) {
      throw new KtVerificationError('kt: frame masukan melebihi scratch buffer');
    }
    inputView(frame.length).set(frame);
    wasm.kt_run(frame.length);

    const reader = new FrameReader(outputBytes());
    const status = reader.u8();
    if (status === KT_OK) return reader;

    // Frame error tetap punya empat slot (kosong) sebelum pesan error.
    for (let slot = 0; slot < 4; slot++) reader.bytes();
    const message = new TextDecoder().decode(reader.bytes());
    throw new KtVerificationError(message || `kt: verifikasi gagal (status ${status})`);
  };

  const baseFrame = (
    op: number,
    config: KtConfig,
    now: bigint,
    forceMonitor: boolean,
    payloads: Array<Uint8Array | undefined>
  ): Uint8Array => {
    const writer = new FrameWriter().u8(op).u8(ABI_VERSION).u8(config.mode);
    const auditorKeys = config.auditorKeys ?? [];
    writer.u32(auditorKeys.length);
    for (const key of auditorKeys) writer.bytes(key);
    writer.bytes(config.signatureKey);
    writer.u64(now);
    writer.u8(forceMonitor ? 1 : 0);
    for (let index = 0; index < 4; index++) writer.bytes(payloads[index]);
    return writer.build();
  };

  return {
    condenseUpdate(updateResponse, value) {
      const reader = run(
        baseFrame(OP_CONDENSE_UPDATE, { mode: 1, signatureKey: EMPTY_KEY }, 0n, false, [
          updateResponse,
          value,
        ])
      );
      return { fullTreeHead: reader.bytes(), condensedResponse: reader.bytes() };
    },

    verifySearch(input) {
      const context = new FrameWriter()
        .u32(input.version === undefined ? NO_VERSION : input.version >>> 0)
        .bytes(input.context?.lastTreeHead)
        .bytes(input.context?.lastDistinguishedTreeHead)
        .bytes(input.context?.monitoringData)
        .build();

      const reader = run(
        baseFrame(
          OP_VERIFY_SEARCH,
          input.config,
          toMillis(input.now),
          input.forceMonitor === true,
          [input.searchKey, input.condensedResponse, input.fullTreeHead, context]
        )
      );

      const value = reader.bytes();
      const treeHead = reader.bytes();
      const monitoringData = reader.bytes();
      return {
        value,
        treeHead,
        monitoringData: monitoringData.length > 0 ? monitoringData : undefined,
      };
    },

    verifyMonitor(input) {
      const context = new FrameWriter()
        .bytes(input.context.lastTreeHead)
        .bytes(input.context.lastDistinguishedTreeHead);
      const entries = input.context.data ? [...input.context.data.entries()] : [];
      context.u32(entries.length);
      for (const [key, value] of entries) {
        context.bytes(typeof key === 'string' ? fromHex(key) : key);
        context.bytes(value);
      }

      const reader = run(
        baseFrame(OP_VERIFY_MONITOR, input.config, toMillis(input.now), false, [
          input.request,
          input.response,
          context.build(),
          undefined,
        ])
      );

      const treeHead = reader.bytes();
      const count = reader.u32();
      const monitoringData = new Map<string, KtMonitoringData>();
      for (let index = 0; index < count; index++) {
        const key = reader.bytes();
        monitoringData.set(Buffer.from(key).toString('hex'), reader.bytes());
      }
      return { treeHead, monitoringData };
    },

    verifyDistinguished(input) {
      run(
        baseFrame(OP_VERIFY_DISTINGUISHED, input.config, 0n, false, [
          input.fullTreeHead,
          input.lastTreeHead,
          input.lastDistinguishedTreeHead,
          undefined,
        ])
      );
    },

    monitorStep(monitoringData) {
      const reader = run(
        baseFrame(OP_MONITOR_NEXT, { mode: 1, signatureKey: EMPTY_KEY }, 0n, false, [
          monitoringData,
          undefined,
          undefined,
          undefined,
        ])
      );
      const nextMonitor = reader.u64();
      const latestLogPosition = reader.u64();
      const greatestVersion = reader.u32();
      const count = reader.u32();
      const entries: bigint[] = [];
      for (let index = 0; index < count; index++) entries.push(reader.u64());
      return { nextMonitor, latestLogPosition, greatestVersion, entries };
    },

    buildMonitorRequest(input) {
      if (input.monitoringData.length === 0) {
        throw new KtVerificationError('kt: tidak ada monitoring data untuk dimonitor');
      }
      const entries = new FrameWriter().u32(input.monitoringData.length);
      for (const data of input.monitoringData) entries.bytes(data);

      const reader = run(
        baseFrame(OP_MONITOR_BUILD, { mode: 1, signatureKey: EMPTY_KEY }, 0n, false, [
          input.lastTreeHead,
          input.distinguishedTreeHead,
          entries.build(),
          undefined,
        ])
      );
      return reader.bytes();
    },
  };
}

const EMPTY_KEY = new Uint8Array(0);

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}
