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
import type { Participant, UserId } from '@nyx/shared';
import { asUserId, getParticipantUserId } from '@nyx/shared';
import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useTranslation } from 'react-i18next';

const UserStoryRing = memo(function UserStoryRing({ userId, onClick }: { userId: UserId; onClick: () => void }) {
  const { t } = useTranslation(['common']);
  // Find the actual user object from conversations to get encryptedProfile
  // [P2 NORMALISASI + CONTACT FALLBACK] getParticipantUserId (dulu p.id buta —
  // bentuk userId terlewat) + fallback ContactRecord dari contact store bila
  // conversation cache sudah tidak memuat participant ini.
  const user = useConversationStore(state => {
    for (const c of state.conversations) {
      if (!c.isGroup) {
        const p = c.participants.find(p => getParticipantUserId(p) === String(userId));
        if (p) return p;
      }
    }
    return { id: userId, encryptedProfile: null } as Participant;
  });

  const [contactFallback, setContactFallback] = useState<{ id: string; encryptedProfile?: string | null } | null>(null);
  useEffect(() => {
    if (user.encryptedProfile) return; // conversation cache cukup
    let cancelled = false;
    import('@lib/contactStore').then(({ getContact }) => getContact(String(userId))).then(rec => {
      if (!cancelled && rec?.encryptedProfile) setContactFallback({ id: rec.userId, encryptedProfile: rec.encryptedProfile });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId, user.encryptedProfile]);
  const profile = useUserProfile(
    (user.encryptedProfile ? user : (contactFallback ?? user)) as { id: string; encryptedProfile?: string | null }
  );
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
        hasUnseen ? "bg-gradient-to-tr from-accent to-orange-400" : "bg-black/10 dark:bg-white/10"
      )}>
        <div className="w-full h-full rounded-full border-2 border-bg-main overflow-hidden bg-bg-main">
          {profile.avatarUrl ? (
            <img 
              src={toAbsoluteUrl(profile.avatarUrl)} 
              alt={profile.name || t('common:defaults.user')} 
              className="w-full h-full object-cover" 
            />
          ) : (
            <DefaultAvatar name={profile.name || t('common:defaults.user')} id={userId} className="w-full h-full" />
          )}
        </div>
      </div>
      <span className="text-[10px] font-medium text-text-secondary truncate w-full text-center">
        {profile.name?.split(' ')[0] || t('common:defaults.user')}
      </span>
    </button>
  );
});

export default function StoryTray() {
  const { t } = useTranslation(['chat', 'common']);
  const { conversations } = useConversationStore(useShallow(s => ({ conversations: s.conversations })));
  const { user: me } = useAuthStore(useShallow(s => ({ user: s.user })));
  const { fetchActiveStories, stories } = useStoryStore(useShallow(s => ({ fetchActiveStories: s.fetchActiveStories, stories: s.stories })));
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingUserId, setViewingUserId] = useState<UserId | null>(null);

  useEffect(() => {
    if (!me) return;
    fetchActiveStories(me.id);
    
    const userIds = new Set<UserId>();
    // [P3 2026-10-05] Normalisasi via getParticipantUserId (bukan p.id buta)
    // + JANGAN fetch story peer yang diblokir — dulu blocked user tetap
    // muncul di tray (audit temuan #6 sisi tampilan).
    const blocked = new Set(useAuthStore.getState().blockedUserIds);
    conversations.forEach(c => {
      if (!c.isGroup) {
        const other = c.participants.find(p => getParticipantUserId(p) !== me.id);
        if (other) {
          const uid = getParticipantUserId(other);
          if (uid && !blocked.has(uid)) userIds.add(asUserId(uid));
        }
      }
    });

    // [CONTACT STORE 2026-10-05] Peer 1:1 yang kontaknya masih ada tapi
    // conversation cache hilang/terhapus → story-nya tetap ditampilkan.
    import('@lib/contactStore').then(({ getActiveContacts }) => getActiveContacts()).then(contacts => {
      for (const c of contacts) {
        if (c.conversationId && c.userId !== String(me.id)) userIds.add(asUserId(c.userId));
        else if (!c.conversationId) userIds.add(asUserId(c.userId));
      }
      userIds.forEach(id => {
        fetchActiveStories(id);
      });
    }).catch(() => {
      userIds.forEach(id => {
        fetchActiveStories(id);
      });
    });
  }, [conversations, me, fetchActiveStories]);

  const usersWithStories = Object.keys(stories).filter(id => id !== me?.id && stories[id] && stories[id].length > 0) as UserId[];

  const myProfile = useUserProfile(me);
  const myStories = me ? (stories[me.id] || []) : [];

  return (
    <>
      <div className="w-full overflow-x-auto no-scrollbar py-4 px-4 border-b border-text-secondary/10 bg-bg-main">
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
                  {myProfile.avatarUrl ? (
                    <img 
                      src={toAbsoluteUrl(myProfile.avatarUrl)} 
                      alt={t('chat:stories.your_story')} 
                      className={clsx("w-full h-full object-cover transition-all", myStories.length === 0 && "opacity-80")} 
                    />
                  ) : (
                    <DefaultAvatar name={myProfile.name || t('common:defaults.me')} id={me?.id} className={clsx("w-full h-full transition-all", myStories.length === 0 && "opacity-80")} />
                  )}
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
              {t('chat:stories.your_story')}
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
