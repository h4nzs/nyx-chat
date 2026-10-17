// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/31 §31.6b] Kontrak UI pembuat berkas `.nyxbak` (jalur manual).
 *
 * Sebelum komponen ini ada, `startBackupFileDownload` tidak punya pemanggil
 * sama sekali: arsip hanya lahir dari alur QR dengan kunci acak, sehingga modal
 * restore ber-kunci-phrase tidak pernah punya berkas untuk dibuka. Test ini
 * mengunci properti yang membuat lingkaran itu tertutup:
 *
 *  1. Kunci = `deriveBackupKey(normalizeBackupPhrase(phrase), salt)`; salt 16
 *     byte yang SAMA diberikan ke `createFramedBackup` (ditulis di header) →
 *     restore hanya butuh phrase.
 *  2. Byte arsip yang diunduh = byte dari `createFramedBackup` (tidak disalin
 *     ulang/dienkode ulang).
 *  3. Cabang awan: `uploadBackupToCloud` menerima byte yang SAMA; kegagalan
 *     unggah TIDAK membatalkan berkas lokal (tidak ada klaim palsu).
 *  4. Prompt password dibatalkan → error `phrase_required`, tanpa membuat arsip.
 *
 * Kripto berat dipalsukan (Argon2id 128 MB + arsip nyata sudah diuji di
 * `backupRestore.test.ts`); yang diuji di sini adalah wiring-nya.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('../ui/ModalBase', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? React.createElement('div', null, children) : null,
}));

const modalState = {
  showPasswordPrompt: vi.fn(),
};
vi.mock('@store/modal', () => ({
  useModalStore: { getState: () => modalState },
}));

const SALT_FILL = 7;
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    randombytes_buf: (length: number) => new Uint8Array(length).fill(SALT_FILL),
  })),
}));

const deriveBackupKeyMock = vi.fn();
vi.mock('@lib/backupFormat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/backupFormat')>();
  return {
    ...actual,
    deriveBackupKey: (...args: unknown[]) => deriveBackupKeyMock(...args),
  };
});

const createFramedBackup = vi.fn();
const liveBackupStore = vi.fn();
vi.mock('@lib/backupRestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/backupRestore')>();
  return {
    ...actual,
    // `normalizeBackupPhrase` sengaja REAL: normalisasi itulah yang diuji.
    createFramedBackup: (...args: unknown[]) => createFramedBackup(...args),
    liveBackupStore: (...args: unknown[]) => liveBackupStore(...args),
    formatBackupSize: () => '1.00 KB',
  };
});

const startBackupFileDownload = vi.fn();
const uploadBackupToCloud = vi.fn();
vi.mock('@lib/backupTransport', () => ({
  startBackupFileDownload: (...args: unknown[]) => startBackupFileDownload(...args),
  uploadBackupToCloud: (...args: unknown[]) => uploadBackupToCloud(...args),
}));

const getEncryptedKeys = vi.fn();
const getDeviceAutoUnlockKey = vi.fn();
vi.mock('@lib/keyStorage', () => ({
  getEncryptedKeys: (...a: unknown[]) => getEncryptedKeys(...a),
  getDeviceAutoUnlockKey: (...a: unknown[]) => getDeviceAutoUnlockKey(...a),
}));

const getRecoveryPhrase = vi.fn();
vi.mock('@lib/crypto-worker-proxy', () => ({
  getRecoveryPhrase: (...a: unknown[]) => getRecoveryPhrase(...a),
}));

import toast from 'react-hot-toast';
import BackupExportModal from '../BackupExportModal';

const ARCHIVE_BYTES = new Uint8Array([0x4e, 0x59, 0x58, 0x42, 1, 2, 3, 4]);
const KEY = new Uint8Array(32).fill(9);
const REPORT = {
  bytes: ARCHIVE_BYTES,
  salt: new Uint8Array(16).fill(SALT_FILL),
  size: ARCHIVE_BYTES.length,
  frameCount: 3,
  records: 42,
  tables: { messages: 42 },
};

const CREATE_KEY = 'modals:backup_export.create_button';

