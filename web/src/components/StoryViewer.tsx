import { useState, useEffect, useRef } from 'react';
import { useStoryStore } from '@store/story';
import { useAuthStore } from '@store/auth';
import { useUserProfile } from '@hooks/useUserProfile';
import { FiX, FiSend, FiChevronLeft, FiChevronRight, FiTrash2 } from 'react-icons/fi';
import { toAbsoluteUrl } from '@utils/url';
import { useMessageStore } from '@store/message';
import { useConversationStore } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { api } from '@lib/api';
import toast from 'react-hot-toast';

export default function StoryViewer({ userId, onClose, onReply }: { userId: string; onClose: () => void, onReply?: (text: string) => void }) {
  const stories = useStoryStore(state => state.stories[userId] || []);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const { user: me } = useAuthStore(state => ({ user: state.user }));
  const profile = useUserProfile({ id: userId } as any);
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);

  const currentStory = stories[currentIndex];
  const isMe = me?.id === userId;

  useEffect(() => {
    if (!currentStory) return;
    
    // Auto advance progress
    if (isPaused) return;
    
    const interval = setInterval(() => {
      setProgress(p => {
        if (p >= 100) {
          if (currentIndex < stories.length - 1) {
            setCurrentIndex(idx => idx + 1);
            return 0;
          } else {
            onClose();
            return 100;
          }
        }
        return p + 2; // Roughly 5 seconds total (100 / 2 * 100ms)
      });
    }, 100);

    return () => clearInterval(interval);
  }, [currentIndex, isPaused, stories.length, onClose, currentStory]);

  useEffect(() => {
    // Load decrypted media if available
    let isActive = true;
    const loadMedia = async () => {
      if (currentStory?.decryptedData?.mediaUrl && currentStory.decryptedData.fileKey) {
        try {
          const res = await fetch(currentStory.decryptedData.mediaUrl);
          const encryptedBlob = await res.blob();
          const decryptedBlob = await decryptFile(encryptedBlob, currentStory.decryptedData.fileKey, currentStory.decryptedData.mimeType || 'application/octet-stream');
          if (isActive) {
            setMediaBlobUrl(URL.createObjectURL(decryptedBlob));
          }
        } catch (e) {
          console.error("Failed to load story media", e);
        }
      }
    };
    
    setMediaBlobUrl(null);
    setProgress(0);
    loadMedia();

    return () => {
      isActive = false;
      if (mediaBlobUrl) URL.revokeObjectURL(mediaBlobUrl);
    };
  }, [currentIndex, currentStory]);

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

  const [replyText, setReplyText] = useState('');
  const handleSendReply = async () => {
    if (!replyText.trim() || isMe) return;
    
    const conversation = useConversationStore.getState().conversations.find(
        c => !c.isGroup && c.participants.some(p => p.id === userId)
    );

    if (conversation) {
        await useMessageStore.getState().sendMessage(conversation.id, {
            content: `Replying to story: ${replyText}`,
        });
        toast.success("Reply sent!");
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
      toast.success("Story deleted");
      if (stories.length <= 1) onClose();
      else handleNext();
    } catch (e) {
      toast.error("Failed to delete story");
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col" onPointerDown={() => setIsPaused(true)} onPointerUp={() => setIsPaused(false)}>
      
      {/* Progress Bars */}
      <div className="absolute top-2 left-0 right-0 px-2 flex gap-1 z-20">
        {stories.map((s, idx) => (
          <div key={s.id} className="h-1 flex-1 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-white transition-all duration-100 ease-linear"
              style={{ width: `${idx < currentIndex ? 100 : idx === currentIndex ? progress : 0}%` }}
            />
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="absolute top-6 left-0 right-0 px-4 flex justify-between items-center z-20 bg-gradient-to-b from-black/60 to-transparent pb-4">
        <div className="flex items-center gap-2">
          <img src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`} alt="avatar" className="w-8 h-8 rounded-full border border-white/20" />
          <div>
            <p className="text-white text-sm font-bold shadow-sm">{profile.name}</p>
            <p className="text-white/60 text-[10px]">{new Date(currentStory.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isMe && (
            <button onClick={handleDelete} className="p-2 text-white/80 hover:text-red-500 transition-colors">
              <FiTrash2 size={20} />
            </button>
          )}
          <button onClick={onClose} className="p-2 text-white/80 hover:text-white transition-colors">
            <FiX size={24} />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 relative flex items-center justify-center bg-stone-900 overflow-hidden">
        {/* Navigation Overlays */}
        <div className="absolute inset-y-0 left-0 w-1/3 z-10 cursor-pointer" onClick={handlePrev} />
        <div className="absolute inset-y-0 right-0 w-1/3 z-10 cursor-pointer" onClick={handleNext} />

        {currentStory.decryptedData ? (
          <>
            {mediaBlobUrl ? (
              currentStory.decryptedData.mimeType?.startsWith('video/') ? (
                 <video src={mediaBlobUrl} autoPlay playsInline loop className="w-full h-full object-contain" />
              ) : (
                 <img src={mediaBlobUrl} alt="Story" className="w-full h-full object-contain" />
              )
            ) : currentStory.decryptedData.mediaUrl ? (
              <div className="animate-pulse w-16 h-16 rounded-full bg-white/10" />
            ) : null}

            {currentStory.decryptedData.text && (
              <div className="absolute inset-0 flex items-center justify-center p-8 z-0">
                <h2 className="text-white text-3xl font-black text-center drop-shadow-lg leading-snug">
                  {currentStory.decryptedData.text}
                </h2>
              </div>
            )}
          </>
        ) : (
          <div className="text-white/50 text-sm">Decrypting...</div>
        )}
      </div>

      {/* Reply Bar */}
      {!isMe && (
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-20">
           <form 
             onSubmit={(e) => { e.preventDefault(); handleSendReply(); }} 
             className="flex items-center gap-2 max-w-lg mx-auto bg-white/10 backdrop-blur-md rounded-full px-4 py-2 border border-white/20"
           >
             <input 
               type="text" 
               placeholder="Reply..." 
               value={replyText}
               onChange={e => setReplyText(e.target.value)}
               className="flex-1 bg-transparent border-none text-white text-sm focus:outline-none placeholder:text-white/50"
             />
             <button type="submit" disabled={!replyText.trim()} className="text-white p-1 hover:text-accent disabled:opacity-50">
               <FiSend size={18} />
             </button>
           </form>
        </div>
      )}
    </div>
  );
}
