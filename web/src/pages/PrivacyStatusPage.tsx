import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FiChevronLeft, FiRefreshCw, FiShield } from 'react-icons/fi';
import {
  collectPrivacyStatus,
  type PrivacyEvidence,
  type PrivacyLayerId,
  type PrivacyLayerStatus,
} from '@lib/privacyStatus';

/**
 * [docs/34 §34.6 · docs/38] Panel "Privacy Self-Check".
 *
 * Tujuannya bukan menampilkan daftar fitur, melainkan menjawab satu pertanyaan:
 * lapisan privasi mana yang benar-benar berjalan di perangkat ini **sekarang**.
 * Setiap baris diberi label buktinya (`active` = ada state nyata, `configured` =
 * jalur hidup tapi belum ada round-trip tersimpan), supaya panel tidak berubah
 * menjadi klaim marketing.
 */

const STATE_STYLE: Record<PrivacyEvidence, string> = {
  active: 'text-green-500 border-green-500/40 bg-green-500/10',
  configured: 'text-amber-500 border-amber-500/40 bg-amber-500/10',
  off: 'text-red-400 border-red-400/40 bg-red-400/10',
  unknown: 'text-text-secondary border-white/10 bg-bg-main',
};

export default function PrivacyStatusPage() {
  const { t } = useTranslation('settings');
  const [layers, setLayers] = useState<PrivacyLayerStatus[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setFailed(false);
    setLayers(null);
    try {
      setLayers(await collectPrivacyStatus());
    } catch {
      setFailed(true);
      setLayers([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const layerName = (id: PrivacyLayerId) => t(`privacy_status.layer_${id}`);
  const layerDesc = (id: PrivacyLayerId) => t(`privacy_status.layer_${id}_desc`);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto text-text-primary">
      <div className="flex items-center justify-between mb-6">
        <Link
          to="/settings"
          className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
        >
          <FiChevronLeft size={20} />
          <span className="text-sm font-semibold">{t('privacy_status.back')}</span>
        </Link>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-2 text-sm font-semibold text-accent hover:opacity-80 transition-opacity"
        >
          <FiRefreshCw size={16} />
          {t('privacy_status.refresh')}
        </button>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <FiShield className="text-accent" size={22} />
        <h1 className="text-2xl font-bold">{t('privacy_status.title')}</h1>
      </div>
      <p className="text-sm text-text-secondary mb-6 leading-relaxed">
        {t('privacy_status.subtitle')}
      </p>

      {layers === null && (
        <p className="text-sm text-text-secondary">{t('privacy_status.loading')}</p>
      )}

      {failed && (
        <p className="text-sm text-red-400 mb-4">{t('privacy_status.load_failed')}</p>
      )}

      <div className="space-y-3">
        {(layers ?? []).map((layer) => (
          <div
            key={layer.id}
            className="rounded-xl p-4 bg-bg-main shadow-neu-flat-light dark:shadow-neu-flat-dark border border-black/10 dark:border-white/10"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{layerName(layer.id)}</p>
                <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                  {layerDesc(layer.id)}
                </p>
              </div>
              <span
                className={`shrink-0 text-[11px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border ${STATE_STYLE[layer.state]}`}
              >
                {t(`privacy_status.state_${layer.state}`)}
              </span>
            </div>

            {layer.id === 'kt' && layer.params && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary mt-3">
                <span>{t('privacy_status.kt_keys', { count: layer.params.keys ?? 0 })}</span>
                {layer.params.treeSize !== undefined && (
                  <span>{t('privacy_status.kt_tree_size', { size: layer.params.treeSize })}</span>
                )}
                {layer.params.ageMs !== undefined && (
                  <span>
                    {t('privacy_status.kt_last_verified', {
                      when: new Date(Date.now() - Number(layer.params.ageMs)).toLocaleString(),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-text-secondary mt-6 leading-relaxed">
        {t('privacy_status.note')}
      </p>
    </div>
  );
}