function createButton(): HTMLButtonElement {
  const btn = screen.getAllByRole('button').find((b) => b.textContent?.trim() === CREATE_KEY);
  if (!btn) throw new Error('create button not found');
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  getEncryptedKeys.mockResolvedValue('encrypted-bundle');
  getDeviceAutoUnlockKey.mockResolvedValue('auto-unlock-key');
  getRecoveryPhrase.mockResolvedValue('  Legal Winner THANK  ');
  deriveBackupKeyMock.mockResolvedValue(KEY);
  createFramedBackup.mockResolvedValue(REPORT);
  liveBackupStore.mockResolvedValue({ readTables: vi.fn(), writeTables: vi.fn() });
  startBackupFileDownload.mockReturnValue('nyx-backup-20260101-000000.nyxbak');
  uploadBackupToCloud.mockResolvedValue({ key: 'backups/x.nyxbak', size: ARCHIVE_BYTES.length });
});

describe('BackupExportModal', () => {
  it('menurunkan kunci dari phrase ternormalisasi + salt 16 byte yang sama ditulis ke arsip, lalu mengunduh byte hasil', async () => {
    render(<BackupExportModal isOpen onClose={() => {}} />);
    fireEvent.click(createButton());

    await waitFor(() => expect(createFramedBackup).toHaveBeenCalledTimes(1));

    // 1. Kunci dari phrase yang dinormalkan (trim + lowercase) — sama dengan
    //    aturan jalur restore, jadi arsip ini bisa dibuka kembali dari berkas.
    expect(deriveBackupKeyMock).toHaveBeenCalledTimes(1);
    const [phraseArg, saltArg] = deriveBackupKeyMock.mock.calls[0]! as [string, Uint8Array];
    expect(phraseArg).toBe('legal winner thank');
    expect(saltArg).toHaveLength(16);

    // 2. Salt yang SAMA masuk ke arsip → header memuat salt KDF.
    const createArg = createFramedBackup.mock.calls[0]![0] as {
      key: Uint8Array;
      salt: Uint8Array;
      store: unknown;
    };
    expect(createArg.salt).toBe(saltArg);
    expect(createArg.key).toBe(KEY);
    expect(createArg.store).toBeTruthy();

    // 3. Byte yang diunduh = byte arsip (tanpa encode ulang), tanpa cabang awan.
    expect(startBackupFileDownload).toHaveBeenCalledWith(ARCHIVE_BYTES);
    expect(uploadBackupToCloud).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/backup_export.result_summary/)).toBeTruthy());
    expect(screen.queryByText(/backup_export.result_cloud/)).toBeNull();
    expect(toast.success).toHaveBeenCalled();
  });

  it('checkbox awan → mengunggah byte arsip yang sama dan menandai hasilnya', async () => {
    render(<BackupExportModal isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('backup-export-cloud'));
    fireEvent.click(createButton());

    await waitFor(() => expect(uploadBackupToCloud).toHaveBeenCalledTimes(1));
    const [uploadedBytes] = uploadBackupToCloud.mock.calls[0]! as [Uint8Array];
    expect(uploadedBytes).toBe(ARCHIVE_BYTES);
    expect(startBackupFileDownload).toHaveBeenCalledWith(ARCHIVE_BYTES);

    await waitFor(() => expect(screen.getByText(/backup_export.result_cloud/)).toBeTruthy());
  });

  it('unggah awan gagal → berkas lokal tetap terunduh, tanpa klaim "tersimpan di awan"', async () => {
    uploadBackupToCloud.mockRejectedValue(new Error('Backup too large'));

    render(<BackupExportModal isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('backup-export-cloud'));
    fireEvent.click(createButton());

    await waitFor(() => expect(uploadBackupToCloud).toHaveBeenCalledTimes(1));
    expect(startBackupFileDownload).toHaveBeenCalledWith(ARCHIVE_BYTES);
    expect(toastError).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/backup_export.result_summary/)).toBeTruthy());
    expect(screen.queryByText(/backup_export.result_cloud/)).toBeNull();
  });

  it('prompt password dibatalkan → error phrase_required, tanpa membuat arsip', async () => {
    getDeviceAutoUnlockKey.mockResolvedValue(undefined);

    render(<BackupExportModal isOpen onClose={() => {}} />);
    fireEvent.click(createButton());

    await waitFor(() => expect(modalState.showPasswordPrompt).toHaveBeenCalledTimes(1));
    const submit = modalState.showPasswordPrompt.mock.calls[0]![0] as (password: string | null) => void;
    await act(async () => {
      submit(null);
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('modals:backup_export.phrase_required');
    });
    expect(getRecoveryPhrase).not.toHaveBeenCalled();
    expect(createFramedBackup).not.toHaveBeenCalled();
    expect(startBackupFileDownload).not.toHaveBeenCalled();
  });
});
