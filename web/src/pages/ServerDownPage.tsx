import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FiCloudOff, FiWifiOff, FiRefreshCw } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';

const INITIAL_DELAY_S = 15;
const MAX_DELAY_S = 120;
const jitter = (s: number) => Math.max(5, Math.round(s * (0.7 + Math.random() * 0.6)));

/**
 * Layar "server tidak terjangkau" (tak terencana) — beda dari MaintenancePage
 * (terencana, dipicu flag Redis). Dirender sebagai overlay di atas app yang
 * tetap ter-mount, sehingga state & koneksi tidak hilang saat server pulih.
 *
 * PENTING: komponen ini harus di-import STATIS (bukan lazy) — chunk lazy tidak
 * bisa diunduh saat server mati. Tidak memakai request/aset eksternal apa pun.
 */
export const ServerDownPage: React.FC<{ onRetry: () => Promise<void> | void }> = ({ onRetry }) => {
  const { t } = useTranslation('common');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [seconds, setSeconds] = useState(INITIAL_DELAY_S);
  const [checking, setChecking] = useState(false);
  const delayRef = useRef(INITIAL_DELAY_S);
  const checkingRef = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    if (manual) delayRef.current = INITIAL_DELAY_S;
    try {
      await onRetry();
    } finally {
      checkingRef.current = false;
      setChecking(false);
      // Exponential backoff + jitter agar pemulihan server tidak diserbu serentak.
      delayRef.current = Math.min(MAX_DELAY_S, Math.round(delayRef.current * 1.5));
      setSeconds(jitter(delayRef.current));
    }
  }, [onRetry]);

  // Hitung mundur 1 dtk; berhenti saat tab tersembunyi atau sedang mengecek.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden || checkingRef.current) return;
      setSeconds((s) => s - 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (seconds <= 0) void runCheck(false);
  }, [seconds, runCheck]);

  // Jaringan kembali → cek segera tanpa menunggu hitung mundur.
  useEffect(() => {
    const goOnline = () => { setOnline(true); void runCheck(true); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [runCheck]);

  const Icon = online ? FiCloudOff : FiWifiOff;

  return (
    <div
      role="alert"
      aria-live="polite"
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
          <Icon className="w-8 h-8 text-accent animate-pulse motion-reduce:animate-none" />
        </div>

        <h1 className="font-display text-2xl font-bold mb-2 text-text-primary">
          {online ? t('serverDown.title') : t('serverDown.offlineTitle')}
        </h1>

        <p className="text-sm text-text-secondary mb-8 leading-relaxed">
          {online ? t('serverDown.description') : t('serverDown.offlineDescription')}
        </p>

        <button
          type="button"
          onClick={() => void runCheck(true)}
          disabled={checking}
          className="group flex items-center justify-center w-full py-3 px-4 rounded-xl bg-bg-surface text-accent font-semibold transition-all disabled:opacity-60"
          style={{ boxShadow: 'var(--shadow-neu-flat)' }}
        >
          <FiRefreshCw
            className={`w-4 h-4 mr-2 ${checking ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`}
          />
          {checking ? t('serverDown.checking') : t('serverDown.retryButton')}
        </button>

        <p className="mt-5 text-xs text-text-secondary" aria-hidden={checking}>
          {checking ? ' ' : t('serverDown.nextCheck', { seconds: Math.max(0, seconds) })}
        </p>
      </div>
    </div>
  );
};
