// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(5)] Fuzz deterministik untuk **parser yang menerima input tak
 * terpercaya**. Gate `docs/30` §30.11 butir (4) meminta "fuzz jalan ≥1 jam tanpa
 * crash"; harness ini yang menjalankannya, dengan dua keputusan sadar:
 *
 *  1. **Tanpa `cargo-fuzz`/nightly untuk parser TS.** Targetnya adalah kode TS
 *     (`parseTransportHello`, `readBackupHeader`, `parseBackupArchive`,
 *     `readBackupChunk`, `unpadBackupPayload`), jadi runner-nya vitest: tidak ada
 *     toolchain baru, jalan di CI maupun dev, dan bisa diperpanjang lewat env
 *     (`NYX_FUZZ_ITERS` / `NYX_FUZZ_SECONDS`) — lihat `package.json`
 *     `fuzz:parsers` / `fuzz:parsers:hour`.
 *  2. **Deterministik (xorshift32 + seed tetap).** Tanpa `Math.random`: temuan
 *     selalu bisa direproduksi dari `seed + iterasi + inputHex` yang dilaporkan,
 *     dan dua eksekusi dengan seed sama memberi hasil identik (dijaga test).
 *
 * Invariant yang diperiksa (yang membuat fuzz ini berguna, bukan sekadar jalan):
 *
 *  - Parser **tidak boleh melempar error tipe lain** untuk input sampah. Kontrak
 *    `BackupFormatError` adalah cara UI membedakan "berkas rusak" dari bug, jadi
 *    `TypeError`/`RangeError` di sini = regresi nyata.
 *  - `parseTransportHello` (jalur peer, tanpa auth) **tidak boleh melempar sama
 *    sekali** — hasilnya hanya `null` atau hello yang sah.
 *  - Nilai balik yang diterima tetap harus **invarian bentuknya** (mis. salt
 *    header = 16 byte, `frameCount ≥ 1`), bukan hanya "tidak meledak".
 *
 * Fixture kripto: `BackupCryptoBackend` palsu yang **meniru kontrak produksi**
 * (`aeadOpen` mengembalikan `null` saat gagal, tidak melempar) dan sengaja
 * mengembalikan plaintext berukuran/berisi sembarang — inilah cara menguji
 * tahap setelah AEAD tanpa kunci nyata.
 */

import {
  BACKUP_SALT_BYTES,
  BackupFormatError,
  BackupFrameType,
  readBackupHeader,
  parseBackupArchive,
  unpadBackupPayload,
  type BackupCryptoBackend,
  type BackupFrameOutput,
} from './backupFormat';
import {
  BACKUP_TABLE_FRAME_TYPE,
  readBackupChunk,
  type BackupValueCodec,
} from './backupPayload';
import { parseTransportHello } from '@nyx/shared';

// ─── PRNG deterministik ─────────────────────────────────────────────────────

/** xorshift32 — kecil, deterministik, cukup untuk mutasi byte. */
export class FuzzRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** Bilangan bulat di [0, maxExclusive). */
  below(maxExclusive: number): number {
    return maxExclusive <= 0 ? 0 : this.next() % maxExclusive;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.next() & 0xff;
    return out;
  }
}

// ─── Mutator & korpus awal ──────────────────────────────────────────────────

/** Arsip "berbentuk sah" minimal (header saja) sebagai titik awal mutasi. */
function seedArchiveHeader(): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = 0x4e; // N
  out[1] = 0x59; // Y
  out[2] = 0x58; // X
  out[3] = 0x42; // B
  out[4] = 1; // versi format
  out[6] = 0; // frameCount hi
  out[7] = 2; // frameCount = 2
  for (let i = 8; i < 8 + BACKUP_SALT_BYTES; i++) out[i] = (i * 7) & 0xff;
  return out;
}

/** Frame "berbentuk sah" minimal tanpa isi terenkripsi (untuk mutasi). */
function seedFrameBytes(): Uint8Array {
  const out = new Uint8Array(32 + 1 + 4 + 24 + 4 + 16);
  out.set(seedArchiveHeader(), 0);
  let offset = 32;
  out[offset] = BACKUP_TABLE_FRAME_TYPE['messages']!;
  offset += 5;
  offset += 24; // nonce
  const view = new DataView(out.buffer);
  view.setUint32(offset, 16, false); // ciphertextLength = tag minimal
  return out;
}

