import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch, handleApiError } from "@lib/api";
import { encryptMessage, ensureGroupSession, encryptFile } from "@utils/crypto";
import { emitGroupKeyDistribution } from "@lib/socket";
import toast from "react-hot-toast";
import { useAuthStore } from "./auth";
import { useMessageStore } from "./message";
import { useConversationStore } from "./conversation";
import type { Message } from "./conversation";
import { compressImage } from "@lib/fileUtils";
import useDynamicIslandStore, { UploadActivity } from "./dynamicIsland";
import { uploadToR2 } from '../lib/r2'; // Import fungsi upload R2

type State = {
  replyingTo: Message | null;
  typingLinkPreview: any | null;

  // Actions
  setReplyingTo: (message: Message | null) => void;
  fetchTypingLinkPreview: (text: string) => void;
  clearTypingLinkPreview: () => void;
  sendMessage: (conversationId: string, data: { content: string }) => Promise<void>;
  uploadFile: (conversationId: string, file: File) => Promise<void>;
  handleStopRecording: (conversationId: string, blob: Blob, duration: number) => Promise<void>;
  retrySendMessage: (message: Message) => void;
};

const ensureGroupSessionIfNeeded = async (conversationId: string): Promise<boolean> => {
  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation) {
    toast.error("Internal error: Active conversation not found.");
    return false;
  }
  
  if (conversation.isGroup) {
    try {
      const distributionKeys = await ensureGroupSession(conversationId, conversation.participants);
      if (distributionKeys && distributionKeys.length > 0) {
        emitGroupKeyDistribution(conversationId, distributionKeys);
      }
    } catch (e: any) {
      console.error("Failed to ensure group session.", e);
      toast.error(`Failed to establish group session: ${e.message}`);
      return false;
    }
  }
  return true;
};

