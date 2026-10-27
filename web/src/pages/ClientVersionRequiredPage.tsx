// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-15 · 2026-10-27] Layar penuh saat server menolak versi klien (426).
 *
 * Kenapa bukan toast: penolakan ini tidak selesai sendiri. Pada `CLIENT_TOO_OLD`
 * SETIAP request gagal, dan pengguna akan terus kehilangan pesan grup sampai ia
 * memperbarui — toast yang bisa tertutup/tertimpa toast lain adalah cara paling
 * halus untuk menyembunyikan kegagalan total. Pada `CLIENT_VERSION_REQUIRED`
 * hanya mutasi yang gagal; layar ini menjelaskan bedanya dan memberi jalan
 * keluar (muat ulang) atau lanjut membaca tanpa mengirim.
 *
 * Dirender sebagai overlay di atas app yang tetap ter-mount (pola yang sama
 * dengan `ServerDownPage`), jadi state & koneksi tidak hilang setelah reload
 * gagal. Import statis: layar ini harus bisa tampil ketika request API sedang
 * ditolak, bukan diunduh lewat chunk lazy.
 */

import React from 'react';
import { FiArrowUpCircle, FiRefreshCw, FiShieldOff, FiX } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';

import { CLIENT_VERSION_VALUE } from '@lib/clientVersion';
import { useClientVersionGateStore } from '@store/clientVersionGate';

/**
 * `onReload` ada supaya tombol utamanya bisa diuji tanpa memicu navigasi jsdom
 * (`window.location.reload` tidak bisa di-stub dengan andal); di produksi
 * prop ini tidak diisi.
 */
export const ClientVersionRequiredPage: React.FC<{ onReload?: () => void }> = ({ onReload }) => {
  const { t } = useTranslation('errors');
  const rejection = useClientVersionGateStore((state) => state.rejection);
  const dismissed = useClientVersionGateStore((state) => state.dismissed);
  const dismiss = useClientVersionGateStore((state) => state.dismiss);

  if (!rejection) return null;
  // Hanya mode yang masih bisa membaca yang boleh ditutup.
  if (rejection.kind === 'version-required' && dismissed) return null;

  const tooOld = rejection.kind === 'too-old';
  const reload = onReload ?? (() => window.location.reload());
  const minimum = rejection.minimumVersion ?? t('client_version_unknown_minimum');
  const current = rejection.clientVersion ?? CLIENT_VERSION_VALUE;
  const Icon = tooOld ? FiArrowUpCircle : FiShieldOff;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="client-version-title"
      aria-describedby="client-version-body"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-bg-main text-text-primary p-4"
    >
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-accent/10 rounded-full blur-[100px] pointer-events-none" />

      <div
        className="relative z-10 max-w-md w-full p-8 rounded-3xl bg-bg-surface border border-text-secondary/10 flex flex-col items-center text-center"
        style={{ boxShadow: 'var(--shadow-neu-flat)' }}
      >
        <div
          className="w-20 h-20 mb-6 rounded-full flex items-center justify-center bg-bg-main"
          style={{ boxShadow: 'var(--shadow-neu-pressed)' }}
        >
          <Icon className="w-8 h-8 text-accent" />
        </div>

        <h1 id="client-version-title" className="font-display text-2xl font-bold mb-2 text-text-primary">
          {tooOld ? t('client_version_too_old_title') : t('client_version_required_title')}
        </h1>

        <p id="client-version-body" className="text-sm text-text-secondary mb-5 leading-relaxed">
          {tooOld
            ? t('client_version_too_old_body', { version: current, minimum })
            : t('client_version_required_body', { version: current, minimum })}
        </p>

        <dl className="w-full grid grid-cols-2 gap-2 mb-6 text-xs">
          <div className="rounded-xl bg-bg-main px-3 py-2 text-left">
            <dt className="text-text-secondary">{t('client_version_current')}</dt>
            <dd className="font-mono font-semibold text-text-primary">{current}</dd>
          </div>
          <div className="rounded-xl bg-bg-main px-3 py-2 text-left">
            <dt className="text-text-secondary">{t('client_version_minimum')}</dt>
            <dd className="font-mono font-semibold text-text-primary">{minimum}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={reload}
          className="group flex items-center justify-center w-full py-3 px-4 rounded-xl bg-bg-surface text-accent font-semibold transition-all"
          style={{ boxShadow: 'var(--shadow-neu-flat)' }}
        >
          <FiRefreshCw className="w-4 h-4 mr-2 group-hover:rotate-180 transition-transform duration-500 motion-reduce:transition-none" />
          {t('client_version_reload')}
        </button>

        {!tooOld && (
          <button
            type="button"
            onClick={dismiss}
            className="mt-3 flex items-center justify-center w-full py-2 px-4 rounded-xl text-text-secondary text-sm hover:text-text-primary transition-colors"
          >
            <FiX className="w-4 h-4 mr-2" />
            {t('client_version_continue')}
          </button>
        )}

        <p className="mt-5 text-xs text-text-secondary leading-relaxed">
          {t('client_version_pwa_hint')}
        </p>
      </div>
    </div>
  );
};

export default ClientVersionRequiredPage;