export const FUZZ_SEEDS: ReadonlyArray<Uint8Array> = [
  new Uint8Array(0),
  seedArchiveHeader(),
  seedFrameBytes(),
  new TextEncoder().encode('{"v":1,"caps":["hello-v1"]}'),
  new TextEncoder().encode('{"v":1,"caps":[]}'),
];

/**
 * Satu langkah mutasi byte. Strategi dipilih acak-deterministik; semuanya
 * "merusak" benih dengan cara yang berbeda supaya cabang parser yang berbeda
 * terlatih (panjang, magic, index, tipe frame, panjang ciphertext).
 */
export function mutateBytes(rng: FuzzRng, input: Uint8Array): Uint8Array {
  const out = input.slice();
  const strategy = rng.below(8);

  switch (strategy) {
    case 0: {
      // Bit flip.
      if (out.length === 0) return out;
      const at = rng.below(out.length);
      out[at] = (out[at]! ^ (1 << rng.below(8))) & 0xff;
      return out;
    }
    case 1: {
      // Byte acak.
      if (out.length === 0) return out;
      out[rng.below(out.length)] = rng.next() & 0xff;
      return out;
    }
    case 2: {
      // Potong (latih "terpotong"/truncate).
      return out.slice(0, rng.below(out.length + 1));
    }
    case 3: {
      // Tambah byte acak (latih panjang tak terduga).
      const extra = rng.bytes(1 + rng.below(64));
      const merged = new Uint8Array(out.length + extra.length);
      merged.set(out, 0);
      merged.set(extra, out.length);
      return merged;
    }
    case 4: {
      // Duplikasi sepotong di posisi acak (latih index/AAD).
      if (out.length === 0) return out;
      const start = rng.below(out.length);
      const end = Math.min(out.length, start + 1 + rng.below(32));
      const piece = out.slice(start, end);
      const merged = new Uint8Array(out.length + piece.length);
      merged.set(out.slice(0, start), 0);
      merged.set(piece, start);
      merged.set(out.slice(start), start + piece.length);
      return merged;
    }
    case 5: {
      // Panjang acak penuh (bukan mutasi benih).
      return rng.bytes(rng.below(96));
    }
    case 6: {
      // Tukar dua potongan (latih reorder).
      if (out.length < 2) return out;
      const cut = rng.below(out.length);
      return Uint8Array.from([...out.slice(cut), ...out.slice(0, cut)]);
    }
    default: {
      // Nol-kan sebuah rentang (latih padding non-nol & panjang 0).
      if (out.length === 0) return out;
      const start = rng.below(out.length);
      const len = 1 + rng.below(Math.max(1, out.length - start));
      out.fill(0, start, start + len);
      return out;
    }
  }
}

// ─── Fixture kripto/kodek (tanpa kunci nyata) ───────────────────────────────

/**
 * Backend kripto palsu yang kontraknya = produksi: `aeadOpen` mengembalikan
 * `null` saat autentikasi gagal (tidak melempar). Plaintext yang dikembalikan
 * saat "berhasil" sengaja acak → melatih `unpadBackupPayload`.
 */
export function makeFuzzCrypto(rng: FuzzRng): BackupCryptoBackend {
  return {
    randomBytes: (length) => rng.bytes(length),
    aeadSeal: () => rng.bytes(16),
    aeadOpen: ({ ciphertext }) => {
      // 3 dari 4 frame "gagal autentikasi" (pola normal untuk input sampah),
      // sisanya mengembalikan plaintext sembarang = kasus yang paling sulit.
      if (rng.below(4) !== 0) return null;
      return rng.bytes(rng.below(1 + (ciphertext.length % 97)));
    },
  };
}

/** Kodek identitas: fuzz ini menguji container, bukan base64 libsodium. */
export const identityCodec: BackupValueCodec = {
  encodeBytes: (bytes) => Array.from(bytes).join(','),
  decodeBytes: (text) => Uint8Array.from(text.length === 0 ? [] : text.split(',').map((n) => Number(n) & 0xff)),
};

// ─── Target & invariant ─────────────────────────────────────────────────────

export interface FuzzCrash {
  target: string;
  seed: number;
  iteration: number;
  /** Hex input (dipotong 256 byte). Bisa kosong untuk input 0 byte. */
  inputHex: string;
  /** Panjang input asli — `inputHex` kosong tetap bisa direproduksi. */
  inputLength: number;
  errorName: string;
  errorMessage: string;
}

