// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 4 / docs/31 §31.6c] Restore berkas `.nyxbak` manual.
 *
 * Dua sumber arsip, satu jalur kunci (recovery phrase):
 *   - **Berkas** yang dipilih pengguna (`.nyxbak` hasil "Buat Backup" / transfer).
 *   - **Awan** (`downloadCloudBackup` → `/api/backup/download-url`), supaya
 *     perangkat pengganti tanpa perangkat lama tetap bisa menarik arsipnya.
 * Keduanya memakai kunci turunan phrase, jadi tidak ada kunci yang perlu
 * dikirim lewat kanal lain.
 *
 * Validasi header (`readBackupFile` / `readBackupHeader` di jalur awan)
 * dijalankan **sebelum** phrase disentuh, sehingga berkas asing/terpotong
 * ditolak lebih awal dan tidak memicu KDF mahal.
 */
import { useEffect, useRef, useState } from 'react';
import { FiCloud, FiFile, FiShield, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import ModalBase from './ui/ModalBase';
import { Spinner } from './Spinner';
import { getSodium } from '@lib/sodiumInitializer';
import { ApiError } from '@lib/api';
import { libsodiumBackupCrypto } from '@lib/backupFormat';
import { libsodiumBackupValueCodec } from '@lib/backupPayload';
import {
  formatBackupSize,
  liveBackupStore,
  normalizeBackupPhrase,
  openFramedBackupWithPhrase
} from '@lib/backupRestore';
import { downloadCloudBackup, readBackupFile } from '@lib/backupTransport';

interface BackupRestoreModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function BackupRestoreModal({ isOpen, onClose }: BackupRestoreModalProps) {
  const { t } = useTranslation(['modals', 'common']);

  const [fileName, setFileName] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [isFetchingCloud, setIsFetchingCloud] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset setiap kali modal dibuka supaya phrase/berkas lama tidak tertinggal.
  useEffect(() => {
    if (isOpen) {
      setFileName(null);
      setBytes(null);
      setPhrase('');
      setError('');
      setProgress(0);
      setIsRestoring(false);
      setIsFetchingCloud(false);
    }
  }, [isOpen]);

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // izinkan memilih berkas yang sama lagi
    if (!file) return;

    try {
      // Validasi magic/versi/panjang sebelum menyentuh kunci.
      const read = await readBackupFile(file);
      setBytes(read);
      setFileName(file.name);
      setError('');
    } catch {
      setBytes(null);
      setFileName(null);
      setError(t('modals:backup_restore.invalid_file', 'Bukan berkas backup NYX yang sah.'));
    }
  };

  /**
   * Ambil arsip dari R2 (`/api/backup/download-url` → GET URL presigned). Header
   * divalidasi di dalam `downloadCloudBackup`, jadi arsip rusak ditolak sebelum
   * phrase/KDF. 404 = belum pernah ada backup awan — dibedakan dari error lain
   * supaya pesannya tidak menyesatkan.
   */
  const handleFetchCloud = async () => {
    if (isRestoring || isFetchingCloud) return;
    setIsFetchingCloud(true);
    setError('');
    try {
      const downloaded = await downloadCloudBackup();
      setBytes(downloaded);
      setFileName(t('modals:backup_restore.cloud_source', 'Salinan awan'));
    } catch (err) {
      setBytes(null);
      setFileName(null);
      if (err instanceof ApiError && err.status === 404) {
        setError(t('modals:backup_restore.cloud_missing', 'Tidak ada backup awan untuk akun ini.'));
      } else if (err instanceof ApiError && err.status === 403) {
        setError(t('modals:backup_restore.cloud_forbidden', 'Akun sandbox tidak boleh menyimpan blob di awan.'));
      } else {
        setError(t('modals:backup_restore.cloud_failed', 'Gagal mengambil backup dari awan.'));
      }
    } finally {
      setIsFetchingCloud(false);
    }
  };

  const handleRestore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isRestoring) return;
    if (!bytes) {
      setError(t('modals:backup_restore.no_file_selected', 'Pilih berkas .nyxbak terlebih dahulu.'));
      return;
    }
    if (!phrase.trim()) return;

    setIsRestoring(true);
    setError('');
    setProgress(0);

    try {
      const sodium = await getSodium();
      const crypto = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
      const codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
      const store = await liveBackupStore();

      const report = await openFramedBackupWithPhrase({
        store,
        bytes,
        // Aturan normalisasi yang SAMA dengan jalur export (`normalizeBackupPhrase`)
        // supaya arsip buatan "Buat Backup" selalu bisa dibuka di sini.
        phrase: normalizeBackupPhrase(phrase),
        crypto,
        codec,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 100)),
      });

      // Selaraskan dengan alur "Import Vault" yang sudah ada: paksa bootstrap
      // identitas baru untuk perangkat ini (deviceId + kunci identitas lokal).
      localStorage.removeItem('deviceId');
      const { db } = await import('@lib/db');
      await db.identityKeys.clear();

      toast.success(
        t('modals:backup_restore.success', 'Brankas dipulihkan: {{records}} catatan · {{size}}', {
          records: report.records.toLocaleString('en-US'),
          size: formatBackupSize(report.size),
        }),
        { duration: 5000 }
      );
      onClose();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      console.error('[BackupRestore] restore failed:', err);
      const message = err instanceof Error && /Autentikasi|kunci salah/i.test(err.message)
        ? t('modals:backup_restore.wrong_phrase', 'Recovery phrase salah atau arsip rusak.')
        : t('modals:backup_restore.failed', 'Restore gagal: arsip mungkin rusak.');
      setError(message);
      toast.error(message, { id: 'backup-restore-error' });
    } finally {
      setIsRestoring(false);
      setProgress(0);
    }
  };

  return (
    <ModalBase
      isOpen={isOpen}
      onClose={isRestoring ? () => {} : onClose}
      title={t('modals:backup_restore.title', 'Restore dari Berkas Backup')}
    >
      <form onSubmit={handleRestore} className="space-y-5">
        <p className="text-[11px] leading-relaxed text-text-secondary uppercase tracking-wider opacity-80">
          {t('modals:backup_restore.warning', 'Memulihkan arsip akan menimpa data lokal di perangkat ini.')}
        </p>

        {/* Pemilih berkas */}
        <div className="space-y-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">
            {t('modals:backup_restore.file_label', 'Berkas .nyxbak')}
          </span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isRestoring || isFetchingCloud}
            className="
              w-full flex items-center gap-3 p-4 rounded-xl text-left
              bg-bg-main text-text-primary
              shadow-neu-concave active:shadow-neu-pressed
              hover:brightness-110 transition-all disabled:opacity-60
            "
          >
            <FiFile size={18} className={bytes ? 'text-emerald-500' : 'text-text-secondary'} />
            <span className="font-mono text-xs truncate">
              {fileName ?? t('modals:backup_restore.choose_file', 'Pilih berkas...')}
            </span>
          </button>
          {/* Sumber alternatif: arsip yang diunggah ke R2 (satu objek per akun). */}
          <button
            type="button"
            onClick={handleFetchCloud}
            disabled={isRestoring || isFetchingCloud}
            data-testid="backup-restore-cloud"
            className="
              w-full flex items-center gap-3 p-4 rounded-xl text-left
              bg-bg-main text-text-primary
              shadow-neu-concave active:shadow-neu-pressed
              hover:brightness-110 transition-all disabled:opacity-60
            "
          >
            {isFetchingCloud
              ? <Spinner size="sm" className="text-accent" />
              : <FiCloud size={18} className="text-accent" />}
            <span className="font-mono text-xs">
              {isFetchingCloud
                ? t('modals:backup_restore.cloud_fetching', 'Mengambil dari awan...')
                : t('modals:backup_restore.cloud_button', 'Ambil dari awan')}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".nyxbak"
            onChange={handleFile}
            className="hidden"
            data-testid="nyxbak-file-input"
          />
        </div>

        {/* Recovery phrase */}
        <div className="space-y-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary flex items-center gap-2">
            <FiShield size={12} />
            {t('modals:backup_restore.phrase_label', 'Recovery phrase')}
          </span>
          <textarea
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            disabled={isRestoring}
            spellCheck={false}
            autoComplete="off"
            rows={3}
            className="
              w-full p-4 rounded-xl resize-none font-mono text-sm
              bg-bg-main text-text-primary shadow-neu-concave
              focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-60
            "
            placeholder={t('modals:backup_restore.phrase_placeholder', 'kata1 kata2 kata3 ...')}
          />
        </div>

        {error && (
          <p role="alert" className="text-[11px] font-bold uppercase tracking-wider text-red-500">
            {error}
          </p>
        )}

        {isRestoring && (
          <div className="space-y-2" aria-live="polite">
            <div className="h-1.5 w-full rounded-full bg-bg-main shadow-neu-concave overflow-hidden">
              <div className="h-full bg-accent transition-all duration-200" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-text-secondary text-center">
              {t('modals:backup_restore.progress', 'Memulihkan... {{percent}}%', { percent: progress })}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isRestoring}
            className="
              px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-wider
              bg-bg-main text-text-secondary shadow-neu-flat active:shadow-neu-pressed
              hover:brightness-110 transition-all disabled:opacity-50
            "
          >
            {t('common:actions.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={isRestoring || !bytes || !phrase.trim()}
            className="
              px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-wider
              bg-accent text-white shadow-neu-convex active:shadow-neu-pressed
              hover:brightness-110 transition-all
              disabled:opacity-50 disabled:cursor-not-allowed
              flex items-center justify-center gap-2
            "
          >
            {isRestoring ? <Spinner size="sm" className="text-white" /> : <FiUpload size={16} />}
            {isRestoring
              ? t('modals:backup_restore.restoring', 'Memulihkan...')
              : t('modals:backup_restore.restore_button', 'Restore')}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}