export const useMessageInputStore = createWithEqualityFn<State>((set, get) => ({
  replyingTo: null,
  typingLinkPreview: null,

  setReplyingTo: (message) => set({ replyingTo: message }),

  fetchTypingLinkPreview: async (text) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);
    if (urls && urls.length > 0) {
      try {
        const preview = await api("/api/previews", {
          method: "POST",
          body: JSON.stringify({ url: urls[0] }),
        });
        set({ typingLinkPreview: preview });
      } catch (error) {
        set({ typingLinkPreview: null });
      }
    } else {
      set({ typingLinkPreview: null });
    }
  },

  clearTypingLinkPreview: () => set({ typingLinkPreview: null }),

  sendMessage: async (conversationId, data) => {
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    const { replyingTo } = get();

    if (!await ensureGroupSessionIfNeeded(conversationId)) return;
    
    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId)!;
    const isGroup = conversation.isGroup;

    let payload: Partial<Message> = { ...data };

    try {
      const { ciphertext, sessionId } = await encryptMessage(data.content, conversationId, isGroup);
      payload.content = ciphertext;
      payload.sessionId = sessionId;
    } catch (e: any) {
      toast.error(`Encryption failed: ${e.message}`);
      return;
    }
    
    const tempId = Date.now();
    const optimisticMessage: Message = {
      id: `temp-${tempId}`,
      tempId,
      conversationId,
      senderId: me!.id,
      sender: me!,
      createdAt: new Date().toISOString(),
      optimistic: true,
      ...data,
      repliedTo: replyingTo || undefined,
    };

    addOptimisticMessage(conversationId, optimisticMessage);
    
    const finalPayload = { 
      conversationId,
      tempId,
      repliedToId: replyingTo?.id,
      ...payload, 
    };

    try {
      await authFetch<Message>("/api/messages", {
        method: "POST",
        body: JSON.stringify(finalPayload),
      });
    } catch (error) {
      const errorMessage = handleApiError(error);
      toast.error(`Failed to send message: ${errorMessage}`);
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }

    set({ replyingTo: null });
  },
  
  uploadFile: async (conversationId, file) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: `Processing ${file.name}...`, progress: 0 };
    const activityId = addActivity(activity);
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    if (!me) {
      removeActivity(activityId);
      toast.error("User not authenticated.");
      return;
    }

    if (!await ensureGroupSessionIfNeeded(conversationId)) {
      removeActivity(activityId);
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId)!;
    const isGroup = conversation.isGroup;

    const tempId = Date.now();
    const optimisticMessage: Message = {
      id: `temp-${tempId}`,
      tempId,
      conversationId,
      senderId: me.id,
      sender: me,
      createdAt: new Date().toISOString(),
      optimistic: true,
      fileUrl: URL.createObjectURL(file), // Preview lokal
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      repliedTo: replyingTo || undefined,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null });

    try {
      // 1. KOMPRESI GAMBAR
      let fileToProcess = file;
      if (file.type.startsWith('image/')) {
        updateActivity(activityId, { progress: 10, fileName: `Compressing ${file.name}...` });
        try {
          fileToProcess = await compressImage(file);
          console.log(`📉 Image compressed: ${(file.size / 1024).toFixed(2)}KB -> ${(fileToProcess.size / 1024).toFixed(2)}KB`);
        } catch (e) {
          console.warn("Image compression failed, using original file.", e);
        }
      }

      // 2. ENKRIPSI FILE
      updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(fileToProcess);
      
      // Enkripsi Kunci File agar aman dikirim ke server
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId, isGroup);

      // 3. UPLOAD KE CLOUDFLARE R2 (Bypass Server)
      updateActivity(activityId, { progress: 30, fileName: `Uploading ${file.name}...` });
      
      // Buat File object dari encryptedBlob agar punya properti name & type saat diupload
      const encryptedFile = new File([encryptedBlob], file.name, { type: file.type });
      
      // Panggil fungsi R2
      const fileUrl = await uploadToR2(encryptedFile, 'attachments', (percent) => {
         // Progress upload R2 (30% - 90%)
         const totalProgress = 30 + (percent * 0.6);
         updateActivity(activityId, { progress: totalProgress });
      });

      // 4. KIRIM METADATA KE SERVER (Menyelesaikan proses)
      updateActivity(activityId, { progress: 95, fileName: 'Finalizing...' });
      
      await api(`/api/uploads/messages/${conversationId}`, {
        method: "POST",
        body: JSON.stringify({
          fileUrl, // URL Publik dari R2
          fileName: file.name,
          fileType: file.type, // Tipe asli
          fileSize: file.size,
          duration: null,
          tempId,
          fileKey: encryptedFileKey, // Kunci dekripsi (terenkripsi)
          sessionId,
          repliedToId: replyingTo?.id
        })
      });
      
      updateActivity(activityId, { progress: 100, fileName: 'Done!' });
      setTimeout(() => removeActivity(activityId), 1000); 

    } catch (error: any) {
      console.error("Upload error:", error);
      const errorMsg = handleApiError(error);
      toast.error(`File upload failed: ${errorMsg}`);
      removeActivity(activityId);
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }
  },

  handleStopRecording: async (conversationId, blob, duration) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: 'Processing Voice...', progress: 0 };
    const activityId = addActivity(activity);
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    if (!me) {
      removeActivity(activityId);
      toast.error("User not authenticated.");
      return;
    }
    
    if (!await ensureGroupSessionIfNeeded(conversationId)) {
      removeActivity(activityId);
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId)!;
    const isGroup = conversation.isGroup;
    
    const tempId = Date.now();
    const optimisticMessage: Message = {
      id: `temp-${tempId}`,
      tempId,
      conversationId,
      senderId: me.id,
      sender: me,
      createdAt: new Date().toISOString(),
      optimistic: true,
      fileUrl: URL.createObjectURL(blob),
      fileName: "voice-message.webm",
      fileType: "audio/webm",
      fileSize: blob.size,
      duration,
      repliedTo: replyingTo || undefined,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null });

    try {
      // 1. ENKRIPSI VOICE
      updateActivity(activityId, { progress: 20, fileName: 'Encrypting voice...' });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(blob);
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId, isGroup);

      // 2. UPLOAD KE CLOUDFLARE R2
      updateActivity(activityId, { progress: 40, fileName: 'Uploading voice...' });
      
      const encryptedFile = new File([encryptedBlob], "voice-message.webm", { type: "audio/webm" });

      const fileUrl = await uploadToR2(encryptedFile, 'attachments', (percent) => {
        const totalProgress = 40 + (percent * 0.5);
        updateActivity(activityId, { progress: totalProgress });
      });

      // 3. KIRIM METADATA KE SERVER
      updateActivity(activityId, { progress: 95, fileName: 'Finalizing...' });

      await api(`/api/uploads/messages/${conversationId}`, {
        method: "POST",
        body: JSON.stringify({
          fileUrl,
          fileName: "voice-message.webm",
          fileType: "audio/webm",
          fileSize: blob.size,
          duration,
          tempId,
          fileKey: encryptedFileKey,
          sessionId,
          repliedToId: replyingTo?.id
        })
      });
      
      updateActivity(activityId, { progress: 100, fileName: 'Sent!' });
      setTimeout(() => removeActivity(activityId), 1000); 

    } catch (error: any) {
      const errorMsg = handleApiError(error);
      toast.error(`Voice message failed: ${errorMsg}`);
      removeActivity(activityId);
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }
  },

  retrySendMessage: (message: Message) => {
    const { conversationId, content, fileUrl, repliedTo } = message;
    
    useMessageStore.getState().removeMessage(conversationId, message.id);

    if (fileUrl) {
      toast.error("Cannot retry file messages automatically. Please try uploading again.");
      return;
    }
    
    if (repliedTo) {
      set({ replyingTo: repliedTo });
    }
    get().sendMessage(conversationId, { content: content || '' });
  },
}));