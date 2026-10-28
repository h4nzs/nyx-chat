import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch } from '@lib/api';
import { apiErrorTranslator, formatApiError } from '@lib/apiErrorText';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';
import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useVerificationStore, computeFingerprint } from '@store/verification';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedTabs } from './ui/AnimatedTabs';
import { useUserProfile } from '@hooks/useUserProfile';
import MediaGallery from './MediaGallery';
import type { UserId, ProfileUser, ConversationId } from '@nyx/shared';
import { asConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useSettingsStore } from '@store/settings';
import { estimateDailyCoverBytes } from '@lib/coverTraffic';

// [docs/35 Fase 3] Cover traffic 1:1 opt-in. State client-local seperti versi
// grup: server tidak pernah tahu chat mana yang mengirim umpan. Kartu hanya
// diberikan untuk DM yang sudah punya riwayat — cover tidak boleh memulai sesi.
function DirectCoverTrafficCard({
  conversationId,
  hasHistory,
}: {
  conversationId: ConversationId;
  hasHistory: boolean;
}) {
  const { t } = useTranslation(['modals']);
  const { maximum, masterEnabled } = useSettingsStore(useShallow((s) => ({
    maximum: s.coverTrafficMaximumGroups.includes(conversationId),
    masterEnabled: s.coverTrafficMasterEnabled,
  })));
  const dailyMb = (estimateDailyCoverBytes() / (1024 * 1024)).toFixed(1);
  const isOn = maximum && masterEnabled;
  const blockedNoHistory = !maximum && !hasHistory;

  const handleToggle = () => {
    const next = !maximum;
    useSettingsStore.getState().setGroupCoverTraffic(conversationId, next);
    import('@lib/coverTraffic').then(({ getCoverScheduler }) => {
      const settings = useSettingsStore.getState();
      const scheduler = getCoverScheduler();
      scheduler.updatePreferences({
        masterEnabled: settings.coverTrafficMasterEnabled,
        maximumGroups: new Set(settings.coverTrafficMaximumGroups),
      });
      scheduler.sync(settings.coverTrafficMaximumGroups);
    }).catch(() => {});
    toast.success(next
      ? t('modals:user_info.cover.enabled_toast', { mb: dailyMb })
      : t('modals:user_info.cover.disabled_toast'));
  };

  return (
    <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h4 className="font-semibold text-text-primary">{t('modals:user_info.cover.title')}</h4>
          <p className="text-xs text-text-secondary mt-1">
            {!masterEnabled
              ? t('modals:user_info.cover.disabled_by_master')
              : blockedNoHistory
                ? t('modals:user_info.cover.no_history')
                : t('modals:user_info.cover.description', { mb: dailyMb })}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={isOn}
          disabled={!masterEnabled || blockedNoHistory}
          onClick={handleToggle}
          className={clsx(
            'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors',
            isOn ? 'bg-accent-color' : 'bg-bg-tertiary',
            (!masterEnabled || blockedNoHistory) && 'opacity-50 cursor-not-allowed'
          )}
        >
          <span
            className={clsx(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              isOn ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
      </div>
    </div>
  );
}

export default function UserInfoPanel({ userId }: { userId: UserId }) {
  // Tambahkan namespace 'common' untuk menangkap pesan error global
  const { t } = useTranslation(['modals', 'common']);
  const { activeId, conversations } = useConversationStore(useShallow(s => ({
    activeId: s.activeId,
    conversations: s.conversations
  })));
  const { verifiedStatus, setVerified } = useVerificationStore();
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const profile = useUserProfile(user);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState('');
  const [activeTab, setActiveTab] = useState('details');

  const activeConversation = conversations.find(c => c.id === activeId);
  const isPqDr = activeConversation?.encryptionMode === 'SPQR';

  const tabs = [
    { id: 'details', label: t('modals:user_info.tabs.details') },
    { id: 'media', label: t('modals:user_info.tabs.media') },
  ];

  const isAlreadyVerified = activeId ? !!verifiedStatus[activeId] : false;

  useEffect(() => {
    if (!userId) {
      setUser(null);
      return;
    }

    const fetchUser = async () => {
      setLoading(true);
      setError(null);
      setUser(null);
      try {
        const userData = await authFetch<ProfileUser>(`/api/users/${userId}`);
        setUser(userData);
      } catch (e) {
        setError(formatApiError(e, apiErrorTranslator(t)));
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [userId]);

  const handleViewProfile = () => {
    if (!user) return;
    navigate(`/profile/${user.id}`);
  };

  const handleVerifySecurity = async () => {
    if (!user?.publicKey) {
      setError(t('modals:user_info.errors.no_keys'));
      return;
    }

    try {
      const { generateSafetyNumber } = await import('@lib/crypto-worker-proxy');
      const { computeSafetyNumberParts } = await import('@utils/safetyNumber');
      const { getEncryptionKeyPair, getPqEncryptionKeyPair, getSigningPrivateKey } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) {
        throw new Error(t('modals:user_info.errors.my_key_missing'));
      }
      
      const pqKeyPair = await getPqEncryptionKeyPair().catch(() => null);
      const mySigningKey = await getSigningPrivateKey();

      // FIXED: user as ProfileUser
      const { myPublicKeyCombined, theirPublicKeyCombined } = await computeSafetyNumberParts(
        keyPair.publicKey,
        pqKeyPair?.publicKey || null,
        mySigningKey,
        user as ProfileUser & { publicKey: string }
      );

      const sn = await generateSafetyNumber(myPublicKeyCombined, theirPublicKeyCombined);
      setSafetyNumber(sn);
      setShowSafetyModal(true);

    } catch (e: unknown) {
      console.error("Safety Number generation error:", e);
      setError((e instanceof Error ? e.message : t('common:errors.unknown')) || t('modals:user_info.errors.safety_number_failed'));
    }
  };

  const renderDetails = () => {
    if (loading) return <div className="flex justify-center items-center min-h-[200px]"><Spinner /></div>;
    if (error) return <p className="text-center text-red-500">{error}</p>;
    if (user) {
      return (
        <div className="space-y-6">
          <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-6 text-center">
            {profile.avatarUrl ? (
              <img
                src={toAbsoluteUrl(profile.avatarUrl)}
                alt={profile.name}
                className="w-24 h-24 rounded-full bg-secondary object-cover mb-4 mx-auto"
              />
            ) : (
              <DefaultAvatar name={profile.name} id={userId} className="w-24 h-24 mb-4 mx-auto bg-secondary" />
            )}
            <h3 className="text-xl font-bold text-text-primary">{profile.name}</h3>
            {user.isVerified && (
              <span className="inline-block mt-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-bold uppercase tracking-wider">{t('modals:user_info.verified')}</span>
            )}
            <p className="text-text-secondary mt-2 text-sm">
              {profile.description || t('modals:user_info.no_desc')}
            </p>
          </div>
          <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-4 space-y-2">
            <div className="flex items-center justify-between p-3 rounded-lg bg-bg-surface shadow-neumorphic-pressed">
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-text-primary">X-Wing Post-Quantum</span>
                <span className="text-[10px] text-text-secondary opacity-60">Hardened Forward Secrecy Enabled</span>
              </div>
              <div className="p-1.5 rounded-full bg-green-500/20 text-green-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </div>
            </div>
            <button
              onClick={handleViewProfile}
              className="w-full p-3 rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
            >
              {t('modals:user_info.view_profile')}
            </button>
            <button
              onClick={handleVerifySecurity}
              className="w-full p-3 rounded-lg font-semibold text-text-primary bg-bg-surface shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
            >
              {t('modals:user_info.verify_security')}
            </button>
          </div>
          {activeId && (
            <DirectCoverTrafficCard
              conversationId={asConversationId(activeId)}
              hasHistory={Boolean(activeConversation?.lastMessage)}
            />
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <div className="h-full flex flex-col">
        <div className="p-4 text-center border-b border-text-secondary/10 dark:border-black/5">
            <h2 className="text-lg font-semibold">{t('modals:user_info.about', { name: profile.name || t('common:defaults.user') })}</h2>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 md:p-6 relative">
          <div className="px-4 md:px-0 mb-4">
            <AnimatedTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          </div>

          <AnimatePresence mode="wait">
            {activeTab === 'details' && (
              <motion.div
                key="user-details"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="absolute top-24 left-0 w-full px-4 md:px-6"
              >
                {renderDetails()}
              </motion.div>
            )}
            {activeTab === 'media' && activeId && (
              <motion.div
                key="user-media"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="absolute top-24 left-0 w-full px-4 md:px-6"
              >
                <MediaGallery conversationId={asConversationId(activeId)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      
      {showSafetyModal && user && (
        <SafetyNumberModal
          safetyNumber={safetyNumber}
          // FIXED: removed unnecessary any cast
          userName={profile.name || ''}
          onClose={() => setShowSafetyModal(false)}
          onVerify={() => {
        if (activeId && safetyNumber) {
          // [docs/29 §7.2] Verifikasi safety number = menerima kunci baru
          // (membuka hard gate kirim) — peerUserId wajib ikut.
          setVerified(activeId, safetyNumber, String(user.id));
        }
        setShowSafetyModal(false);
      }}
          isVerified={isAlreadyVerified}
          hasPeerPQ={!!user.pqPublicKey}
          hasPeerSigning={!!user.signingKey}
        />
      )}
    </>
  );
}
