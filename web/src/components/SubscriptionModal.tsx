import { useState, useEffect } from 'react';
import ModalBase from './ui/ModalBase';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '@store/auth';
import { FiStar, FiShield, FiZap, FiUsers, FiFile, FiLock } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';

// Add type for window.snap
declare global {
  interface Window {
    snap: {
      pay: (token: string, options: any) => void;
    };
  }
}

export default function SubscriptionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['common']);
  const [isLoading, setIsLoading] = useState(false);
  const user = useAuthStore(s => s.user);

  // Load Midtrans Snap script dynamically
  useEffect(() => {
    const isProd = import.meta.env.PROD;
    const scriptSrc = isProd 
        ? 'https://app.midtrans.com/snap/snap.js' 
        : 'https://app.sandbox.midtrans.com/snap/snap.js';
        
    // Use a placeholder client key for loading the script. 
    // Actual payment uses the token from the backend.
    const clientKey = import.meta.env.VITE_MIDTRANS_CLIENT_KEY || 'SB-Mid-client-DUMMY';

    if (!document.querySelector(`script[src="${scriptSrc}"]`)) {
      const script = document.createElement('script');
      script.src = scriptSrc;
      script.setAttribute('data-client-key', clientKey);
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  const handleUpgrade = async () => {
    setIsLoading(true);
    try {
      const res = await api<{ token: string, redirect_url: string }>('/api/subscriptions/create-transaction', {
        method: 'POST'
      });

      if (window.snap && res.token) {
        window.snap.pay(res.token, {
          onSuccess: function (result: any) {
            toast.success("Payment successful! Your account will be upgraded momentarily.");
            onClose();
          },
          onPending: function (result: any) {
            toast.success("Payment pending. Please complete your payment.");
            onClose();
          },
          onError: function (result: any) {
            toast.error("Payment failed. Please try again.");
            setIsLoading(false);
          },
          onClose: function () {
            setIsLoading(false);
          }
        });
      } else {
        // Fallback to redirect if snap fails to load
        window.location.href = res.redirect_url;
      }
    } catch (error: unknown) {
        setIsLoading(false);
        const err = error as Error;
        toast.error(err.message || 'Failed to initiate payment');
    }
  };

  return (
    <ModalBase isOpen={true} onClose={onClose} title="NYX PRO">
      <div className="p-6 md:p-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 mx-auto rounded-full bg-accent/20 flex items-center justify-center border border-accent/30 shadow-[0_0_15px_rgba(var(--color-accent),0.3)]">
            <FiStar className="text-accent text-3xl" />
          </div>
          <h2 className="text-2xl font-bold text-white tracking-wide">NYX PRO</h2>
          <p className="text-text-secondary text-sm">
            Unlock the ultimate limits while maintaining zero-knowledge privacy.
          </p>
        </div>

        {/* Features Comparison */}
        <div className="bg-bg-dark border border-white/10 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-2">Pro Limits</h3>
          
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0 mt-1">
              <FiZap className="text-green-500" />
            </div>
            <div>
              <div className="text-white font-medium">Turbo Messaging</div>
              <div className="text-sm text-text-secondary">Up to 50 messages per minute. (Free: 15/min)</div>
            </div>
          </div>

          <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0 mt-1">
              <FiUsers className="text-blue-500" />
            </div>
            <div>
              <div className="text-white font-medium">Massive Groups</div>
              <div className="text-sm text-text-secondary">Host groups with up to 500 members. (Free: 100)</div>
            </div>
          </div>

          <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0 mt-1">
              <FiFile className="text-purple-500" />
            </div>
            <div>
              <div className="text-white font-medium">Heavy Uploads</div>
              <div className="text-sm text-text-secondary">Send files up to 500 MB safely. (Free: 100 MB)</div>
            </div>
          </div>
          
          <div className="flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
              <FiShield className="text-accent" />
            </div>
            <div>
              <div className="text-white font-medium">Total Anonymity</div>
              <div className="text-sm text-text-secondary">No public badges. Your PRO status is invisible to others.</div>
            </div>
          </div>
        </div>

        {/* Price & CTA */}
        <div className="text-center space-y-4 pt-2">
          <div className="flex items-baseline justify-center gap-1">
            <span className="text-3xl font-bold text-white">Rp55.000</span>
            <span className="text-text-secondary">/ month</span>
          </div>

          <button
            onClick={handleUpgrade}
            disabled={isLoading || user?.subscriptionTier === 'SUBSCRIBER'}
            className="w-full py-3 px-4 bg-accent hover:bg-accent/80 disabled:opacity-50 text-bg-dark font-bold rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <span className="animate-spin w-5 h-5 border-2 border-bg-dark border-t-transparent rounded-full" />
            ) : user?.subscriptionTier === 'SUBSCRIBER' ? (
              'Already Subscribed'
            ) : (
              <>Upgrade to PRO <FiStar /></>
            )}
          </button>
        </div>

        {/* Privacy Disclaimer */}
        <div className="bg-bg-dark/50 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-3">
          <FiLock className="text-yellow-500 shrink-0 mt-0.5" />
          <p className="text-xs text-text-secondary leading-relaxed">
            <strong className="text-yellow-500/90 font-medium">Zero-Knowledge Guarantee:</strong> Payment is processed externally by Midtrans using an anonymous alias (<span className="font-mono">nyx_pay_{user?.id?.substring(0, 5)}...</span>). Your payment details are never linked to your cryptographic identity or chat logs.
          </p>
        </div>

      </div>
    </ModalBase>
  );
}
