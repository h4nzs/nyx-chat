// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 3 / docs/31 §31.6b] Membuat berkas backup `.nyxbak`.
 *
 * Sampai komponen ini ada, `startBackupFileDownload` tidak punya pemanggil:
 * berkas `.nyxbak` hanya lahir dari alur QR (`MigrationSendPage`, kunci acak
 * yang di-seal ke penerima) sehingga `BackupRestoreModal` — yang membuka arsip
 * dengan kunci turunan recovery phrase — tidak pernah punya sumber berkas. Modul
 * transport fase 3-nya lengkap tetapi tidak terjangkau dari UI.
 *
 * Alur di sini menutup lingkaran itu, dan itu sebabnya urutannya penting:
 *   1. Ambil recovery phrase (auto-unlock key, atau prompt password).
 *   2. Buat salt acak 16 byte, turunkan kunci lewat `deriveBackupKey` (Argon2id
 *      128 MB — parameter yang dipin `BACKUP_KDF_PARAMS`).
 *   3. Bangun arsip ber-frame dengan salt yang SAMA, sehingga salt itu ikut
 *      ditulis di header → `openFramedBackupWithPhrase` di perangkat pengganti
 *      bisa menurunkan ulang kunci yang sama dari phrase saja.
 *   4. Unduh byte arsip sebagai `nyx-backup-<UTC>.nyxbak` (jalur manual), dan
 *      bila diminta unggah salinan yang SAMA ke R2 lewat `uploadBackupToCloud`
 *      (server hanya melihat blob opaque; kunci objek HMAC tanpa userId).
 *
 * Phrase dinormalkan lewat `normalizeBackupPhrase` — implementasi yang sama
 * dipakai jalur restore, jadi export dan restore tidak bisa menyimpang.
 */
import { useEffect, useState } from 'react';
import { FiCloud, FiDownload, FiShield } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import ModalBase from './ui/ModalBase';
import { Spinner } from './Spinner';
import { getSodium } from '@lib/sodiumInitializer';
import { BACKUP_SALT_BYTES, deriveBackupKey, libsodiumBackupCrypto } from '@lib/backupFormat';
import { libsodiumBackupValueCodec } from '@lib/backupPayload';
import {
  createFramedBackup,
  formatBackupSize,
  liveBackupStore,
  normalizeBackupPhrase,
} from '@lib/backupRestore';
import { startBackupFileDownload, uploadBackupToCloud } from '@lib/backupTransport';
import { ApiError } from '@lib/api';
import { getDeviceAutoUnlockKey, getEncryptedKeys } from '@lib/keyStorage';
import { getRecoveryPhrase } from '@lib/crypto-worker-proxy';
import { useModalStore } from '@store/modal';

interface BackupExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ExportPhase = 'idle' | 'phrase' | 'creating' | 'uploading' | 'done';

interface ExportResult {
  fileName: string;
  size: number;
  frameCount: number;
  records: number;
  uploaded: boolean;
  /**
   * Alasan salinan awan gagal, kalau memang gagal. Disimpan di state hasil
   * supaya alasannya tetap terbaca setelah toast hilang — sebelumnya pengguna
   * hanya melihat "gagal unggah ke awan" sesaat tanpa tahu penyebabnya.
   */
  uploadFailure?: 'unverified' | 'failed';
}

/**
 * Ambil recovery phrase. Jalur cepat: auto-unlock key perangkat (tanpa prompt).
 * Jalur lambat: prompt password global. `null` = pengguna membatalkan prompt —
 * pemanggil harus berhenti tanpa membuat berkas (bukan membuat arsip yang tidak
 * bisa dibuka).
 */
