import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch, apiUpload, handleApiError } from "@lib/api";
import { encryptMessage, encryptFile } from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore } from "./auth";
import { useMessageStore } from "./message";
import type { Message } from "./conversation";
import useDynamicIslandStore from "./dynamicIsland";

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

  // This function now ONLY handles sending pure text messages.
  sendMessage: async (conversationId, data) => {
    const tempId = Date.now();
    const me = useAuthStore.getState().user;
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();

    let payload: Partial<Message> = { ...data };

    try {
      const { ciphertext, sessionId } = await encryptMessage(data.content, conversationId);
      payload.content = ciphertext;
      payload.sessionId = sessionId;
    } catch (e: any) {
      toast.error(`Encryption failed: ${e.message}`);
      return;
    }
    
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
      const finalMessage = await authFetch<Message>("/api/messages", {
        method: "POST",
        body: JSON.stringify(finalPayload),
      });
      // The `message:new` socket event will handle replacing the optimistic message
      // so we don't need to call replaceOptimisticMessage here.
    } catch (error) {
      const errorMessage = handleApiError(error);
      toast.error(`Failed to send message: ${errorMessage}`);
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }

    set({ replyingTo: null });
  },
  
    uploadFile: async (conversationId, file) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activityId = addActivity({ type: 'upload', fileName: `Encrypting ${file.name}...`, progress: 0 });
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    if (!me) {
      removeActivity(activityId);
      return toast.error("User not authenticated.");
    }
    const tempId = Date.now();

    // 1. Create and add optimistic message immediately
    const optimisticMessage: Message = {
      id: `temp-${tempId}`,
      tempId,
      conversationId,
      senderId: me.id,
      sender: me,
      createdAt: new Date().toISOString(),
      optimistic: true,
      fileUrl: URL.createObjectURL(file),
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      repliedTo: replyingTo || undefined,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null });

    try {
      // 2. Encrypt the file and its key
      updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(file);
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId);

      // 3. Upload the encrypted file with metadata
      updateActivity(activityId, { progress: 50, fileName: `Uploading ${file.name}...` });
      const form = new FormData();
      form.append("file", new File([encryptedBlob], file.name, { type: "application/octet-stream" }));
      form.append("fileKey", encryptedFileKey);
      form.append("sessionId", sessionId);
      form.append("tempId", String(tempId));
      if (replyingTo) form.append("repliedToId", replyingTo.id);

      // The server will create the message and broadcast it via 'message:new'
      // The socket listener will then replace our optimistic message.
      await apiUpload<{ file: any }> ({
        path: `/api/uploads/${conversationId}/upload`,
        formData: form,
        onUploadProgress: (progress) => updateActivity(activityId, { progress: 50 + (progress / 2) }),
      });
      
      updateActivity(activityId, { progress: 100, fileName: 'Finishing...' });
      setTimeout(() => removeActivity(activityId), 1000); 

    } catch (error: any) {
      const errorMsg = handleApiError(error);
      toast.error(`File upload failed: ${errorMsg}`);
      removeActivity(activityId);
      // Mark the optimistic message as failed
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }
  },

  // This function is now completely self-contained for sending voice messages.
  handleStopRecording: async (conversationId, blob, duration) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activityId = addActivity({ type: 'upload', fileName: 'Encrypting & Uploading Voice...', progress: 0 });
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    if (!me) {
      removeActivity(activityId);
      return toast.error("User not authenticated.");
    }
    const tempId = Date.now();

    // 1. Create and add optimistic message immediately
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
      // 2. Encrypt the audio file and get the raw key
      updateActivity(activityId, { progress: 25, fileName: 'Encrypting voice message...' });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(blob);
      
      // 3. Encrypt the raw key for transmission
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId);

      // 4. Upload the encrypted file with metadata
      updateActivity(activityId, { progress: 50, fileName: 'Uploading voice message...' });
      const form = new FormData();
      form.append("file", new File([encryptedBlob], "voice-message.webm", { type: "application/octet-stream" })); // Corrected line
      form.append("fileKey", encryptedFileKey);
      form.append("sessionId", sessionId);
      form.append("tempId", String(tempId));
      form.append("duration", String(duration));
      if (replyingTo) form.append("repliedToId", replyingTo.id);

      // The server will create the message and broadcast it via 'message:new'
      // The socket listener will then replace our optimistic message.
      await apiUpload<{ file: any }> ({
        path: `/api/uploads/${conversationId}/upload`,
        formData: form,
        onUploadProgress: (progress) => updateActivity(activityId, { progress: 50 + (progress / 2) }),
      });
      
      updateActivity(activityId, { progress: 100, fileName: 'Finishing...' });
      setTimeout(() => removeActivity(activityId), 1000); 

    } catch (error: any) {
      const errorMsg = handleApiError(error);
      toast.error(`Voice message failed: ${errorMsg}`);
      removeActivity(activityId);
      // Mark the optimistic message as failed
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }
  },

  retrySendMessage: (message: Message) => {
    // This can only retry text messages now
    if (message.fileUrl) {
      toast.error("Cannot retry file messages automatically.");
      return;
    };
    const { conversationId, content } = message;
    useMessageStore.getState().removeMessage(conversationId, message.id);
    get().sendMessage(conversationId, { content: content || '' });
  },
}));