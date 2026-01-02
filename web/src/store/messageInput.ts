import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch, apiUpload, handleApiError } from "@lib/api";
import { encryptMessage, ensureGroupSession, encryptFile } from "@utils/crypto";
import { emitGroupKeyDistribution } from "@lib/socket";
import toast from "react-hot-toast";
import { useAuthStore } from "./auth";
import { useMessageStore } from "./message";
import { useConversationStore } from "./conversation";
import type { Message } from "./conversation";
import useDynamicIslandStore, { UploadActivity } from "./dynamicIsland";

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
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: `Encrypting ${file.name}...`, progress: 0 };
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
      fileUrl: URL.createObjectURL(file),
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      repliedTo: replyingTo || undefined,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null });

    try {
      updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(file);
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId, isGroup);

      updateActivity(activityId, { progress: 50, fileName: `Uploading ${file.name}...` });
      const form = new FormData();
      // Defensive programming: Append metadata fields BEFORE the file blob.
      form.append("fileKey", encryptedFileKey);
      if (sessionId) form.append("sessionId", sessionId);
      form.append("tempId", String(tempId));
      if (replyingTo) form.append("repliedToId", replyingTo.id);
      form.append("file", new File([encryptedBlob], file.name, { type: "application/octet-stream" }));

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
      updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
    }
  },

  handleStopRecording: async (conversationId, blob, duration) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: 'Encrypting & Uploading Voice...', progress: 0 };
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
      updateActivity(activityId, { progress: 25, fileName: 'Encrypting voice message...' });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(blob);
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId, isGroup);

      updateActivity(activityId, { progress: 50, fileName: 'Uploading voice message...' });
      const form = new FormData();
      // Defensive programming: Append metadata fields BEFORE the file blob.
      form.append("fileKey", encryptedFileKey);
      if (sessionId) form.append("sessionId", sessionId);
      form.append("tempId", String(tempId));
      form.append("duration", String(duration));
      if (replyingTo) form.append("repliedToId", replyingTo.id);
      form.append("file", new File([encryptedBlob], "voice-message.webm", { type: "application/octet-stream" }));

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