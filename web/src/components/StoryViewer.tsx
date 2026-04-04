import { useState, useEffect, useRef } from 'react';
import { useStoryStore } from '@store/story';
import { useAuthStore } from '@store/auth';
import { useUserProfile } from '@hooks/useUserProfile';
import { FiX, FiSend, FiTrash2 } from 'react-icons/fi';
import { toAbsoluteUrl } from '@utils/url';
import { useMessageStore } from '@store/message';
import { useConversationStore } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import type { UserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';
import DefaultAvatar from '@/components/ui/DefaultAvatar';

// Default durasi untuk Teks/Gambar
const DEFAULT_STORY_DURATION_MS = 5000;
const TICK_RATE_MS = 50;

export default function StoryViewer({ userId, onClose, onReply }: { userId: UserId; onClose: () => void, onReply?: (text: string) => void }) {
  const { t } = useTranslation(['chat']);
  const stories = useStoryStore(state => state.stories[userId] || []);
  const [currentIndex, setCurrentIndex] = useState(0);
  
  // States progress & timer control
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [durationMs, setDurationMs] = useState(DEFAULT_STORY_DURATION_MS);

  const { user: me } = useAuthStore(state => ({ user: state.user }));
  
  // Find the actual user object from conversations to get encryptedProfile
  const targetUser = useConversationStore(state => {
    if (userId === me?.id) return me;
    for (const c of state.conversations) {
      if (!c.isGroup) {
        const p = c.participants.find(p => p.id === userId);
        if (p) return p;
      }
    }
    return { id: userId };
  });

  const profile = useUserProfile(targetUser as unknown as { id: string });
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const mediaBlobUrlRef = useRef<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const currentStory = stories[currentIndex];
  const isMe = me?.id === userId;

  // 1. SIKLUS HIDUP MEDIA (DOWNLOAD & DECRYPT)
  useEffect(() => {
    let isActive = true;
    
    // Reset ke kondisi awal saat pindah story
    setProgress(0);
    setIsMediaReady(false);
    setDurationMs(DEFAULT_STORY_DURATION_MS);

    // Hapus Blob URL sebelumnya untuk cegah memory leak
    if (mediaBlobUrlRef.current) {
        URL.revokeObjectURL(mediaBlobUrlRef.current);
        mediaBlobUrlRef.current = null;
    }
    setMediaBlobUrl(null);

    if (!currentStory) return;

    const loadMedia = async () => {
      // Jika story hanya teks, bisa langsung jalan (ready)
      if (!currentStory.decryptedData?.mediaUrl) {
         if (isActive) setIsMediaReady(true);
         return;
      }

      if (currentStory.decryptedData.fileKey) {
        try {
          const res = await fetch(currentStory.decryptedData.mediaUrl);
          const encryptedBlob = await res.blob();
          const decryptedBlob = await decryptFile(encryptedBlob, currentStory.decryptedData.fileKey, currentStory.decryptedData.mimeType || 'application/octet-stream');
          
          if (isActive) {
            const url = URL.createObjectURL(decryptedBlob);
            mediaBlobUrlRef.current = url;
            setMediaBlobUrl(url);
            
            // Jika gambar, langsung ready. 
            // Jika video, biarkan false sampai onLoadedMetadata di-trigger oleh <video>
            if (!currentStory.decryptedData.mimeType?.startsWith('video/')) {
               setIsMediaReady(true);
            }
          }
        } catch (e) {
          console.error("Failed to load story media", e);
          if (isActive) setIsMediaReady(true); // Paksa jalan agar story tidak membeku selamanya jika error
        }
      }
    };
    
    loadMedia();

    return () => {
      isActive = false;
      if (mediaBlobUrlRef.current) {
        URL.revokeObjectURL(mediaBlobUrlRef.current);
        mediaBlobUrlRef.current = null;
      }
    };
  }, [currentIndex, currentStory]);

  // 2. SIKLUS HIDUP TIMER & PROGRESS BAR
  useEffect(() => {
    // Jangan jalan sebelum media diunduh & didekripsi
    if (!currentStory || !isMediaReady) return;
    
    // Jangan jalan jika user menahan layar atau sedang mengetik balasan
    if (isPaused || isTyping) return;
    
    const interval = setInterval(() => {
      setProgress(prev => {
        // Hitung penambahan proporsional berdasarkan durasi dinamis
        const increment = (TICK_RATE_MS / durationMs) * 100;
        const nextProgress = prev + increment;

        if (nextProgress >= 100) {
          if (currentIndex < stories.length - 1) {
            setCurrentIndex(idx => idx + 1);
            return 0; // Reset ke 0 untuk story berikutnya
          } else {
            onClose();
            return 100; // Batas mentok 100
          }
        }
        return nextProgress;
      });
    }, TICK_RATE_MS);

    return () => clearInterval(interval);
  }, [currentIndex, isPaused, isTyping, isMediaReady, durationMs, stories.length, onClose, currentStory]);

  if (!currentStory) {
    onClose();
    return null;
  }

  const handleNext = () => {
    if (currentIndex < stories.length - 1) {
      setCurrentIndex(i => i + 1);
    } else {
      onClose();
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
    }
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || isMe) return;
    
    const conversation = useConversationStore.getState().conversations.find(
        c => !c.isGroup && c.participants.some(p => p.id === userId)
    );

    if (conversation) {
        const payload = {
          type: 'story_reply',
          text: replyText,
          storyId: currentStory.id,
          storyAuthorId: userId,
          storyText: currentStory.decryptedData?.text || '',
          hasMedia: !!currentStory.decryptedData?.mediaUrl
        };
        
        await useMessageStore.getState().sendMessage(conversation.id, {
            content: JSON.stringify(payload),
        });
        toast.success(t('stories.reply_sent'));
        onClose();
    }
  };

  const handleDelete = async () => {
    try {
      await api(`/api/stories/${currentStory.id}`, { method: 'DELETE' });
      useStoryStore.setState(state => ({
        stories: {
          ...state.stories,
          [userId]: state.stories[userId].filter(s => s.id !== currentStory.id)
        }
      }));
      toast.success(t('stories.story_deleted'));
      if (stories.length <= 1) {
          onClose();
      } else {
          // Tangani navigasi setelah menghapus
          if (currentIndex >= stories.length - 1) {
             setCurrentIndex(Math.max(0, currentIndex - 1));
          } else {
             setProgress(0); // Restart untuk story pengganti di posisi yang sama
          }
      }
    } catch (e) {
      toast.error(t('stories.delete_failed'));
    }
  };

  return (
    <div 
      className="fixed inset-0 z-[100] bg-black flex flex-col" 
      onPointerDown={() => setIsPaused(true)} 
      onPointerUp={() => setIsPaused(false)}
      onPointerLeave={() => setIsPaused(false)}
    >
      {/* Progress Bars */}
      <div className="absolute top-2 left-0 right-0 px-2 flex gap-1 z-20">
        {stories.map((s, idx) => (
          <div key={s.id} className="h-1 flex-1 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-white transition-all duration-75 ease-linear"
              style={{ width: `${idx < currentIndex ? 100 : idx === currentIndex ? progress : 0}%` }}
            />
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="absolute top-6 left-0 right-0 px-4 flex justify-between items-center z-20 bg-gradient-to-b from-black/60 to-transparent pb-4 pt-2 pointer-events-auto">
        <div className="flex items-center gap-2">
          {profile.avatarUrl ? (
            <img src={toAbsoluteUrl(profile.avatarUrl)} alt="avatar" className="w-8 h-8 rounded-full border border-white/20 object-cover" />
          ) : (
            <DefaultAvatar name={profile.name} id={targetUser?.id} className="w-8 h-8 border border-white/20" />
          )}
          <div>
            <p className="text-white text-sm font-bold shadow-sm drop-shadow-md">{profile.name}</p>
            <p className="text-white/80 text-[10px] font-medium drop-shadow-md">{new Date(currentStory.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isMe && (
            <button onClick={handleDelete} className="p-2 text-white/80 hover:text-red-500 transition-colors drop-shadow-md">
              <FiTrash2 size={20} />
            </button>
          )}
          <button onClick={onClose} className="p-2 text-white/80 hover:text-white transition-colors drop-shadow-md">
            <FiX size={24} />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 relative flex items-center justify-center bg-stone-900 overflow-hidden">
        {/* Navigation Overlays */}
        <div className="absolute inset-y-0 left-0 w-1/3 z-10 cursor-pointer" onClick={(e) => { e.stopPropagation(); handlePrev(); }} />
        <div className="absolute inset-y-0 right-0 w-1/3 z-10 cursor-pointer" onClick={(e) => { e.stopPropagation(); handleNext(); }} />

        {currentStory.decryptedData ? (
          <>
            {mediaBlobUrl ? (
              currentStory.decryptedData.mimeType?.startsWith('video/') ? (
                 <video 
                    src={mediaBlobUrl} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-contain" 
                    onLoadedMetadata={(e) => {
                        // Tarik durasi aktual video (e.currentTarget.duration dalam detik)
                        const vidDuration = e.currentTarget.duration;
                        if (vidDuration && vidDuration > 0 && isFinite(vidDuration)) {
                            setDurationMs(vidDuration * 1000);
                        }
                        setIsMediaReady(true);
                    }}
                    onEnded={() => {
                        // Failsafe auto-next ketika pemutar video selesai murni
                        if (!isPaused && !isTyping) handleNext();
                    }}
                 />
              ) : (
                 <img src={mediaBlobUrl} alt="Story" className="w-full h-full object-contain" />
              )
            ) : currentStory.decryptedData.mediaUrl ? (
              // Loading state while decrypting
              <div className="flex flex-col items-center justify-center gap-3">
                 <div className="animate-spin w-8 h-8 border-4 border-white/20 border-t-white rounded-full" />
                 <span className="text-white/60 text-xs font-medium uppercase tracking-wider">{t('media.decrypting', 'Decrypting...')}</span>
              </div>
            ) : null}

            {currentStory.decryptedData.text && (
              <div className={
                currentStory.decryptedData.mediaUrl
                  ? "absolute bottom-16 left-0 right-0 p-6 flex justify-center items-end bg-gradient-to-t from-black/80 via-black/40 to-transparent z-10 pt-16 pointer-events-none"
                  : "absolute inset-0 flex items-center justify-center p-8 z-0 pointer-events-none"
              }>
                <h2 className={
                  currentStory.decryptedData.mediaUrl
                    ? "text-white text-base md:text-lg font-medium text-center drop-shadow-md leading-relaxed mb-2"
                    : "text-white text-3xl font-black text-center drop-shadow-lg leading-snug"
                }>
                  {currentStory.decryptedData.text}
                </h2>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3">
             <div className="animate-spin w-8 h-8 border-4 border-white/20 border-t-white rounded-full" />
             <span className="text-white/60 text-xs font-medium uppercase tracking-wider">{t('media.decrypting', 'Decrypting...')}</span>
          </div>
        )}
      </div>

      {/* Reply Bar */}
      {!isMe && (
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-20 pointer-events-auto">
           <form 
             onSubmit={(e) => { 
               e.preventDefault(); 
               handleSendReply(); 
               setIsTyping(false);
             }} 
             className="flex items-center gap-2 max-w-lg mx-auto bg-black/40 backdrop-blur-xl rounded-full px-4 py-2 border border-white/10 shadow-lg"
             // Hindari pause saat user memencet area ketik
             onPointerDown={(e) => e.stopPropagation()}
           >
             <input 
               type="text" 
               placeholder={t('stories.reply_placeholder', 'Reply to story...')} 
               value={replyText}
               onChange={e => setReplyText(e.target.value)}
               onFocus={() => setIsTyping(true)}
               onBlur={() => setIsTyping(false)}
               className="flex-1 bg-transparent border-none text-white text-sm focus:outline-none placeholder:text-white/60"
             />
             <button type="submit" disabled={!replyText.trim()} className="text-white p-1.5 hover:text-accent hover:scale-110 active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100">
               <FiSend size={18} />
             </button>
           </form>
        </div>
      )}
    </div>
  );
}
