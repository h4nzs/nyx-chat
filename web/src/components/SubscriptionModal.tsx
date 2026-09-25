import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '@store/auth';
import { FiStar, FiShield, FiZap, FiUsers, FiFile, FiLock } from 'react-icons/fi';
import { useTranslation, Trans } from 'react-i18next';

export default function SubscriptionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['modals', 'common']);
  const [isLoading, setIsLoading] = useState(false);
  const user = useAuthStore(s => s.user);

  // [PAYMENTS CRYPTO-ONLY] Jalur fiat (Tripay/Midtrans) dihapus total —
  // hanya NOWPayments. Selector metode pembayaran tidak diperlukan lagi.
  const handleCryptoUpgrade = async () => {
    setIsLoading(true);
    try {
      const res = await api<{ invoice_url: string }>('/api/subscriptions/create-crypto-transaction', {
        method: 'POST'
      });
      window.location.href = res.invoice_url;
    } catch (error: unknown) {
      setIsLoading(false);
      const err = error as Error;
      toast.error(err.message || 'Failed to initiate crypto payment');
    }
  };

  return (
    <ModalBase isOpen={true} onClose={onClose} title={t('modals:subscription.title')}>
      <div className="p-6 md:p-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 mx-auto rounded-full bg-accent/20 flex items-center justify-center border border-accent/30 shadow-neu-icon">
            <FiStar className="text-accent text-3xl" />
          </div>
          <h2 className="text-2xl font-bold text-text-primary tracking-wide">{t('modals:subscription.title')}</h2>
          <p className="text-text-secondary text-sm">
            {t('modals:subscription.subtitle')}
          </p>
        </div>

        {(
          <>
            {/* Features Comparison */}
            <div className="bg-bg-surface border border-text-secondary/10 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-2">{t('modals:subscription.pro_limits')}</h3>
              
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiZap className="text-green-500" />
                </div>
                <div>
                  <div className="text-text-primary font-medium">{t('modals:subscription.features.turbo_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.turbo_desc')}</div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiUsers className="text-blue-500" />
                </div>
                <div>
                  <div className="text-text-primary font-medium">{t('modals:subscription.features.groups_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.groups_desc')}</div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiFile className="text-purple-500" />
                </div>
                <div>
                  <div className="text-text-primary font-medium">{t('modals:subscription.features.uploads_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.uploads_desc')}</div>
                </div>
              </div>
              
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                  <FiShield className="text-accent" />
                </div>
                <div>
                  <div className="text-text-primary font-medium">{t('modals:subscription.features.anon_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.anon_desc')}</div>
                </div>
              </div>
            </div>

            {/* Price & CTA */}
            <div className="text-center space-y-4 pt-2">
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-3xl font-bold text-text-primary">{t('modals:subscription.pricing.amount')}</span>
                <span className="text-text-secondary">{t('modals:subscription.pricing.per_month')}</span>
              </div>

              <button
                onClick={handleCryptoUpgrade}
                disabled={isLoading || user?.subscriptionTier === 'SUBSCRIBER'}
                className="w-full py-3 px-4 bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-slate-900 font-bold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <span className="animate-spin w-5 h-5 border-2 border-slate-900 border-t-transparent rounded-full" />
                ) : user?.subscriptionTier === 'SUBSCRIBER' ? (
                  t('modals:subscription.buttons.already_subscribed')
                ) : (
                  <>{t('modals:subscription.buttons.upgrade')} (Crypto) <FiLock /></>
                )}
              </button>

              <div className="flex items-start gap-2 text-sm text-text-secondary mt-3">
                <FiShield className="shrink-0 mt-0.5 text-yellow-500" />
                <p className="text-left leading-relaxed">
                  Payments are processed 100% anonymously via Cryptocurrency.{' '}
                  <a href="https://nyx-app.my.id/refund" target="_blank" rel="noopener noreferrer" className="text-yellow-500 hover:underline">
                    {t('modals:subscription.refund_policy')}
                  </a>
                </p>
              </div>
            </div>
          </>
        )}

        {/* Privacy Disclaimer */}
        <div className="bg-bg-surface/50 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-3">
          <FiLock className="text-yellow-500 shrink-0 mt-0.5" />
          <p className="text-xs text-text-secondary leading-relaxed">
            <strong className="text-yellow-500/90 font-medium">{t('modals:subscription.disclaimer.guarantee')}</strong>{' '}
            {/* [PAYMENTS CRYPTO-ONLY] Disclaimer fiat (Midtrans alias) dihapus —
                pembayaran hanya kripto: tidak ada email, tidak ada jejak keuangan fiat. */}
            Payments are processed 100% anonymously via Cryptocurrency. We don't even
            have your email — we only verify that you paid the invoice amount, without
            any personal info.
          </p>
        </div>

      </div>
    </ModalBase>
  );
}
