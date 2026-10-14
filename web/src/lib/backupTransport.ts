// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 3 / docs/31 §31.6] Transport arsip backup `.nyxbak`.
 *
 * Dua jalur, keduanya memindahkan byte yang SUDAH terenkripsi di klien:
 *
 *  1. **Manual** — unduh berkas `.nyxbak` dan pindahkan sendiri (USB/berkas
 *     pribadi). Tidak butuh server; ini jalur restore yang selalu tersedia.
 *  2. **R2** — presign unggah/unduh lewat `/api/backup/*`. Server hanya melihat
 *     blob opaque; kunci objek diturunkan server dari HMAC (tanpa userId).
 *
 * Modul ini **tidak** membangun/membuka arsip (itu `backupFormat`) dan tidak
 * memetakan payload (itu `backupPayload`). Semua jalur di sini memvalidasi
 * header sebelum data dipakai, sehingga berkas asing/rusak gagal lebih awal.
 */

import { api, ApiError } from './api';
import { readBackupHeader } from './backupFormat';

/** Ekstensi berkas backup NYX. */
export const BACKUP_FILE_EXTENSION = 'nyxbak';

/** MIME arsip (selalu opaque — tidak ada metadata isi). */
export const BACKUP_MIME = 'application/octet-stream';

/**
 * Nama berkas unduhan manual. Waktu disimpan di nama supaya pengguna bisa
 * membedakan beberapa salinan; isinya tetap opaque.
 */
export function buildBackupFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `nyx-backup-${stamp}.${BACKUP_FILE_EXTENSION}`;
}

/** Bungkus byte arsip menjadi Blob agar siap diunduh/PUT. */
export function backupToBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: BACKUP_MIME });
}

/**
 * Picu unduhan berkas di browser. Mengembalikan nama berkas yang dipakai.
 * `URL.revokeObjectURL` ditunda satu tick supaya unduhan sempat dimulai.
 */
export function startBackupFileDownload(bytes: Uint8Array, filename = buildBackupFileName()): string {
  const url = URL.createObjectURL(backupToBlob(bytes));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return filename;
}

/**
 * Baca berkas `.nyxbak` pilihan pengguna dan validasi headernya. Melempar
 * `BackupFormatError` bila magic/versi salah atau berkas terlalu pendek — jadi
 * file asing ditolak sebelum menyentuh kunci.
 */
export async function readBackupFile(file: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  readBackupHeader(bytes);
  return bytes;
}

export interface BackupPresignResponse {
  uploadUrl: string;
  key: string;
  size: number;
  urlTtl: number;
  contentType: string;
}

export interface BackupDownloadResponse {
  downloadUrl: string;
  key: string;
  urlTtl: number;
}

/** Minta URL presigned untuk mengunggah arsip. */
export async function presignBackupUpload(size: number, urlTtl?: number): Promise<BackupPresignResponse> {
  return api<BackupPresignResponse>('/api/backup/presign', {
    method: 'POST',
    body: JSON.stringify({ size, urlTtl }),
  });
}

/** Minta URL presigned untuk mengunduh arsip (restore di perangkat pengganti). */
export async function requestBackupDownloadUrl(urlTtl?: number): Promise<BackupDownloadResponse> {
  return api<BackupDownloadResponse>('/api/backup/download-url', {
    method: 'POST',
    body: JSON.stringify({ urlTtl }),
  });
}

/** Hapus backup awan milik sendiri (bagian alur nuke / pengguna berubah pikiran). */
export async function deleteCloudBackup(): Promise<void> {
  await api('/api/backup', { method: 'DELETE' });
}

/** Fungsi PUT — dapat disuntik di test supaya tidak perlu jaringan/XHR nyata. */
export type BackupPutFn = (url: string, body: Uint8Array, onProgress?: (percent: number) => void) => Promise<void>;

/** PUT byte ke URL presigned dengan progres (XMLHttpRequest, pola `lib/r2.ts`). */
export const putBackupToR2: BackupPutFn = (url, body, onProgress) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', BACKUP_MIME);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, `Backup upload failed: ${xhr.statusText || xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during backup upload'));
    xhr.send(backupToBlob(body));
  });

export interface UploadBackupOptions {
  onProgress?: (percent: number) => void;
  urlTtl?: number;
  put?: BackupPutFn;
}

/**
 * Unggah arsip ke R2: presign dulu (kuota/diizinkan?), lalu PUT langsung ke R2.
 * Byte tidak pernah melewati API server.
 */
export async function uploadBackupToCloud(
  bytes: Uint8Array,
  opts: UploadBackupOptions = {}
): Promise<{ key: string; size: number }> {
  const presign = await presignBackupUpload(bytes.length, opts.urlTtl);
  await (opts.put ?? putBackupToR2)(presign.uploadUrl, bytes, opts.onProgress);
  return { key: presign.key, size: presign.size };
}

/**
 * Unduh arsip dari R2 dan validasi headernya. Tidak mendekripsi — pemanggil
 * meneruskan byte ke `parseBackupArchive` dengan kunci dari recovery phrase.
 *
 * Bila objek belum ada, R2 membalas 404 pada URL presigned → kita lempar
 * `ApiError(404)` supaya UI bisa membedakan "tidak ada backup" dari error lain.
 */
export async function downloadCloudBackup(signal?: AbortSignal): Promise<Uint8Array> {
  const { downloadUrl } = await requestBackupDownloadUrl();
  const res = await fetch(downloadUrl, { cache: 'no-store', signal });
  if (!res.ok) {
    throw new ApiError(res.status, res.status === 404 ? 'No cloud backup found' : 'Cloud backup download failed');
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  readBackupHeader(bytes);
  return bytes;
}
