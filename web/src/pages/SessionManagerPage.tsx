import { useState, useEffect } from 'react';
import { api } from '@lib/api';
import { toast } from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { Link } from 'react-router-dom';
import { FiMonitor, FiSmartphone, FiLogOut, FiChevronLeft, FiServer, FiLink } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';
// [2026-10-27] 401/403/429 dari sesi perangkat punya sebab spesifik.
import { apiErrorTranslator, formatApiErrorOr } from '@lib/apiErrorText';
// [LINK 2026-10-18] Pairing perangkat baru lewat QR (token + persetujuan).
import LinkDeviceModal from '@components/LinkDeviceModal';
// [docs/40 §40.8] Percobaan ulang impor arsip riwayat setelah link.
import { hasPendingHistoryImport, retryLinkedHistory } from '@lib/linkHistoryRetry';

type Session = {
  deviceId?: string;
  deviceName?: string;
  deviceInfo?: string;
  ipAddress?: string;
  lastUsedAt: string | number | Date;
  jti: string;
  isCurrent?: boolean;
  [key: string]: unknown;
};

/**
 * [docs/28 Tier 0 — D5] Server tidak lagi menyimpan userAgent/IP per sesi.
 * Label sesi = nama perangkat yang di-set klien (Device.name); hanya bentuk
 * ikon (mobile/desktop) yang diturunkan dari label itu.
 */
const isMobileLabel = (label: string) => /android|iphone|ipad|ios|mobile/i.test(label);

