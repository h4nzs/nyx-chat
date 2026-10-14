// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.6 poin 2] Loop monitor Key Transparency di klien.
 *
 * Verifier (`web/src/lib/keyTransparency.ts`) sudah bisa memverifikasi bukti,
 * dan op `monitor_build` (op 6 WASM) sudah bisa merakit `MonitorRequest` dari
 * state yang dimiliki klien. Yang belum ada — dan yang modul ini isi — adalah
 * **tempat menyimpan state itu** dan **satu langkah monitor** yang bisa
 * dijadwalkan:
 *
 *   1. `saveKtState` / `loadKtStates` — tree head + monitoring data per search
 *      key, disimpan di tabel `ktMonitoring` (NyxUnifiedDB) dengan nilai
 *      ter-seal `ENC1:` (masterSeed). Tree head mengungkap kontak mana yang
 *      dimonitor, jadi tidak boleh plaintext.
 *   2. `planKtMonitor` — pilih baris yang siap dimonitor (punya monitoring data
 *      + anchor distinguished) dan tentukan tree head terakhir.
 *   3. `runKtMonitorOnce` — rakit permintaan, ambil bukti, verifikasi, lalu
 *      simpan state baru. **State hanya ditulis setelah verifikasi berhasil**,
 *      jadi kegagalan jaringan/bukti palsu tidak merusak state (fail-closed).
 *
 * Kenapa ini penting (bukan nice-to-have): `docs/34` §34.5 menunjukkan bahwa
 * tanpa anchor yang tersimpan, perubahan `search`/tree head **tidak terdeteksi**
 * — keamanan KT bergantung pada loop ini.
 *
 * Batas yang jujur: modul ini belum dipanggil dari jalur bundle produksi
 * (`docs/34` §34.6 poin 1) sehingga belum ada state yang terisi di lapangan;
 * dan notifikasi ke user saat `keyVersion` berubah diserahkan ke pemanggil
 * (`KtMonitorOutcome.changed`) supaya modul ini tetap bebas UI/toast.
 */

import { db, type KtMonitoringRecord } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';
import type { KeyTransparencyVerifier, KtConfig, KtMonitoringData, KtStoredTreeHead } from './keyTransparency';

/** State per search key yang dihidupkan kembali dari penyimpanan. */
export interface KtStoredState {
  searchKey: Uint8Array;
  treeHead?: KtStoredTreeHead;
  monitoringData?: KtMonitoringData;
  distinguishedTreeHead?: KtStoredTreeHead;
  keyVersion?: number;
  /** Ukuran pohon saat bukti terakhir diterima (dipakai sebagai `last`). */
  treeSize?: number;
}

export interface KtStateUpdate {
  searchKey: Uint8Array;
  treeHead?: KtStoredTreeHead;
  monitoringData?: KtMonitoringData;
  distinguishedTreeHead?: KtStoredTreeHead;
  keyVersion?: number;
  treeSize?: number;
}

export interface KtMonitorPlan {
  /** Anchor distinguished (wajib) — konsistensi diverifikasi terhadap ini. */
  distinguishedTreeHead: KtStoredTreeHead;
  /** Tree head terakhir yang dipercaya (menyalakan bukti konsistensi). */
  lastTreeHead?: KtStoredTreeHead;
  /** Baris yang benar-benar ikut dimonitor (punya monitoring data). */
  states: KtStoredState[];
}

export interface KtMonitorChange {
  searchKey: Uint8Array;
  previousVersion: number;
  newVersion: number;
}

export interface KtMonitorOutcome {
  /** Jumlah kunci yang ikut dalam satu langkah monitor. */
  checked: number;
  /** Kunci yang `keyVersion`-nya berubah (kandidat notifikasi ke user). */
  changed: KtMonitorChange[];
}

// ---------------------------------------------------------------------------
// Kodek (tanpa Buffer — modul ini ikut ke bundel browser)
// ---------------------------------------------------------------------------

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
};

/** Kunci baris = hex search key (bukan base64: mudah dipakai sebagai PK Dexie). */
export const ktSearchKeyHex = (searchKey: Uint8Array): string => bytesToHex(searchKey);

async function sealBytes(bytes: Uint8Array | undefined | null): Promise<string | null> {
  if (!bytes || bytes.length === 0) return null;
  return await encryptValueAtRest(bytesToBase64Url(bytes));
}

