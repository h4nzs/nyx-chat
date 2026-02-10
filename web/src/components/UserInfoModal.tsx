import { useEffect, useState } from 'react';
import { useModalStore } from '@store/modal';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';

import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore } from '@store/verification';
import { useAuthStore } from '@store/auth';
import ModalBase from './ui/ModalBase';
import MediaGallery from './MediaGallery';
import { AnimatedTabs } from './ui/AnimatedTabs';

type ProfileUser = User & { email?: string; publicKey?: string };

export default function UserInfoModal() {
  const { isProfileModalOpen, profileUserId, closeProfileModal } = useModalStore();
  const { activeId } = useConversationStore();
  const { verifiedStatus, setVerified } = useVerificationStore();
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState('');
  const [activeTab, setActiveTab] = useState('about');

  // Subscribe to blockedUserIds changes to ensure UI updates when blocking/unblocking
  const blockedUserIds = useAuthStore(state => state.blockedUserIds);

  const tabs = [
    { id: 'about', label: 'About' },
    { id: 'media', label: 'Media' },
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
      setError("This user has not set up their encryption keys yet.");
      return;
    }

    try {
      const { generateSafetyNumber } = await import('@lib/crypto-worker-proxy');
      const { getSodium } = await import('@lib/sodiumInitializer');
      const { getEncryptionKeyPair } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) {
        throw new Error("Your public key is not found. Please set up your keys first.");
      }

      const sodium = await getSodium();
      const myPublicKey = keyPair.publicKey;
      const theirPublicKey = sodium.from_base64(user.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      const sn = await generateSafetyNumber(myPublicKey, theirPublicKey);
      setSafetyNumber(sn);
      setShowSafetyModal(true);

    } catch (e: any) {
      setError(e.message || "Failed to generate safety number.");
    }
  };

  const renderContent = () => {
    if (loading) return <div className="flex justify-center items-center min-h-[200px]"><Spinner /></div>;
    if (error) return <p className="text-center text-red-500 font-mono text-sm">{error}</p>;
    if (user) {
      return (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-6">
            {/* Avatar: INSET (Pressed in) - Looks like a porthole */}
            <div className="relative w-24 h-24 rounded-full shadow-neu-pressed dark:shadow-neu-pressed-dark flex items-center justify-center p-1 bg-bg-main">
               <img
                 src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
                 alt={user.name}
                 className="w-full h-full rounded-full object-cover"
                 onError={(e) => {
                   const target = e.target as HTMLImageElement;
                   target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`;
                 }}
               />
               <div className="absolute bottom-1 right-1 w-4 h-4 bg-green-500 border-2 border-bg-main rounded-full shadow-neu-flat dark:shadow-neu-flat-dark" />
            </div>

            {/* Info: Left Aligned */}
            <div className="flex-1 pt-2">
              <h3 className="text-2xl font-bold tracking-tight text-text-primary">{user.name}</h3>
              {/* ID Badge: Extruded pill */}
              <div className="inline-flex items-center gap-2 mt-2 px-3 py-1 rounded-full shadow-neu-flat dark:shadow-neu-flat-dark bg-bg-main">
                 <span className="text-xs font-mono text-text-secondary uppercase">ID</span>
                 <span className="text-sm font-mono text-accent">@{user.username}</span>
              </div>
            </div>
          </div>

          <div className="w-full text-left">
             <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2 mb-1 block">Bio-Data</label>
             <div className="
               w-full p-4 rounded-xl min-h-[80px]
               bg-bg-main text-text-primary text-sm font-medium
               shadow-neu-pressed dark:shadow-neu-pressed-dark
               border border-white/5
             ">
               {user.description || <span className="opacity-40 italic">No data available.</span>}
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
        title={user?.name || 'User Profile'}
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
                    View Personnel File
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
                    Verify Encryption Handshake
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
                          Unblock Signal
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
                          Block Signal
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === 'media' && activeId && (
            <div className="min-h-[300px]">
              <MediaGallery conversationId={activeId} />
            </div>
          )}
        </div>
      </ModalBase>
      
      {showSafetyModal && user && (
        <SafetyNumberModal 
          safetyNumber={safetyNumber} 
          userName={user.name} 
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