async function acquireRecoveryPhrase(): Promise<string | null> {
  const encryptedKeysStr = await getEncryptedKeys();
  if (!encryptedKeysStr) throw new Error('keys_not_found');

  const autoUnlockKey = await getDeviceAutoUnlockKey();
  if (autoUnlockKey) {
    try {
      const phrase = await getRecoveryPhrase(encryptedKeysStr, autoUnlockKey);
      if (phrase) return phrase;
    } catch (e) {
      console.warn('[BackupExport] auto-unlock gagal, jatuh ke prompt password:', e instanceof Error ? e.message : e);
    }
  }

  return await new Promise<string | null>((resolve, reject) => {
    useModalStore.getState().showPasswordPrompt(async (password) => {
      if (!password) {
        resolve(null);
        return;
      }
      try {
        resolve(await getRecoveryPhrase(encryptedKeysStr, password));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Terjemahkan kegagalan unggah awan menjadi alasan yang bisa ditindaklanjuti.
 *
 * 403 `SANDBOX_UPLOAD_RESTRICTION` bukan gangguan jaringan: server menolak
 * backup awan untuk akun yang belum terverifikasi (`isVerified=false`). Itu
 * sebabnya pesan generik "gagal unggah" menyesatkan — yang perlu dilakukan
 * pengguna adalah menyelesaikan verifikasi perangkat, bukan mengulang unggah.
 */
function classifyUploadFailure(error: unknown): 'unverified' | 'failed' {
  if (error instanceof ApiError && error.status === 403) return 'unverified';
  if (error instanceof Error && /SANDBOX_UPLOAD_RESTRICTION/.test(error.message)) return 'unverified';
  return 'failed';
}

export default function BackupExportModal({ isOpen, onClose }: BackupExportModalProps) {
  const { t } = useTranslation(['modals', 'common']);

  const [includeCloud, setIncludeCloud] = useState(false);
  const [phase, setPhase] = useState<ExportPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  const isWorking = phase !== 'idle' && phase !== 'done';

  // Reset setiap kali dibuka supaya hasil/laporan lama tidak tertinggal.
  useEffect(() => {
    if (isOpen) {
      setIncludeCloud(false);
      setPhase('idle');
      setProgress(0);
      setError('');
      setResult(null);
    }
  }, [isOpen]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isWorking) return;

    setError('');
    setProgress(0);

    try {
      setPhase('phrase');
      const phrase = await acquireRecoveryPhrase();
      if (!phrase) {
        // Dibatalkan di prompt password: berhenti tanpa menyentuh vault.
        setPhase('idle');
        setError(t('modals:backup_export.phrase_required', 'Recovery phrase diperlukan untuk mengenkripsi backup.'));
        return;
      }

      setPhase('creating');
      const sodium = await getSodium();
      const crypto = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
      const codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
      const store = await liveBackupStore();

      // Salt dibuat di sini dan DIBERIKAN ke pembangun arsip: nilai yang sama
      // ditulis ke header, jadi restore hanya butuh phrase (+ berkas ini).
      const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
      const key = await deriveBackupKey(normalizeBackupPhrase(phrase), salt);

      const report = await createFramedBackup({
        store,
        key,
        crypto,
        codec,
        salt,
        onProgress: (done, total) => setProgress(total > 0 ? Math.round((done / total) * 100) : 0),
      });

      setPhase('uploading');
      const fileName = startBackupFileDownload(report.bytes);

      let uploaded = false;
      let uploadFailure: ExportResult['uploadFailure'];
      if (includeCloud) {
        try {
          setProgress(0);
          await uploadBackupToCloud(report.bytes, {
            onProgress: (percent) => setProgress(percent),
          });
          uploaded = true;
          toast.success(t('modals:backup_export.upload_success', 'Salinan terenkripsi tersimpan di awan.'), { id: 'backup-export-upload' });
        } catch (uploadError) {
          // Berkas lokal SUDAH terunduh — kegagalan awan tidak boleh membatalkan
          // backup yang sah, hanya dilaporkan.
          console.error('[BackupExport] cloud upload failed:', uploadError);
          uploadFailure = classifyUploadFailure(uploadError);
          toast.error(
            uploadFailure === 'unverified'
              ? t(
                  'modals:backup_export.upload_unverified',
                  'Akun belum terverifikasi — verifikasi perangkat dulu agar backup awan diizinkan. Berkas lokal tetap tersimpan.'
                )
              : t('modals:backup_export.upload_failed', 'Gagal mengunggah ke awan; berkas lokal tetap tersimpan.'),
            { id: 'backup-export-upload' }
          );
        }
      }

      setResult({
        fileName,
        size: report.size,
        frameCount: report.frameCount,
        records: report.records,
        uploaded,
        uploadFailure,
      });
      setPhase('done');
      toast.success(
        t('modals:backup_export.success', 'Backup dibuat: {{records}} catatan · {{size}}', {
          records: report.records.toLocaleString('en-US'),
          size: formatBackupSize(report.size),
        }),
        { duration: 5000 }
      );
    } catch (e) {
      console.error('[BackupExport] failed:', e);
      setPhase('idle');
      setError(t('modals:backup_export.failed', 'Backup gagal dibuat.'));
    } finally {
      setProgress(0);
    }
  };

  return (
    <ModalBase
      isOpen={isOpen}
      onClose={isWorking ? () => {} : onClose}
      title={t('modals:backup_export.title', 'Buat Backup Terenkripsi')}
    >
      <form onSubmit={handleCreate} className="space-y-5">
        <p className="text-[11px] leading-relaxed text-text-secondary uppercase tracking-wider opacity-80">
          {t(
            'modals:backup_export.warning',
            'Arsip dienkripsi dengan recovery phrase Anda. Tanpa phrase itu, berkas ini tidak bisa dibuka siapa pun — termasuk kami.'
          )}
        </p>

        {/* Sumber kunci */}
        <div className="flex items-start gap-3 p-4 rounded-xl bg-bg-main shadow-neu-concave">
          <FiShield size={16} className="mt-0.5 text-emerald-500 shrink-0" />
          <p className="font-mono text-[10px] leading-relaxed text-text-secondary">
            {t(
              'modals:backup_export.phrase_note',
              'Kunci diturunkan dari recovery phrase (Argon2id). Kami tidak pernah melihat phrase atau isi arsip.'
            )}
          </p>
        </div>

        {/* Opsi awan */}
        <button
          type="button"
          onClick={() => setIncludeCloud((v) => !v)}
          disabled={isWorking}
          aria-pressed={includeCloud}
          data-testid="backup-export-cloud"
          className={`
            w-full flex items-center gap-3 p-4 rounded-xl text-left
            bg-bg-main text-text-primary transition-all disabled:opacity-60
            ${includeCloud ? 'shadow-neu-pressed ring-1 ring-accent/40' : 'shadow-neu-concave'}
          `}
        >
          <FiCloud size={18} className={includeCloud ? 'text-accent' : 'text-text-secondary'} />
          <span className="flex-1">
            <span className="block text-[11px] font-bold uppercase tracking-wider">
              {t('modals:backup_export.cloud_label', 'Simpan juga salinan terenkripsi di awan')}
            </span>
            <span className="block mt-1 font-mono text-[10px] text-text-secondary opacity-80">
              {t(
                'modals:backup_export.cloud_hint',
                'Objek opaque (satu per akun, unggahan menimpa). Bisa diambil kembali dari modal Restore.'
              )}
            </span>
          </span>
        </button>

        {error && (
          <p role="alert" className="text-[11px] font-bold uppercase tracking-wider text-red-500">
            {error}
          </p>
        )}

        {isWorking && (
          <div className="space-y-2" aria-live="polite">
            <div className="h-1.5 w-full rounded-full bg-bg-main shadow-neu-concave overflow-hidden">
              <div className="h-full bg-accent transition-all duration-200" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-text-secondary text-center">
              {phase === 'phrase'
                ? t('modals:backup_export.reading_phrase', 'Membaca recovery phrase...')
                : phase === 'uploading'
                  ? t('modals:backup_export.uploading', 'Mengunggah ke awan...')
                  : t('modals:backup_export.creating', 'Membuat arsip... {{percent}}%', { percent: progress })}
            </p>
          </div>
        )}

        {result && (
          <div className="p-4 rounded-xl bg-bg-main shadow-neu-concave space-y-1">
            <p className="font-mono text-[10px] text-text-secondary break-all">{result.fileName}</p>
            <p className="font-mono text-[10px] text-text-secondary">
              {t('modals:backup_export.result_summary', '{{records}} catatan · {{frames}} frame · {{size}}', {
                records: result.records.toLocaleString('en-US'),
                frames: result.frameCount,
                size: formatBackupSize(result.size),
              })}
            </p>
            {result.uploaded && (
              <p className="font-mono text-[10px] text-accent">
                {t('modals:backup_export.result_cloud', 'Tersimpan juga di awan.')}
              </p>
            )}
            {!result.uploaded && result.uploadFailure && (
              <p role="status" className="font-mono text-[10px] text-amber-500">
                {result.uploadFailure === 'unverified'
                  ? t(
                      'modals:backup_export.result_cloud_unverified',
                      'Salinan awan dilewati: akun belum terverifikasi. Verifikasi perangkat di Pengaturan, lalu buat ulang backup.'
                    )
                  : t(
                      'modals:backup_export.result_cloud_failed',
                      'Salinan awan gagal diunggah — berkas .nyxbak di perangkat ini tetap sah.'
                    )}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isWorking}
            className="
              px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-wider
              bg-bg-main text-text-secondary shadow-neu-flat active:shadow-neu-pressed
              hover:brightness-110 transition-all disabled:opacity-50
            "
          >
            {phase === 'done' ? t('common:actions.close', 'Close') : t('common:actions.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={isWorking}
            className="
              px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-wider
              bg-accent text-white shadow-neu-convex active:shadow-neu-pressed
              hover:brightness-110 transition-all
              disabled:opacity-50 disabled:cursor-not-allowed
              flex items-center justify-center gap-2
            "
          >
            {isWorking ? <Spinner size="sm" className="text-white" /> : <FiDownload size={16} />}
            {isWorking
              ? t('modals:backup_export.working', 'Membuat...')
              : t('modals:backup_export.create_button', 'Buat & Unduh Backup')}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}