async function openBytes(sealed: string | null | undefined): Promise<Uint8Array | undefined> {
  if (!sealed) return undefined;
  const plain = await decryptValueAtRest(sealed);
  if (!plain) return undefined;
  try {
    return base64UrlToBytes(plain);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Simpan / muat
// ---------------------------------------------------------------------------

/**
 * Simpan (atau perbarui) state satu search key. Field yang tidak dikirim
 * mempertahankan nilai lama — panggilan verifikasi search tidak perlu mengirim
 * ulang tree head distinguished.
 */
export async function saveKtState(update: KtStateUpdate): Promise<void> {
  const searchKeyHex = ktSearchKeyHex(update.searchKey);
  const existing = await db.ktMonitoring.get(searchKeyHex);

  const record: KtMonitoringRecord = {
    searchKeyHex,
    treeHead: (await sealBytes(update.treeHead)) ?? existing?.treeHead ?? null,
    monitoringData: (await sealBytes(update.monitoringData)) ?? existing?.monitoringData ?? null,
    distinguishedTreeHead:
      (await sealBytes(update.distinguishedTreeHead)) ?? existing?.distinguishedTreeHead ?? null,
    keyVersion:
      update.keyVersion === undefined
        ? existing?.keyVersion ?? null
        : await encryptValueAtRest(String(update.keyVersion)),
    treeSize:
      update.treeSize === undefined
        ? existing?.treeSize ?? null
        : await encryptValueAtRest(String(update.treeSize)),
    updatedAt: await encryptValueAtRest(new Date().toISOString()),
  };

  await db.ktMonitoring.put(record);
}

/** Baca semua state; nilai yang tidak bisa dibuka (vault terkunci) dilewati. */
export async function loadKtStates(): Promise<KtStoredState[]> {
  const records = await db.ktMonitoring.toArray();
  const out: KtStoredState[] = [];
  for (const record of records) {
    let searchKey: Uint8Array;
    try {
      searchKey = hexToBytes(record.searchKeyHex);
    } catch {
      continue;
    }
    const rawVersion = record.keyVersion ? await decryptValueAtRest(record.keyVersion) : null;
    const keyVersion = rawVersion === null ? undefined : Number.parseInt(rawVersion, 10);
    const rawTreeSize = record.treeSize ? await decryptValueAtRest(record.treeSize) : null;
    const treeSize = rawTreeSize === null ? undefined : Number.parseInt(rawTreeSize, 10);
    out.push({
      searchKey,
      treeHead: await openBytes(record.treeHead),
      monitoringData: await openBytes(record.monitoringData),
      distinguishedTreeHead: await openBytes(record.distinguishedTreeHead),
      keyVersion: Number.isFinite(keyVersion as number) ? (keyVersion as number) : undefined,
      treeSize: Number.isFinite(treeSize as number) ? (treeSize as number) : undefined,
    });
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('kt: hex tidak sah');
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Pilih baris yang layak dimonitor. Anchor diambil dari baris pertama yang
 * punya distinguished tree head; tree head "terakhir" diambil dari baris mana
 * pun yang sudah punya (semuanya berasal dari verifikasi search yang sama).
 */
export function planKtMonitor(states: KtStoredState[]): KtMonitorPlan | null {
  const ready = states.filter((state) => state.monitoringData && state.distinguishedTreeHead);
  if (ready.length === 0) return null;

  const anchor = ready[0]!.distinguishedTreeHead!;
  const lastTreeHead = states.find((state) => state.treeHead)?.treeHead;

  return { distinguishedTreeHead: anchor, lastTreeHead, states: ready };
}

/**
 * Satu langkah monitor: rakit permintaan, ambil bukti, verifikasi, simpan.
 *
 * Fail-closed: bila `fetchMonitor` atau `verifyMonitor` gagal, tidak ada yang
 * ditulis dan error diteruskan ke pemanggil (yang memutuskan cara menampilkannya).
 */
export async function runKtMonitorOnce(deps: {
  verifier: KeyTransparencyVerifier;
  config: KtConfig;
  /** Pengambil bukti (mis. `POST /api/keys/kt/monitor` → byte respons). */
  fetchMonitor: (request: Uint8Array) => Promise<Uint8Array>;
  /** State yang dimuat; default `loadKtStates()` (disuntik di test). */
  states?: KtStoredState[];
  now?: Date | number;
}): Promise<KtMonitorOutcome> {
  const states = deps.states ?? (await loadKtStates());
  const plan = planKtMonitor(states);
  if (!plan) return { checked: 0, changed: [] };

  const request = deps.verifier.buildMonitorRequest({
    monitoringData: plan.states.map((state) => state.monitoringData!),
    distinguishedTreeHead: plan.distinguishedTreeHead,
    lastTreeHead: plan.lastTreeHead,
  });

  const response = await deps.fetchMonitor(request);

  const result = deps.verifier.verifyMonitor({
    config: deps.config,
    request,
    response,
    context: {
      lastTreeHead: plan.lastTreeHead,
      lastDistinguishedTreeHead: plan.distinguishedTreeHead,
      data: new Map(plan.states.map((state) => [ktSearchKeyHex(state.searchKey), state.monitoringData!])),
    },
    now: deps.now,
  });

  const changed: KtMonitorChange[] = [];
  for (const state of plan.states) {
    const key = ktSearchKeyHex(state.searchKey);
    const updated = result.monitoringData.get(key);
    if (!updated) continue;

    // Versi terbesar dari monitoring data baru — dasar deteksi rotasi kunci.
    const version = deps.verifier.monitorStep(updated).greatestVersion;
    if (state.keyVersion !== undefined && version > state.keyVersion) {
      changed.push({ searchKey: state.searchKey, previousVersion: state.keyVersion, newVersion: version });
    }

    await saveKtState({
      searchKey: state.searchKey,
      monitoringData: updated,
      treeHead: result.treeHead,
      keyVersion: version,
    });
  }

  return { checked: plan.states.length, changed };
}

/** Hapus semua state monitoring (logout/wipe). */
export async function clearKtStates(): Promise<void> {
  await db.ktMonitoring.clear();
}

// ---------------------------------------------------------------------------
// Penjadwal (loop monitor)
// ---------------------------------------------------------------------------

/**
 * Jeda antar langkah monitor. `docs/34` §34.5 menunjukkan keamanan KT bergantung
 * pada loop ini (tanpa langkah monitor, perubahan tree head/search tidak
 * terdeteksi), dan `docs/32` menetapkan bahwa entri log bisa berubah kapan saja
 * — Tree head adalah satu-satunya cara membuktikan "server yang sama" dari waktu
 * ke waktu. Enam jam adalah kompromi: cukup rapat untuk menangkap rotasi kunci
 * pada sesi kerja normal, cukup jarang untuk tidak memanggil layanan KT terus
 * menerus dari klien yang tidak aktif.
 */
export const KT_MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Jeda langkah PERTAMA setelah app siap (beri ruang untuk unlock & sync). */
export const KT_MONITOR_INITIAL_DELAY_MS = 30 * 1000;

export interface KtMonitorLoopOptions {
  /** Satu langkah monitor (biasanya `monitorKeyTransparency()` dari `ktBundleProof`). */
  run: () => Promise<KtMonitorOutcome>;
  /** Perubahan `keyVersion` yang terlihat (kandidat notifikasi). */
  onChanged?: (changes: KtMonitorChange[]) => void;
  /** Kegagalan satu langkah: loop TIDAK berhenti. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Hook test: pemasang timer. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Jalankan loop monitor. Mengembalikan fungsi `stop()`.
 *
 * Sifat yang dijaga: satu langkah pada satu waktu (timer yang menyala saat
 * langkah sebelumnya belum selesai hanya dilewati — bukan menumpuk), kegagalan
 * tidak mematikan loop, dan `stop()` selalu aman dipanggil ganda (unmount ganda
 * di React StrictMode).
 */
export function startKtMonitorLoop(options: KtMonitorLoopOptions): () => void {
  const intervalMs = options.intervalMs ?? KT_MONITOR_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? KT_MONITOR_INITIAL_DELAY_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      // Langkah sebelumnya masih berjalan (jaringan lambat) → jangan menumpuk.
      schedule(intervalMs);
      return;
    }
    running = true;
    try {
      const outcome = await options.run();
      if (!stopped && outcome.changed.length > 0) options.onChanged?.(outcome.changed);
    } catch (error) {
      // Fail-open: KT tidak tersedia bukan alasan menghentikan loop.
      options.onError?.(error);
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);

  return () => {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };
}