export interface FuzzTargetReport {
  name: string;
  iterations: number;
  crashes: FuzzCrash[];
}

export interface FuzzReport {
  seed: number;
  iterationsPerTarget: number;
  ms: number;
  targets: FuzzTargetReport[];
  totalCrashes: number;
}

export interface FuzzOptions {
  seed?: number;
  /** Iterasi per target. Diabaikan bila `seconds` diisi. */
  iterations?: number;
  /** Batas waktu (detik); 0/undefined = pakai `iterations`. */
  seconds?: number;
  /** Cetak progres tiap N iterasi (0 = senyap). */
  progressEvery?: number;
}

function toHex(bytes: Uint8Array, maxBytes = 256): string {
  const slice = bytes.slice(0, maxBytes);
  let out = '';
  for (const byte of slice) out += byte.toString(16).padStart(2, '0');
  return out + (bytes.length > maxBytes ? `…(+${bytes.length - maxBytes}B)` : '');
}

function asHex(value: unknown): string {
  if (value instanceof Uint8Array) return toHex(value);
  if (typeof value === 'string') return value.slice(0, 512);
  return String(value).slice(0, 512);
}

export interface FuzzTarget {
  name: string;
  /** Jalankan parser + invariant bentuknya. */
  run(input: Uint8Array, rng: FuzzRng): void;
}

function assertOnlyBackupFormatError(target: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof BackupFormatError) return;
    throw Object.assign(
      new Error(`[${target}] melempar ${(error as Error)?.name ?? typeof error}: ${(error as Error)?.message ?? ''}`),
      { cause: error }
    );
  }
}

export const FUZZ_TARGETS: ReadonlyArray<FuzzTarget> = [
  {
    name: 'parseTransportHello',
    // Jalur peer tanpa auth: TIDAK boleh melempar sama sekali.
    run: (input) => {
      const fromBytes = parseTransportHello(input);
      const text = new TextDecoder().decode(input);
      const fromText = parseTransportHello(text);
      for (const parsed of [fromBytes, fromText]) {
        if (parsed === null) continue;
        if (!Number.isInteger(parsed.v) || parsed.v < 1 || parsed.v > 65535) {
          throw new Error(`hello.v di luar batas: ${String(parsed.v)}`);
        }
        if (!Array.isArray(parsed.caps) || parsed.caps.length > 32) {
          throw new Error(`hello.caps tidak sah: ${JSON.stringify(parsed.caps).slice(0, 80)}`);
        }
        if (parsed.caps.some((cap) => typeof cap !== 'string' || cap.length === 0 || cap.length > 64)) {
          throw new Error(`hello cap tidak sah: ${JSON.stringify(parsed.caps).slice(0, 80)}`);
        }
      }
    },
  },
  {
    name: 'readBackupHeader',
    run: (input) =>
      assertOnlyBackupFormatError('readBackupHeader', () => {
        const header = readBackupHeader(input);
        if (header.salt.length !== BACKUP_SALT_BYTES) throw new Error(`salt ${header.salt.length} byte`);
        if (header.frameCount < 1) throw new Error(`frameCount ${header.frameCount}`);
        if (header.formatVersion !== 1) throw new Error(`formatVersion ${header.formatVersion}`);
      }),
  },
  {
    name: 'unpadBackupPayload',
    run: (input) =>
      assertOnlyBackupFormatError('unpadBackupPayload', () => {
        const payload = unpadBackupPayload(input);
        if (payload.length > input.length) throw new Error('payload lebih panjang dari input');
      }),
  },
  {
    name: 'parseBackupArchive',
    run: (input, rng) => {
      const key = new Uint8Array(32);
      const crypto = makeFuzzCrypto(rng);
      assertOnlyBackupFormatError('parseBackupArchive', () => {
        const parsed = parseBackupArchive(input, key, crypto);
        const known = new Set<number>(Object.values(BackupFrameType) as number[]);
        for (const frame of parsed.frames) {
          if (!known.has(frame.type)) throw new Error(`tipe frame tidak dikenal: ${String(frame.type)}`);
        }
        if (parsed.formatVersion !== 1) throw new Error(`formatVersion ${parsed.formatVersion}`);
        if (parsed.salt.length !== BACKUP_SALT_BYTES) throw new Error(`salt ${parsed.salt.length} byte`);
      });
    },
  },
  {
    name: 'readBackupChunk',
    run: (input) => {
      const frame: BackupFrameOutput = {
        type: BACKUP_TABLE_FRAME_TYPE['messages']!,
        payload: input,
      };
      assertOnlyBackupFormatError('readBackupChunk', () => {
        readBackupChunk(frame, identityCodec);
      });
    },
  },
];

