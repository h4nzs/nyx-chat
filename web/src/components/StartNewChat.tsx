import DefaultAvatar from "@/components/ui/DefaultAvatar";
import { useEffect, useState, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useConversationStore } from '@store/conversation';
import { useShallow } from 'zustand/react/shallow';
import toast from 'react-hot-toast';
import { useUserProfile } from '@hooks/useUserProfile';
import { toAbsoluteUrl } from '@utils/url';
import type { UserId, ConversationId } from '@nyx/shared';
import { asUserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

export interface SearchUser {
  id: UserId;
  encryptedProfile?: string | null;
  isVerified?: boolean;
  publicKey?: string;
}

function SearchResultItem({ u, loadingId, onStarted }: { u: SearchUser, loadingId: UserId | null, onStarted: (id: UserId) => void }) {
  const { t } = useTranslation(['common']);
  const profile = useUserProfile(u);
  return (
    <button 
      disabled={loadingId === u.id}
      onClick={() => onStarted(u.id)}
      className={`w-full text-left p-3 rounded-lg transition flex items-center hover:bg-primary/50 disabled:opacity-50`}
    >
      {profile.avatarUrl ? (
        <img src={toAbsoluteUrl(profile.avatarUrl)} alt={profile.name} className="w-10 h-10 rounded-full bg-gray-700 mr-3" />
      ) : (
        <DefaultAvatar name={profile.name} id={u.id} className="w-10 h-10 mr-3 bg-gray-700" />
      )}
      <div className="flex-1 text-left">
        <div className="font-medium text-white">{profile.name}</div>
      </div>
      {loadingId === u.id && <span className="ml-2 text-xs text-text-secondary">{t('actions.starting')}</span>}
    </button>
  );
}

export default function StartNewChat({ query, onStarted }: { query: string; onStarted: (id: ConversationId) => void }) {
  const { t } = useTranslation(['common', 'chat']);
  const [list, setList] = useState<SearchUser[]>([]);
  const [loadingId, setLoadingId] = useState<UserId | null>(null);
  const searchIdRef = useRef(0);
  const { searchUsers, startConversation } = useConversationStore(useShallow(state => ({
    searchUsers: state.searchUsers,
    startConversation: state.startConversation,
  })));

  useEffect(() => {
    if (!query.trim()) {
      setList([]);
      return;
    }
    const tTimer = setTimeout(async () => {
      const currentId = ++searchIdRef.current;
      try {
        const r = await searchUsers(query);
        if (currentId === searchIdRef.current) {
          setList(r.map((u: Record<string, unknown>) => ({ ...u, id: asUserId(u.id as string) })));
        }
      } catch {
        toast.error(t('search.failed'));
      }
    }, 300);
    return () => clearTimeout(tTimer);
  }, [query, searchUsers, t]);

  const handleStart = async (peerId: UserId) => {
    try {
      setLoadingId(peerId);
      const id = await startConversation(peerId);
      onStarted(id);
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : 'Unknown error') || t('connect.failed_start'));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="space-y-1">
      {list.length > 0 ? (
        <Virtuoso
          style={{ height: '400px' }} // Or a more dynamic height
          data={list}
          itemContent={(index, u) => (
            <SearchResultItem key={u.id} u={u} loadingId={loadingId} onStarted={handleStart} />
          )}
        />
      ) : (
        <div className="text-center py-4 text-sm text-text-secondary">{t('search.no_results', { query })}</div>
      )}
    </div>
  );
}
