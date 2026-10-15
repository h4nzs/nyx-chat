// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/10 §10.13 · docs/30 WS-A] Unggah snapshot log KT ke R2.
 *
 * Log Key Transparency hanya ada di satu tempat: LevelDB milik `nyx-kt-query`
 * di VPS. `nyx-kt-query` sudah membuat arsip harian yang **diverifikasi**
 * (`server/kt-query/snapshot.go`: penulisan dijeda, salinan dibuka ulang, tree
 * head + root dibandingkan dengan pohon hidup, lalu di-`tar.gz`). Arsip di VPS
 * yang sama bukan backup — satu disk rusak / satu `rm -rf` menghapus keduanya.
 * Modul ini memindahkannya keluar host.
 *
 * Kenapa unggahan ada di proses server NYX, bukan di `nyx-kt-query`:
 *
 *   1. Kredensial R2 hanya hidup di server NYX (`R2_ACCESS_KEY_ID`, dst). Memberi
 *      proses log kredensial bucket penuh berarti satu bug di sana bisa
 *      menghapus objek milik fitur lain.
 *   2. Server NYX sudah punya `@aws-sdk/client-s3` + kebijakan retensi.
 *
 * Sifat yang dijaga:
 *   - **Idempoten**: kalau objek untuk arsip itu sudah ada, tidak diunggah dua
 *     kali (cron bisa berjalan ulang setelah restart, dan nama arsip berasal dari
 *     waktu snapshot).
 *   - **Fail-visible**: tanpa `KT_SNAPSHOT_DIR` job melaporkan `disabled` (sekali
 *     per hari di log), dan setiap kegagalan dicatat + dihitung — tidak pernah
 *     "berhasil" secara senyap.
 *   - **Tidak pernah melempar**: cron tidak boleh mati karena satu unggahan gagal.
 *   - **Nama berkas divalidasi**: hanya `kt-snapshot-<stempel>.tar.gz` dari
 *     manifest yang diunggah, jadi manifest yang rusak/dimodifikasi tidak bisa
 *     membuat server membaca berkas lain di host (`../`).
 *
 * Retensi: objek di bawah prefix yang lebih tua dari `KT_SNAPSHOT_KEEP_DAYS`
 * dihapus. Arsip lokal di VPS sudah dibatasi `NYX_KT_SNAPSHOT_KEEP` (default 7)
 * oleh `nyx-kt-query` — dua batas itu sengaja berbeda: yang di VPS menjaga
 * pemulihan cepat, yang di R2 menjaga riwayat panjang.
 */

import cron from 'node-cron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config.js';
import { deleteR2Files, listR2Objects, putR2Object } from '../utils/r2.js';
import { incCounter, KT_SNAPSHOT_UPLOAD, KT_SNAPSHOT_DELETED } from '../utils/metrics.js';

/** Prefix objek di R2; satu tempat untuk semua arsip log KT. */
export const KT_SNAPSHOT_PREFIX = 'kt-snapshots/';
/** Umur maksimum arsip di R2 (hari). */
export const KT_SNAPSHOT_KEEP_DAYS = 30;
/** Nama berkas arsip yang boleh diunggah (dibuat `server/kt-query/snapshot.go`). */
export const KT_SNAPSHOT_FILE_PATTERN = /^kt-snapshot-\d{8}T\d{6}Z\.tar\.gz$/;

export interface KtSnapshotManifest {
  file: string;
  createdAt: string;
  treeSize: number;
  root: string;
  bytes: number;
}

export type KtSnapshotSkip = 'disabled' | 'no-manifest' | 'manifest-invalid' | 'already-uploaded';

export interface KtSnapshotOutcome {
  /** Kunci objek yang diunggah, atau null bila tidak ada unggahan. */
  uploaded: string | null;
  /** Alasan tidak ada unggahan (bila ada). */
  skipped?: KtSnapshotSkip;
  /** Jumlah objek lama yang dihapus dari R2. */
  deleted: number;
  /** Kegagalan yang tercatat (tidak pernah membuat job berhenti). */
  errors: string[];
}

export interface KtSnapshotRemoteObject {
  key: string;
  /** Waktu terakhir objek diubah; dipakai untuk retensi (fallback nama). */
  lastModified?: Date;
}

export interface KtSnapshotDeps {
  /** Direktori arsip (`NYX_KT_SNAPSHOT_DIR`); kosong = fitur nonaktif. */
  dir?: string;
  readTextFile?: (path: string) => Promise<string>;
  readBinaryFile?: (path: string) => Promise<Uint8Array>;
  putObject?: (key: string, body: Uint8Array) => Promise<void>;
  listObjects?: (prefix: string) => Promise<KtSnapshotRemoteObject[]>;
  deleteObjects?: (keys: string[]) => Promise<void>;
  now?: () => Date;
  keepDays?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Validasi bentuk manifest: satu-satunya hal yang menentukan nama berkas. */
export function parseKtSnapshotManifest(value: string): KtSnapshotManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const manifest = parsed as Partial<KtSnapshotManifest>;
  if (typeof manifest.file !== 'string' || !KT_SNAPSHOT_FILE_PATTERN.test(manifest.file)) return null;
  if (typeof manifest.treeSize !== 'number' || !Number.isInteger(manifest.treeSize) || manifest.treeSize <= 0) return null;
  if (typeof manifest.root !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.root)) return null;
  return {
    file: manifest.file,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    treeSize: manifest.treeSize,
    root: manifest.root,
    bytes: typeof manifest.bytes === 'number' ? manifest.bytes : 0,
  };
}

