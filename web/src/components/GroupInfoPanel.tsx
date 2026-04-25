import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useState, useRef, useEffect } from 'react';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import ParticipantList from './ParticipantList';
import EditGroupInfoModal from './EditGroupInfoModal';
import AddParticipantModal from './AddParticipantModal';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { toAbsoluteUrl } from '@utils/url';
import { FiEdit2, FiLogOut, FiPlus, FiX, FiLock } from 'react-icons/fi';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import MediaGallery from './MediaGallery';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedTabs } from './ui/AnimatedTabs';
import { uploadToR2 } from '@lib/r2';
import { compressImage } from '@lib/fileUtils';
import ImageCropperModal from './ImageCropperModal';
import type { ConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

const GroupInfoPanel = ({ conversationId, onClose }: { conversationId: ConversationId; onClose: () => void; }) => {
  const { t } = useTranslation(['modals', 'common']);
  const { conversation } = useConversationStore(useShallow(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  })));
  const { user } = useAuthStore(useShallow(s => ({ user: s.user })));

  const [isEditing, setIsEditing] = useState(false);
  const [isAddParticipantModalOpen, setIsAddParticipantModalOpen] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('details'); 
  const [avatarCropTarget, setAvatarCropTarget] = useState<{ url: string, file: File } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabs = [
    { id: 'details', label: t('modals:group_info.tabs.details') },
    { id: 'media', label: t('modals:group_info.tabs.media') },
  ];

  useEffect(() => {
    const timer = setTimeout(() => setIsPanelOpen(true), 10);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (avatarCropTarget?.url) {
        URL.revokeObjectURL(avatarCropTarget.url);
      }
    };
  }, [avatarCropTarget]);

  const handleClose = () => {
    setIsPanelOpen(false);
    setTimeout(onClose, 300);
  };

  useGlobalEscape(handleClose);

  if (!conversation || !conversation.isGroup) {
    return null;
  }

  const amIAdmin = conversation.participants.find(p => p.id === user?.id)?.role === 'ADMIN';

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    setAvatarCropTarget({ url: URL.createObjectURL(file), file });
    e.target.value = '';
  };

  const handleUploadCroppedAvatar = async (croppedFile: File) => {
    const toastId = toast.loading(t('modals:group_info.toasts.processing_avatar'));

    try {
      let fileToUpload = croppedFile;
      try {
        if (croppedFile.type.startsWith('image/')) {
           fileToUpload = await compressImage(croppedFile);
        }
      } catch (err) {
        // Fallback
      }

      toast.loading(t('modals:group_info.toasts.uploading'), { id: toastId });
      
      const fileUrl = await uploadToR2(fileToUpload, 'groups', (progress) => {
         // Opsional: update progress toast
      });

      toast.loading(t('modals:group_info.toasts.updating'), { id: toastId });
      
      // [FIX] ZERO-KNOWLEDGE METADATA UPDATE
      const { encryptGroupMetadata, ensureGroupSession } = await import('@utils/crypto');
      const { emitGroupKeyDistribution } = await import('@lib/socket');

      // Ensure session exists
      const distributionKeys = await ensureGroupSession(conversation.id, conversation.participants);
      if (distributionKeys && distributionKeys.length > 0) {
        emitGroupKeyDistribution(conversation.id, distributionKeys as { userId: string; key: string }[]);
      }

      const currentMetadata = conversation.decryptedMetadata || {};
      const newMetadata = { ...currentMetadata, avatarUrl: fileUrl };
      const encryptedMetadata = await encryptGroupMetadata(newMetadata, conversation.id);

      await api(`/api/conversations/${conversation.id}/details`, {
        method: 'PUT',
        body: JSON.stringify({ encryptedMetadata }),
      });

      toast.success(t('modals:group_info.toasts.avatar_updated'), { id: toastId });
      setAvatarCropTarget(null);
    } catch (error: unknown) {
      console.error('Avatar upload failed');
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:group_info.toasts.upload_failed', { error: msg }), { id: toastId });
      setAvatarCropTarget(null);
    }
  };

  const handleForceRotateKeys = async () => {
    const toastId = toast.loading('Rotating encryption keys via ML-KEM...');
    try {
      const { forceRotateGroupSenderKey, ensureGroupSession } = await import('@utils/crypto');
      const { emitGroupKeyDistribution } = await import('@lib/socket');
      
      await forceRotateGroupSenderKey(conversation.id);
      
      const distributionKeys = await ensureGroupSession(conversation.id, conversation.participants, true);
      if (distributionKeys) {
          emitGroupKeyDistribution(conversation.id, distributionKeys as { userId: string; key: string }[]);
          toast.success('Encryption keys rotated successfully via ML-KEM', { id: toastId });
      } else {
          throw new Error("Failed to generate new keys");
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(`Key rotation failed: ${msg}`, { id: toastId });
    }
  };

  const handleLeaveGroup = async () => {
    const toastId = toast.loading(t('modals:group_info.toasts.leaving'));
    try {
      await api(`/api/conversations/${conversation.id}/leave`, { method: 'DELETE' });
      toast.success(t('modals:group_info.toasts.left_success'), { id: toastId });
      handleClose(); 
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:group_info.toasts.leave_failed', { error: msg }), { id: toastId });
    }
  };

  const title = conversation.decryptedMetadata?.title || t('common:defaults.group_unknown', 'Unknown Group');
  const avatarSrc = conversation.decryptedMetadata?.avatarUrl 
    ? `${toAbsoluteUrl(conversation.decryptedMetadata.avatarUrl)}?t=${conversation.lastUpdated}` 
    : undefined;

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
          <h2 className="text-xl font-bold text-text-primary">{t('modals:group_info.title')}</h2>
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
                      {avatarSrc ? (
                        <img
                          src={avatarSrc}
                          alt={title}
                          className="w-full h-full rounded-full object-cover bg-bg-primary"
                        />
                      ) : (
                        <DefaultAvatar name={title} id={conversation.id} className="w-full h-full bg-bg-primary" />
                      )}
                      {amIAdmin && (
                        <>
                          <button onClick={() => fileInputRef.current?.click()} className="absolute bottom-0 right-0 bg-accent-gradient rounded-full p-2 text-white hover:opacity-90" aria-label={t('modals:group_info.change_avatar')}>
                            <FiEdit2 size={16} />
                          </button>
                          <input type="file" ref={fileInputRef} onChange={handleAvatarChange} className="hidden" accept="image/*" />
                        </>
                      )}
                    </div>
                    <h3 className="text-2xl font-bold text-text-primary">{title}</h3>
                    <p className="text-text-secondary mt-1">{conversation.decryptedMetadata?.description || t('modals:group_info.no_desc')}</p>
                    {amIAdmin && (
                      <button onClick={() => setIsEditing(true)} className="absolute top-4 right-4 text-text-secondary hover:text-accent-color">
                        <FiEdit2 size={20} />
                      </button>
                    )}
                  </div>

                  {/* Members Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex">
                    <div className="p-6 border-b border-border">
                      <h4 className="text-lg font-semibold text-text-primary">{t('modals:group_info.member_count', { count: conversation.participants.length })}</h4>
                      {amIAdmin && (
                        <button
                          onClick={() => setIsAddParticipantModalOpen(true)}
                          className="w-full flex items-center justify-center p-3 mt-4 rounded-lg text-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                        >
                          <FiPlus className="mr-2" />
                          <span>{t('modals:group_info.add_participants')}</span>
                        </button>
                      )}
                    </div>
                    <ParticipantList conversationId={conversation.id} participants={conversation.participants} amIAdmin={amIAdmin} />
                  </div>

                  {/* Actions Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex flex flex-col">
                    <button
                      onClick={handleForceRotateKeys}
                      className="w-full flex items-center justify-center p-4 font-semibold text-orange-500 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all rounded-t-xl border-b border-border"
                    >
                      <FiLock className="mr-3" />
                      <span>Rotate Encryption Keys Now</span>
                    </button>
                    <button
                      onClick={handleLeaveGroup}
                      className="w-full flex items-center justify-center p-4 font-semibold text-red-500 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all rounded-b-xl"
                    >
                      <FiLogOut className="mr-3" />
                      <span>{t('modals:group_info.leave_group')}</span>
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
            currentTitle={conversation.decryptedMetadata?.title || ''}
            currentDescription={conversation.decryptedMetadata?.description || null}
            onClose={() => setIsEditing(false)}
          />
        )}

        {isAddParticipantModalOpen && (
          <AddParticipantModal
            conversationId={conversation.id}
            onClose={() => setIsAddParticipantModalOpen(false)}
          />
        )}

        {avatarCropTarget && (
          <ImageCropperModal
            file={avatarCropTarget.file}
            url={avatarCropTarget.url}
            aspect={1}
            onClose={() => setAvatarCropTarget(null)}
            onSave={handleUploadCroppedAvatar}
          />
        )}
      </div>
    </div>
  );
};

export default GroupInfoPanel;
