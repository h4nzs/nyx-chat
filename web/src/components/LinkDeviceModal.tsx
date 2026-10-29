import { useCallback, useEffect, useRef, useState } from 'react';
import QRCodeRaw from 'react-qr-code';
import { FiCheck, FiRefreshCw, FiShield, FiSmartphone, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { apiErrorTranslator, formatApiErrorOr } from '@lib/apiErrorText';

import ModalBase from './ui/ModalBase';
import { transportClient } from '@lib/transportClient';
import { approveDeviceLink, buildDeviceLinkUrl, denyDeviceLink } from '@lib/deviceLinking';
import {
  countHistoryRecords,
  parseHistoryTooLarge,
  readHistoryTables,
  sendHistoryArchive,
} from '@lib/linkHistoryExport';

const QRCode = (
  (QRCodeRaw as { default?: { default?: typeof QRCodeRaw } }).default?.default ||
  (QRCodeRaw as { default?: typeof QRCodeRaw }).default ||
  QRCodeRaw
) as typeof QRCodeRaw;

/**
 * [LINK 2026-10-18] Sisi PERANGKAT LAMA: tampilkan QR untuk ditautkan, lalu
 * setujui/tolak perangkat yang memindainya.
 *
 * Dua event yang didengarkan berasal dari server (bukan dari jalur WT/WSS
 * khusus, jadi keduanya berjalan di dua transport):
 *   - `auth:linking_qr_ready`  → token QR (5 menit, sekali pakai)
 *   - `auth:linking_request`   → ada perangkat baru menunggu persetujuan
 * Keputusan diambil lewat REST supaya tetap bisa dilakukan walaupun relay
 * sedang putus; event hanya memberi tahu ada apa.
 */
interface Props {
  onClose: () => void;
}

interface PendingLink {
  pendingId: string;
  deviceName: string;
  /**
   * [docs/40] X-Wing public key perangkat baru (dari `auth:linking_request`).
   * Arsip riwayat diseal ke kunci ini — tanpa field ini arsip tidak bisa
   * dialamatkan dan opsi riwayat harus disembunyikan, bukan gagal diam-diam.
   */
  pqPublicKey?: string;
}

const QR_REQUEST_TIMEOUT_MS = 8000;

export default function LinkDeviceModal({ onClose }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [linkingToken, setLinkingToken] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLink[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // [docs/40] Opsi "sertakan riwayat": hanya ditawarkan bila memang ada yang
  // bisa dipindah. `readHistoryTables` memakai pembaca yang mendekripsi, jadi
  // jumlahnya nyata (bukan tebakan dari baris Dexie).
  const [includeHistory, setIncludeHistory] = useState(true);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [historyPhase, setHistoryPhase] = useState<'exporting' | 'uploading' | null>(null);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRequestTimer = () => {
    if (requestTimer.current) {
      clearTimeout(requestTimer.current);
      requestTimer.current = null;
    }
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const tables = await readHistoryTables();
        if (alive) setHistoryCount(countHistoryRecords(tables));
      } catch (e) {
        console.warn('[Link] Gagal menghitung riwayat yang bisa dipindah:', e);
        if (alive) setHistoryCount(0);
      }
    })();
    return () => { alive = false; };
  }, []);

  const requestQr = useCallback(() => {
    setLinkingToken(null);
    clearRequestTimer();
    if (!transportClient?.connected) {
      toast.error(t('settings:sessions_page.link_offline'));
      return;
    }
    // Token diikat server ke sesi ini (userId + deviceId perangkat), bukan ke
    // payload — tidak ada kunci yang perlu dikirim.
    transportClient.sendEvent('auth:request_linking_qr', {});
    requestTimer.current = setTimeout(() => {
      // Relay putus / server menolak (rate limit 5/menit) → tanpa timer ini
      // modal hanya menampilkan spinner selamanya.
      setLinkingToken((current) => {
        if (!current) toast.error(t('settings:sessions_page.link_qr_failed'));
        return current;
      });
    }, QR_REQUEST_TIMEOUT_MS);
  }, [t]);

  useEffect(() => {
    // `transportClient.on` menerima handler `(...args: unknown[])`, jadi payload
    // dinarrow di dalam handler (bukan di tipe parameter).
    const onQrReady = (raw: unknown) => {
      const data = (raw ?? {}) as { linkingToken?: unknown };
      if (typeof data.linkingToken !== 'string' || !data.linkingToken) return;
      clearRequestTimer();
      setLinkingToken(data.linkingToken);
    };

    const onLinkRequest = (raw: unknown) => {
      const data = (raw ?? {}) as { pendingId?: unknown; deviceName?: unknown; pqPublicKey?: unknown };
      if (typeof data.pendingId !== 'string' || !data.pendingId) return;
      const pendingId = data.pendingId;
      const deviceName = typeof data.deviceName === 'string' && data.deviceName
        ? data.deviceName
        : t('settings:sessions_page.link_unknown_device');
      const pqPublicKey = typeof data.pqPublicKey === 'string' && data.pqPublicKey
        ? data.pqPublicKey
        : undefined;
      setPending((prev) => [
        ...prev.filter((item) => item.pendingId !== pendingId),
        { pendingId, deviceName, ...(pqPublicKey ? { pqPublicKey } : {}) },
      ]);
      toast(t('settings:sessions_page.link_incoming', { device: deviceName }), { icon: '🔗' });
    };

    transportClient.on('auth:linking_qr_ready', onQrReady);
    transportClient.on('auth:linking_request', onLinkRequest);
    requestQr();

    return () => {
      clearRequestTimer();
      transportClient.off('auth:linking_qr_ready', onQrReady);
      transportClient.off('auth:linking_request', onLinkRequest);
    };
  }, [requestQr, t]);

  const handleApprove = async (item: PendingLink) => {
    // [docs/40 §40.4] `expectHistory` memberi tahu perangkat baru untuk menunggu
    // arsip sebelum `complete` — kalau tidak, login-nya mencabut sesi perangkat
    // ini di tengah unggahan. Hanya diklaim bila arsipnya memang mungkin dibuat.
    const wantsHistory =
      includeHistory &&
      (historyCount ?? 0) > 0 &&
      typeof item.pqPublicKey === 'string' &&
      item.pqPublicKey.length > 0;

    setBusyId(item.pendingId);
    try {
      const { deviceId } = await approveDeviceLink(item.pendingId, { expectHistory: wantsHistory });
      setPending((prev) => prev.filter((entry) => entry.pendingId !== item.pendingId));

      if (wantsHistory) {
        try {
          const result = await sendHistoryArchive({
            deviceId,
            pqPublicKeyB64: item.pqPublicKey!,
            onProgress: (label) => setHistoryPhase(label === 'ready' ? null : label),
          });
          if (result.records > 0) {
            toast.success(t('settings:sessions_page.link_history_uploaded'));
          }
        } catch (e) {
          // Arsip gagal TIDAK membatalkan tautan: perangkat baru sudah disetujui
          // dan akan lanjut tanpa riwayat (intent dibersihkan oleh exporter).
          console.error('[Link] Arsip riwayat gagal dikirim:', e);
          const tooLarge = parseHistoryTooLarge(e);
          if (tooLarge) {
            // [docs/40 §40.7 langkah 8] Kelebihan kuota dilaporkan dengan angka
            // nyata; tanpa ini pesannya hanya "gagal mengirim arsip".
            const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
            toast.error(
              t('settings:sessions_page.link_history_too_large', {
                size: mb(tooLarge.size),
                limit: mb(tooLarge.limit),
              })
            );
          } else {
            toast.error(t('settings:sessions_page.link_history_failed'));
          }
        } finally {
          setHistoryPhase(null);
        }
      }

      toast.success(t('settings:sessions_page.link_approved', { device: item.deviceName }));
    } catch (e) {
      toast.error(formatApiErrorOr(e, apiErrorTranslator(t), t('settings:sessions_page.link_action_failed')));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeny = async (item: PendingLink) => {
    setBusyId(item.pendingId);
    try {
      await denyDeviceLink(item.pendingId);
      setPending((prev) => prev.filter((entry) => entry.pendingId !== item.pendingId));
      toast.success(t('settings:sessions_page.link_denied', { device: item.deviceName }));
    } catch (e) {
      toast.error(formatApiErrorOr(e, apiErrorTranslator(t), t('settings:sessions_page.link_action_failed')));
    } finally {
      setBusyId(null);
    }
  };

  const linkUrl = linkingToken
    ? buildDeviceLinkUrl(window.location.origin, linkingToken)
    : null;

  return (
    <ModalBase
      isOpen
      onClose={onClose}
      title={t('settings:sessions_page.link_title')}
      footer={(
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
        >
          {t('common:actions.close')}
        </button>
      )}
    >
      <div className="space-y-5">
        <p className="text-sm text-text-secondary">
          {t('settings:sessions_page.link_desc')}
        </p>

        <div className="flex flex-col items-center gap-3">
          {linkUrl ? (
            <div className="bg-white p-3 rounded-xl shadow-neumorphic-pressed">
              <QRCode value={linkUrl} size={180} level="M" />
            </div>
          ) : (
            <div className="w-[204px] h-[204px] rounded-xl bg-bg-main border border-text-secondary/20 flex items-center justify-center text-text-secondary text-xs text-center px-4">
              {t('settings:sessions_page.link_qr_waiting')}
            </div>
          )}
          <button
            onClick={requestQr}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-main border border-text-secondary/10 text-xs font-bold uppercase tracking-wider text-text-secondary hover:text-accent transition-colors"
          >
            <FiRefreshCw size={14} />
            {t('settings:sessions_page.link_new_qr')}
          </button>
        </div>

        {linkUrl && (
          <div className="rounded-xl bg-bg-main border border-text-secondary/10 p-3">
            <p className="text-[10px] uppercase tracking-widest text-text-secondary mb-1">
              {t('settings:sessions_page.link_manual_label')}
            </p>
            <code className="block break-all text-xs text-text-primary select-all">{linkUrl}</code>
          </div>
        )}

        <div className="rounded-xl bg-bg-main border border-text-secondary/10 p-3 space-y-1">
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              className="mt-1 accent-accent"
              checked={includeHistory}
              disabled={!historyCount || historyPhase !== null}
              onChange={(e) => setIncludeHistory(e.target.checked)}
            />
            <span>
              {t('settings:sessions_page.link_include_history', { count: historyCount ?? 0 })}
              <span className="block text-[11px] leading-relaxed text-text-secondary/80 mt-1">
                {!historyCount
                  ? t('settings:sessions_page.link_history_empty')
                  : t('settings:sessions_page.link_history_hint')}
              </span>
            </span>
          </label>
          {historyPhase && (
            <p className="text-[11px] text-accent">
              {historyPhase === 'exporting'
                ? t('settings:sessions_page.link_history_exporting')
                : t('settings:sessions_page.link_history_uploading')}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-text-secondary flex items-center gap-2">
            <FiSmartphone size={14} />
            {t('settings:sessions_page.link_pending_title')}
          </h3>
          {pending.length === 0 ? (
            <p className="text-xs text-text-secondary/70">
              {t('settings:sessions_page.link_pending_empty')}
            </p>
          ) : (
            pending.map((item) => (
              <div
                key={item.pendingId}
                className="flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/5 p-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FiShield className="text-accent shrink-0" size={16} />
                  <span className="text-sm font-semibold truncate">{item.deviceName}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleDeny(item)}
                    disabled={busyId === item.pendingId}
                    className="p-2 rounded-lg bg-bg-main text-text-secondary hover:text-red-500 transition-colors disabled:opacity-40"
                    aria-label={t('settings:sessions_page.link_deny')}
                  >
                    <FiX size={16} />
                  </button>
                  <button
                    onClick={() => handleApprove(item)}
                    disabled={busyId === item.pendingId}
                    className="p-2 rounded-lg bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    aria-label={t('settings:sessions_page.link_approve')}
                  >
                    <FiCheck size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-text-secondary/80 flex items-start gap-2">
          <FiShield size={14} className="mt-0.5 shrink-0" />
          {t('settings:sessions_page.link_single_device_note')}
        </p>
      </div>
    </ModalBase>
  );
}
