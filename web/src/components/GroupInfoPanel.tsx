import { useState, useRef, useEffect } from 'react';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import ParticipantList from './ParticipantList';
import EditGroupInfoModal from './EditGroupInfoModal';
import AddParticipantModal from './AddParticipantModal';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { toAbsoluteUrl } from '@utils/url';
import { FiEdit2, FiLogOut, FiPlus, FiX } from 'react-icons/fi';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import MediaGallery from './MediaGallery';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedTabs } from './ui/AnimatedTabs';

const GroupInfoPanel = ({ conversationId, onClose }: { conversationId: string; onClose: () => void; }) => {
  const { conversation } = useConversationStore(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  }));
  const { user } = useAuthStore();

  const [isEditing, setIsEditing] = useState(false);
  const [isAddParticipantModalOpen, setIsAddParticipantModalOpen] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('details'); // State for tabs
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'media', label: 'Media' },
  ];

  useEffect(() => {
    const timer = setTimeout(() => setIsPanelOpen(true), 10);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsPanelOpen(false);
    setTimeout(onClose, 300);
  };

  useGlobalEscape(handleClose);

  if (!conversation || !conversation.isGroup) {
    return null;
  }

  const amIAdmin = conversation.participants.find(p => p.id === user?.id)?.role === 'ADMIN';

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;

    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('avatar', file);

    const toastId = toast.loading('Uploading avatar...');
    try {
      await api(`/api/conversations/${conversation.id}/avatar`, {
        method: 'POST',
        body: formData,
      });
      toast.success('Avatar updated!', { id: toastId });
    } catch (error: any) {
      toast.error(`Failed to upload avatar: ${error.message || 'Unknown error'}`, { id: toastId });
    }
  };

  const handleLeaveGroup = async () => {
    // We will use our custom ConfirmModal now
    // This logic will be moved or triggered via the modal store
    const toastId = toast.loading('Leaving group...');
    try {
      await api(`/api/conversations/${conversation.id}/leave`, { method: 'DELETE' });
      toast.success('You have left the group.', { id: toastId });
      handleClose(); // Close the panel on success
    } catch (error: any) {
      toast.error(`Failed to leave group: ${error.message || 'Unknown error'}`, { id: toastId });
    }
  };

  const avatarSrc = conversation.avatarUrl 
    ? `${toAbsoluteUrl(conversation.avatarUrl)}?t=${conversation.lastUpdated}` 
    : `https://api.dicebear.com/8.x/initials/svg?seed=${conversation.title}`;

  return (
    <div className="fixed inset-0 z-40">
      <div 
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${isPanelOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
        aria-hidden="true"
      ></div>

      <div className={`absolute top-0 right-0 h-full w-full max-w-md bg-bg-surface shadow-neumorphic-convex z-50 flex flex-col transition-transform duration-300 ease-in-out ${isPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <header className="p-4 flex items-center flex-shrink-0">
          <button onClick={handleClose} className="btn-flat p-2 rounded-full text-text-secondary mr-2">
            <FiX size={24} />
          </button>
          <h2 className="text-xl font-bold text-text-primary">Group Info</h2>
        </header>

        <main className="flex-1 flex flex-col overflow-y-auto bg-bg-main">
          <div className="p-4 md:px-6 md:pt-6 flex-shrink-0">
            <AnimatedTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          </div>

          <div className="flex-1 relative px-4 md:px-6 pb-6">
            <AnimatePresence mode="wait">
              {activeTab === 'details' && (
                <motion.div
                  key="group-details"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-6"
                >
                  {/* Group Identity Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-6 text-center relative">
                    <div className="relative w-24 h-24 mx-auto mb-4">
                      <img
                        src={avatarSrc}
                        alt="Group Avatar"
                        className="w-full h-full rounded-full object-cover bg-bg-primary"
                      />
                      {amIAdmin && (
                        <>
                          <button onClick={() => fileInputRef.current?.click()} className="absolute bottom-0 right-0 bg-accent-gradient rounded-full p-2 text-white hover:opacity-90" aria-label="Change group avatar">
                            <FiEdit2 size={16} />
                          </button>
                          <input type="file" ref={fileInputRef} onChange={handleAvatarChange} className="hidden" accept="image/*" />
                        </>
                      )}
                    </div>
                    <h3 className="text-2xl font-bold text-text-primary">{conversation.title}</h3>
                    <p className="text-text-secondary mt-1">{conversation.description || 'No description'}</p>
                    {amIAdmin && (
                      <button onClick={() => setIsEditing(true)} className="absolute top-4 right-4 text-text-secondary hover:text-accent-color">
                        <FiEdit2 size={20} />
                      </button>
                    )}
                  </div>

                  {/* Members Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex">
                    <div className="p-6 border-b border-border">
                      <h4 className="text-lg font-semibold text-text-primary">{conversation.participants.length} Members</h4>
                      {amIAdmin && (
                        <button
                          onClick={() => setIsAddParticipantModalOpen(true)}
                          className="w-full flex items-center justify-center p-3 mt-4 rounded-lg text-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                        >
                          <FiPlus className="mr-2" />
                          <span>Add Participants</span>
                        </button>
                      )}
                    </div>
                    <ParticipantList conversationId={conversation.id} participants={conversation.participants} amIAdmin={amIAdmin} />
                  </div>

                  {/* Actions Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex">
                    <button
                      onClick={handleLeaveGroup}
                      className="w-full flex items-center justify-center p-4 font-semibold text-red-500 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all rounded-xl"
                    >
                      <FiLogOut className="mr-3" />
                      <span>Leave Group</span>
                    </button>
                  </div>
                </motion.div>
              )}

              {activeTab === 'media' && (
                <motion.div
                  key="group-media"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                >
                  <MediaGallery conversationId={conversation.id} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        {isEditing && (
          <EditGroupInfoModal
            conversationId={conversation.id}
            currentTitle={conversation.title || ''}
            currentDescription={conversation.description || null}
            onClose={() => setIsEditing(false)}
          />
        )}

        {isAddParticipantModalOpen && (
          <AddParticipantModal
            conversationId={conversation.id}
            onClose={() => setIsAddParticipantModalOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

export default GroupInfoPanel;