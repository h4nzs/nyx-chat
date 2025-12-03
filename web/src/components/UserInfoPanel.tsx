import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toAbsoluteUrl } from '@utils/url';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { Spinner } from './Spinner';
import { generateSafetyNumber } from '@utils/keyManagement';
import { getSodium } from '@lib/sodiumInitializer';
import SafetyNumberModal from './SafetyNumberModal';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore } from '@store/verification';
import { motion, AnimatePresence } from 'framer-motion';
import MediaGallery from './MediaGallery';
import { AnimatedTabs } from './ui/AnimatedTabs';

type ProfileUser = User & { email?: string; publicKey?: string };

export default function UserInfoPanel({ userId }: { userId: string }) {
  const { activeId } = useConversationStore();
  const { verifiedStatus, setVerified } = useVerificationStore();
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState('');
  const [activeTab, setActiveTab] = useState('details');

  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'media', label: 'Media' },
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

  const renderDetails = () => {
    if (loading) return <div className="flex justify-center items-center min-h-[200px]"><Spinner /></div>;
    if (error) return <p className="text-center text-destructive">{error}</p>;
    if (user) {
      return (
        <div className="space-y-6">
          <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-6 text-center">
            <img 
              src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
              alt={user.name}
              className="w-24 h-24 rounded-full bg-secondary object-cover mb-4 mx-auto"
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
          <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-4 space-y-2">
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
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <div className="h-full flex flex-col">
        <div className="p-4 text-center border-b border-border">
            <h2 className="text-lg font-semibold">About {user?.name || 'User'}</h2>
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
                <MediaGallery conversationId={activeId} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      
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