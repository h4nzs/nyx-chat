// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D] Pembungkus TS untuk modul WASM `spqr` (SPQR: PQ forward
 * secrecy **dan** post-compromise security).
 *
 * Modul WASM-nya (`packages/spqr-wasm/dist/spqr.wasm`) adalah **raw module tanpa
 * import sama sekali** — tidak ada `wasm-bindgen`, tidak ada glue JS yang perlu
 * dipercaya, tidak ada `WebAssembly.instantiate` streaming dari CDN. ABI-nya
 * primitif: satu scratch buffer input, satu scratch output, dan kode hasil
 * numerik (lihat `packages/spqr-wasm/src/lib.rs`).
 *
 * **Entropi disuntik host.** Crate `spqr` diarahkan ke backend `getrandom`
 * kustom, jadi byte acak datang dari `randomBytes()` di sini (produksi:
 * `crypto.getRandomValues`). Konsekuensi urutan yang mudah salah: entropi WAJIB
 * di-seed **sebelum** state ditulis ke scratch, karena `spqr_seed_entropy`
 * membaca dari scratch yang sama.
 *
 * Modul ini **belum dipakai jalur pesan produksi** (lihat `docs/33` §33.7):
 * format wire & state ratchet NYX saat ini beku, dan peralihan ke v2 harus
 * bergerbang kapabilitas + diuji end-to-end dulu.
 *
 * **Urutan baca memory itu penting.** Akses pertama ke scratch Rust memicu
 * alokasi malas + `memory.grow`, dan grow **melepas** (`detach`) ArrayBuffer
 * yang sudah dipegang. Jadi getter memori SELALU dipanggil lebih dulu, dan
 * `memory.buffer` dibaca paling akhir saat membentuk view.
 */

/** Kode hasil dari ABI WASM (harus sama dengan `src/lib.rs`). */
export const SPQR_OK = 0;
export const SPQR_ERR_CRATE = 1;
export const SPQR_ERR_ARGS = 3;
export const SPQR_ERR_ENTROPY = 4;
/** Status khusus `currentVersion`: masih negosiasi. */
export const SPQR_VERSION_NEGOTIATING = 100;

/** Batas entropi per panggilan (byte) — sama dengan `MAX_ENTROPY` di Rust. */
export const SPQR_MAX_ENTROPY_BYTES = 4096;
/** Ukuran scratch buffer input/output di Rust. */
export const SPQR_SCRATCH_BYTES = 256 * 1024;

export type SpqrVersion = 'V0' | 'V1';
export type SpqrDirection = 'A2B' | 'B2A';
export type SpqrVersionStatus = SpqrVersion | 'NEGOTIATING';

export class SpqrError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'SpqrError';
  }
}

const describeCode = (code: number): string => {
  switch (code) {
    case SPQR_ERR_CRATE:
      return 'spqr: state/pesan tidak bisa diproses (StateDecode/ChainNotAvailable/dll)';
    case SPQR_ERR_ARGS:
      return 'spqr: argumen tidak sah (panjang di luar batas)';
    case SPQR_ERR_ENTROPY:
      return 'spqr: entropi host habis/tidak disuntik';
    default:
      return `spqr: kode hasil tak dikenal (${code})`;
  }
};

interface SpqrExports {
  memory: WebAssembly.Memory;
  spqr_in_ptr(): number;
  spqr_out_ptr(): number;
  spqr_out_len(): number;
  spqr_seed_entropy(length: number): number;
  spqr_empty_state(): number;
  spqr_current_version(length: number): number;
  spqr_initial_state(authKeyLen: number, direction: number, version: number, minVersion: number): number;
  spqr_send(stateLen: number, entropyLen: number): number;
  spqr_recv(stateLen: number, msgLen: number): number;
}

export interface SpqrRatchet {
  /** State kosong (referensi; ratchet sebenarnya dimulai dari `initialState`). */
  emptyState(): Uint8Array;
  currentVersion(state: Uint8Array): SpqrVersionStatus;
  initialState(input: {
    authKey: Uint8Array;
    direction: SpqrDirection;
    version?: SpqrVersion;
    minVersion?: SpqrVersion;
  }): Uint8Array;
  send(state: Uint8Array): { state: Uint8Array; msg: Uint8Array; key: Uint8Array | null };
  recv(state: Uint8Array, msg: Uint8Array): { state: Uint8Array; key: Uint8Array | null };
  /** Entropi per panggilan `send` (byte). Default 128. */
  readonly entropyBytes: number;
}

const DIRECTION_CODE: Record<SpqrDirection, number> = { A2B: 0, B2A: 1 };
const VERSION_CODE: Record<SpqrVersion, number> = { V0: 0, V1: 1 };

function defaultRandomBytes(length: number): Uint8Array {
  const globalCrypto = globalThis.crypto as Crypto | undefined;
  if (!globalCrypto || typeof globalCrypto.getRandomValues !== 'function') {
    throw new SpqrError(SPQR_ERR_ENTROPY, 'spqr: crypto.getRandomValues tidak tersedia');
  }
  return globalCrypto.getRandomValues(new Uint8Array(length));
}

