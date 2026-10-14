// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/33 §33.5] Penyimpanan state ratchet braid SPQR per sesi.
 *
 * Benchmark menghasilkan dua angka yang menentukan desain ini
 * (`docs/33` §33.5): langkah ratchet murah (p50 0,26 ms) tetapi **state 3,8 KiB
 * ditulis ulang setiap langkah**. Menyimpan state itu apa adanya per pesan
 * berarti satu tulis IndexedDB + satu seal kunci (~3,8 KiB) per pesan — jauh
 * lebih mahal daripada kripto-nya sendiri. Karena itu:
 *
 *   1. **Ter-seal `ENC1:`** (kunci `masterSeed`), sama seperti state DR v1
 *      (`utils/crypto.ts`): state braid memuat chunk ML-KEM yang belum
 *      dipertukarkan, dan membocorkannya = kehilangan properti PCS.
 *   2. **Tulis di-koalesensi** (debounce): beberapa pesan dalam satu burst
 *      menghasilkan satu tulis. `flushSpqrState()` memaksa tulis segera (dipakai
 *      saat tab disembunyikan/keluar).
 *   3. **Batas ukuran** (`SPQR_MAX_STATE_BYTES`) — state yang tumbuh tanpa batas
 *      (skipped key menumpuk karena pesan hilang berturut-turut) ditolak dengan
 *      terlihat, bukan diam-diam menulis 8 KiB setiap langkah.
 *   4. **Fail-closed saat dibaca**: state yang tidak bisa dibuka (vault terkunci,
 *      cipher rusak) mengembalikan `undefined` — pemanggil harus memulai sesi
 *      baru, bukan memakai state kosong yang diam-diam memutus rantai.
 *
 * Modul ini sengaja hanya menyimpan/mengambil **byte opaque**: ia tidak tahu
 * bentuk state braid, jadi modul WASM tetap satu-satunya pemilik format
 * (`spqrRatchet.ts`).
 *
 * **Koalesensi tulis aman dibaca:** `loadSpqrState` selalu mengembalikan state
 * yang **paling baru** — termasuk tulis yang masih menunggu debounce (peta
 * `pending`). Tanpa itu, langkah ratchet berikutnya di tab yang sama akan
 * membaca state lama dari IndexedDB dan mengulang chunck braid yang sudah
 * dikirim (pesan peer berikutnya tidak bisa dibuka). Tulis yang tertunda tetap
 * ditulis ke disk seperti biasa.
 */

import { db } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';
import type { RatchetWireVersion } from './spqrNegotiation';

/** Prefix baris state di `kvStore` (satu baris per sesi). */
export const SPQR_STATE_KEY_PREFIX = 'nyx_spqr_state_v1:';

/**
 * Batas ukuran state (byte, sebelum seal). 64 KiB ≈ 16× state mapan 3,8 KiB:
 * cukup untuk pertumbuhan wajar (skipped key + chunk braid yang belum
 * dipertukarkan) sekaligus menahan state yang membengkak karena bug kehilangan
 * pesan bertubi-tubi.
 */
export const SPQR_MAX_STATE_BYTES = 64 * 1024;

/** Jendela koalesensi tulis (ms). */
export const SPQR_STATE_WRITE_DEBOUNCE_MS = 250;

export interface SpqrStateRecord {
  sessionId: string;
  /** Versi wire yang memakai state ini (`v2` = jalur braid). */
  version: RatchetWireVersion;
  state: Uint8Array;
  /** ms; kapan state terakhir benar-benar ditulis. */
  updatedAt: number;
}

export class SpqrStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpqrStateError';
  }
}

const stateKey = (sessionId: string): string => `${SPQR_STATE_KEY_PREFIX}${sessionId}`;

/** Validasi id sesi: nilai ini masuk ke kunci baris, jadi tidak boleh kosong/aneh. */
function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 200 || sessionId.includes('\u0000')) {
    throw new SpqrStateError('spqr: sessionId tidak sah');
  }
}

// ---------------------------------------------------------------------------
// Koalesensi tulis
// ---------------------------------------------------------------------------

