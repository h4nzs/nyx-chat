import { useState, useMemo } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useUserSearch } from '@hooks/useUserSearch';
import { toAbsoluteUrl } from '@utils/url';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import useDynamicIslandStore from '@store/dynamicIsland';
import ModalBase from './ui/ModalBase';
import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useTranslation } from 'react-i18next';

const AddParticipantModal = ({ conversationId, onClose }: {
  conversationId: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation(['modals', 'common']);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const me = useAuthStore(s => s.user);

  const { conversation } = useConversationStore(useShallow(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  })));

  const existingParticipantIds = conversation?.participants.map(p => p.id) || [];
  const existingSet = useMemo(() => new Set<string>(existingParticipantIds.map(id => id as string)), [conversation]);

  // [T4 UX] Pencarian ter-debounce + stale-guard via hook. Hasil TIDAK
  // difilter: anggota grup yang dicari tetap muncul (ditandai "sudah
  // anggota", nonaktif) — dulu disembunyikan sehingga user mengira
  // pencariannya rusak padahal server balas 200 OK.
  const { results: rawResults, isSearching } = useUserSearch(searchTerm);
  const searchResults = useMemo(() => {
    const rawQuery = searchTerm.trim();
    // Optimistic name/username: respons server tidak membawa nama plaintext.
    const knownUsers = useConversationStore.getState().conversations.flatMap(c => c.participants);
    return rawResults.map(u => {
      const known = knownUsers.find(k => k.id === u.id);
      if (known?.name && known.name !== 'Unknown') {
        return { ...u, name: known.name, username: known.username || rawQuery };
      }
      return { ...u, username: rawQuery, name: rawQuery };
    });
  }, [rawResults, searchTerm]);

  const handleSelectUser = (userId: string) => {
    if (!selectedUserIds.includes(userId)) {
      const maxMembers = me?.subscriptionTier === 'SUBSCRIBER' ? 500 : 100;
      if (existingParticipantIds.length + selectedUserIds.length >= maxMembers) {
        if (me?.subscriptionTier !== 'SUBSCRIBER') {
          useDynamicIslandStore.getState().addActivity({
            type: 'upsell',
            message: `Group limit reached (${maxMembers} max). Upgrade to host 500 members.`
          }, 5000);
        } else {
          toast.error(t('modals:group_info.toasts.limit_reached', { defaultValue: `Group limit reached (${maxMembers} members max).` }));
        }
        return;
      }
    }
    
    setSelectedUserIds(prev => 
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
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
      // Notify existing members about new participants
      const addRecipients = conversation?.participants?.filter(p => p.id !== me?.id)?.map(p => p.id) || [];
      // [T3b] Inviter issues one delivery token per new member — server stores
      // (conversation, token) rows for blinded discovery.
      const { generateDeliveryToken } = await import('@lib/groupPseudonyms');
      const deliveryTokens: Record<string, string> = {};
      for (const uid of selectedUserIds) deliveryTokens[uid] = await generateDeliveryToken();
      // [26.8.1] Blind auth: add = mutasi grup, wajib X-Group-Token.
      const groupToken = (conversation?.decryptedMetadata as { authSecret?: string } | undefined)?.authSecret;
      if (!groupToken) throw new Error('Group token unavailable (metadata not decrypted)');
      await api(`/api/conversations/${conversationId}/participants`, {
        method: 'POST',
        headers: { 'X-Group-Token': groupToken },
        body: JSON.stringify({ userIds: selectedUserIds, targetRecipients: addRecipients, deliveryTokens }),
      });
      // [T4 RACE FIX] Tambah ke store SEKARANG (jangan tunggu event socket):
      // rotateGroupKey di bawah membaca participants store — kalau member baru
      // belum ada di store saat rotasi, metadata v3 baru terenkripsi TANPA dia
      // (bug: member baru tak pernah masuk roster; kick ulang jadi ambigu).
      const { useConversationStore } = await import('@store/conversation');
      useConversationStore.getState().addParticipants(
        conversationId,
        selectedUserIds.map(uid => ({ id: uid as never, name: '', role: 'MEMBER' as const }))
      );
      // [T1 FIX 2026-09-28] Rotasi AKTIF: metadata baru (member baru masuk peta,
      // generation+1) + distribusi kunci era baru SEKARANG — member baru tidak
      // perlu menunggu pesan berikutnya untuk menerima sender key.
      try {
        const { rotateGroupKey } = await import('@utils/crypto');
        await rotateGroupKey(conversationId, 'membership_change', true);
      } catch (rotErr) {
        console.warn('[T1] Active rotation after add failed (will retry lazily):', rotErr);
      }
      toast.success(t('modals:add_participant.success'));
      onClose();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown', 'Unknown error');
      toast.error(t('modals:add_participant.error', { error: msg }));
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
        <div className="mb-4">
          <input
            type="text"
            placeholder={t('modals:add_participant.search_placeholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full p-2 rounded-md bg-background border border-border text-text-primary"
          />
          {isSearching && <p className="text-sm text-text-secondary mt-2">{t('modals:add_participant.searching')}</p>}
          {!isSearching && searchTerm.trim().length > 0 && searchTerm.trim().length < 3 && (
            <p className="text-sm text-text-secondary mt-2">{t('modals:add_participant.min_query')}</p>
          )}
        </div>

        <div className="max-h-60 overflow-y-auto mb-4 border border-border rounded-md">
          {searchResults.length > 0 ? (
            searchResults.map(user => {
              const isExisting = existingSet.has(user.id);
              const isSelected = selectedUserIds.includes(user.id);
              return (
                <div
                  key={user.id}
                  className={`flex items-center justify-between p-2 ${isExisting ? 'opacity-50 cursor-not-allowed' : isSelected ? 'bg-accent/20 cursor-pointer' : 'hover:bg-secondary cursor-pointer'}`}
                  onClick={() => { if (!isExisting) handleSelectUser(user.id); }}
                >
                  <div className="flex items-center gap-3">
                    {user.avatarUrl ? (
                      <img
                        src={toAbsoluteUrl(user.avatarUrl)}
                        alt={user.name}
                        className="w-8 h-8 rounded-full object-cover bg-secondary"
                      />
                    ) : (
                      <DefaultAvatar name={user.name} id={user.id} className="w-8 h-8 bg-secondary" />
                    )}
                    <div>
                      <p className="text-text-primary">{user.name} (@{user.username})</p>
                      {isExisting && <p className="text-xs text-text-secondary">{t('modals:add_participant.already_member')}</p>}
                    </div>
                  </div>
                  {isSelected && (
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  )}
                </div>
              );
            })
          ) : ( searchTerm.trim().length >= 3 && !isSearching &&
            <p className="p-2 text-text-secondary">{t('modals:add_participant.no_users')}</p>
          )}
        </div>
      </form>
    </ModalBase>
  );
};

export default AddParticipantModal;
