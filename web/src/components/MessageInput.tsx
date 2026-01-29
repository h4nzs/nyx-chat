import { useState, useRef, useEffect, useCallback, ChangeEvent, Suspense, lazy } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiSmile, FiMic, FiSquare, FiAlertTriangle, FiPaperclip, FiSend, FiX } from 'react-icons/fi';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import clsx from 'clsx';
import { useMessageInputStore } from '@store/messageInput';
import { useConnectionStore } from '@store/connection';
import { useAuthStore } from '@store/auth';
import { useThemeStore } from '@store/theme';
import LinkPreviewCard from './LinkPreviewCard';

// --- Types ---
interface MessageInputProps {
  onSend: (data: { content: string }) => void;
  onTyping: () => void;
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onVoiceSend: (blob: Blob, duration: number) => void;
  conversation: any; // Using any to match existing flexibility, ideally Typed
}

// --- Helper: Debounce ---
function debounce<F extends (...args: any[]) => any>(func: F, waitFor: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), waitFor);
  };
}

const ReplyPreview = () => {
  const { replyingTo, setReplyingTo } = useMessageInputStore(state => ({
    replyingTo: state.replyingTo,
    setReplyingTo: state.setReplyingTo,
  }));

  if (!replyingTo) return null;

  const authorName = replyingTo.sender?.name || 'Unknown Signal';
  let contentPreview = '...';
  
  if (replyingTo.duration) contentPreview = '[Voice Transmission]';
  else if (replyingTo.fileName) contentPreview = `[File: ${replyingTo.fileName}]`;
  else if (replyingTo.fileUrl) contentPreview = '[Attachment]';
  else if (replyingTo.content) contentPreview = replyingTo.content;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      className="px-4 pb-2"
    >
      <div className="
        relative flex items-center justify-between
        bg-bg-main rounded-t-xl p-3 border-b border-accent/20
        shadow-neumorphic-concave
      ">
        <div className="flex flex-col border-l-2 border-accent pl-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">Replying to {authorName}</span>
          <span className="text-xs text-text-secondary truncate max-w-[200px]">{contentPreview}</span>
        </div>
        <button
          onClick={() => setReplyingTo(null)}
          className="p-1 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors"
        >
          <FiX size={14} />
        </button>
      </div>
    </motion.div>
  );
};

