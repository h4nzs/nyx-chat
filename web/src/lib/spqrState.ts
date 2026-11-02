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

/** Tulis satu baris ter-seal pada kunci tertentu (tanpa debounce). */
async function writeSealedRow(
  key: string,
  input: { version: RatchetWireVersion; state: Uint8Array; now: number },
): Promise<void> {
  if (input.state.length === 0) throw new SpqrStateError('spqr: state kosong');
  if (input.state.length > SPQR_MAX_STATE_BYTES) {
    throw new SpqrStateError(
      `spqr: state terlalu besar (${input.state.length} > ${SPQR_MAX_STATE_BYTES} byte)`
    );
  }
  await db.kvStore.put({
    key,
    value: await encryptValueAtRest(JSON.stringify({
      v: input.version,
      s: base64FromBytes(input.state),
      t: input.now,
    })),
  });
}

/** Tulis baris state aktif sesi (tanpa debounce). */
async function writeState(entry: PendingWrite, now: number): Promise<void> {
  await writeSealedRow(stateKey(entry.sessionId), {
    version: entry.version,
    state: entry.state,
    now,
  });
}

/** Dekode nilai baris ter-seal; `undefined` = rusak (bukan "state kosong"). */
function decodeStoredRow(
  plain: string,
  label: string,
): { version: RatchetWireVersion; state: Uint8Array; updatedAt: number } | undefined {
  try {
    const parsed = JSON.parse(plain) as { v?: unknown; s?: unknown; t?: unknown };
    if (parsed.v !== 'v1' && parsed.v !== 'v2') throw new Error('versi state tidak dikenal');
    if (typeof parsed.s !== 'string') throw new Error('state bukan base64');
    const state = bytesFromBase64(parsed.s);
    if (state.length === 0) throw new Error('state kosong');
    return {
      version: parsed.v,
      state,
      updatedAt: typeof parsed.t === 'number' ? parsed.t : 0,
    };
  } catch (error) {
    console.error('[SPQR] State ratchet rusak:', label, error);
    return undefined;
  }
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

  const decoded = decodeStoredRow(plain, sessionId);
  if (!decoded) return undefined;
  return { sessionId, ...decoded };
}

/** Hapus state aktif satu sesi (baris era arsip TIDAK ikut dihapus). */
export async function deleteSpqrState(sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const entry = pending.get(sessionId);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(sessionId);
  await db.kvStore.delete(stateKey(sessionId));
}

// ---------------------------------------------------------------------------
// Arsip era braid (audit N5-01)
//
// Jalur v1 punya tiga slot `#archived_0..2` (`keychainDb.ts`, `RATCHET_ARCHIVE_
// SLOTS`): pesan yang tertunda melewati rotasi sesi tetap bisa dibuka karena
// state era lama TIDAK ditimpa. Jalur v2 dulu hanya punya SATU baris per
// percakapan dan baris itu dihapus saat sesi X3DH baru lahir — pesan v2 yang
// masih di jalan (peer offline, relay lambat) menjadi tidak terbaca permanen.
//
// Solusinya sama bentuknya dengan v1: sebelum baris aktif dihapus untuk era
// baru, isinya digeser ke arsip FIFO `#era_0..2` (slot 0 = era tepat
// sebelumnya). Arsip dibaca HANYA sebagai fallback dekripsi — ia tidak pernah
// dipromosikan menjadi state aktif (itu akan memutar ulang braid dan memutus
// rantai era sekarang).
// ---------------------------------------------------------------------------

/** Jumlah era braid lama yang disimpan (pola `RATCHET_ARCHIVE_SLOTS` v1). */
export const SPQR_STATE_ARCHIVE_SLOTS = 3;

const eraStateKey = (sessionId: string, slot: number): string =>
  `${SPQR_STATE_KEY_PREFIX}${sessionId}#era_${slot}`;

function sameState(
  a: { version: RatchetWireVersion; state: Uint8Array },
  b: { version: RatchetWireVersion; state: Uint8Array },
): boolean {
  if (a.version !== b.version) return false;
  if (a.state.length !== b.state.length) return false;
  for (let index = 0; index < a.state.length; index++) {
    if (a.state[index] !== b.state[index]) return false;
  }
  return true;
}

/** Baca satu slot arsip. `undefined` = kosong atau tidak bisa dibuka. */
async function loadEraState(
  sessionId: string,
  slot: number,
): Promise<SpqrStateRecord | undefined> {
  const row = await db.kvStore.get(eraStateKey(sessionId, slot));
  if (typeof row?.value !== 'string') return undefined;
  const plain = await decryptValueAtRest(row.value);
  if (!plain) return undefined;
  const decoded = decodeStoredRow(plain, `${sessionId}#era_${slot}`);
  if (!decoded) return undefined;
  return { sessionId, ...decoded };
}

/**
 * [audit N5-01] Tutup era braid sekarang dan mulai era baru tanpa membuang
 * kemampuan membaca pesan era lama.
 *
 * Dipanggil tepat sebelum state X3DH baru disimpan (penerima) atau saat sesi
 * dianggap berganti. Tulis yang masih menunggu debounce di-flush lebih dulu —
 * kalau tidak, arsip bisa berisi state satu/lebih langkah di belakang.
 */
export async function rotateSpqrStateForNewSession(sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  await flushSpqrState(sessionId);
  const current = await loadSpqrState(sessionId);

  if (current) {
    // [audit N9-03] Jangan menggeser arsip untuk era yang belum pernah maju.
    // Sesi X3DH baru bisa lahir berulang tanpa satu pun pesan v2 di antaranya
    // (retry handshake, kedua sisi mendirikan sesi berdekatan). Tanpa cek ini,
    // setiap rotasi menulis ulang state yang nyaris identik ke slot 0 dan
    // membuang era yang sebenarnya masih dibutuhkan — "tiga era terakhir"
    // menjadi jauh lebih pendek daripada yang dijanjikan N5-01.
    const newest = await loadEraState(sessionId, 0);
    const unchanged = newest !== undefined && sameState(newest, current);

    if (!unchanged) {
      // Geser FIFO: slot terakhir dibuang, sisanya turun satu posisi.
      for (let slot = SPQR_STATE_ARCHIVE_SLOTS - 1; slot > 0; slot--) {
        const older = await loadEraState(sessionId, slot - 1);
        if (older) {
          await writeSealedRow(eraStateKey(sessionId, slot), {
            version: older.version,
            state: older.state,
            now: older.updatedAt,
          });
        } else {
          await db.kvStore.delete(eraStateKey(sessionId, slot));
        }
      }
      await writeSealedRow(eraStateKey(sessionId, 0), {
        version: current.version,
        state: current.state,
        now: current.updatedAt || Date.now(),
      });
    }
  }

  await deleteSpqrState(sessionId);
}

/**
 * Era braid lama untuk satu percakapan, **terbaru dulu** (slot 0 = era tepat
 * sebelum yang aktif). Dipakai fallback dekripsi saat state aktif menolak
 * frame pesan lama.
 */
export async function loadArchivedSpqrStates(sessionId: string): Promise<SpqrStateRecord[]> {
  assertSessionId(sessionId);
  const out: SpqrStateRecord[] = [];
  for (let slot = 0; slot < SPQR_STATE_ARCHIVE_SLOTS; slot++) {
    const record = await loadEraState(sessionId, slot);
    if (record) out.push(record);
  }
  return out;
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
