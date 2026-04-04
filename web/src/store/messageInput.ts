// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import type { UserId, ConversationId, MessageId } from '@nyx/shared';
import { asUserId, asConversationId, asMessageId } from '@nyx/shared';
import { createWithEqualityFn } from "zustand/traditional";
import { api, handleApiError } from "@lib/api";
import { ensureGroupSession } from "@utils/crypto";
import { emitGroupKeyDistribution } from "@lib/socket";
import toast from "react-hot-toast";
import { useAuthStore } from "./auth";
import { useMessageStore } from "./message";
import { useConversationStore } from "./conversation";
import type { Message } from "./conversation";
import { compressImage } from "@lib/fileUtils";
import useDynamicIslandStore, { UploadActivity } from "./dynamicIsland";

export type StagedFile = {
  id: string;
  file: File;
};

type State = {
  replyingTo: Message | null;
  typingLinkPreview: Record<string, unknown> | null;
  expiresIn: number | null;
  isViewOnce: boolean;
  stagedFiles: StagedFile[];
  isHD: boolean;
  isVoiceAnonymized: boolean;
  editingMessage: Message | null;

  // Actions
  setReplyingTo: (message: Message | null) => void;
  setEditingMessage: (message: Message | null) => void;
  sendEdit: (conversationId: string, messageId: string, newText: string) => Promise<void>;
  setExpiresIn: (seconds: number | null) => void;
  setIsViewOnce: (value: boolean) => void;
  setIsHD: (value: boolean) => void;
  setIsVoiceAnonymized: (value: boolean) => void;
  fetchTypingLinkPreview: (text: string) => void;
  clearTypingLinkPreview: () => void;
  addStagedFiles: (files: File[]) => void;
  updateStagedFile: (id: string, newFile: File) => void;
  removeStagedFile: (id: string) => void;
  clearStagedFiles: () => void;
  sendMessage: (conversationId: string, data: { content: string }, tempId?: number, isSilent?: boolean) => Promise<void>;
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
        emitGroupKeyDistribution(conversationId, distributionKeys as { userId: string; key: string }[]);
      }
    } catch (e: unknown) {
      console.error("Failed to ensure group session.", e);
      toast.error(`Failed to establish group session: ${(e instanceof Error ? e.message : 'Unknown error')}`);
      return false;
    }
  }
  return true;
};

let tempIdCounter = 0;
const generateTempId = () => Date.now() * 1000 + (++tempIdCounter) + Math.floor(Math.random() * 1000);