function readFramed(buffer: Uint8Array, offset: number): { bytes: Uint8Array; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
  const length = view.getUint32(0, false);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) throw new SpqrError(SPQR_ERR_CRATE, 'spqr: framing output rusak');
  return { bytes: buffer.slice(start, end), next: end };
}

function readOptionalKey(buffer: Uint8Array, offset: number): { key: Uint8Array | null; next: number } {
  const present = buffer[offset] ?? 0;
  const { bytes, next } = readFramed(buffer, offset + 1);
  return { key: present === 1 ? bytes : null, next };
}

/**
 * Instansiasi modul. `bytes` = isi `packages/spqr-wasm/dist/spqr.wasm`.
 * Modul tanpa import → tidak ada objek import yang perlu disiapkan.
 */
export function instantiateSpqrRatchet(
  // `Uint8Array<ArrayBuffer>` (bukan `ArrayBufferLike`) karena `WebAssembly.Module`
  // menolak buffer yang mungkin `SharedArrayBuffer`.
  bytes: Uint8Array<ArrayBuffer>,
  options: { randomBytes?: (length: number) => Uint8Array; entropyBytes?: number } = {}
): SpqrRatchet {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    // Guardrail: modul yang kita bangun tidak boleh menarik host function apa pun.
    throw new SpqrError(SPQR_ERR_ARGS, `spqr: modul WASM punya ${imports.length} import (diharapkan 0)`);
  }

  const instance = new WebAssembly.Instance(module, {});
  const wasm = instance.exports as unknown as SpqrExports;
  const memory = wasm.memory;
  if (!memory) throw new SpqrError(SPQR_ERR_ARGS, 'spqr: modul tidak mengekspor memory');

  const entropyBytes = options.entropyBytes ?? 128;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  // Penting: `spqr_*_ptr()` dulu (bisa memicu grow → ArrayBuffer lama di-detach),
  // `memory.buffer` dibaca paling akhir.
  const inputView = () => {
    const ptr = wasm.spqr_in_ptr();
    return new Uint8Array(memory.buffer, ptr, SPQR_SCRATCH_BYTES);
  };
  const outputBytes = () => {
    const ptr = wasm.spqr_out_ptr();
    const length = wasm.spqr_out_len();
    return new Uint8Array(memory.buffer, ptr, length).slice();
  };

  const writeInput = (bytes: Uint8Array, offset = 0) => {
    if (bytes.length + offset > SPQR_SCRATCH_BYTES) {
      throw new SpqrError(SPQR_ERR_ARGS, 'spqr: input melebihi scratch buffer');
    }
    inputView().set(bytes, offset);
  };

  const seedEntropy = (length: number) => {
    if (length <= 0 || length > SPQR_MAX_ENTROPY_BYTES) {
      throw new SpqrError(SPQR_ERR_ARGS, 'spqr: panjang entropi di luar batas');
    }
    const seed = randomBytes(length);
    if (seed.length !== length) throw new SpqrError(SPQR_ERR_ENTROPY, 'spqr: sumber entropi mengembalikan panjang salah');
    writeInput(seed);
    const code = wasm.spqr_seed_entropy(length);
    if (code !== SPQR_OK) throw new SpqrError(code, describeCode(code));
  };

  const expect = (code: number) => {
    if (code !== SPQR_OK) throw new SpqrError(code, describeCode(code));
    return outputBytes();
  };

  return {
    entropyBytes,

    emptyState() {
      return expect(wasm.spqr_empty_state());
    },

    currentVersion(state) {
      writeInput(state);
      const raw = expect(wasm.spqr_current_version(state.length));
      const code = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false);
      if (code === SPQR_VERSION_NEGOTIATING) return 'NEGOTIATING';
      return code === 1 ? 'V1' : 'V0';
    },

    initialState({ authKey, direction, version = 'V1', minVersion = 'V1' }) {
      writeInput(authKey);
      return expect(
        wasm.spqr_initial_state(authKey.length, DIRECTION_CODE[direction], VERSION_CODE[version], VERSION_CODE[minVersion])
      );
    },

    send(state) {
      // Entropi dulu, baru state: `spqr_seed_entropy` membaca scratch yang sama.
      seedEntropy(entropyBytes);
      writeInput(state);
      const raw = expect(wasm.spqr_send(state.length, entropyBytes));

      const stateFrame = readFramed(raw, 0);
      const msgFrame = readFramed(raw, stateFrame.next);
      const { key } = readOptionalKey(raw, msgFrame.next);
      return { state: stateFrame.bytes, msg: msgFrame.bytes, key };
    },

    recv(state, msg) {
      writeInput(state);
      writeInput(msg, state.length);
      const raw = expect(wasm.spqr_recv(state.length, msg.length));

      const stateFrame = readFramed(raw, 0);
      const { key } = readOptionalKey(raw, stateFrame.next);
      return { state: stateFrame.bytes, key };
    },
  };
}