const SessionBlade = ({ session, onLogout, isCurrent }: { session: Session, onLogout: (jti: string) => void, isCurrent: boolean }) => {
  const label = String(session.deviceName || session.deviceInfo || 'Unknown Device');
  const os = isMobileLabel(label) ? 'Mobile' : 'Desktop';
  const { t } = useTranslation(['settings', 'common']);
  const Icon = os === 'Mobile' ? FiSmartphone : FiMonitor;

  return (
    <div className={`
      relative group
      flex items-center justify-between p-4 rounded-xl mb-4
      bg-bg-main
      shadow-neu-flat-light dark:shadow-neu-flat-dark
      border border-black/10 dark:border-white/10 dark:border-black/20
      ${isCurrent ? 'ring-1 ring-green-500/50' : ''}
    `}>
      {/* LED Indicator */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-12 bg-bg-main rounded-r-md flex flex-col justify-center gap-1">
         <div className={`w-1 h-8 rounded-r-sm mx-auto ${isCurrent ? 'bg-green-500 shadow-[0_0_8px_lime]' : 'bg-gray-400'}`}></div>
      </div>

      <div className="flex items-center gap-6 pl-4">
        <div className={`
          p-3 rounded-xl 
          ${isCurrent ? 'bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark text-green-500' : 'bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark text-text-secondary'}
        `}>
          <Icon size={24} />
        </div>
        
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-text-primary uppercase tracking-wide text-sm">{label}</h3>
            {isCurrent && (
               <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-green-500 text-white shadow-sm">{t('settings:sessions_page.current')}</span>
            )}
          </div>
          
          <div className="font-mono text-xs text-text-secondary mt-1 space-y-0.5 opacity-80">
            <p>{t('settings:sessions_page.ip')} <span className="text-text-primary">{session.ipAddress}</span></p>
            <p>{t('settings:sessions_page.last_ping')} {new Date(session.lastUsedAt).toLocaleString()}</p>
          </div>
        </div>
      </div>

      {!isCurrent && (
        <button
          onClick={() => onLogout(session.jti)}
          className="
            p-3 rounded-xl text-red-500
            bg-bg-main
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            hover:text-red-600 hover:scale-105 active:scale-95 transition-all
          "
          title={t('settings:emergency.eject')}
        >
          <FiLogOut size={20} />
        </button>
      )}
    </div>
  );
};

export default function SessionManagerPage() {
  const { t } = useTranslation(['settings', 'common']);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  // [LINK 2026-10-18] Modal QR pairing — dirender on-demand (bukan di App).
  const [showLinkDevice, setShowLinkDevice] = useState(false);
  // [docs/40 §40.8] Arsip riwayat yang impornya gagal masih ada di server
  // sampai TTL 30 menit — tawarkan percobaan ulang hanya bila penandanya ada.
  const [pendingHistory, setPendingHistory] = useState(false);
  const [retryingHistory, setRetryingHistory] = useState(false);
  const [retryMessages, setRetryMessages] = useState(0);

  useEffect(() => {
    let alive = true;
    void hasPendingHistoryImport().then((pending) => {
      if (alive) setPendingHistory(pending);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const data = await api<{ sessions: Session[] }>('/api/sessions');

        // Dedupe per perangkat (dulu per userAgent — kolom itu sudah tidak ada).
        const uniqueSessions = new Map<string, Session>();
        for (const session of data.sessions) {
          const key = session.deviceId || session.jti;
          const existing = uniqueSessions.get(key);
          if (!existing || new Date(session.lastUsedAt) > new Date(existing.lastUsedAt)) {
            uniqueSessions.set(key, session);
          }
        }
        
        const processedSessions = Array.from(uniqueSessions.values())
          .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());

        setSessions(processedSessions);

      } catch (error: unknown) {
        // 401 (sesi berakhir) / 429 tidak sama dengan gangguan jaringan; kalau
        // servernya memang tak terjangkau, kalimat jaringan yang dipakai.
        toast.error(formatApiErrorOr(error, apiErrorTranslator(t), t('common:errors.network')));
      } finally {
        setLoading(false);
      }
    };
    fetchSessions();
  }, [t]);

  const handleRetryHistory = async () => {
    setRetryingHistory(true);
    setRetryMessages(0);
    try {
      const outcome = await retryLinkedHistory({
        onProgress: (progress) => setRetryMessages(progress.messages),
      });
      if (outcome.status === 'imported') {
        toast.success(t('settings:sessions_page.history_retry_done', { count: outcome.records }));
        setPendingHistory(false);
      } else if (outcome.status === 'expired') {
        // TTL habis / sudah dikonsumsi: tidak ada lagi yang bisa diulang.
        toast(t('settings:sessions_page.history_retry_expired'), { icon: 'ℹ️' });
        setPendingHistory(false);
      } else if (outcome.status === 'failed') {
        toast.error(t('settings:sessions_page.history_retry_failed'));
      } else {
        setPendingHistory(false);
      }
    } finally {
      setRetryingHistory(false);
    }
  };

  const handleLogoutSession = async (jti: string) => {
    const toastId = toast.loading(t('settings:messages.ejecting'));
    try {
      await api(`/api/sessions/${jti}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.jti !== jti));
      toast.success(t('settings:messages.terminated'), { id: toastId });
    } catch (error: unknown) {
      // 403/404 dari DELETE /api/sessions/:jti dijelaskan apa adanya.
      toast.error(formatApiErrorOr(error, apiErrorTranslator(t), t('settings:messages.eject_failed')), { id: toastId });
    }
  };

  return (
    <div className="min-h-screen bg-bg-main flex flex-col items-center p-4">
      
      {/* Header */}
      <div className="w-full max-w-3xl mb-8 mt-4 flex items-center justify-between">
         <Link 
            to="/settings" 
            className="
              p-3 rounded-xl text-text-secondary
              bg-bg-main
              shadow-neu-flat-light dark:shadow-neu-flat-dark
              active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
              hover:text-accent transition-all
            "
          >
            <FiChevronLeft size={20} />
          </Link>
          <div className="flex flex-col items-end">
             <h1 className="text-xl font-black uppercase tracking-widest text-text-primary">{t('settings:sessions_page.title')}</h1>
             <p className="text-[10px] font-mono text-text-secondary uppercase">{t('settings:sessions_page.subtitle')}</p>
          </div>
      </div>

      <div className="w-full max-w-3xl mb-6">
        <button
          onClick={() => setShowLinkDevice(true)}
          className="w-full flex items-center justify-center gap-3 rounded-xl bg-bg-surface border border-text-secondary/10 px-4 py-3 text-sm font-bold text-text-primary shadow-neu-flat-light dark:shadow-neu-flat-dark hover:text-accent transition-all"
        >
          <FiLink size={18} />
          {t('settings:sessions_page.link_button')}
        </button>
        <p className="mt-2 text-center text-[10px] font-mono uppercase tracking-widest text-text-secondary/70">
          {t('settings:sessions_page.link_button_hint')}
        </p>

        {pendingHistory && (
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
            <p className="text-sm font-bold text-text-primary">
              {t('settings:sessions_page.history_retry_title')}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              {t('settings:sessions_page.history_retry_desc')}
            </p>
            <button
              onClick={handleRetryHistory}
              disabled={retryingHistory}
              className="mt-3 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {retryingHistory
                ? t('settings:sessions_page.history_retry_running', { messages: retryMessages })
                : t('settings:sessions_page.history_retry_button')}
            </button>
          </div>
        )}
      </div>

      <div className="w-full max-w-3xl flex-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-text-secondary">
             <Spinner size="lg" />
             <p className="mt-4 font-mono text-xs animate-pulse">{t('settings:sessions_page.scanning')}</p>
          </div>
        ) : (
          <div className="space-y-6">
             {/* Rack Mount Rails - Visual Decoration */}
             <div className="hidden md:block fixed left-4 top-0 bottom-0 w-2 bg-[repeating-linear-gradient(0deg,transparent,transparent_20px,rgba(0,0,0,0.1)_20px,rgba(0,0,0,0.1)_21px)]"></div>
             <div className="hidden md:block fixed right-4 top-0 bottom-0 w-2 bg-[repeating-linear-gradient(0deg,transparent,transparent_20px,rgba(0,0,0,0.1)_20px,rgba(0,0,0,0.1)_21px)]"></div>

            {sessions.map(session => {
              const sessionProps = session as Session;
              return (
              <SessionBlade
                key={sessionProps.jti}
                session={sessionProps}
                onLogout={handleLogoutSession}
                isCurrent={sessionProps.isCurrent ?? false} 
              />
            )})}
            
            {sessions.length === 0 && (
               <div className="p-8 text-center text-text-secondary opacity-50">
                  <FiServer size={48} className="mx-auto mb-4" />
                  <p>{t('settings:sessions_page.no_nodes')}</p>
               </div>
            )}
          </div>
        )}
      </div>

      {showLinkDevice && <LinkDeviceModal onClose={() => setShowLinkDevice(false)} />}
    </div>
  );
}
