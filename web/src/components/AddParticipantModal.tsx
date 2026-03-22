import { useState, useEffect } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { toAbsoluteUrl } from '@utils/url';
import { useConversationStore } from '@store/conversation';
import { useShallow } from 'zustand/react/shallow';
import { hashUsername } from '@lib/crypto-worker-proxy';
import { asUserId } from '@nyx/shared';
import ModalBase from './ui/ModalBase';
import { useTranslation } from 'react-i18next';

interface UserSearchResult {
  id: string;
  username: string;
  name: string;
  avatarUrl?: string | null;
}

const AddParticipantModal = ({ conversationId, onClose }: {
  conversationId: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation(['modals', 'common']);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  const { conversation } = useConversationStore(useShallow(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  })));

  const existingParticipantIds = conversation?.participants.map(p => p.id) || [];

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      const rawQuery = searchTerm.trim();
      if (rawQuery.length > 2) {
        setIsSearching(true);
        try {
          const hashedQuery = await hashUsername(rawQuery);
          const safeQuery = encodeURIComponent(hashedQuery);
          const users = await api<UserSearchResult[]>(`/api/users/search?q=${safeQuery}`);
          
          // Inject optimistic query as username/name since it was an exact hash match
          // Guard: Check known users
          const knownUsers = useConversationStore.getState().conversations.flatMap(c => c.participants);

          const optimisticUsers = users.map(u => {
              const known = knownUsers.find(k => k.id === u.id);
              if (known?.name && known.name !== 'Unknown') {
                  return { ...u, name: known.name, username: known.username || rawQuery };
              }
              return { ...u, username: rawQuery, name: rawQuery };
          });
          
          setSearchResults(optimisticUsers.filter(u => !existingParticipantIds.includes(asUserId(u.id))));
        } catch (error) {
          console.error("Failed to search users:", error);
          setSearchResults([]);
        } finally {
          setIsSearching(false);
        }
      } else {
        setSearchResults([]);
      }
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchTerm, existingParticipantIds]);

  const handleSelectUser = (userId: string) => {
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
      await api(`/api/conversations/${conversationId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ userIds: selectedUserIds }),
      });
      toast.success(t('modals:add_participant.success'));
      onClose();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
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
        </div>

        <div className="max-h-60 overflow-y-auto mb-4 border border-border rounded-md">
          {searchResults.length > 0 ? (
            searchResults.map(user => (
              <div 
                key={user.id} 
                className={`flex items-center justify-between p-2 cursor-pointer ${selectedUserIds.includes(user.id) ? 'bg-accent/20' : 'hover:bg-secondary'}`}
                onClick={() => handleSelectUser(user.id)}
              >
                <div className="flex items-center gap-3">
                  <img
                    src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(user.id)}`}
                    alt={user.name}
                    className="w-8 h-8 rounded-full object-cover bg-secondary"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(user.id)}`;
                    }}
                  />
                  <p className="text-text-primary">{user.name} (@{user.username})</p>
                </div>
                {selectedUserIds.includes(user.id) && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><polyline points="20 6 9 17 4 12"></polyline></svg>
                )}
              </div>
            ))
          ) : ( searchTerm.trim().length > 2 && !isSearching &&
            <p className="p-2 text-text-secondary">{t('modals:add_participant.no_users')}</p>
          )}
        </div>
      </form>
    </ModalBase>
  );
};

export default AddParticipantModal;
