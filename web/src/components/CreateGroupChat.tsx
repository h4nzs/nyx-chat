import { useState, useEffect } from 'react';
import { useConversationStore, type Conversation } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { authFetch } from '@lib/api';
import { toAbsoluteUrl } from '@utils/url';
import { getSocket } from '@lib/socket';
import { hashUsername } from '@lib/crypto-worker-proxy';
import toast from 'react-hot-toast';
import ModalBase from './ui/ModalBase';
import { FiCheck } from 'react-icons/fi';

type UserSearchResult = {
  id: string;
  username: string;
  name: string;
  avatarUrl?: string | null;
};

export default function CreateGroupChat({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<UserSearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [userList, setUserList] = useState<UserSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const me = useAuthStore(s => s.user);
  const { addOrUpdateConversation, openConversation } = useConversationStore(state => ({
    addOrUpdateConversation: state.addOrUpdateConversation,
    openConversation: state.openConversation,
  }));

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setUserList([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const hashedQuery = await hashUsername(searchQuery.trim());
        const safeQuery = encodeURIComponent(hashedQuery);
        const results = await authFetch<UserSearchResult[]>(`/api/users/search?q=${safeQuery}`);
        const selectedIds = selectedUsers.map(u => u.id);
        setUserList(results.filter(u => u.id !== me?.id && !selectedIds.includes(u.id)));
      } catch {
        // Silent fail or show toast? Silent is better for typing.
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, me?.id, selectedUsers]);

  const handleSelectUser = (user: UserSearchResult) => {
    setSelectedUsers(prev => [...prev, user]);
    setSearchQuery('');
  };

  const handleRemoveUser = (userId: string) => {
    setSelectedUsers(prev => prev.filter(u => u.id !== userId));
  };

  const handleCreateGroup = async () => {
    if (!title.trim() || selectedUsers.length === 0) {
      return toast.error("Group name and at least one member are required.");
    }
        setLoading(true);
        try {      const newConversation = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          userIds: selectedUsers.map(u => u.id),
          isGroup: true,
        }),
      });

      // Join the socket room for real-time updates
      getSocket().emit("conversation:join", newConversation.id);

      addOrUpdateConversation(newConversation);
      openConversation(newConversation.id);

      toast.success(`Group "${newConversation.title}" created!`);
      onClose();

    } catch (error: unknown) {
      if (error instanceof Error) {
        toast.error(`Failed to create group: ${error.message}`);
      } else {
        toast.error("An unknown error occurred while creating the group.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBase
      isOpen={true}
      onClose={onClose}
      title="Create New Group"
      footer={(
        <>
          <button onClick={onClose} disabled={loading} className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
            Cancel
          </button>
          <button onClick={handleCreateGroup} disabled={loading || !title.trim() || selectedUsers.length === 0} className="px-4 py-2 rounded-lg bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
            {loading ? 'Creating...' : 'Create Group'}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <input
          type="text"
          placeholder="Group Name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full input-neumorphic mb-4"
        />

        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search users to add..."
            className="w-full input-neumorphic"
          />
          {userList.length > 0 && (
            <div className="absolute top-full left-0 right-0 max-h-60 overflow-y-auto z-10 rounded-xl p-2 space-y-2 bg-bg-main/50 backdrop-blur-md shadow-neu-flat dark:shadow-neu-flat-dark border border-white/10 mt-2">
              {userList.map(user => {
                const isSelected = selectedUsers.some(u => u.id === user.id);
                return (
                  <div 
                    key={user.id}
                    onClick={() => handleSelectUser(user)}
                    className={`
                      relative flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-all duration-300
                      border border-transparent
                      bg-bg-main shadow-[5px_5px_10px_rgba(0,0,0,0.1),-5px_-5px_10px_rgba(255,255,255,0.8)] dark:shadow-[4px_4px_8px_rgba(0,0,0,0.4),-4px_-4px_8px_rgba(255,255,255,0.03)] hover:-translate-y-0.5
                    `}
                  >
                    <div className="relative">
                      <img 
                        src={user.avatarUrl ? toAbsoluteUrl(user.avatarUrl) : `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`} 
                        className={`w-10 h-10 rounded-full object-cover transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`}
                        alt={user.name}
                      />
                      <div className={`
                        absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300
                        ${isSelected ? 'bg-accent scale-100 shadow-[0_0_10px_rgba(var(--accent),0.6)]' : 'bg-transparent scale-0'}
                      `}>
                        <FiCheck size={10} className="text-white" />
                      </div>
                    </div>

                    <div className="flex-1">
                      <h4 className={`text-sm font-bold transition-colors ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                        {user.name}
                      </h4>
                      <p className="text-xs text-text-secondary font-mono">@{user.username}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 min-h-[40px]">
          {selectedUsers.map(user => (
            <div key={user.id} className="flex items-center bg-accent text-accent-foreground rounded-full px-3 py-1 text-sm font-medium">
              <span>{user.name}</span>
              <button onClick={() => handleRemoveUser(user.id)} className="ml-2 text-accent-foreground/70 hover:text-accent-foreground font-bold">
                &times;
              </button>
            </div>
          ))}
        </div>
      </div>
    </ModalBase>
  );
}