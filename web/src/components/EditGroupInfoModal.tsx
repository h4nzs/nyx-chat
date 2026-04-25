import { useState } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { Spinner } from './Spinner';
import ModalBase from './ui/ModalBase';
import type { ConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

interface EditGroupInfoModalProps {
  conversationId: ConversationId;
  currentTitle: string;
  currentDescription: string | null;
  onClose: () => void;
}

export default function EditGroupInfoModal({ conversationId, currentTitle, currentDescription, onClose }: EditGroupInfoModalProps) {
  const { t } = useTranslation(['modals', 'common']);
  const [title, setTitle] = useState(currentTitle);
  const [description, setDescription] = useState(currentDescription || '');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const { encryptGroupMetadata, ensureGroupSession } = await import('@utils/crypto');
      const { useConversationStore } = await import('@store/conversation');
      const { emitGroupKeyDistribution } = await import('@lib/socket');
      
      const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
      if (!conversation) throw new Error("Conversation not found");

      // Ensure session exists
      const distributionKeys = await ensureGroupSession(conversationId, conversation.participants);
      if (distributionKeys && distributionKeys.length > 0) {
        emitGroupKeyDistribution(conversationId, distributionKeys as { userId: string; key: string }[]);
      }

      const currentMetadata = conversation.decryptedMetadata || {};
      
      const newMetadata = {
          ...currentMetadata,
          title: title.trim(),
          description: description.trim()
      };
      
      const encryptedMetadata = await encryptGroupMetadata(newMetadata, conversationId);

      await api(`/api/conversations/${conversationId}/details`, {
        method: 'PUT',
        body: JSON.stringify({ encryptedMetadata }),
      });
      toast.success(t('modals:edit_group.success'));
      onClose();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      toast.error(t('modals:edit_group.error', { error: msg }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalBase
      isOpen={true}
      onClose={onClose}
      title={t('modals:edit_group.title')}
      footer={(
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-text-primary bg-secondary hover:bg-secondary/80">
             {t('common:actions.cancel')}
          </button>
          <button type="submit" form="edit-group-form" disabled={isLoading} className="btn btn-primary">
            {isLoading && <Spinner size="sm" className="mr-2" />} 
            {t('modals:edit_group.save')}
          </button>
        </>
      )}
    >
      <form id="edit-group-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="group-title" className="block text-sm font-medium text-text-secondary mb-1">{t('modals:edit_group.group_name')}</label>
            <input
              id="group-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full p-2 rounded-md bg-bg-surface focus:outline-none focus:ring-2 focus:ring-accent shadow-neumorphic-concave"
            />
        </div>
        <div>
          <label htmlFor="group-description" className="block text-sm font-medium text-text-secondary mb-1">{t('modals:edit_group.description')}</label>
          <textarea
            id="group-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full p-2 bg-background border border-border rounded-md text-text-primary"
          />
        </div>
      </form>
    </ModalBase>
  );
}
