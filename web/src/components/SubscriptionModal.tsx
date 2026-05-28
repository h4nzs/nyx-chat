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
  const [showPaymentSelector, setShowPaymentSelector] = useState(false);
  const user = useAuthStore(s => s.user);

  const handleUpgrade = async () => {
    setIsLoading(true);
    try {
      const res = await api<{ checkout_url: string }>('/api/subscriptions/create', {
        method: 'POST'
      });

      if (res.checkout_url) {
        window.location.href = res.checkout_url;
      } else {
        throw new Error('Failed to get checkout URL');
      }
    } catch (error: unknown) {
        setIsLoading(false);
        const err = error as Error;
        toast.error(err.message || 'Failed to initiate payment');
    }
  };

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
          <div className="w-16 h-16 mx-auto rounded-full bg-accent/20 flex items-center justify-center border border-accent/30 shadow-[0_0_15px_rgba(var(--color-accent),0.3)]">
            <FiStar className="text-accent text-3xl" />
          </div>
          <h2 className="text-2xl font-bold text-white tracking-wide">{t('modals:subscription.title')}</h2>
          <p className="text-text-secondary text-sm">
            {t('modals:subscription.subtitle')}
          </p>
        </div>

        {showPaymentSelector ? (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-2 text-center">{t('modals:subscription.payment.select_method')}</h3>
            
            <button
              onClick={handleUpgrade}
              disabled={isLoading}
              className="w-full p-4 bg-bg-dark border border-white/10 hover:border-accent/50 hover:bg-accent/5 rounded-xl transition-all text-left flex items-center gap-4"
            >
              <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                 <FiZap className="text-accent" />
              </div>
              <div>
                <div className="text-white font-bold">{t('modals:subscription.payment.fiat_title')}</div>
                <div className="text-xs text-text-secondary">{t('modals:subscription.payment.fiat_desc')}</div>
              </div>
            </button>

            <button
              onClick={handleCryptoUpgrade}
              disabled={isLoading}
              className="w-full p-4 bg-bg-dark border border-white/10 hover:border-yellow-500/50 hover:bg-yellow-500/5 rounded-xl transition-all text-left flex items-center gap-4"
            >
              <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center shrink-0">
                 <FiLock className="text-yellow-500" />
              </div>
              <div>
                <div className="text-white font-bold">{t('modals:subscription.payment.crypto_title')}</div>
                <div className="text-xs text-yellow-500/80">{t('modals:subscription.payment.crypto_desc')}</div>
              </div>
            </button>

            <button 
              onClick={() => setShowPaymentSelector(false)}
              className="w-full py-2 text-text-secondary hover:text-white text-sm transition-colors mt-2"
            >
              {t('modals:subscription.buttons.back_to_features')}
            </button>
          </div>
        ) : (
          <>
            {/* Features Comparison */}
            <div className="bg-bg-dark border border-white/10 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-2">{t('modals:subscription.pro_limits')}</h3>
              
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiZap className="text-green-500" />
                </div>
                <div>
                  <div className="text-white font-medium">{t('modals:subscription.features.turbo_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.turbo_desc')}</div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiUsers className="text-blue-500" />
                </div>
                <div>
                  <div className="text-white font-medium">{t('modals:subscription.features.groups_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.groups_desc')}</div>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0 mt-1">
                  <FiFile className="text-purple-500" />
                </div>
                <div>
                  <div className="text-white font-medium">{t('modals:subscription.features.uploads_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.uploads_desc')}</div>
                </div>
              </div>
              
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                  <FiShield className="text-accent" />
                </div>
                <div>
                  <div className="text-white font-medium">{t('modals:subscription.features.anon_title')}</div>
                  <div className="text-sm text-text-secondary">{t('modals:subscription.features.anon_desc')}</div>
                </div>
              </div>
            </div>

            {/* Price & CTA */}
            <div className="text-center space-y-4 pt-2">
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-3xl font-bold text-white">{t('modals:subscription.pricing.amount')}</span>
                <span className="text-text-secondary">{t('modals:subscription.pricing.per_month')}</span>
              </div>

              <button
                onClick={() => setShowPaymentSelector(true)}
                disabled={isLoading || user?.subscriptionTier === 'SUBSCRIBER'}
                className="w-full py-3 px-4 bg-accent hover:bg-accent/80 disabled:opacity-50 text-bg-dark font-bold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <span className="animate-spin w-5 h-5 border-2 border-bg-dark border-t-transparent rounded-full" />
                ) : user?.subscriptionTier === 'SUBSCRIBER' ? (
                  t('modals:subscription.buttons.already_subscribed')
                ) : (
                  <>{t('modals:subscription.buttons.upgrade')} <FiStar /></>
                )}
              </button>

              <div className="flex items-start gap-2 text-sm text-text-secondary mt-3">
                <FiShield className="shrink-0 mt-0.5 text-accent" />
                <p className="text-left leading-relaxed">
                  {t('modals:subscription.trust_guarantee')}{' '}
                  <a href="https://nyx-app.my.id/refund" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {t('modals:subscription.refund_policy')}
                  </a>
                </p>
              </div>
            </div>
          </>
        )}

        {/* Privacy Disclaimer */}
        <div className="bg-bg-dark/50 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-3">
          <FiLock className="text-yellow-500 shrink-0 mt-0.5" />
          <p className="text-xs text-text-secondary leading-relaxed">
            <strong className="text-yellow-500/90 font-medium">{t('modals:subscription.disclaimer.guarantee')}</strong>{' '}
            <Trans 
              i18nKey="modals:subscription.disclaimer.desc" 
              values={{ id: user?.id?.substring(0, 5) }} 
              components={{ 1: <span className="font-mono" /> }} 
            />
          </p>
        </div>

      </div>
    </ModalBase>
  );
}
