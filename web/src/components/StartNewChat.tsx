import { useEffect, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useConversationStore } from '@store/conversation';
import toast from 'react-hot-toast';
import { useUserProfile } from '@hooks/useUserProfile';
import { toAbsoluteUrl } from '@utils/url';

function SearchResultItem({ u, loadingId, onStarted }: { u: any, loadingId: string | null, onStarted: (id: string) => void }) {
  const profile = useUserProfile(u);
  return (
    <button 
      disabled={loadingId === u.id}
      onClick={() => onStarted(u.id)}
      className={`w-full text-left p-3 rounded-lg transition flex items-center hover:bg-primary/50 disabled:opacity-50`}
    >
      <img src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`} alt={profile.name} className="w-10 h-10 rounded-full bg-gray-700 mr-3" />
      <div className="flex-1 text-left">
        <div className="font-medium text-white">{profile.name}</div>
      </div>
      {loadingId === u.id && <span className="ml-2 text-xs text-text-secondary">Starting…</span>}
    </button>
  );
}

export default function StartNewChat({ query, onStarted }: { query: string; onStarted: (id: string) => void }) {
  const [list, setList] = useState<{ id: string; encryptedProfile?: string | null; isVerified?: boolean; publicKey?: string }[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const { searchUsers, startConversation } = useConversationStore(state => ({
    searchUsers: state.searchUsers,
    startConversation: state.startConversation,
  }));

  useEffect(() => {
    if (!query.trim()) {
      setList([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await searchUsers(query);
        setList(r);
      } catch {
        toast.error("Failed to search users.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, searchUsers]);

  const handleStart = async (peerId: string) => {
    try {
      setLoadingId(peerId);
      const id = await startConversation(peerId);
      if (id) {
        onStarted(id);
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to start conversation.");
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
        <div className="text-center py-4 text-sm text-text-secondary">No users found for &quot;{query}&quot;</div>
      )}
    </div>
  );
}
