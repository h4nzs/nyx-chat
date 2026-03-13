import { useEffect, useState, memo } from 'react';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useStoryStore } from '@store/story';
import { useShallow } from 'zustand/react/shallow';
import { FiPlus } from 'react-icons/fi';
import CreateStoryModal from './CreateStoryModal';
import StoryViewer from './StoryViewer';
import { useUserProfile } from '@hooks/useUserProfile';
import { toAbsoluteUrl } from '@utils/url';
import clsx from 'clsx';

const UserStoryRing = memo(function UserStoryRing({ userId, onClick }: { userId: string; onClick: () => void }) {
  // Find the actual user object from conversations to get encryptedProfile
  const user = useConversationStore(state => {
    for (const c of state.conversations) {
      if (!c.isGroup) {
        const p = c.participants.find(p => p.id === userId);
        if (p) return p;
      }
    }
    return { id: userId };
  });

  const profile = useUserProfile(user as any);
  const stories = useStoryStore(state => state.stories[userId] || []);
  
  if (stories.length === 0) return null;

  // Ideally, we'd track "unseen" state, but for now we just show a ring if they have stories.
  const hasUnseen = true;

  return (
    <button 
      onClick={onClick}
      className="flex flex-col items-center gap-1 min-w-[70px] shrink-0 group focus:outline-none"
    >
      <div className={clsx(
        "relative w-14 h-14 rounded-full p-[2px] transition-all duration-300 shadow-neu-flat dark:shadow-neu-flat-dark group-active:scale-95",
        hasUnseen ? "bg-gradient-to-tr from-accent to-orange-400" : "bg-white/10"
      )}>
        <div className="w-full h-full rounded-full border-2 border-bg-main overflow-hidden bg-bg-main">
          <img 
            src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name || 'User'}`} 
            alt="Story" 
            className="w-full h-full object-cover" 
          />
        </div>
      </div>
      <span className="text-[10px] font-medium text-text-secondary truncate w-full text-center">
        {profile.name?.split(' ')[0] || 'User'}
      </span>
    </button>
  );
});

export default function StoryTray() {
  const { conversations } = useConversationStore(useShallow(s => ({ conversations: s.conversations })));
  const { user: me } = useAuthStore(useShallow(s => ({ user: s.user })));
  const { fetchActiveStories, stories } = useStoryStore(useShallow(s => ({ fetchActiveStories: s.fetchActiveStories, stories: s.stories })));
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    // Fetch my own stories
    fetchActiveStories(me.id);
    
    // Extract unique user IDs from 1-on-1 conversations
    const userIds = new Set<string>();
    conversations.forEach(c => {
      if (!c.isGroup) {
        const other = c.participants.find(p => p.id !== me.id);
        if (other) userIds.add(other.id);
      }
    });

    userIds.forEach(id => {
      fetchActiveStories(id);
    });
  }, [conversations, me, fetchActiveStories]);

  const usersWithStories = Object.keys(stories).filter(id => id !== me?.id && stories[id] && stories[id].length > 0);

  const myProfile = useUserProfile(me);
  const myStories = me ? (stories[me.id] || []) : [];

  return (
    <>
      <div className="w-full overflow-x-auto no-scrollbar py-4 px-4 border-b border-white/5 bg-bg-main">
        <div className="flex items-start gap-4">
          
          {/* Add Story Button (Self) */}
          <div className="relative flex flex-col items-center gap-1 min-w-[70px] shrink-0">
            <button 
              onClick={() => myStories.length > 0 ? setViewingUserId(me!.id) : setShowCreateModal(true)}
              className="group focus:outline-none"
            >
              <div className={clsx(
                "relative w-14 h-14 rounded-full p-[2px] transition-all duration-300 shadow-neu-flat dark:shadow-neu-flat-dark group-active:scale-95",
                myStories.length > 0 ? "bg-gradient-to-tr from-text-secondary to-text-secondary/50" : "bg-transparent"
              )}>
                 <div className="w-full h-full rounded-full border-2 border-bg-main overflow-hidden bg-bg-main relative">
                  <img 
                    src={toAbsoluteUrl(myProfile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${myProfile.name || 'Me'}`} 
                    alt="My Story" 
                    className={clsx("w-full h-full object-cover transition-all", myStories.length === 0 && "opacity-80")} 
                  />
                </div>
              </div>
            </button>

            {/* Persistent Plus Button for creating NEW stories */}
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setShowCreateModal(true);
              }}
              className="absolute top-9 right-1 bg-accent text-white rounded-full p-[3px] border-[3px] border-bg-main z-10 hover:scale-110 transition-transform shadow-sm cursor-pointer"
            >
              <FiPlus size={12} strokeWidth={3} />
            </button>

            <span className="text-[10px] font-medium text-text-primary truncate w-full text-center">
              Your Story
            </span>
          </div>

          {/* Friends' Stories */}
          {usersWithStories.map(userId => (
            <UserStoryRing key={userId} userId={userId} onClick={() => setViewingUserId(userId)} />
          ))}
        </div>
      </div>

      {showCreateModal && <CreateStoryModal onClose={() => setShowCreateModal(false)} />}
      
      {viewingUserId && (
        <StoryViewer 
          userId={viewingUserId} 
          onClose={() => setViewingUserId(null)} 
          onReply={(text) => { /* Optional: hook this up directly or handled inside Viewer */ }}
        />
      )}
    </>
  );
}