export default function MessageInput({ onSend, onTyping, onFileChange, onVoiceSend, conversation }: MessageInputProps) {
  const [text, setText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  
  const { typingLinkPreview, fetchTypingLinkPreview, clearTypingLinkPreview } = useMessageInputStore();
  const { status: connectionStatus } = useConnectionStore();
  const blockedUserIds = useAuthStore(state => state.blockedUserIds);
  const theme = useThemeStore(state => state.theme);

  // Voice State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingTimeRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Permissions & Logic
  const isOneToOne = !conversation.isGroup;
  const otherParticipant = isOneToOne && conversation.participants?.find((p: any) => p.id !== useAuthStore.getState().user?.id);
  const isOtherParticipantBlocked = isOneToOne && otherParticipant && blockedUserIds.includes(otherParticipant.id);
  const isConnected = connectionStatus === 'connected';
  const hasText = text.trim().length > 0;
  const isInputDisabled = !isConnected || isOtherParticipantBlocked;

  // Debounced Link Preview
  const debouncedFetchPreview = useCallback(
    debounce((inputText: string) => fetchTypingLinkPreview(inputText), 500),
    [fetchTypingLinkPreview]
  );

  // Close Emoji Picker on Click Outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // --- Handlers ---

  const handleTextChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    setText(newText);
    if (isConnected) {
      onTyping();
      debouncedFetchPreview(newText);
    }
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setText(prev => prev + emojiData.emoji);
    setShowEmojiPicker(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasText || !isConnected) return;
    onSend({ content: text });
    setText('');
    clearTypingLinkPreview();
  };

  const handleStartRecording = async () => {
    if (!isConnected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        onVoiceSend(audioBlob, recordingTimeRef.current);
        stream.getTracks().forEach(track => track.stop());
        setRecordingTime(0);
        recordingTimeRef.current = 0;
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => {
          const newTime = prev + 1;
          recordingTimeRef.current = newTime;
          return newTime;
        });
      }, 1000);
    } catch (error) {
      console.error("Mic access denied:", error);
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  // --- Render ---

  return (
    <div className="
      p-4 bg-bg-surface 
      shadow-neumorphic-convex
      z-20 relative
    ">
      {/* Previews Stack */}
      <div className="absolute bottom-full left-0 w-full px-4">
        <ReplyPreview />
        {typingLinkPreview && (
          <div className="mb-2">
            <LinkPreviewCard preview={typingLinkPreview} />
          </div>
        )}
      </div>

      {/* Emoji Picker Popover */}
      {showEmojiPicker && (
        <div ref={emojiPickerRef} className="absolute bottom-24 left-4 z-50 shadow-2xl rounded-xl overflow-hidden">
          <Suspense fallback={<div className="w-[350px] h-[450px] bg-bg-surface flex items-center justify-center text-text-secondary">Loading Emojis...</div>}>
            <EmojiPicker
              onEmojiClick={handleEmojiClick}
              autoFocusSearch={false}
              lazyLoadEmojis={true}
              theme={theme as any}
            />
          </Suspense>
        </div>
      )}

      {/* Input Module */}
      {isOtherParticipantBlocked ? (
        <div className="flex items-center justify-between p-4 bg-red-500/10 rounded-xl border border-red-500/20">
          <div className="flex items-center gap-3 text-red-500">
            <FiAlertTriangle size={20} />
            <span className="font-bold text-sm">TRANSMISSION BLOCKED</span>
          </div>
          <button
             onClick={() => useAuthStore.getState().unblockUser(otherParticipant.id)}
             className="text-xs font-mono uppercase bg-red-500 text-white px-3 py-1.5 rounded-lg shadow-sm hover:bg-red-600"
          >
            Unblock Signal
          </button>
        </div>
      ) : isRecording ? (
        // Voice Recording Mode
        <div className="flex items-center gap-4 animate-fade-in">
          <button 
            onClick={handleStopRecording} 
            className="
              p-3 rounded-full bg-red-500 text-white 
              shadow-[0_0_15px_rgba(239,68,68,0.5)]
              hover:scale-110 active:scale-95 transition-all
            "
          >
             <FiSquare fill="currentColor" size={20} />
          </button>
          <div className="flex-1 bg-bg-main shadow-neumorphic-concave rounded-full h-12 flex items-center px-6 gap-3">
             <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_red]"></div>
             <span className="font-mono text-lg text-text-primary tracking-widest">
                {new Date(recordingTime * 1000).toISOString().substr(14, 5)}
             </span>
             <span className="text-xs text-text-secondary uppercase tracking-wider ml-auto">Recording Audio Feed...</span>
          </div>
        </div>
      ) : (
        // Text Input Mode
        <form onSubmit={handleSubmit} className="flex items-center gap-3">
          
          {/* Action Buttons (Left) */}
          <div className="flex items-center gap-2">
            <button 
              type="button" 
              onClick={() => fileInputRef.current?.click()} 
              disabled={isInputDisabled}
              aria-label="Attach file"
              className="
                p-3 rounded-full text-text-secondary
                shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm
                hover:text-accent transition-all
              "
            >
              <FiPaperclip size={20} />
            </button>
            <button 
              type="button" 
              onClick={() => setShowEmojiPicker(!showEmojiPicker)} 
              disabled={isInputDisabled}
              aria-label="Insert emoji"
              className="
                p-3 rounded-full text-text-secondary
                shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm
                hover:text-yellow-500 transition-all
              "
            >
              <FiSmile size={20} />
            </button>
          </div>

          <input type="file" ref={fileInputRef} className="hidden" onChange={onFileChange} disabled={isInputDisabled} />

          {/* Main Transmission Slot */}
          <div className="flex-1 relative group">
            <input
              type="text"
              value={text}
              onChange={handleTextChange}
              disabled={isInputDisabled}
              aria-label="Message text"
              placeholder={isConnected ? "Type a message..." : "Connection Lost"}
              className="
                w-full h-12 px-6 rounded-full
                bg-bg-main text-text-primary font-medium
                shadow-neumorphic-concave
                focus:ring-2 focus:ring-accent/50 focus:shadow-none
                outline-none transition-all
                placeholder:text-text-secondary/40
              "
            />
          </div>

          {/* Send / Mic Button */}
          {hasText ? (
             <button
              type="submit"
              disabled={isInputDisabled}
              aria-label="Send message"
              className="
                p-3 rounded-full bg-accent text-white
                shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm
                hover:scale-105 active:scale-95 transition-all
              "
             >
               <FiSend size={20} className={hasText ? 'translate-x-0.5' : ''} />
             </button>
          ) : (
             <button
              type="button"
              onClick={handleStartRecording}
              disabled={isInputDisabled}
              aria-label="Record voice message"
              className="
                p-3 rounded-full text-text-secondary
                shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm
                hover:text-red-500 transition-all
              "
             >
               <FiMic size={20} />
             </button>
          )}

        </form>
      )}
    </div>
  );
}
