import { useEffect, useState } from 'react';
import { useModalStore } from '@store/modal';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';
import { generateSafetyNumber } from '@lib/crypto-worker-proxy';
import { getSodium } from '@lib/sodiumInitializer';
import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore } from '@store/verification';
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
      const myPublicKeyB64 = localStorage.getItem('publicKey');
      if (!myPublicKeyB64) {
        throw new Error("Your public key is not found. Please set up your keys first.");
      }

      const sodium = await getSodium();
      const myPublicKey = sodium.from_base64(myPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
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
    if (error) return <p className="text-center text-destructive">{error}</p>;
    if (user) {
      return (
        <div className="flex flex-col items-center text-center">
          <img
            src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
            alt={user.name}
            className="w-24 h-24 rounded-full bg-secondary object-cover mb-4"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`;
            }}
          />
          <h3 className="text-xl font-bold text-text-primary">{user.name}</h3>
          <p className="text-sm text-text-secondary">@{user.username}</p>
          {user.email && (
            <p className="text-sm text-accent mt-1">{user.email}</p>
          )}
          <p className="text-text-secondary mt-2 text-sm">
            {user.description || 'This user prefers to keep an air of mystery.'}
          </p>
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
                <div className="w-full flex flex-col space-y-2 pt-4 border-t border-border">
                  <button
                    onClick={handleViewProfile}
                    className="w-full p-3 rounded-lg font-semibold text-white bg-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                  >
                    View Full Profile
                  </button>
                  <button
                    onClick={handleVerifySecurity}
                    className="w-full p-3 rounded-lg font-semibold text-text-primary bg-bg-surface shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                  >
                    Verify Security
                  </button>
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
