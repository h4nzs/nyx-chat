import { useState, useRef, useEffect, useCallback, ChangeEvent, Suspense, lazy } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiSmile, FiMic, FiAlertTriangle, FiPaperclip, FiSend, FiX, FiClock, FiPlus, FiEye, FiTrash2, FiEdit2, FiCpu, FiVolumeX, FiCrop } from 'react-icons/fi';
import EmojiPicker, { EmojiClickData, Theme } from 'emoji-picker-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useShallow } from 'zustand/react/shallow';
import { useMessageInputStore } from '@store/messageInput';
import { useConnectionStore } from '@store/connection';
import { useAuthStore } from '@store/auth';
import { useThemeStore } from '@store/theme';
import LinkPreviewCard from './LinkPreviewCard';
import SmartReply from './SmartReply';
import { useMessageStore } from '@store/message';
import { triggerSendFeedback } from '@utils/feedback';
import { useUserProfile } from '@hooks/useUserProfile';
import AttachmentCropperModal from './AttachmentCropperModal';
import ImageEditorModal from './ImageEditorModal';
import { FiEdit3 } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';

// --- Types ---
interface MessageInputProps {
  onSend: (data: { content: string }) => void;
  onTyping: () => void;
  onVoiceSend: (blob: Blob, duration: number) => void;
  conversation: { id: string, isGroup: boolean, participants?: { id: string }[] };
}

// --- Helper: Debounce ---
function debounce<Args extends unknown[]>(func: (...args: Args) => void, waitFor: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), waitFor);
  };
}

const EditPreview = () => {
  const { t } = useTranslation('chat');
  const { editingMessage, setEditingMessage } = useMessageInputStore(useShallow(s => ({ editingMessage: s.editingMessage, setEditingMessage: s.setEditingMessage })));
  if (!editingMessage) return null;
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="px-4 pb-2">
      <div className="relative flex items-center justify-between bg-bg-main rounded-t-xl p-3 border-b border-accent/20 shadow-neumorphic-concave">
        <div className="flex flex-col border-l-2 border-accent pl-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent flex items-center gap-1"><FiEdit2 size={10}/> {t('input.editing')}</span>
          <span className="text-xs text-text-secondary truncate max-w-[200px]">{editingMessage.content}</span>
        </div>
        <button onClick={() => setEditingMessage(null)} className="p-1 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors"><FiX size={14} /></button>
      </div>
    </motion.div>
  );
};

const ReplyPreview = () => {
  const { t } = useTranslation('chat');
  const { replyingTo, setReplyingTo } = useMessageInputStore(useShallow(state => ({
    replyingTo: state.replyingTo,
    setReplyingTo: state.setReplyingTo,
  })));

  const profile = useUserProfile(replyingTo?.sender as { id: string; encryptedProfile?: string | null });
  const currentUser = useAuthStore(state => state.user);

  if (!replyingTo) return null;

  const isMe = replyingTo.senderId === currentUser?.id;
  const authorName = isMe ? t('input.you') : (profile.name || t('input.unknown'));
  let contentPreview = '...';
  
  if (replyingTo.duration) contentPreview = `[${t('input.voice_transmission')}]`;
  else if (replyingTo.fileName) contentPreview = `[${t('input.file_attachment', { fileName: replyingTo.fileName })}]`;
  else if (replyingTo.fileUrl) contentPreview = `[${t('input.attachment')}]`;
  else if (replyingTo.content) contentPreview = replyingTo.content;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      className="px-4 pb-2"
    >
      <div className="relative flex items-center justify-between bg-bg-main rounded-t-xl p-3 border-b border-accent/20 shadow-neumorphic-concave">
        <div className="flex flex-col border-l-2 border-accent pl-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">{t('input.replying_to', { name: authorName })}</span>
          <span className="text-xs text-text-secondary truncate max-w-[200px]">{contentPreview}</span>
        </div>
        <button onClick={() => setReplyingTo(null)} className="p-1 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors">
          <FiX size={14} />
        </button>
      </div>
    </motion.div>
  );
};

