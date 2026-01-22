import { useState, useEffect } from 'react';
import { useConversationStore, type Conversation } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { authFetch } from '@lib/api';
import { getSocket } from '@lib/socket';
import toast from 'react-hot-toast';
import ModalBase from './ui/ModalBase';

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
        const results = await authFetch<UserSearchResult[]>(`/api/users/search?q=${searchQuery}`);
        const selectedIds = selectedUsers.map(u => u.id);
        setUserList(results.filter(u => u.id !== me?.id && !selectedIds.includes(u.id)));
      } catch {
        toast.error("Failed to search users.");
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
            <div className="absolute top-full left-0 right-0 card-neumorphic max-h-40 overflow-y-auto z-10 rounded-b-xl">
              {userList.map(user => (
                <div key={user.id} onClick={() => handleSelectUser(user)} className="p-3 hover:bg-secondary cursor-pointer text-text-primary rounded-lg m-1">
                  {user.name} (@{user.username})
                </div>
              ))}
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