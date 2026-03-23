import { useEffect, useState } from 'react';
import { useModalStore } from '@store/modal';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';
import toast from 'react-hot-toast';

import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore } from '@store/verification';
import { useAuthStore } from '@store/auth';
import { usePresenceStore } from '@store/presence';
import { useShallow } from 'zustand/react/shallow';
import ModalBase from './ui/ModalBase';
import MediaGallery from './MediaGallery';
import { AnimatedTabs } from './ui/AnimatedTabs';
import { useUserProfile } from '@hooks/useUserProfile';
import { asConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

type ProfileUser = User & { publicKey?: string };

export default function UserInfoModal() {
  const { t } = useTranslation(['modals', 'common', 'chat']);
  const { isProfileModalOpen, profileUserId, closeProfileModal } = useModalStore(useShallow(s => ({
    isProfileModalOpen: s.isProfileModalOpen, profileUserId: s.profileUserId, closeProfileModal: s.closeProfileModal
  })));
  const { activeId } = useConversationStore(useShallow(s => ({ activeId: s.activeId })));
  const { verifiedStatus, setVerified } = useVerificationStore(useShallow(s => ({ verifiedStatus: s.verifiedStatus, setVerified: s.setVerified })));
  const onlineUsers = usePresenceStore(s => s.onlineUsers);
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const profile = useUserProfile(user);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState('');
  const [activeTab, setActiveTab] = useState('about');

  // Subscribe to blockedUserIds changes to ensure UI updates when blocking/unblocking
  const blockedUserIds = useAuthStore(state => state.blockedUserIds);

  const tabs = [
    { id: 'about', label: t('modals:user_info_modal.about', 'About') },
    { id: 'media', label: t('modals:user_info_modal.media', 'Media') },
  ];

  const isAlreadyVerified = activeId ? verifiedStatus[activeId] : false;

  useEffect(() => {
    if (!profileUserId) {
      setUser(null);
      return;
    }

    const fetchUser = async () => {
      setLoading(true);
      setError(null);
      setUser(null);
      try {
        const userData = await authFetch<ProfileUser>(`/api/users/${profileUserId}`);
        setUser(userData);
      } catch (e) {
        setError(handleApiError(e));
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [profileUserId]);

  const handleViewProfile = () => {
    if (!user) return;
    closeProfileModal();
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
      const { getEncryptionKeyPair } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) {
        throw new Error(t('modals:user_info.errors.my_key_missing'));
      }

      const sodium = await getSodium();
      const myPublicKey = keyPair.publicKey;
      const theirPublicKey = sodium.from_base64(user.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      const sn = await generateSafetyNumber(myPublicKey, theirPublicKey);
      setSafetyNumber(sn);
      setShowSafetyModal(true);

    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : t('common:errors.unknown')) || t('modals:user_info.errors.safety_number_failed'));
    }
  };

  const handleReportUser = async () => {
    if (!user) return;
    const reason = prompt(t('modals:user_info_modal.prompt_report', 'Enter reason for reporting this user:'));
    if (!reason) return;
    
    try {
      await authFetch('/api/reports/user', {
        method: 'POST',
        body: JSON.stringify({ reportedUserId: user.id, reason })
      });
      toast.success(t('modals:report.success'));
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : t('common:errors.unknown')) || t('modals:report.failed'));
    }
  };

  const renderContent = () => {
    if (loading) return <div className="flex justify-center items-center min-h-[200px]"><Spinner /></div>;
    if (error) return <p className="text-center text-red-500 font-mono text-sm">{error}</p>;
    if (user) {
      const isOnline = onlineUsers.has(user.id);
      return (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-6">
            {/* Avatar: INSET (Pressed in) - Looks like a porthole */}
            <div className="relative w-24 h-24 rounded-full shadow-neu-pressed dark:shadow-neu-pressed-dark flex items-center justify-center p-1 bg-bg-main">
               <img
                 src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`}
                 alt={profile.name}
                 className="w-full h-full rounded-full object-cover"
                 onError={(e) => {
                   const target = e.target as HTMLImageElement;
                   target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`;
                 }}
               />
               <div className={`absolute bottom-1 right-1 w-4 h-4 border-2 border-bg-main rounded-full shadow-neu-flat dark:shadow-neu-flat-dark ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
            </div>

            {/* Info: Left Aligned */}
            <div className="flex-1 pt-2">
              <h3 className="text-2xl font-bold tracking-tight text-text-primary">{profile.name}</h3>
              {/* ID Badge: Extruded pill */}
              <div className="flex flex-col items-start gap-2 mt-2">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full shadow-neu-flat dark:shadow-neu-flat-dark bg-bg-main">
                   <span className="text-xs font-mono text-text-secondary uppercase">ID</span>
                   <span className="text-sm font-mono text-accent">#{user.id.substring(0, 8)}</span>
                </div>
                {user.isVerified && (
                  <span className="text-[10px] text-emerald-500 font-bold tracking-widest uppercase px-2">
                    {t('modals:user_info.verified')}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="w-full text-left">
             <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2 mb-1 block">{t('common:profile.bio_data')}</label>
             <div className="
               w-full p-4 rounded-xl min-h-[80px]
               bg-bg-main text-text-primary text-sm font-medium
               shadow-neu-pressed dark:shadow-neu-pressed-dark
               border border-white/5
             ">
               {profile.description || <span className="opacity-40 italic">{t('modals:user_info_modal.no_data', 'No data available.')}</span>}
             </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <ModalBase
        isOpen={isProfileModalOpen}
        onClose={closeProfileModal}
        title={profile.name || t('common:defaults.user')}
      >
        <div className="flex flex-col gap-4">
          <div className="px-4 md:px-0">
            <AnimatedTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          </div>

          {activeTab === 'about' && (
            <>
              {renderContent()}
              {user && (
                <div className="w-full grid grid-cols-1 gap-3 pt-6 border-t border-white/5">
                  <button
                    onClick={handleViewProfile}
                    className="
                      w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                      bg-bg-main text-text-primary
                      shadow-neu-flat dark:shadow-neu-flat-dark 
                      active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                      hover:text-accent transition-all
                    "
                  >
                    {t('modals:user_info_modal.view_personnel', 'View Personnel File')}
                  </button>
                  <button
                    onClick={handleVerifySecurity}
                    className="
                      w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                      bg-bg-main text-text-primary
                      shadow-neu-flat dark:shadow-neu-flat-dark 
                      active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                      hover:text-green-500 transition-all
                    "
                  >
                    {t('modals:user_info_modal.verify_handshake', 'Verify Encryption Handshake')}
                  </button>
                  {user && user.id !== useAuthStore.getState().user?.id && (
                    <>
                      {blockedUserIds.includes(user.id) ? (
                        <button
                          onClick={() => {
                            useAuthStore.getState().unblockUser(user.id).catch(console.error);
                          }}
                          className="
                            w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                            bg-bg-main text-red-500
                            shadow-neu-flat dark:shadow-neu-flat-dark 
                            active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                            hover:bg-red-500 hover:text-white transition-all
                          "
                        >
                          {t('modals:user_info_modal.unblock_signal', 'Unblock Signal')}
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            useAuthStore.getState().blockUser(user.id).catch(console.error);
                          }}
                          className="
                            w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                            bg-bg-main text-text-secondary
                            shadow-neu-flat dark:shadow-neu-flat-dark 
                            active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                            hover:text-red-500 transition-all
                          "
                        >
                          {t('modals:user_info_modal.block_signal', 'Block Signal')}
                        </button>
                      )}
                      
                      <button
                        onClick={handleReportUser}
                        className="
                          w-full py-3 rounded-xl font-bold uppercase tracking-wider text-xs
                          bg-bg-main text-text-secondary
                          shadow-neu-flat dark:shadow-neu-flat-dark 
                          active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark
                          hover:text-yellow-500 transition-all
                        "
                      >
                        {t('modals:user_info_modal.report_signal', 'Report Signal')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === 'media' && activeId && (
            <div className="min-h-[300px]">
              <MediaGallery conversationId={asConversationId(activeId)} />
            </div>
          )}
        </div>
      </ModalBase>
      
      {showSafetyModal && user && (
        <SafetyNumberModal 
          safetyNumber={safetyNumber} 
          userName={profile.name} 
          onClose={() => setShowSafetyModal(false)} 
          onVerify={() => {
            if (activeId && user.publicKey) {
              setVerified(activeId, user.publicKey);
            }
            setShowSafetyModal(false);
          }}
          isVerified={isAlreadyVerified}
        />
      )}
    </>
  );
}