/**
 * Objek yang melewati retensi. Dipisah & murni supaya batas umurnya bisa diuji
 * tanpa jaringan: umur diambil dari `lastModified` bila ada, kalau tidak dari
 * stempel waktu di nama berkas (R2 selalu mengisi `lastModified`, tapi test dan
 * daftar yang dipangkas tidak boleh bergantung itu).
 */
export function expiredKtSnapshotKeys(
  objects: KtSnapshotRemoteObject[],
  now: Date,
  keepDays: number = KT_SNAPSHOT_KEEP_DAYS
): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for (const object of objects) {
    const stamp = object.lastModified?.getTime() ?? timestampFromKey(object.key);
    if (stamp === null) continue; // tidak diketahui → jangan dihapus
    if (stamp < cutoff) expired.push(object.key);
  }
  return expired;
}

/** `kt-snapshots/kt-snapshot-20261014T030000Z.tar.gz` → waktu UTC. */
function timestampFromKey(key: string): number | null {
  const match = /kt-snapshot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(key);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const stamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Satu putaran: unggah arsip terbaru (bila belum ada) lalu terapkan retensi.
 * Mengembalikan laporan; tidak pernah melempar.
 */
export async function uploadLatestKtSnapshot(deps: KtSnapshotDeps = {}): Promise<KtSnapshotOutcome> {
  const dir = deps.dir ?? process.env.KT_SNAPSHOT_DIR ?? '';
  const now = deps.now ?? (() => new Date());
  const keepDays = deps.keepDays ?? KT_SNAPSHOT_KEEP_DAYS;
  const log = deps.log ?? (() => {});
  const outcome: KtSnapshotOutcome = { uploaded: null, deleted: 0, errors: [] };

  const readTextFile = deps.readTextFile ?? (async (path: string) => await readFile(path, 'utf8'));
  const readBinaryFile = deps.readBinaryFile ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const listObjects = deps.listObjects ?? listR2Objects;
  const deleteObjects = deps.deleteObjects ?? deleteR2Files;
  const putObject =
    deps.putObject ?? (async (key: string, body: Uint8Array) => await putR2Object(key, body, 'application/gzip'));

  if (!dir) {
    outcome.skipped = 'disabled';
    log('[KtSnapshot] dilewati: KT_SNAPSHOT_DIR tidak diatur (snapshot log KT tidak diunggah)');
    return outcome;
  }

  try {
    const manifest = parseKtSnapshotManifest(await readTextFile(join(dir, 'latest.json')));
    if (!manifest) {
      outcome.skipped = 'manifest-invalid';
      log('[KtSnapshot] dilewati: latest.json tidak ada/tidak sah', { dir });
      return outcome;
    }

    const key = `${KT_SNAPSHOT_PREFIX}${manifest.file}`;
    let remote: KtSnapshotRemoteObject[] = [];
    try {
      remote = await listObjects(KT_SNAPSHOT_PREFIX);
    } catch (error) {
      // Daftar tidak bisa dibaca: unggahan masih bisa dilanjutkan (tanpa dedup),
      // retensi dilewati tahun ini.
      outcome.errors.push(`list: ${(error as Error).message}`);
      log('[KtSnapshot] daftar objek gagal dibaca', { reason: (error as Error).message });
    }

    if (remote.some((object) => object.key === key)) {
      outcome.skipped = 'already-uploaded';
    } else {
      const body = await readBinaryFile(join(dir, manifest.file));
      await putObject(key, body);
      outcome.uploaded = key;
      incCounter(KT_SNAPSHOT_UPLOAD, { result: 'ok' });
      log('[KtSnapshot] arsip diunggah', { key, treeSize: manifest.treeSize, bytes: body.byteLength });
      // Objek baru harus ikut dipertimbangkan retensi berikutnya.
      remote = [...remote, { key, lastModified: now() }];
    }

    if (remote.length > 0) {
      const expired = expiredKtSnapshotKeys(remote, now(), keepDays);
      if (expired.length > 0) {
        await deleteObjects(expired);
        outcome.deleted = expired.length;
        incCounter(KT_SNAPSHOT_DELETED, { result: 'ok' }, expired.length);
        log('[KtSnapshot] arsip lama dihapus dari R2', { count: expired.length });
      }
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome.errors.push(message);
    incCounter(KT_SNAPSHOT_UPLOAD, { result: 'error' });
    log('[KtSnapshot] unggahan gagal', { reason: message });
    return outcome;
  }
}

/** Jadwalkan unggahan harian; dipanggil dari `index.ts` bersama sweeper. */
export const startKtSnapshotUploader = () => {
  const dir = process.env.KT_SNAPSHOT_DIR ?? '';
  if (!dir) {
    console.warn('⚠️  KT_SNAPSHOT_DIR tidak diatur — snapshot log KT tidak akan diunggah ke R2.');
    return;
  }
  console.log('🔐 KT Snapshot Uploader scheduled (Daily at 03:30)...');
  cron.schedule('30 3 * * *', async () => {
    // Unggahan kemungkinan besar berjalan setelah snapshot lokal jam 00:00–03:00;
    // kalau belum ada arsip baru, manifest terbaru-lah yang diunggah (idempoten).
    await uploadLatestKtSnapshot({ dir });
  });
};

/** Dipakai test & jalur manual (`CHAT_SECRET`-protected) bila diperlukan. */
export const ktSnapshotConfigured = (): boolean => Boolean(process.env.KT_SNAPSHOT_DIR ?? '') && Boolean(env.r2BucketName);
