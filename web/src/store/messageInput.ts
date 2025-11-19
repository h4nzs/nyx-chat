import { createWithEqualityFn } from "zustand/traditional";
import { api, apiUpload, handleApiError } from "@lib/api";
import { getSocket } from "@lib/socket";
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
    
    const socket = getSocket();
    const finalPayload = { 
      ...payload, 
      repliedToId: replyingTo?.id,
    };

    socket.emit("message:send", { conversationId, tempId, ...finalPayload }, (ack: { ok: boolean, error?: string, msg?: Message }) => {
      if (ack.ok && ack.msg) {
        useMessageStore.getState().replaceOptimisticMessage(conversationId, tempId, ack.msg);
      } else {
        toast.error(`Failed to send message: ${ack.error || 'Unknown error'}`);
        updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
      }
    });

    set({ replyingTo: null });
  },
  
    uploadFile: async (conversationId, file) => {
  
      const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
  
      const activityId = addActivity({ type: 'upload', fileName: `Encrypting ${file.name}...`, progress: 0 });
  
      const { replyingTo } = get();
  
      const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
  
      const me = useAuthStore.getState().user;
  
      const tempId = Date.now();
  
  
  
      try {
  
        // 1. Encrypt the file and get the raw key
  
        updateActivity(activityId, { progress: 25, fileName: `Encrypting ${file.name}...` });
  
        const { encryptedBlob, key: rawFileKey } = await encryptFile(file);
  
        
  
        // 2. Encrypt the raw key for transmission
  
        const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId);
  
  
  
        // 3. Upload the encrypted file
  
        updateActivity(activityId, { progress: 50, fileName: `Uploading ${file.name}...` });
  
        const form = new FormData();
  
        // Use original file name to preserve extension on the server
  
        const encryptedFile = new File([encryptedBlob], file.name, { type: "application/octet-stream" });
  
        form.append("file", encryptedFile);
  
        const { file: fileData } = await apiUpload<{ file: any }> ({
  
          path: `/api/uploads/${conversationId}/upload`,
  
          formData: form,
  
          onUploadProgress: (progress) => updateActivity(activityId, { progress: 50 + (progress / 2) }),
  
        });
  
        
  
        updateActivity(activityId, { progress: 100, fileName: 'Finishing...' });
  
        setTimeout(() => removeActivity(activityId), 1000); 
  
  
  
        // 4. Create optimistic message with RAW key for local display/decryption
  
        const optimisticMessage: Message = {
  
          id: `temp-${tempId}`, tempId, conversationId, senderId: me!.id, sender: me!, createdAt: new Date().toISOString(), optimistic: true,
  
          fileUrl: fileData.url, fileName: file.name, fileType: `${file.type};encrypted=true`, fileSize: encryptedBlob.size,
  
          content: '',
  
          fileKey: rawFileKey,
  
          sessionId: sessionId,
  
          repliedTo: replyingTo || undefined,
  
        };
  
        addOptimisticMessage(conversationId, optimisticMessage);
  
  
  
        // 5. Create final payload with ENCRYPTED key for the server
  
        const finalPayload = {
  
          fileUrl: fileData.url, fileName: file.name, fileType: `${file.type};encrypted=true`, fileSize: encryptedBlob.size,
  
          content: '',
  
          fileKey: encryptedFileKey,
  
          sessionId: sessionId,
  
          repliedToId: replyingTo?.id,
  
        };
  
        
  
        // 6. Emit to socket
  
        getSocket().emit("message:send", { conversationId, tempId, ...finalPayload }, (ack: { ok: boolean, error?: string, msg?: Message }) => {
          if (ack.ok && ack.msg) {
            useMessageStore.getState().replaceOptimisticMessage(conversationId, tempId, ack.msg);
          } else {
            toast.error(`Failed to send file: ${ack.error || 'Unknown error'}`);
            updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
          }
        });
  
  
  
        set({ replyingTo: null });
  
  
  
      } catch (error: any) {
  
        const errorMsg = handleApiError(error);
  
        toast.error(`File upload failed: ${errorMsg}`);
  
        removeActivity(activityId);
  
      }
  
    },

  // This function is now completely self-contained for sending voice messages.
  handleStopRecording: async (conversationId, blob, duration) => {
    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activityId = addActivity({ type: 'upload', fileName: 'Encrypting & Uploading Voice...', progress: 0 });
    const { replyingTo } = get();
    const { addOptimisticMessage, updateMessage } = useMessageStore.getState();
    const me = useAuthStore.getState().user;
    const tempId = Date.now();

    try {
      // 1. Encrypt the audio file and get the raw key
      updateActivity(activityId, { progress: 25, fileName: 'Encrypting voice message...' });
      const { encryptedBlob, key: rawFileKey } = await encryptFile(blob);
      console.log("handleStopRecording: Raw file key for optimistic UI:", rawFileKey);
      
      // 2. Encrypt the raw key for transmission
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(rawFileKey, conversationId);
      console.log("handleStopRecording: Encrypted file key for server:", encryptedFileKey);

      // 3. Upload the encrypted file
      updateActivity(activityId, { progress: 50, fileName: 'Uploading voice message...' });
      const form = new FormData();
      const encryptedFile = new File([encryptedBlob], "voice-message.webm", { type: "application/octet-stream" });
      form.append("file", encryptedFile);
      const { file: fileData } = await apiUpload<{ file: any }>({
        path: `/api/uploads/${conversationId}/upload`,
        formData: form,
        onUploadProgress: (progress) => updateActivity(activityId, { progress: 50 + (progress / 2) }),
      });
      
      updateActivity(activityId, { progress: 100, fileName: 'Finishing...' });
      setTimeout(() => removeActivity(activityId), 1000); 

      // 4. Create optimistic message with RAW key for local playback
      const optimisticMessage: Message = {
        id: `temp-${tempId}`, tempId, conversationId, senderId: me!.id, sender: me!, createdAt: new Date().toISOString(), optimistic: true,
        fileUrl: fileData.url, fileName: "voice-message.webm", fileType: "audio/webm;encrypted=true", fileSize: encryptedBlob.size,
        duration: duration,
        content: '', // Content is empty for file messages now
        fileKey: rawFileKey, // Use RAW key for optimistic message
        sessionId: sessionId,
        repliedTo: replyingTo || undefined,
      };
      addOptimisticMessage(conversationId, optimisticMessage);

      // 5. Create final payload with ENCRYPTED key for the server
      const finalPayload = {
        fileUrl: fileData.url,
        fileName: "voice-message.webm",
        fileType: "audio/webm;encrypted=true",
        fileSize: encryptedBlob.size,
        duration: duration,
        content: '', // Content is empty
        fileKey: encryptedFileKey, // Use ENCRYPTED key in the dedicated field
        sessionId: sessionId,
        repliedToId: replyingTo?.id,
      };

      console.log("handleStopRecording: Final payload being sent to server:", finalPayload);
      
      // 6. Emit to socket
      getSocket().emit("message:send", { conversationId, tempId, ...finalPayload }, (ack: { ok: boolean, error?: string, msg?: Message }) => {
        if (ack.ok && ack.msg) {
          useMessageStore.getState().replaceOptimisticMessage(conversationId, tempId, ack.msg);
        } else {
          toast.error(`Failed to send voice message: ${ack.error || 'Unknown error'}`);
          updateMessage(conversationId, `temp-${tempId}`, { error: true, optimistic: false });
        }
      });

      set({ replyingTo: null });

    } catch (error: any) {
      const errorMsg = handleApiError(error);
      toast.error(`Voice message failed: ${errorMsg}`);
      removeActivity(activityId);
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