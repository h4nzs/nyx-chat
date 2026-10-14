// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/31 §31.6c] Kontrak UI restore berkas `.nyxbak` manual:
 *
 *  1. Berkas divalidasi lewat `readBackupFile` SEBELUM phrase disentuh; berkas
 *     asing/rusak menampilkan error, bukan memicu KDF/reload.
 *  2. Tombol Restore non-aktif sampai ada berkas DAN phrase.
 *  3. Restore menormalkan phrase (trim + lowercase) dan memanggil
 *     `openFramedBackupWithPhrase` dengan byte arsip persis seperti yang dibaca.
 *  4. Setelah sukses: deviceId dihapus + kunci identitas lokal dibersihkan
 *     (bootstrap identitas baru), lalu sukses di-toast.
 *
 * Semua modul berat (libsodium, Dexie, arsip) dipalsukan — yang diuji adalah
 * wiring UI, bukan kripto (itu sudah diuji di `backupRestore.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// `t` mengembalikan KUNCI (bukan fallback berbahasa Indonesia) supaya asersi
// tidak bergantung pada bahasa fallback komponen.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

// ModalBase memakai framer-motion; ganti dengan pembungkus minimal.
vi.mock('../ui/ModalBase', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? React.createElement('div', null, children) : null,
}));

const readBackupFile = vi.fn();
vi.mock('@lib/backupTransport', () => ({
  readBackupFile: (...args: unknown[]) => readBackupFile(...args),
}));

const openFramedBackupWithPhrase = vi.fn();
const liveBackupStore = vi.fn();
vi.mock('@lib/backupRestore', () => ({
  openFramedBackupWithPhrase: (...args: unknown[]) => openFramedBackupWithPhrase(...args),
  liveBackupStore: (...args: unknown[]) => liveBackupStore(...args),
  formatBackupSize: () => '1.00 KB',
}));

vi.mock('@lib/sodiumInitializer', () => ({ getSodium: vi.fn(async () => ({})) }));
vi.mock('@lib/backupFormat', () => ({ libsodiumBackupCrypto: vi.fn(() => ({})) }));
vi.mock('@lib/backupPayload', () => ({ libsodiumBackupValueCodec: vi.fn(() => ({})) }));

const identityKeysClear = vi.fn();
vi.mock('@lib/db', () => ({ db: { identityKeys: { clear: (...a: unknown[]) => identityKeysClear(...a) } } }));

import toast from 'react-hot-toast';
import BackupRestoreModal from '../BackupRestoreModal';

const RESTORE_KEY = 'modals:backup_restore.restore_button';

function restoreButton(): HTMLButtonElement {
  const btn = screen.getAllByRole('button').find((b) => b.textContent?.trim() === RESTORE_KEY);
  if (!btn) throw new Error('Restore button not found');
  return btn as HTMLButtonElement;
}

function chooseFile(name = 'nyx-backup-20260101-000000.nyxbak') {
  const input = screen.getByTestId('nyxbak-file-input') as HTMLInputElement;
  const file = new File(['NYXB'], name, { type: 'application/octet-stream' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  liveBackupStore.mockResolvedValue({ readTables: vi.fn(), writeTables: vi.fn() });
  // Neutralkan reload pasca-sukses (jsdom tidak mengimplementasikan navigasi).
  vi.spyOn(window, 'location', 'get').mockReturnValue({ reload: vi.fn() } as unknown as Location);
});

describe('BackupRestoreModal', () => {
  it('menolak berkas asing tanpa memanggil restore', async () => {
    readBackupFile.mockRejectedValue(new Error('Bukan berkas backup NYX'));

    render(<BackupRestoreModal isOpen onClose={() => {}} />);
    chooseFile('random.bin');

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('modals:backup_restore.invalid_file');
    });
    expect(openFramedBackupWithPhrase).not.toHaveBeenCalled();
  });

  it('tombol Restore non-aktif sampai ada berkas dan phrase', async () => {
    readBackupFile.mockResolvedValue(new Uint8Array([0x4e, 0x59, 0x58, 0x42]));

    render(<BackupRestoreModal isOpen onClose={() => {}} />);
    expect(restoreButton()).toBeDisabled();

    chooseFile();
    await waitFor(() => expect(screen.getByText(/nyx-backup-/)).toBeTruthy());
    // Berkas ada tapi phrase masih kosong.
    expect(restoreButton()).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'words here' } });
    expect(restoreButton()).toBeEnabled();
  });

  it('restore menormalkan phrase dan memakai byte arsip yang dibaca', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    readBackupFile.mockResolvedValue(bytes);
    openFramedBackupWithPhrase.mockResolvedValue({ records: 1234, size: 4096, tables: {}, frameCount: 1, formatVersion: 1 });
    localStorage.setItem('deviceId', 'old-device');

    render(<BackupRestoreModal isOpen onClose={() => {}} />);
    chooseFile();
    await waitFor(() => expect(screen.getByText(/nyx-backup-/)).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  LEGAL Winner THANK  ' } });
    fireEvent.click(restoreButton());

    await waitFor(() => expect(openFramedBackupWithPhrase).toHaveBeenCalledTimes(1));
    const arg = openFramedBackupWithPhrase.mock.calls[0]![0] as {
      bytes: Uint8Array;
      phrase: string;
      store: unknown;
    };
    expect(arg.bytes).toBe(bytes);
    expect(arg.phrase).toBe('legal winner thank');
    expect(arg.store).toBeTruthy();

    await waitFor(() => expect(identityKeysClear).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('deviceId')).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('phrase salah → error tampil, tanpa klaim sukses', async () => {
    readBackupFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    openFramedBackupWithPhrase.mockRejectedValue(new Error('Autentikasi frame gagal (tamper atau kunci salah)'));

    render(<BackupRestoreModal isOpen onClose={() => {}} />);
    chooseFile();
    await waitFor(() => expect(screen.getByText(/nyx-backup-/)).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong phrase here' } });
    fireEvent.click(restoreButton());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('modals:backup_restore.wrong_phrase');
    });
    expect(identityKeysClear).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
