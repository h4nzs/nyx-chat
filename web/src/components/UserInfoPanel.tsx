import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';
import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore, computeFingerprint } from '@store/verification';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedTabs } from './ui/AnimatedTabs';
import { useUserProfile } from '@hooks/useUserProfile';
import MediaGallery from './MediaGallery';
import type { UserId } from '@nyx/shared';
import { asConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

type ProfileUser = User & { publicKey?: string; pqPublicKey?: string; signingKey?: string };

export default function UserInfoPanel({ userId }: { userId: UserId }) {
  // Tambahkan namespace 'common' untuk menangkap pesan error global
  const { t } = useTranslation(['modals', 'common']);
  const { activeId } = useConversationStore();
  const { verifiedStatus, setVerified } = useVerificationStore();
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const profile = useUserProfile(user);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState('');
  const [activeTab, setActiveTab] = useState('details');

  const tabs = [
    { id: 'details', label: t('modals:user_info.tabs.details') },
    { id: 'media', label: t('modals:user_info.tabs.media') },
  ];

  const isAlreadyVerified = activeId ? verifiedStatus[activeId] : false;

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
        setError(handleApiError(e));
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
      const { getSodium } = await import('@lib/sodiumInitializer');
      const { useAuthStore } = await import('@store/auth');
      const { getEncryptionKeyPair, getPqEncryptionKeyPair, getSigningPrivateKey } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) {
        throw new Error(t('modals:user_info.errors.my_key_missing'));
      }
      
      const pqKeyPair = await getPqEncryptionKeyPair().catch(() => null);

      const sodium = await getSodium();
      const mySigningKey = await getSigningPrivateKey();
      const mySigningPubKey = mySigningKey.slice(32);
      
      // Combine all available keys for a robust safety number
      const myParts = [keyPair.publicKey];
      if (pqKeyPair?.publicKey) myParts.push(pqKeyPair.publicKey);
      myParts.push(mySigningPubKey);
      
      const myTotalLen = myParts.reduce((acc, p) => acc + p.length, 0);
      const myPublicKeyCombined = new Uint8Array(myTotalLen);
      let myOffset = 0;
      for (const part of myParts) {
        myPublicKeyCombined.set(part, myOffset);
        myOffset += part.length;
      }

      const theirX25519PubKey = sodium.from_base64(user.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const theirPqPubKey = user.pqPublicKey 
          ? sodium.from_base64(user.pqPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING) 
          : null;
      const theirSigningPubKey = user.signingKey 
          ? sodium.from_base64(user.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING) 
          : new Uint8Array(0);
          
      const theirParts = [theirX25519PubKey];
      if (theirPqPubKey) theirParts.push(theirPqPubKey);
      theirParts.push(theirSigningPubKey);
      
      const theirTotalLen = theirParts.reduce((acc, p) => acc + p.length, 0);
      const theirPublicKeyCombined = new Uint8Array(theirTotalLen);
      let theirOffset = 0;
      for (const part of theirParts) {
        theirPublicKeyCombined.set(part, theirOffset);
        theirOffset += part.length;
      }

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
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <div className="h-full flex flex-col">
        <div className="p-4 text-center border-b border-white/5 dark:border-black/5">
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
          userName={profile.name}
          onClose={() => setShowSafetyModal(false)}
          onVerify={async () => {
            if (activeId && user) {
              const fingerprint = await computeFingerprint(user);
              setVerified(activeId, fingerprint);
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
