// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 3 / docs/31 §31.6] Transport `.nyxbak` — R2 dan manual.
 *
 * Semua dependensi eksternal di-stub (`api`, jaringan) sesuai aturan repo
 * (test tidak boleh butuh Postgres/Redis/jaringan). Validasi header TIDAK
 * di-stub: kita memakai `readBackupHeader` yang sebenarnya, sehingga berkas
 * rusak/asing benar-benar ditolak.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

import { ApiError } from '../api';
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_MIME,
  buildBackupFileName,
  deleteCloudBackup,
  downloadCloudBackup,
  presignBackupUpload,
  readBackupFile,
  requestBackupDownloadUrl,
  uploadBackupToCloud,
} from '../backupTransport';

/** Header arsip valid minimal (32 byte) tanpa frame — cukup untuk validasi bentuk. */
function validHeaderBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x4e, 0x59, 0x58, 0x42], 0); // 'NYXB'
  bytes[4] = 1; // formatVersion
  bytes[5] = 0; // flags
  bytes[6] = 0;
  bytes[7] = 1; // frameCount = 1
  bytes.set(new Uint8Array(16).fill(7), 8); // salt
  return bytes;
}

function blobOf(bytes: Uint8Array, type = BACKUP_MIME): Blob {
  return new Blob([bytes as BlobPart], { type });
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backupTransport: berkas manual', () => {
  it('nama berkas memakai waktu UTC dan ekstensi .nyxbak', () => {
    const name = buildBackupFileName(new Date('2026-10-11T01:30:05Z'));
    expect(name).toBe(`nyx-backup-20261011-013005.${BACKUP_FILE_EXTENSION}`);
    expect(name.endsWith('.nyxbak')).toBe(true);
  });

  it('menerima berkas dengan header sah', async () => {
    const bytes = await readBackupFile(blobOf(validHeaderBytes()));
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4e, 0x59, 0x58, 0x42]);
  });

  it('menolak berkas dengan magic salah sebelum menyentuh kunci', async () => {
    const bad = validHeaderBytes();
    bad[0] = 0x00;
    await expect(readBackupFile(blobOf(bad))).rejects.toThrow(/bukan berkas backup/i);
  });

  it('menolak berkas terlalu pendek', async () => {
    await expect(readBackupFile(blobOf(new Uint8Array(8)))).rejects.toThrow(/terlalu pendek/i);
  });
});

describe('backupTransport: endpoint R2', () => {
  it('presign unggah mengirim size dan urlTtl ke endpoint yang benar', async () => {
    apiMock.mockResolvedValue({ uploadUrl: 'https://r2/put', key: 'backups/x.nyxbak', size: 2048, urlTtl: 300, contentType: BACKUP_MIME });
    const res = await presignBackupUpload(2048, 300);

    expect(apiMock).toHaveBeenCalledWith('/api/backup/presign', {
      method: 'POST',
      body: JSON.stringify({ size: 2048, urlTtl: 300 }),
    });
    expect(res.key).toBe('backups/x.nyxbak');
  });

  it('minta URL unduh dan hapus memakai endpoint yang benar', async () => {
    apiMock.mockResolvedValue({ downloadUrl: 'https://r2/get', key: 'k', urlTtl: 60 });
    await requestBackupDownloadUrl(60);
    expect(apiMock).toHaveBeenCalledWith('/api/backup/download-url', {
      method: 'POST',
      body: JSON.stringify({ urlTtl: 60 }),
    });

    apiMock.mockReset();
    apiMock.mockResolvedValue({ deleted: true });
    await deleteCloudBackup();
    expect(apiMock).toHaveBeenCalledWith('/api/backup', { method: 'DELETE' });
  });

  it('unggah ke awan: presign lalu PUT byte yang sama, progres diteruskan', async () => {
    const bytes = validHeaderBytes();
    apiMock.mockResolvedValue({ uploadUrl: 'https://r2/put', key: 'backups/y.nyxbak', size: bytes.length, urlTtl: 300, contentType: BACKUP_MIME });
    const put = vi.fn(async (_url: string, _body: Uint8Array, onProgress?: (p: number) => void) => {
      onProgress?.(100);
    });
    const onProgress = vi.fn();

    const result = await uploadBackupToCloud(bytes, { put, onProgress });

    expect(apiMock).toHaveBeenCalledWith('/api/backup/presign', {
      method: 'POST',
      body: JSON.stringify({ size: bytes.length, urlTtl: undefined }),
    });
    expect(put).toHaveBeenCalledTimes(1);
    const [url, body] = put.mock.calls[0]!;
    expect(url).toBe('https://r2/put');
    expect(Array.from(body)).toEqual(Array.from(bytes));
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(result).toEqual({ key: 'backups/y.nyxbak', size: bytes.length });
  });

  it('unggah ke awan tidak memanggil PUT bila presign ditolak', async () => {
    apiMock.mockRejectedValue(new ApiError(400, 'Backup too large. Maximum size for your plan is 100 MB.'));
    const put = vi.fn(async () => {});

    await expect(uploadBackupToCloud(validHeaderBytes(), { put })).rejects.toThrow(/too large/i);
    expect(put).not.toHaveBeenCalled();
  });

  it('unduh memvalidasi header arsip sebelum dipakai', async () => {
    apiMock.mockResolvedValue({ downloadUrl: 'https://r2/get', key: 'k', urlTtl: 60 });
    const bytes = validHeaderBytes();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await downloadCloudBackup();
    expect(Array.from(out)).toEqual(Array.from(bytes));
    expect(fetchMock).toHaveBeenCalledWith('https://r2/get', expect.objectContaining({ cache: 'no-store' }));
  });

  it('unduh 404 → ApiError 404 (UI bisa bilang "tidak ada backup")', async () => {
    apiMock.mockResolvedValue({ downloadUrl: 'https://r2/get', key: 'k', urlTtl: 60 });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));

    await expect(downloadCloudBackup()).rejects.toMatchObject({ status: 404, message: 'No cloud backup found' });
  });

  it('unduh menolak blob yang bukan arsip NYX', async () => {
    apiMock.mockResolvedValue({ downloadUrl: 'https://r2/get', key: 'k', urlTtl: 60 });
    const junk = new Uint8Array(32).fill(3);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength),
    })));

    await expect(downloadCloudBackup()).rejects.toThrow(/bukan berkas backup/i);
  });
});