interface PendingWrite {
  sessionId: string;
  version: RatchetWireVersion;
  state: Uint8Array;
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingWrite>();

/** Tulis satu baris state (tanpa debounce). */
async function writeState(entry: PendingWrite, now: number): Promise<void> {
  if (entry.state.length === 0) throw new SpqrStateError('spqr: state kosong');
  if (entry.state.length > SPQR_MAX_STATE_BYTES) {
    throw new SpqrStateError(
      `spqr: state terlalu besar (${entry.state.length} > ${SPQR_MAX_STATE_BYTES} byte)`
    );
  }
  await db.kvStore.put({
    key: stateKey(entry.sessionId),
    value: await encryptValueAtRest(JSON.stringify({
      v: entry.version,
      s: base64FromBytes(entry.state),
      t: now,
    })),
  });
}

/**
 * Simpan state sesi (di-koalesensi).
 *
 * Ukuran state diperiksa **sebelum** dijadwalkan: state yang melampaui batas
 * tidak pernah masuk antrean, jadi tidak ada tulis 1 MB yang datang belakangan.
 */
export async function saveSpqrState(input: {
  sessionId: string;
  state: Uint8Array;
  version: RatchetWireVersion;
  now?: number;
}): Promise<void> {
  assertSessionId(input.sessionId);
  if (input.state.length === 0) throw new SpqrStateError('spqr: state kosong');
  if (input.state.length > SPQR_MAX_STATE_BYTES) {
    throw new SpqrStateError(
      `spqr: state terlalu besar (${input.state.length} > ${SPQR_MAX_STATE_BYTES} byte)`
    );
  }

  const now = input.now ?? Date.now();
  const existing = pending.get(input.sessionId);
  if (existing?.timer) clearTimeout(existing.timer);

  const entry: PendingWrite = {
    sessionId: input.sessionId,
    version: input.version,
    // Salin: pemanggil (langkah ratchet) boleh saja memakai ulang/memzero buffer.
    state: input.state.slice(),
    timer: null,
  };
  entry.timer = setTimeout(() => {
    void flushSpqrState(input.sessionId);
  }, SPQR_STATE_WRITE_DEBOUNCE_MS);
  pending.set(input.sessionId, entry);
}

/**
 * Tulis sekarang juga (batalkan debounce) untuk satu sesi, atau semua sesi bila
 * `sessionId` tidak diberikan. Aman dipanggil saat tidak ada yang tertunda.
 */
export async function flushSpqrState(sessionId?: string): Promise<void> {
  const targets = sessionId
    ? [pending.get(sessionId)].filter((entry): entry is PendingWrite => !!entry)
    : [...pending.values()];

  for (const entry of targets) {
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(entry.sessionId);
    try {
      await writeState(entry, Date.now());
    } catch (error) {
      // Nilai state ini akan hilang; itu lebih baik daripada kehilangan seluruh
      // sesi karena satu tulis gagal — tapi harus terlihat.
      console.error('[SPQR] Gagal menyimpan state ratchet:', entry.sessionId, error);
    }
  }
}

/** Buang antrean tanpa menulis (dipakai wipe/panic). */
export function discardPendingSpqrState(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pending.clear();
}

// ---------------------------------------------------------------------------
// Baca / hapus
// ---------------------------------------------------------------------------

/**
 * Muat state sesi. `undefined` bila belum ada — dan juga bila barisnya tidak
 * bisa dibuka (vault terkunci / cipher rusak): pemanggil tidak boleh menyimpulkan
 * "state kosong" dari kegagalan dekripsi.
 */
export async function loadSpqrState(sessionId: string): Promise<SpqrStateRecord | undefined> {
  assertSessionId(sessionId);

  // Tulis yang belum ter-flush adalah state TERBARU (debounce 250 ms) — state
  // yang sudah ada di disk bisa tertinggal satu/lebih langkah ratchet.
  const pendingEntry = pending.get(sessionId);
  if (pendingEntry) {
    return {
      sessionId,
      version: pendingEntry.version,
      state: pendingEntry.state.slice(),
      updatedAt: Date.now(),
    };
  }

  const row = await db.kvStore.get(stateKey(sessionId));
  if (typeof row?.value !== 'string') return undefined;

  const plain = await decryptValueAtRest(row.value);
  if (!plain) {
    console.warn('[SPQR] State ratchet tidak bisa dibuka (vault terkunci?) — sesi dianggap baru.');
    return undefined;
  }

  try {
    const parsed = JSON.parse(plain) as { v?: unknown; s?: unknown; t?: unknown };
    if (parsed.v !== 'v1' && parsed.v !== 'v2') throw new Error('versi state tidak dikenal');
    if (typeof parsed.s !== 'string') throw new Error('state bukan base64');
    const state = bytesFromBase64(parsed.s);
    if (state.length === 0) throw new Error('state kosong');
    return {
      sessionId,
      version: parsed.v,
      state,
      updatedAt: typeof parsed.t === 'number' ? parsed.t : 0,
    };
  } catch (error) {
    console.error('[SPQR] State ratchet rusak:', sessionId, error);
    return undefined;
  }
}

/** Hapus state satu sesi (setelah rollback terkonfirmasi/rotasi sesi). */
export async function deleteSpqrState(sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const entry = pending.get(sessionId);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(sessionId);
  await db.kvStore.delete(stateKey(sessionId));
}

/** Hapus semua state braid (wipe/panic — lihat `nukeProtocol`). */
export async function clearSpqrStates(): Promise<void> {
  discardPendingSpqrState();
  try {
    await db.kvStore.where('key').startsWith(SPQR_STATE_KEY_PREFIX).delete();
  } catch (error) {
    console.warn('[SPQR] Gagal menghapus state braid:', error);
  }
}

// ---------------------------------------------------------------------------
// Kodek (tanpa Buffer — modul ini ikut bundel browser)
// ---------------------------------------------------------------------------

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}