export default function MessageInput({ onSend, onTyping, onVoiceSend, conversation }: MessageInputProps) {
  const { t } = useTranslation(['chat', 'common']);
  
  // ✅ SUPER OPTIMIZATION: Uncontrolled Input
  // Hapus `const [text, setText] = useState('')`! Kita gunakan `inputRef` untuk 
  // mengakses DOM secara langsung agar komponen tidak di-render ulang setiap kali mengetik.
  const inputRef = useRef<HTMLInputElement>(null);
  
  // State ini HANYA digunakan untuk mengubah tampilan tombol (Mic ke Send).
  const [hasTextUI, setHasTextUI] = useState(false); 

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showSilentMenu, setShowSilentMenu] = useState(false);

  const DURATIONS = [
    { label: t('chat:input.timer_off', 'Off'), value: null },
    { label: '1m', value: 60 },
    { label: '1h', value: 3600 },
    { label: '24h', value: 86400 },
  ];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const timerMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSendTouchStart = () => {
    longPressTimerRef.current = setTimeout(() => setShowSilentMenu(true), 500);
  };
  const handleSendTouchEnd = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  };
  
  const { 
    typingLinkPreview, fetchTypingLinkPreview, clearTypingLinkPreview, 
    expiresIn, setExpiresIn, isViewOnce, setIsViewOnce,
    stagedFiles, addStagedFiles, removeStagedFile, clearStagedFiles, updateStagedFile,
    isHD, setIsHD,
    isVoiceAnonymized, setIsVoiceAnonymized,
    editingMessage, setEditingMessage, sendEdit
  } = useMessageInputStore(useShallow(s => ({
    typingLinkPreview: s.typingLinkPreview, fetchTypingLinkPreview: s.fetchTypingLinkPreview, clearTypingLinkPreview: s.clearTypingLinkPreview, 
    expiresIn: s.expiresIn, setExpiresIn: s.setExpiresIn, isViewOnce: s.isViewOnce, setIsViewOnce: s.setIsViewOnce,
    stagedFiles: s.stagedFiles, addStagedFiles: s.addStagedFiles, removeStagedFile: s.removeStagedFile, clearStagedFiles: s.clearStagedFiles, updateStagedFile: s.updateStagedFile,
    isHD: s.isHD, setIsHD: s.setIsHD,
    isVoiceAnonymized: s.isVoiceAnonymized, setIsVoiceAnonymized: s.setIsVoiceAnonymized,
    editingMessage: s.editingMessage, setEditingMessage: s.setEditingMessage, sendEdit: s.sendEdit
  })));
  
  const { status: connectionStatus } = useConnectionStore(useShallow(s => ({ status: s.status })));
  const blockedUserIds = useAuthStore(state => state.blockedUserIds);
  const user = useAuthStore(state => state.user);
  const messages = useMessageStore(state => state.messages[conversation.id] || []);
  const theme = useThemeStore(state => state.theme);

  const [cropTarget, setCropTarget] = useState<{ id: string, url: string, file: File } | null>(null);
  const [paintTarget, setPaintTarget] = useState<{ id: string, file: File } | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingTimeRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const shouldSendVoiceRef = useRef<boolean>(true);

  const isOneToOne = !conversation.isGroup;
  const otherParticipant = isOneToOne && (conversation.participants as { id: string }[] | undefined)?.find(p => p.id !== useAuthStore.getState().user?.id);
  const isOtherParticipantBlocked = isOneToOne && otherParticipant && blockedUserIds.includes(otherParticipant.id);
  const isConnected = connectionStatus === 'connected';
  const isInputDisabled = !isConnected || isOtherParticipantBlocked;

  const absoluteLastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const isLastMessageFromOther = absoluteLastMessage?.senderId !== user?.id;
  const isValidTextMessage = absoluteLastMessage && !absoluteLastMessage.fileUrl && !absoluteLastMessage.imageUrl && absoluteLastMessage.content;
  const lastDecryptedText = (isLastMessageFromOther && isValidTextMessage) ? (absoluteLastMessage.content || null) : null;

  // Set nilai awal jika sedang membalas/mengedit
  useEffect(() => {
  if (editingMessage && inputRef.current) {
    inputRef.current.value = editingMessage.content || '';
    setHasTextUI(!!editingMessage.content);
    inputRef.current.focus();
  } else if (inputRef.current) { // ✅ Tambahkan cabang ini
    inputRef.current.value = '';
    setHasTextUI(false);
  }
}, [editingMessage, setHasTextUI]);

  // ✅ SUPER OPTIMIZATION: Debounce untuk emit Socket (Mencegah jaringan tersedak)
  const debouncedTypingSignal = useCallback(
    debounce(() => { if (isConnected) onTyping(); }, 1500),
    [isConnected, onTyping]
  );

  const debouncedFetchPreview = useCallback(
    debounce((inputText: string) => fetchTypingLinkPreview(inputText), 800),
    [fetchTypingLinkPreview]
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) setShowEmojiPicker(false);
      if (timerMenuRef.current && !timerMenuRef.current.contains(event.target as Node)) setShowTimerMenu(false);
      if (plusMenuRef.current && !plusMenuRef.current.contains(event.target as Node)) setShowPlusMenu(false);
      if (sendButtonRef.current && !sendButtonRef.current.contains(event.target as Node)) setShowSilentMenu(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const [filePreviews, setFilePreviews] = useState<Map<string, string>>(new Map());
  const previewsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const currentMap = previewsRef.current;
    let changed = false;
    const activeIds = new Set(stagedFiles.map(sf => sf.id));

    for (const [id, url] of currentMap.entries()) {
        if (!activeIds.has(id)) {
            URL.revokeObjectURL(url);
            currentMap.delete(id);
            changed = true;
        }
    }

    stagedFiles.forEach(sf => {
        if (sf.file.type.startsWith('image/') && !currentMap.has(sf.id)) {
            const url = URL.createObjectURL(sf.file);
            currentMap.set(sf.id, url);
            changed = true;
        }
    });

    if (changed) setFilePreviews(new Map(currentMap));
  }, [stagedFiles]);

  useEffect(() => {
      return () => {
          previewsRef.current.forEach(url => URL.revokeObjectURL(url));
          previewsRef.current.clear();
      };
  }, []);


  // --- Handlers ---

  const handleTextChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    
    // Hanya perbarui UI state jika berubah dari kosong ke ada teks (atau sebaliknya)
    const currentHasText = newText.trim().length > 0;
    if (currentHasText !== hasTextUI) {
      setHasTextUI(currentHasText);
    }

    if (isConnected) {
      debouncedTypingSignal();
      debouncedFetchPreview(newText);
    }
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    if (inputRef.current) {
        inputRef.current.value += emojiData.emoji;
        setHasTextUI(true);
    }
    setShowEmojiPicker(false);
    setShowPlusMenu(false);
  };

  const handleLocalFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFiles = Array.from(e.target.files);
      const validFiles: File[] = [];
      const MAX_FILE_SIZE = 100 * 1024 * 1024;
      const MAX_FILES_PER_MESSAGE = 10;
      const restrictedExtensions = ['.exe', '.sh', '.bat', '.cmd', '.msi', '.vbs', '.js', '.ts', '.html', '.php', '.phtml', '.php5', '.py', '.rb', '.pl', '.jar', '.com', '.scr', '.cpl', '.msc'];

      if (stagedFiles.length + selectedFiles.length > MAX_FILES_PER_MESSAGE) {
        toast.error(t('chat:messages.max_files', { count: MAX_FILES_PER_MESSAGE, defaultValue: `You can only send up to ${MAX_FILES_PER_MESSAGE} files at once.` }));        
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      for (const file of selectedFiles) {
        if (file.size > MAX_FILE_SIZE) {
           toast.error(t('chat:messages.file_too_large', { name: file.name, defaultValue: `"${file.name}" is too large (Max: 100MB)` }));
           continue;
        }
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (restrictedExtensions.includes(ext)) {
           toast.error(t('chat:messages.file_restricted', { name: file.name, defaultValue: `"${file.name}" has a restricted file type and cannot be sent.` }));
           continue;
        }
        validFiles.push(file);
      }

      if (validFiles.length > 0) addStagedFiles(validFiles);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasContentToSend = hasTextUI || stagedFiles.length > 0;

  const handleSubmit = async (e?: React.FormEvent, forceSilent = false) => {
    if (e) e.preventDefault();
    const currentText = inputRef.current?.value || '';
    
    if ((!currentText.trim() && stagedFiles.length === 0) || !isConnected) return;
    
    if (!forceSilent) triggerSendFeedback();
    setShowSilentMenu(false);
    
    if (editingMessage) {
        await sendEdit(conversation.id, editingMessage.id, currentText);
        if (inputRef.current) inputRef.current.value = '';
        setHasTextUI(false);
        return;
    }
    
    if (stagedFiles.length > 0) {
       const filesToProcess = [...stagedFiles];
       clearStagedFiles();
       (async () => {
           for (const staged of filesToProcess) {
               await useMessageInputStore.getState().uploadFile(conversation.id, staged.file);
           }
       })();
    }

    if (currentText.trim()) {
      let finalContent = currentText;
      if (forceSilent) {
          finalContent = JSON.stringify({ type: 'silent', text: currentText });
      }
      onSend({ content: finalContent });
      
      // Reset input secara langsung
      if (inputRef.current) inputRef.current.value = '';
      setHasTextUI(false);
      setIsHD(false);
      setIsVoiceAnonymized(false);
    }
    
    clearTypingLinkPreview();
    setShowEmojiPicker(false);
    setShowPlusMenu(false);
    setShowTimerMenu(false);
  };

  const handleSmartReplySelect = (reply: string) => {
    if (inputRef.current) {
        inputRef.current.value = reply;
        setHasTextUI(true);
    }
    if (isConnected) onTyping();
  };

  const handleStartRecording = async () => {
    if (!isConnected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let finalStream = stream;

      if (isVoiceAnonymized) {
          const AudioContextClass = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          const audioCtx = new AudioContextClass();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const filter = audioCtx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 800;
          const oscillator = audioCtx.createOscillator();
          oscillator.type = 'sine';
          oscillator.frequency.value = 40;
          const ringModulator = audioCtx.createGain();
          ringModulator.gain.value = 0;
          oscillator.connect(ringModulator.gain);
          source.connect(ringModulator);
          ringModulator.connect(filter);
          const destination = audioCtx.createMediaStreamDestination();
          filter.connect(destination);
          oscillator.start();
          finalStream = destination.stream;
      }

      const options = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 };
      mediaRecorderRef.current = new MediaRecorder(finalStream, options);
      audioChunksRef.current = [];
      shouldSendVoiceRef.current = true;

      mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
      mediaRecorderRef.current.onstop = () => {
        if (shouldSendVoiceRef.current) {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          onVoiceSend(audioBlob, recordingTimeRef.current);
        }
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
      shouldSendVoiceRef.current = true;
      mediaRecorderRef.current.stop();
      if (audioContextRef.current) {
          audioContextRef.current.close().catch(()=>{});
          audioContextRef.current = null;
      }
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  const handleCancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      shouldSendVoiceRef.current = false;
      mediaRecorderRef.current.stop();
      if (audioContextRef.current) {
          audioContextRef.current.close().catch(()=>{});
          audioContextRef.current = null;
      }
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  // --- Render ---

  return (
    <div className="bg-bg-main border-t border-white/10 z-20 relative">
      <div className="absolute bottom-full left-0 w-full">
        <SmartReply lastMessage={lastDecryptedText} isFromMe={!isLastMessageFromOther} onSelectReply={handleSmartReplySelect} />
        <div className="px-4">
            <EditPreview />
            <ReplyPreview />

            {typingLinkPreview && (
            <div className="mb-2">
                <LinkPreviewCard preview={typingLinkPreview as { url: string; title: string; description: string; image: string; siteName: string }} />
            </div>
            )}
            
            {stagedFiles.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-2 p-3 bg-bg-surface backdrop-blur-md rounded-2xl shadow-neumorphic-convex border border-white/5 flex gap-3 overflow-x-auto scrollbar-hide">
                    {stagedFiles.map((staged) => {
                        const isImage = staged.file.type.startsWith('image/');
                        const url = isImage ? filePreviews.get(staged.id) : null;
                        return (
                            <div key={staged.id} className="relative w-20 h-20 flex-shrink-0 rounded-xl shadow-neumorphic-concave overflow-hidden border border-white/5 group bg-bg-main">
                                {isImage && url ? (
                                    <>
                                      <img src={url} alt="preview" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                      <div className="absolute top-1 left-1 flex items-center gap-1 z-10">
                                          <button type="button" onClick={(e) => { e.preventDefault(); setPaintTarget({ id: staged.id, file: staged.file }); }} className="bg-black/60 hover:bg-accent text-white p-1 rounded-full backdrop-blur-md transition-colors"><FiEdit3 size={12} /></button>
                                          <button type="button" onClick={(e) => { e.preventDefault(); setCropTarget({ id: staged.id, url, file: staged.file }); }} className="bg-black/60 hover:bg-accent text-white p-1 rounded-full backdrop-blur-md transition-colors"><FiCrop size={12} /></button>
                                      </div>
                                    </>
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center text-text-secondary">
                                        <FiPaperclip size={20} />
                                        <span className="text-[8px] mt-1 px-1 truncate w-full text-center">{staged.file.name}</span>
                                    </div>
                                )}
                                <button type="button" onClick={() => removeStagedFile(staged.id)} className="absolute top-1 right-1 bg-black/60 hover:bg-red-500 text-white p-1 rounded-full backdrop-blur-md transition-colors"><FiX size={12} /></button>
                            </div>
                        );
                    })}
                </motion.div>
            )}
        </div>
      </div>

      {showEmojiPicker && (
        <div ref={emojiPickerRef} className="absolute bottom-24 left-4 z-50 shadow-2xl rounded-xl overflow-hidden">
          <Suspense fallback={<div className="w-[350px] h-[450px] bg-bg-surface flex items-center justify-center text-text-secondary">{t('common:actions.loading')}</div>}>
            <EmojiPicker onEmojiClick={handleEmojiClick} autoFocusSearch={false} lazyLoadEmojis={true} theme={theme === 'dark' ? Theme.DARK : Theme.LIGHT} />
          </Suspense>
        </div>
      )}

      {showTimerMenu && (
        <div ref={timerMenuRef} className="absolute bottom-full left-10 mb-2 z-50 bg-bg-surface border border-white/10 rounded-xl shadow-xl overflow-hidden min-w-[120px]">
          <div className="p-2 text-[10px] uppercase font-bold text-text-secondary border-b border-white/5">{t('chat:input.auto_delete', 'Auto-Delete')}</div>
          {DURATIONS.map((opt) => (
            <button key={opt.label} onClick={() => { setExpiresIn(opt.value); setShowTimerMenu(false); setShowPlusMenu(false); }} className={clsx("w-full text-left px-4 py-2 text-sm hover:bg-white/5 transition-colors flex items-center justify-between", expiresIn === opt.value ? "text-orange-500 font-bold" : "text-text-primary")}>
              {opt.label}
              {expiresIn === opt.value && <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />}
            </button>
          ))}
        </div>
      )}

      {showPlusMenu && (
        <div ref={plusMenuRef} className="absolute bottom-full left-4 mb-2 z-50 bg-bg-surface border border-white/10 rounded-xl shadow-xl overflow-hidden min-w-[160px] flex flex-col p-1">
          <button onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary"><FiPaperclip size={18} /><span>{t('input.attach_file')}</span></button>
          <button onClick={() => { setShowTimerMenu(true); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary"><FiClock size={18} className={expiresIn ? "text-orange-500" : ""} /><span>{t('input.set_timer')}</span></button>
          <button onClick={() => { setIsViewOnce(!isViewOnce); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary"><FiEye size={18} className={isViewOnce ? "text-accent" : ""} /><span>{t('input.toggle_view_once')}</span></button>
          <button onClick={() => { setIsHD(!isHD); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary font-bold"><span className={isHD ? "text-accent" : "text-text-secondary"}>HD</span><span>{isHD ? t('chat:input.hd_on', 'HD Quality: ON') : t('chat:input.hd_off', 'Standard Quality')}</span></button>
          <button onClick={() => { setIsVoiceAnonymized(!isVoiceAnonymized); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary font-bold"><FiCpu size={18} className={isVoiceAnonymized ? "text-red-500" : "text-text-secondary"} /><span className={isVoiceAnonymized ? "text-red-500" : ""}>{isVoiceAnonymized ? t('chat:input.anon_on', 'Anon Voice: ON') : t('chat:input.anon_off', 'Anon Voice: OFF')}</span></button>
          <button onClick={() => { setShowEmojiPicker(true); setShowPlusMenu(false); }} className="flex items-center gap-3 w-full text-left px-4 py-3 text-sm hover:bg-white/5 rounded-lg transition-colors text-text-primary"><FiSmile size={18} /><span>{t('input.insert_emoji')}</span></button>
        </div>
      )}

      {isOtherParticipantBlocked ? (
        <div className="flex items-center justify-between p-4 bg-red-500/10 rounded-xl border border-red-500/20 m-4">
          <div className="flex items-center gap-3 text-red-500"><FiAlertTriangle size={20} /><span className="font-bold text-sm">{t('input.transmission_blocked')}</span></div>
          <button onClick={() => useAuthStore.getState().unblockUser(otherParticipant.id)} className="text-xs font-mono uppercase bg-red-500 text-white px-3 py-1.5 rounded-lg shadow-sm hover:bg-red-600">{t('input.unblock_signal')}</button>
        </div>
      ) : isRecording ? (
        <div className="flex items-center gap-2 md:gap-4 animate-fade-in p-2 md:p-4 w-full">
          <button onClick={handleCancelRecording} className="p-3 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10 transition-all flex-shrink-0" title={t('input.cancel_voice')}><FiTrash2 size={20} /></button>
          <div className="flex-1 bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark rounded-full h-12 flex items-center px-4 md:px-6 gap-3 min-w-0">
             <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_red] flex-shrink-0"></div>
             <span className="font-mono text-sm md:text-lg text-text-primary tracking-widest flex-shrink-0">{new Date(recordingTime * 1000).toISOString().substr(14, 5)}</span>
             <span className="hidden md:inline text-xs text-text-secondary uppercase tracking-wider ml-auto truncate">{t('input.recording_state')}</span>
          </div>
          <button onClick={handleStopRecording} className="p-3 rounded-full bg-accent text-white shadow-[0_0_15px_rgba(var(--accent),0.5)] hover:scale-110 active:scale-95 transition-all flex-shrink-0" title={t('input.send_voice')}><FiSend size={20} /></button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="relative flex items-center gap-2 p-2 rounded-2xl bg-bg-main w-full m-4 shadow-neu-pressed dark:shadow-neu-pressed-dark max-w-[calc(100%-2rem)]">
          <div className="hidden md:flex items-center gap-1">
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isInputDisabled} className="p-3 rounded-xl text-text-secondary transition-all hover:text-accent active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark"><FiPaperclip size={18} /></button>
            <button type="button" onClick={() => setShowTimerMenu(!showTimerMenu)} disabled={isInputDisabled} className={clsx("p-3 rounded-xl transition-all active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark", expiresIn ? "text-orange-500 bg-orange-500/10" : "text-text-secondary hover:text-orange-500")}><FiClock size={18} /></button>
            <button type="button" onClick={() => setIsViewOnce(!isViewOnce)} disabled={isInputDisabled} className={clsx("p-3 rounded-xl transition-all active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark", isViewOnce ? "text-accent bg-accent/10" : "text-text-secondary hover:text-accent")}><FiEye size={18} /></button>
            <button type="button" onClick={() => setIsHD(!isHD)} disabled={isInputDisabled} className={clsx("p-3 rounded-xl transition-all active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark font-bold text-xs flex items-center justify-center", isHD ? "text-accent bg-accent/10" : "text-text-secondary hover:text-accent")}>HD</button>
            <button type="button" onClick={() => setIsVoiceAnonymized(!isVoiceAnonymized)} disabled={isInputDisabled} className={clsx("p-3 rounded-xl transition-all active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark font-bold text-xs flex items-center gap-1 justify-center", isVoiceAnonymized ? "text-red-500 bg-red-500/10 shadow-[inset_2px_2px_4px_rgba(0,0,0,0.4)]" : "text-text-secondary hover:text-red-400")}><FiCpu size={14} /> ANON</button>
            <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} disabled={isInputDisabled} className="p-3 rounded-xl text-text-secondary transition-all hover:text-yellow-500 active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark"><FiSmile size={18} /></button>
          </div>
          <div className="md:hidden flex items-center">
            <button type="button" onClick={() => setShowPlusMenu(!showPlusMenu)} disabled={isInputDisabled} className={clsx("p-3 rounded-xl transition-all active:scale-95 shadow-neu-icon dark:shadow-neu-icon-dark", showPlusMenu ? "text-accent bg-accent/10" : "text-text-secondary")}><motion.div animate={{ rotate: showPlusMenu ? 45 : 0 }} transition={{ duration: 0.2 }}><FiPlus size={20} /></motion.div></button>
          </div>

          <input type="file" multiple ref={fileInputRef} className="hidden" onChange={handleLocalFileChange} disabled={isInputDisabled} />

          <div className="flex-1 relative group">
            {/* ✅ UNCONTROLLED INPUT: Hapus `value={text}`! */}
            <input
              ref={inputRef}
              type="text"
              onChange={handleTextChange}
              disabled={isInputDisabled}
              placeholder={isConnected ? (expiresIn ? t('input.placeholder_disappearing') : t('input.placeholder_default')) : t('input.placeholder_offline')}
              className="w-full bg-transparent border-none outline-none text-text-primary placeholder:text-text-secondary/50 h-10 px-2 font-medium"
            />
          </div>

          <div className="relative">
            <AnimatePresence>
               {showSilentMenu && (
                  <motion.div initial={{ opacity: 0, y: 10, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.9 }} className="absolute bottom-full right-0 mb-2 p-2 bg-bg-surface backdrop-blur-xl border border-white/10 rounded-xl shadow-neumorphic-convex z-50 whitespace-nowrap">
                     <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleSubmit(undefined, true); }} className="flex items-center gap-2 px-3 py-2 text-sm font-bold text-text-primary hover:bg-white/5 rounded-lg transition-colors w-full"><FiVolumeX className="text-accent" size={16} /> {t('input.send_silent')}</button>
                  </motion.div>
               )}
            </AnimatePresence>
            {hasContentToSend ? (
               <button ref={sendButtonRef} type="submit" onMouseDown={handleSendTouchStart} onMouseUp={handleSendTouchEnd} onMouseLeave={handleSendTouchEnd} onTouchStart={handleSendTouchStart} onTouchEnd={handleSendTouchEnd} disabled={isInputDisabled} className="p-3 rounded-xl bg-accent text-white shadow-neu-flat dark:shadow-neu-flat-dark hover:-translate-y-0.5 active:translate-y-0 transition-all"><FiSend size={18} className={hasContentToSend ? 'translate-x-0.5' : ''} /></button>
            ) : (
               <button type="button" onClick={handleStartRecording} disabled={isInputDisabled} className="p-3 rounded-xl text-text-secondary shadow-neu-icon dark:shadow-neu-icon-dark hover:text-red-500 active:scale-95 transition-all"><FiMic size={18} /></button>
            )}
          </div>
        </form>
      )}

      {cropTarget && (
        <AttachmentCropperModal file={cropTarget.file} url={cropTarget.url} onClose={() => setCropTarget(null)} onSave={(newFile) => { updateStagedFile(cropTarget.id, newFile); setCropTarget(null); }} />
      )}
      {paintTarget && (
        <ImageEditorModal file={paintTarget.file} onSave={(newFile) => { updateStagedFile(paintTarget.id, newFile); setPaintTarget(null); }} onCancel={() => setPaintTarget(null)} />
      )}
    </div>
  );
}