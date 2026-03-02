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
import { uploadToR2 } from '../lib/r2';

type State = {
  replyingTo: Message | null;
  typingLinkPreview: any | null;
  expiresIn: number | null;
  isViewOnce: boolean;

  // Actions
  setReplyingTo: (message: Message | null) => void;
  setExpiresIn: (seconds: number | null) => void;
  setIsViewOnce: (value: boolean) => void;
  fetchTypingLinkPreview: (text: string) => void;
  clearTypingLinkPreview: () => void;
  sendMessage: (conversationId: string, data: { content: string }, tempId?: number) => Promise<void>;
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
  expiresIn: null,
  isViewOnce: false,

  setReplyingTo: (message) => set({ replyingTo: message }),
  setExpiresIn: (seconds) => set({ expiresIn: seconds }),
  setIsViewOnce: (value) => set({ isViewOnce: value }),

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

  sendMessage: async (conversationId, data, tempId?: number) => {
    const { sendMessage: coreSendMessage } = useMessageStore.getState();
    const { replyingTo, expiresIn, isViewOnce } = get();

    // Delegate to Core Logic in message.ts (Centralized X3DH & Queue handling)
    await coreSendMessage(conversationId, {
      ...data,
      repliedToId: replyingTo?.id,
      // [FIX] Pass full object for optimistic UI
      repliedTo: replyingTo || undefined,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      isViewOnce,
      // Pass original content. message.ts handles encryption.
    }, tempId);

    // Clear Input State
    set({ replyingTo: null, isViewOnce: false });
  },
  
  uploadFile: async (conversationId, file) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: `Processing ${file.name}...`, progress: 0 };
    const activityId = addActivity(activity);
    const { replyingTo, expiresIn, isViewOnce } = get();
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
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // Optimistic UI (We keep this here to have access to File blob for preview)
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
      expiresAt,
      repliedTo: replyingTo || undefined,
      isViewOnce,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null, isViewOnce: false });

    try {
      let fileToProcess = file;
      if (file.type.startsWith('image/')) {
        updateActivity(activityId, { progress: 10, fileName: `Compressing ${file.name}...` });
        try { fileToProcess = await compressImage(file); } catch (e) {}
      }

      updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(fileToProcess);
      
      updateActivity(activityId, { progress: 30, fileName: `Uploading ${file.name}...` });
      
      const encryptedFile = new File([encryptedBlob], file.name, { type: "application/octet-stream" });
      
      // 1. Get Presigned URL
      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: file.name,
              fileType: 'application/octet-stream', 
              folder: 'attachments',
              fileSize: encryptedBlob.size 
          })
      });

      // 2. Upload to R2 via XHR for progress
      await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          
          xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                  const percentComplete = (e.loaded / e.total) * 60; // 30 -> 90
                  updateActivity(activityId, { progress: 30 + percentComplete });
              }
          };
          
          xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Upload failed'));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(encryptedBlob);
      });

      updateActivity(activityId, { progress: 95, fileName: 'Finalizing...' });

      // 3. Send Metadata via Message (Blind Attachment)
      const metadata = {
          type: 'file',
          url: presignedRes.publicUrl,
          key: rawFileKey, // Will be encrypted by sendMessage
          name: file.name,
          size: file.size,
          mimeType: file.type,
      };

      const { sendMessage: coreSendMessage } = useMessageStore.getState();
      await coreSendMessage(conversationId, {
          content: JSON.stringify(metadata),
          repliedTo: replyingTo || undefined,
          expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
          isViewOnce
      }, tempId);
      
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
    const { replyingTo, expiresIn, isViewOnce } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    if (!me) {
      removeActivity(activityId);
      return;
    }
    
    if (!await ensureGroupSessionIfNeeded(conversationId)) {
      removeActivity(activityId);
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId)!;
    const isGroup = conversation.isGroup;
    
    const tempId = Date.now();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

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
      expiresAt,
      repliedTo: replyingTo || undefined,
      isViewOnce,
    };
    addOptimisticMessage(conversationId, optimisticMessage);
    set({ replyingTo: null, isViewOnce: false });

    try {
      updateActivity(activityId, { progress: 20, fileName: 'Encrypting voice...' });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(blob);

      updateActivity(activityId, { progress: 40, fileName: 'Uploading voice...' });
      
      // Get Presigned
      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: "voice-message.webm",
              fileType: "application/octet-stream",
              folder: 'attachments',
              fileSize: encryptedBlob.size
          })
      });

      // Upload
      await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', "application/octet-stream");
          xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                  const percentComplete = (e.loaded / e.total) * 50; 
                  updateActivity(activityId, { progress: 40 + percentComplete });
              }
          };
          xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Upload failed'));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(encryptedBlob);
      });

      updateActivity(activityId, { progress: 95, fileName: 'Finalizing...' });

      // Send Metadata
      const metadata = {
          type: 'file',
          url: presignedRes.publicUrl,
          key: rawFileKey,
          name: "voice-message.webm",
          size: blob.size,
          mimeType: "audio/webm",
          duration
      };

      const { sendMessage: coreSendMessage } = useMessageStore.getState();
      await coreSendMessage(conversationId, {
          content: JSON.stringify(metadata),
          repliedTo: replyingTo || undefined,
          expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
          isViewOnce
      }, tempId);
      
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
    const { conversationId, content, fileUrl, repliedTo, tempId } = message;

    useMessageStore.getState().removeMessage(conversationId, message.id);

    if (fileUrl) {
      toast.error("Cannot retry file messages automatically. Please try uploading again.");
      return;
    }

    if (repliedTo) {
      set({ replyingTo: repliedTo });
    }
    get().sendMessage(conversationId, { content: content || '' }, tempId);
  },
}));
