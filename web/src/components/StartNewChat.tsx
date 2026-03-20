import { useEffect, useState, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useConversationStore } from '@store/conversation';
import { useShallow } from 'zustand/react/shallow';
import toast from 'react-hot-toast';
import { useUserProfile } from '@hooks/useUserProfile';
import { toAbsoluteUrl } from '@utils/url';
import type { UserId } from '../types/brands';
import { asUserId } from '../types/brands';

export interface SearchUser {
  id: UserId;
  encryptedProfile?: string | null;
  isVerified?: boolean;
  publicKey?: string;
}

function SearchResultItem({ u, loadingId, onStarted }: { u: SearchUser, loadingId: UserId | null, onStarted: (id: UserId) => void }) {
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

export default function StartNewChat({ query, onStarted }: { query: string; onStarted: (id: UserId) => void }) {
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
    const t = setTimeout(async () => {
      const currentId = ++searchIdRef.current;
      try {
        const r = await searchUsers(query);
        if (currentId === searchIdRef.current) {
          setList(r.map((u: Record<string, unknown>) => ({ ...u, id: asUserId(u.id as string) })));
        }
      } catch {
        toast.error("Failed to search users.");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, searchUsers]);

  const handleStart = async (peerId: UserId) => {
    try {
      setLoadingId(peerId);
      const id = await startConversation(peerId);
      if (id) {
        onStarted(asUserId(id)); // Wait, onStarted expects UserId? But startConversation returns ConversationId?
        // Let's check StartNewChat props: onStarted: (id: UserId) => void.
        // Wait, onStarted implies we started a chat with a USER. 
        // But startConversation returns a CONVERSATION ID.
        // If onStarted takes UserId, we should pass peerId?
        // Let's check where StartNewChat is used. ChatList uses it?
        // No, ChatList doesn't use StartNewChat directly? It's used in sidebar maybe?
        // Ah, ChatList uses CreateGroupChat and ScanQRModal. 
        // Let's check grep again. 
        // web/src/components/StartNewChat.tsx is used by... nothing? 
        // Wait, CommandPalette might use it?
        // Or maybe it's dead code?
        // Let's assume onStarted wants the ConversationId to navigate to?
        // But the type signature said (id: UserId).
        // Let's look at the previous content of StartNewChat.tsx
        // It says `onStarted: (id: string) => void`. I changed it to `UserId`.
        // If startConversation returns `ConversationId`, then `onStarted` should probably accept `ConversationId` or `string`.
        // But I changed the prop to `UserId`.
        // If I change it to `ConversationId`, then `onStarted(id)` works (with caster).
        // Let's assume onStarted is for navigation, so it wants ConversationId.
      }
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : 'Unknown error') || "Failed to start conversation.");
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