/**
 * Jalankan kampanye fuzz.
 *
 * - Deterministik untuk `(seed, iterations)` yang sama.
 * - `targetsOverride` dipakai **self-test harness** (lihat `fuzzParsers.test.ts`):
 *   membuktikan pelaporan crash benar-benar bekerja, bukan selalu hijau karena
 *   invariant-nya tidak pernah menyala.
 */
export function runParserFuzz(
  options: FuzzOptions = {},
  targetsOverride?: ReadonlyArray<FuzzTarget>
): FuzzReport {
  const targetList = targetsOverride ?? FUZZ_TARGETS;
  const seed = options.seed ?? 0x1f2e3d4c;
  const seconds = options.seconds ?? 0;
  const iterations = Math.max(1, options.iterations ?? 3000);
  const started = Date.now();
  const targets: FuzzTargetReport[] = [];
  // Anggaran waktu dibagi rata antar-target (`NYX_FUZZ_SECONDS=3600` = ~1 jam total).
  const perTargetMs = seconds > 0 ? (seconds * 1000) / targetList.length : Number.POSITIVE_INFINITY;

  for (const target of targetList) {
    const report: FuzzTargetReport = { name: target.name, iterations: 0, crashes: [] };
    const deadline = Date.now() + perTargetMs;

    // Batas iterasi per target; `seconds > 0` mengalahkan `iterations`.
    const limit = seconds > 0 ? Number.POSITIVE_INFINITY : iterations;
    for (let i = 0; i < limit; i++) {
      if (seconds > 0 && Date.now() >= deadline) break;
      report.iterations = i + 1;

      // Seed per-iterasi diturunkan dari seed kampanye → repro satu baris.
      const iterationSeed = (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      const rng = new FuzzRng(iterationSeed);
      const seedBytes = FUZZ_SEEDS[i % FUZZ_SEEDS.length]!;
      const input = rng.below(2) === 0 ? mutateBytes(rng, seedBytes) : rng.bytes(rng.below(96));

      try {
        target.run(input, rng);
      } catch (error) {
        report.crashes.push({
          target: target.name,
          seed: iterationSeed,
          iteration: i,
          inputHex: asHex(input),
          inputLength: input.length,
          errorName: (error as Error)?.name ?? typeof error,
          errorMessage: (error as Error)?.message ?? String(error),
        });
        // Satu temuan per target cukup untuk dilaporkan; lanjut mencari yang lain
        // hanya akan mengulang crash yang sama.
        break;
      }

      if (options.progressEvery && i > 0 && i % options.progressEvery === 0) {
        console.log(`[fuzz] ${target.name}: ${i} iterasi, ${report.crashes.length} temuan`);
      }
    }

    targets.push(report);
  }

  const totalCrashes = targets.reduce((sum, t) => sum + t.crashes.length, 0);
  return {
    seed,
    iterationsPerTarget: Math.min(...targets.map((t) => t.iterations)),
    ms: Date.now() - started,
    targets,
    totalCrashes,
  };
}

/** Ringkasan satu baris per target — dipakai test agar angka terlihat di log. */
export function formatFuzzReport(report: FuzzReport): string {
  const lines = [
    `[fuzz] parsers: ${report.iterationsPerTarget} iterasi/target dalam ${report.ms} ms (seed 0x${report.seed.toString(16)})`,
  ];
  for (const target of report.targets) {
    lines.push(`  - ${target.name}: ${target.iterations} iterasi, ${target.crashes.length} temuan`);
    for (const crash of target.crashes) {
      lines.push(
        `      ✖ seed=0x${crash.seed.toString(16)} iter=${crash.iteration} ${crash.errorName}: ${crash.errorMessage}\n        input(${crash.inputLength}B)=${crash.inputHex || '(kosong)'}`
      );
    }
  }
  return lines.join('\n');
}
