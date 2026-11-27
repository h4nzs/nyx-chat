import { useMemo, useState } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import useDynamicIslandStore from '@store/dynamicIsland';
import ModalBase from './ui/ModalBase';
import { useTranslation } from 'react-i18next';
import type { MinimalProfile } from '@nyx/shared';
import { ContactRow, usePickableContacts } from './ContactPicker';
// [2026-10-27] 403 `ADMIN_AUTH_REQUIRED` / 409 dari server = kode mesin.
import { apiErrorTranslator, formatApiOrLocalError } from '@lib/apiErrorText';

/**
 * [2026-11-26] Add Participant memakai contact store, bukan pencarian username.
 * Alasannya keamanan/privasi: pencarian blind-index bisa menemukan orang yang
 * belum pernah berinteraksi; anggota grup seharusnya berasal dari kontak yang
 * sudah ada. Picker yang sama dipakai Create Group.
 */
const AddParticipantModal = ({ conversationId, onClose }: {
  conversationId: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation(['modals', 'common']);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const me = useAuthStore(s => s.user);
  const contacts = usePickableContacts();

  const { conversation } = useConversationStore(useShallow(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  })));

  const existingSet = useMemo(
    () => new Set((conversation?.participants ?? []).map(participant => String(participant.id))),
    [conversation],
  );

  const handleSelectUser = (profile: MinimalProfile) => {
    const userId = String(profile.id);
    if (existingSet.has(userId)) return;

    if (!selectedUserIds.includes(userId)) {
      const maxMembers = me?.subscriptionTier === 'SUBSCRIBER' ? 500 : 100;
      if ((conversation?.participants.length ?? 0) + selectedUserIds.length >= maxMembers) {
        if (me?.subscriptionTier !== 'SUBSCRIBER') {
          useDynamicIslandStore.getState().addActivity({
            type: 'upsell',
            message: `Group limit reached (${maxMembers} max). Upgrade to host 500 members.`,
          }, 5000);
        } else {
          toast.error(t('modals:group_info.toasts.limit_reached', {
            defaultValue: `Group limit reached (${maxMembers} members max).`,
          }));
        }
        return;
      }
    }

    setSelectedUserIds(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId],
    );
  };

  const handleAddParticipants = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedUserIds.length === 0) {
      toast.error(t('modals:add_participant.empty_selection'));
      return;
    }

    setIsLoading(true);
    try {
      const addRecipients = conversation?.participants
        ?.filter(participant => String(participant.id) !== String(me?.id))
        .map(participant => participant.id) ?? [];
      // [T3b] Undangan mengeluarkan satu delivery token per anggota baru.
      const { generateDeliveryToken } = await import('@lib/groupPseudonyms');
      const deliveryTokens: Record<string, string> = {};
      for (const uid of selectedUserIds) deliveryTokens[uid] = await generateDeliveryToken();
      // [26.8.1] Blind auth: add = mutasi grup, wajib X-Group-Token.
      const groupToken = (conversation?.decryptedMetadata as { authSecret?: string } | undefined)?.authSecret;
      if (!groupToken) throw new Error('Group token unavailable (metadata not decrypted)');
      await api(`/api/conversations/${conversationId}/participants`, {
        method: 'POST',
        headers: { 'X-Group-Token': groupToken },
        body: JSON.stringify({
          userIds: selectedUserIds,
          targetRecipients: addRecipients,
          deliveryTokens,
        }),
      });
      // [T4 RACE FIX] Tambah ke store sebelum rotasi: metadata v3 baru harus
      // sudah memuat anggota baru, kalau tidak kunci era baru terenkripsi tanpa dia.
      const { useConversationStore: store } = await import('@store/conversation');
      store.getState().addParticipants(
        conversationId,
        selectedUserIds.map(uid => ({ id: uid as never, name: '', role: 'MEMBER' as const })),
        { deliveryTokens },
      );
      // [T1 FIX] Rotasi aktif untuk anggota baru; anggota lama sudah punya token.
      try {
        const { rotateGroupKey } = await import('@utils/crypto');
        await rotateGroupKey(conversationId, 'membership_change', true, undefined, new Set(selectedUserIds));
      } catch (rotationError) {
        console.warn('[T1] Active rotation after add failed (will retry lazily):', rotationError);
      }
      toast.success(t('modals:add_participant.success'));
      onClose();
    } catch (error: unknown) {
      const message = formatApiOrLocalError(error, apiErrorTranslator(t), t('common:errors.unknown'));
      toast.error(t('modals:add_participant.error', { error: message }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalBase
      isOpen={true}
      onClose={onClose}
      title={t('modals:add_participant.title')}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-secondary text-text-primary hover:bg-secondary/80 transition-colors"
            disabled={isLoading}
          >
            {t('modals:add_participant.cancel')}
          </button>
          <button
            type="submit"
            form="add-participant-form"
            className="px-4 py-2 rounded-md bg-accent text-accent-foreground hover:bg-accent/90 transition-colors"
            disabled={isLoading || selectedUserIds.length === 0}
          >
            {isLoading ? t('modals:add_participant.adding') : t('modals:add_participant.add_selected')}
          </button>
        </>
      )}
    >
      <form id="add-participant-form" onSubmit={handleAddParticipants}>
        <p className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">
          {t('common:contact_picker_title', { count: contacts.length })}
        </p>
        <div className="max-h-60 overflow-y-auto mb-4 border border-border rounded-md">
          {contacts.length > 0 ? (
            contacts.map(contact => {
              const userId = String(contact.userId);
              return (
                <ContactRow
                  key={userId}
                  contact={contact}
                  isExisting={existingSet.has(userId)}
                  isSelected={selectedUserIds.includes(userId)}
                  onSelect={handleSelectUser}
                />
              );
            })
          ) : (
            <p className="p-3 text-sm text-text-secondary">{t('modals:add_participant.no_contacts')}</p>
          )}
        </div>
      </form>
    </ModalBase>
  );
};

export default AddParticipantModal;