export const useMessageInputStore = createWithEqualityFn<State>((set, get) => ({
  replyingTo: null,
  typingLinkPreview: null,
  expiresIn: null,
  isViewOnce: false,
  stagedFiles: [],
  isHD: false,
  isVoiceAnonymized: false,
  editingMessage: null,

  setReplyingTo: (message) => set({ replyingTo: message }),
  setEditingMessage: (message) => set({ editingMessage: message }),
  sendEdit: async (conversationId, messageId, newText) => {
      const payload = { type: 'edit', targetMessageId: messageId, text: newText };
      const tempId = generateTempId();
      // Memberikan isSilent = true agar coreSendMessage tidak membuat gelembung kosong/hantu
      await get().sendMessage(conversationId, { content: JSON.stringify(payload) }, tempId, true);
      set({ editingMessage: null });
      // Optimistically apply local edit immediately
      useMessageStore.getState().updateMessage(conversationId, messageId, { content: newText, isEdited: true });
  },
  setExpiresIn: (seconds) => set({ expiresIn: seconds }),
  setIsViewOnce: (value) => set({ isViewOnce: value }),
  setIsHD: (value) => set({ isHD: value }),
  setIsVoiceAnonymized: (value) => set({ isVoiceAnonymized: value }),
  addStagedFiles: (files) => set((state) => ({ 
    stagedFiles: [
      ...state.stagedFiles, 
      ...files.map(f => ({ id: Math.random().toString(36).substring(2, 15) + Date.now().toString(36), file: f }))
    ] 
  })),
  updateStagedFile: (id, newFile) => set((state) => ({
    stagedFiles: state.stagedFiles.map(sf => sf.id === id ? { ...sf, file: newFile } : sf)
  })),
  removeStagedFile: (id) => set((state) => ({ stagedFiles: state.stagedFiles.filter(sf => sf.id !== id) })),
  clearStagedFiles: () => set({ stagedFiles: [] }),

  fetchTypingLinkPreview: async (text) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);
    if (urls && urls.length > 0) {
      try {
        const preview = await api<Record<string, unknown>>("/api/previews", {
          method: "POST",
          body: JSON.stringify({ url: urls[0] }),
        });
        set({ typingLinkPreview: preview });
      } catch (_error) {
        set({ typingLinkPreview: null });
      }
    } else {
      set({ typingLinkPreview: null });
    }
  },

  clearTypingLinkPreview: () => set({ typingLinkPreview: null }),

  sendMessage: async (conversationId, data, tempId?: number, isSilent = false) => {
    const { sendMessage: coreSendMessage } = useMessageStore.getState();
    const { replyingTo, expiresIn, isViewOnce } = get();

    // Teruskan status isSilent ke coreSendMessage di store/message.ts
    await coreSendMessage(conversationId, {
      ...data,
      repliedToId: replyingTo?.id,
      repliedTo: replyingTo || undefined,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      isViewOnce,
    }, tempId, isSilent);

    set({ replyingTo: null, isViewOnce: false });
  },
  
  uploadFile: async (conversationId, file) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: `Processing ${file.name}...`, progress: 0 };
    const activityId = addActivity(activity);
    const { replyingTo, expiresIn, isViewOnce, isHD } = get();
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

    const tempId = generateTempId();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // Optimistic UI 
    const optimisticMessage: Message = {
      id: asMessageId(`temp-${tempId}`),
      tempId,
      conversationId: asConversationId(conversationId),
      senderId: asUserId(me.id),
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
    
    // Clear Input state early for UX
    set({ replyingTo: null, isViewOnce: false, isHD: false });

    try {
      let fileToProcess = file;
      if (file.type.startsWith('image/')) {
        updateActivity(activityId, { progress: 10, fileName: `Compressing ${file.name}...` });
        try { fileToProcess = await compressImage(file, isHD); } catch (_e) {}
      }

      updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
      
      // ✅ OPTIMASI: Delegasikan Enkripsi File ke Web Worker!
      // Tidak akan lagi membekukan UI / Animasi meskipun file berukuran 100MB.
      const { encryptFileViaWorker } = await import('@utils/crypto');
      const { encryptedBlob, key: rawFileKey } = await encryptFileViaWorker(fileToProcess);
      
      updateActivity(activityId, { progress: 30, fileName: `Uploading ${file.name}...` });
      
      // Calculate retention
      const fileRetention = expiresIn ? expiresIn : (isViewOnce ? 1209600 : 0);

      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: file.name,
              fileType: 'application/octet-stream', 
              folder: 'attachments',
              fileSize: encryptedBlob.size,
              fileRetention
          })
      });

      // Upload to R2 via XHR for progress
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

      // Send Metadata via Message (Blind Attachment)
      const metadata = {
          type: 'file',
          url: presignedRes.publicUrl,
          key: rawFileKey, 
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

    } catch (error: unknown) {
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

    const tempId = Date.now();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const optimisticMessage: Message = {
      id: asMessageId(`temp-${tempId}`),
      tempId,
      conversationId: asConversationId(conversationId),
      senderId: asUserId(me.id),
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
      
      // ✅ OPTIMASI: Delegasikan Enkripsi Suara ke Web Worker
      const { encryptFileViaWorker } = await import('@utils/crypto');
      const { encryptedBlob, key: rawFileKey } = await encryptFileViaWorker(blob);

      updateActivity(activityId, { progress: 40, fileName: 'Uploading voice...' });
      
      const fileRetention = expiresIn ? expiresIn : (isViewOnce ? 1209600 : 0);

      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: "voice-message.webm",
              fileType: "application/octet-stream",
              folder: 'attachments',
              fileSize: encryptedBlob.size,
              fileRetention
          })
      });

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

    } catch (error: unknown) {
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