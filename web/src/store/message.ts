import { createWithEqualityFn } from "zustand/traditional";
import { api, apiUpload } from "@lib/api";
import { getSocket, emitSessionKeyRequest, emitGroupKeyDistribution } from "@lib/socket";
import { encryptMessage, decryptMessage, ensureAndRatchetSession, encryptFile, ensureGroupSession } from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore, type User } from "./auth";
import type { Message } from "./conversation";
import useDynamicIslandStore, { UploadActivity } from './dynamicIsland';
import { useConversationStore } from "./conversation";
import { addToQueue, getQueueItems, removeFromQueue, updateQueueAttempt } from "@lib/offlineQueueDb";
import { useConnectionStore } from "./connection";

/**
 * Logika Dekripsi Terpusat (Single Source of Truth)
 * Menangani dekripsi teks biasa DAN kunci file.
 */
export async function decryptMessageObject(message: Message, seenIds = new Set<string>(), depth = 0): Promise<Message> {
  // 1. Clone pesan dan tambahkan recursion guard
  const decryptedMsg = { ...message };
  
  if (seenIds.has(decryptedMsg.id) || depth > 10) {
    decryptedMsg.repliedTo = undefined; // Putus rantai rekursif
    return decryptedMsg;
  }
  seenIds.add(decryptedMsg.id);

  try {
    // -------------------------------------------------------------------------
    // LOGIKA PENENTUAN KONTEKS (CRITICAL FIX)
    // -------------------------------------------------------------------------
    const isGroup = !decryptedMsg.sessionId;

    // 2. Tentukan Payload yang Akan Didekripsi
    const contentToDecrypt = decryptedMsg.fileKey || decryptedMsg.content;

    if (!contentToDecrypt) {
      return decryptedMsg;
    }

    // 3. Eksekusi Dekripsi
    decryptedMsg.ciphertext = contentToDecrypt;
    const result = await decryptMessage(
      contentToDecrypt,
      decryptedMsg.conversationId,
      isGroup,
      decryptedMsg.sessionId
    );

    // 4. Proses Hasil
    if (result.status === 'success') {
      const plainText = result.value;
      decryptedMsg.content = plainText;

      // BLIND ATTACHMENT PARSING
      if (plainText.startsWith('{') && plainText.includes('"type":"file"')) {
        try {
          const metadata = JSON.parse(plainText);
          if (metadata.type === 'file') {
            decryptedMsg.fileUrl = metadata.url;
            decryptedMsg.fileKey = metadata.key;
            decryptedMsg.fileName = metadata.name;
            decryptedMsg.fileSize = metadata.size;
            decryptedMsg.fileType = metadata.mimeType;
            decryptedMsg.content = null; 
          }
        } catch (e) { }
      }
      
      // REACTION PARSING (Flag it for post-processing)
      // Note: We leave content as is, but helpers will detect it.

    } else if (result.status === 'pending') {
      decryptedMsg.content = result.reason || 'waiting_for_key';
    } else {
      console.warn(`Decryption failed for msg ${decryptedMsg.id}:`, result.error);
      // Change fallback to 'waiting_for_key' to allow re-decryption attempts
      // when session keys arrive via socket.
      decryptedMsg.content = 'waiting_for_key';
      decryptedMsg.type = 'SYSTEM'; 
    }

    // 5. Dekripsi Replied Message (Nested & Guarded)
    if (decryptedMsg.repliedTo) {
        decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo, seenIds, depth + 1);
    }

    return decryptedMsg;

  } catch (e) {
    console.error("Critical error in decryptMessageObject:", e);
    return { ...message, content: "🔒 Decryption Error", type: 'SYSTEM' };
  }
}

// Robust helper to parse reaction payload
function parseReaction(content: string | null | undefined): { targetMessageId: string, emoji: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    // Quick check before parsing
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"reaction"')) return null;
    
    const payload = JSON.parse(trimmed);
    if (payload.type === 'reaction' && payload.targetMessageId && payload.emoji) {
      return payload;
    }
  } catch (e) {}
  return null;
}

// Helper to separate messages and reactions
function processMessagesAndReactions(decryptedItems: Message[], existingMessages: Message[] = []) {
  const chatMessages: Message[] = [];
  const reactions: any[] = [];

  // 1. Separate content
  for (const msg of decryptedItems) {
    const reactionPayload = parseReaction(msg.content);
    if (reactionPayload) {
        reactions.push({
          id: msg.id, // Use message ID as reaction ID
          messageId: reactionPayload.targetMessageId,
          emoji: reactionPayload.emoji,
          userId: msg.senderId,
          createdAt: msg.createdAt,
          user: msg.sender, // Include sender info
          isMessage: true
        });
    } else {
      chatMessages.push(msg);
    }
  }

  // 2. Apply reactions to messages (both new and existing)
  // We create a map for O(1) lookup
  const messageMap = new Map([...existingMessages, ...chatMessages].map(m => [m.id, m]));
  
  for (const reaction of reactions) {
    const target = messageMap.get(reaction.messageId);
    if (target) {
      const existingReactions = target.reactions || [];
      // Avoid duplicates
      if (!existingReactions.some(r => r.id === reaction.id)) {
        target.reactions = [...existingReactions, reaction];
      }
    }
  }

  return Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

type State = {
  messages: Record<string, Message[]>;
  replyingTo: Message | null;
  isFetchingMore: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  typingLinkPreview: any | null;
  hasLoadedHistory: Record<string, boolean>;
};

type Actions = {
  setReplyingTo: (message: Message | null) => void;
  fetchTypingLinkPreview: (text: string) => void;
  clearTypingLinkPreview: () => void;
  sendReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  uploadFile: (conversationId: string, file: File) => Promise<void>;
  loadMessagesForConversation: (id: string) => Promise<void>;
  loadPreviousMessages: (conversationId: string) => Promise<void>;
  addOptimisticMessage: (conversationId: string, message: Message) => void;
  addIncomingMessage: (conversationId: string, message: Message) => void;
  replaceOptimisticMessage: (conversationId: string, tempId: number, newMessage: Partial<Message>) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  // Old addReaction/removeReaction kept for internal optimistic updates
  addLocalReaction: (conversationId: string, messageId: string, reaction: any) => void;
  removeLocalReaction: (conversationId: string, messageId: string, reactionId: string) => void;
  replaceOptimisticReaction: (conversationId: string, messageId: string, tempId: string, finalReaction: any) => void;
  updateSenderDetails: (user: Partial<User>) => void;
  updateMessageStatus: (conversationId: string, messageId: string, userId: string, status: string) => void;
  clearMessagesForConversation: (conversationId: string) => void;
  retrySendMessage: (message: Message) => void;
  addSystemMessage: (conversationId: string, content: string) => void;
  reDecryptPendingMessages: (conversationId: string) => Promise<void>;
  failPendingMessages: (conversationId: string, reason: string) => void;
  processOfflineQueue: () => Promise<void>;
  reset: () => void;
  resendPendingMessages: () => void;
  sendMessage: (conversationId: string, data: Partial<Message>, tempId?: number) => Promise<void>;
};

const initialState: State = {
  messages: {},
  isFetchingMore: {},
  hasMore: {},
  hasLoadedHistory: {},
  replyingTo: null,
  typingLinkPreview: null,
};

export const useMessageStore = createWithEqualityFn<State & Actions>((set, get) => ({
  ...initialState,

  reset: () => {
    set(initialState);
  },

  setReplyingTo: (message: Message | null) => set({ replyingTo: message }),
  
  fetchTypingLinkPreview: async (text: string) => {
    try {
      const res = await api('/api/previews/link', { method: 'POST', body: JSON.stringify({ text }) });
      set({ typingLinkPreview: res });
    } catch {
      set({ typingLinkPreview: null });
    }
  },
  
  clearTypingLinkPreview: () => set({ typingLinkPreview: null }),

  sendReaction: async (conversationId: string, messageId: string, emoji: string) => {
      const { user } = useAuthStore.getState();
      if (!user) return;

      // Optimistic Update
      const tempId = `temp_react_${Date.now()}`;
      const optimisticReaction = {
          id: tempId,
          messageId,
          emoji,
          userId: user.id,
          createdAt: new Date().toISOString(),
          user: user,
          isMessage: true
      };
      get().addLocalReaction(conversationId, messageId, optimisticReaction);

      // Send as Message
      const metadata = {
          type: 'reaction',
          targetMessageId: messageId,
          emoji
      };
      
      // We use sendMessage to handle encryption and transport
      await get().sendMessage(conversationId, {
          content: JSON.stringify(metadata)
      });
  },

  sendMessage: async (conversationId, data, tempId?: number) => {
    const { user, hasRestoredKeys } = useAuthStore.getState();
    if (!user) return;

    if (!hasRestoredKeys) {
      toast.error("You must restore your keys from your recovery phrase before you can send messages.");
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      toast.error("Conversation not found.");
      return;
    }
    const isGroup = conversation.isGroup;

    // Ensure group session (only for chat messages, not internal stuff if possible, but reaction is a message so yes)
    if (isGroup && useConnectionStore.getState().status === 'connected') {
      try {
        const distributionKeys = await ensureGroupSession(conversationId, conversation.participants);
        if (distributionKeys && distributionKeys.length > 0) {
          emitGroupKeyDistribution(conversationId, distributionKeys);
        }
      } catch (e) {
        console.error("Failed to ensure group session", e);
      }
    }

    const actualTempId = tempId !== undefined ? tempId : Date.now();
    
    // Use helper to detect reaction
    const isReactionPayload = !!parseReaction(data.content);

    // Create optimistic message ONLY if it is NOT a reaction (reactions are handled by sendReaction optimistically)
    if (!isReactionPayload) {
        const optimisticMessage: Message = {
            ...data,
            id: `temp_${actualTempId}`,
            tempId: actualTempId,
            optimistic: true,
            sender: user,
            senderId: user.id,
            createdAt: new Date().toISOString(),
            conversationId,
            reactions: [],
            statuses: [{ userId: user.id, status: 'READ', messageId: `temp_${actualTempId}`, id: `temp_status_${actualTempId}`, updatedAt: new Date().toISOString() }],
            status: 'SENDING', 
        };

        // Encrypt preview for optimistic message content if needed
        if (data.content) {
            optimisticMessage.preview = data.content;
             // We'll encrypt below, but for UI we might want clear text? 
             // Yes, optimistically show clear text.
             // But verify if content is JSON file metadata? 
             // If JSON file metadata, UI handles it (we set fileUrl in uploadFile).
        }

        get().addOptimisticMessage(conversationId, optimisticMessage);
        
        let lastMsgPreview = data.content;
        try {
           if (lastMsgPreview?.startsWith('{') && lastMsgPreview.includes('"type":"file"')) {
               lastMsgPreview = '📎 Sent a file';
           }
        } catch {}
        useConversationStore.getState().updateConversationLastMessage(conversationId, { ...optimisticMessage, content: lastMsgPreview, fileType: data.fileType, fileName: data.fileName });
        set({ replyingTo: null, typingLinkPreview: null });
    }

    try {
      let ciphertext = '', sessionId: string | undefined;
      if (data.content) {
        const result = await encryptMessage(data.content, conversationId, isGroup);
        ciphertext = result.ciphertext;
        sessionId = result.sessionId;
      }
      
      const payload = {
          ...data,
          content: ciphertext,
          sessionId,
          // Remove plain metadata before sending
          fileKey: undefined, fileName: undefined, fileType: undefined, fileSize: undefined
      };

      const socket = getSocket();
      const isConnected = socket?.connected;

      if (!isConnected && !isReactionPayload) {
        // Offline? Queue it!
        // We recreate the optimistic message for the queue
        const queueMsg = { ...data, id: `temp_${actualTempId}`, tempId: actualTempId, conversationId, senderId: user.id, createdAt: new Date().toISOString() } as Message;
        await addToQueue(conversationId, queueMsg, actualTempId);
        return;
      }

      socket?.emit("message:send", { ...payload, conversationId, tempId: actualTempId }, async (res: { ok: boolean, msg?: Message, error?: string }) => {
        if (!isReactionPayload) {
            if (res.ok && res.msg && tempId !== undefined) {
              get().replaceOptimisticMessage(conversationId, actualTempId, { ...res.msg, status: 'SENT' });
            } else if (!res.ok) {
              get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
            }
        }
      });

    } catch (error) {
      console.error("Failed to encrypt/send:", error);
      if (!isReactionPayload) {
         get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
      }
    }
  },

  processOfflineQueue: async () => {
    const queue = await getQueueItems();
    if (queue.length === 0) return;

    const socket = getSocket();
    if (!socket?.connected) return;

    console.log(`[Queue] Processing ${queue.length} offline messages...`);

    for (const item of queue) {
      const { tempId, conversationId, data, attempt } = item;
      
      if (attempt > 5) {
        // Give up after 5 retries
        console.warn(`[Queue] Dropping message ${tempId} after too many retries.`);
        await removeFromQueue(tempId);
        get().updateMessage(conversationId, `temp_${tempId}`, { error: true, status: 'FAILED' });
        continue;
      }

      // Update UI to show we are trying again
      get().updateMessage(conversationId, `temp_${tempId}`, { status: 'SENDING', error: false });

      socket.emit("message:send", data, async (res: { ok: boolean, msg?: Message, error?: string }) => {
        if (res.ok && res.msg) {
          await removeFromQueue(tempId);
          get().replaceOptimisticMessage(conversationId, tempId, { ...res.msg, status: 'SENT' });
        } else {
          console.error(`[Queue] Failed to send queued message ${tempId}:`, res.error);
          await updateQueueAttempt(tempId, attempt + 1);
          // Keep it in queue, but maybe mark visual error if needed?
          // For now, let it stay 'SENDING' or maybe 'FAILED' until next retry
        }
      });

      // Small delay to prevent flooding
      await new Promise(r => setTimeout(r, 200)); 
    }
  },

  uploadFile: async (conversationId, file) => {
    const { user, hasRestoredKeys } = useAuthStore.getState();
    if (!user) return;

    if (!hasRestoredKeys) {
      toast.error("You must restore your keys from your recovery phrase before you can send files.");
      return;
    }
    
    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      toast.error("Conversation not found.");
      return;
    }

    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: file.name, progress: 0 };
    const uploadId = addActivity(activity);
    const tempId = Date.now();
    
    // 1. Create optimistic message
    const optimisticMessage: Message = {
      id: `temp_${tempId}`,
      tempId: tempId,
      optimistic: true,
      sender: user,
      senderId: user.id,
      createdAt: new Date().toISOString(),
      conversationId,
      reactions: [],
      statuses: [{ userId: user.id, status: 'READ', messageId: `temp_${tempId}`, id: `temp_status_${tempId}`, updatedAt: new Date().toISOString() }],
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileUrl: URL.createObjectURL(file) // Use local blob URL for instant preview
    };
    get().addOptimisticMessage(conversationId, optimisticMessage);
    useConversationStore.getState().updateConversationLastMessage(conversationId, optimisticMessage);
    
    try {
      updateActivity(uploadId, { progress: 5 });

      // 2. Encrypt file content and get the key
      const { encryptedBlob, key: fileKey } = await encryptFile(file);
      
      // 3. Encrypt the file key (using conversation session)
      // Note: We don't send this separately anymore, but we need it for the JSON payload
      // Wait, we can't use `encryptMessage` here because it returns { ciphertext, sessionId }
      // AND we want to put this ciphertext INSIDE the JSON payload which is THEN encrypted again?
      // NO.
      // The JSON payload should contain the KEY that decrypts the file.
      // If we put the PLAIN key in the JSON, and then ENCRYPT the JSON with the session key, is it safe?
      // YES. The session key protects the JSON. The JSON protects the file key. The file key protects the file.
      // Double encryption is fine.
      // BUT, if we want to be super standard:
      // We can just put the `fileKey` (base64) into the JSON.
      // Then `sendMessage` encrypts the WHOLE JSON string.
      // So the `fileKey` is never exposed.
      
      updateActivity(uploadId, { progress: 20 });

      // 4. Get Presigned URL
      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: file.name,
              fileType: file.type || 'application/octet-stream', // Use octet-stream for encrypted? Or keep original mime for validation?
              // Ideally we upload encrypted blob, so mime might be application/octet-stream
              // But R2 validation checks extension.
              // Let's keep original fileType for presigned request so server validation passes,
              // but upload the encrypted blob.
              folder: 'attachments',
              fileSize: file.size // Approximate
          })
      });

      updateActivity(uploadId, { progress: 30 });

      // 5. Upload to R2 (PUT)
      await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); // R2 requires matching content-type
          
          xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                  const percentComplete = (e.loaded / e.total) * 60; // Max 60% of total progress bar (30+60=90)
                  updateActivity(uploadId, { progress: 30 + percentComplete });
              }
          };
          
          xhr.onload = () => {
              if (xhr.status === 200) resolve();
              else reject(new Error('Upload failed'));
          };
          
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(encryptedBlob);
      });

      updateActivity(uploadId, { progress: 95 });

      // 6. Create Metadata Payload
      const metadata = {
          type: 'file',
          url: presignedRes.publicUrl,
          key: fileKey, // Plain key, will be encrypted by sendMessage
          name: file.name,
          size: file.size,
          mimeType: file.type
      };

      // 7. Send as Message
      await get().sendMessage(conversationId, {
          content: JSON.stringify(metadata),
          // Store these for optimistic local use (but sendMessage will override content with ciphertext)
          fileName: file.name,
          fileType: file.type
      }, tempId);
      
      updateActivity(uploadId, { progress: 100 });
      setTimeout(() => removeActivity(uploadId), 1000);

    } catch (error) {
      removeActivity(uploadId);
      console.error("File upload failed:", error);
      toast.error(`Failed to upload ${file.name}.`);
      // Mark optimistic message as failed
      set(state => ({
        messages: {
          ...state.messages,
          [conversationId]: state.messages[conversationId]?.map(m => m.tempId === tempId ? { ...m, error: true } : m) || [],
        },
      }));
    }
  },

  loadMessagesForConversation: async (id) => {
    const { hasRestoredKeys } = useAuthStore.getState();
    if (get().hasLoadedHistory[id]) return;

    if (hasRestoredKeys) {
      try {
        // Find the conversation first to determine its type
        const conversation = useConversationStore.getState().conversations.find(c => c.id === id);
        // Key distribution logic is now handled by sendMessage, but we still need to handle the 1-on-1 case.
        if (conversation && !conversation.isGroup) {
          await ensureAndRatchetSession(id);
        }
      } catch (sessionError) {
        console.error("Failed to establish session, decryption may fail:", sessionError);
      }
    }
    
    try {
      set(state => ({ hasMore: { ...state.hasMore, [id]: true }, isFetchingMore: { ...state.isFetchingMore, [id]: false } }));
      const res = await api<{ items: Message[] }>(`/api/messages/${id}`);
      const fetchedMessages = res.items || [];
      const processedMessages: Message[] = [];
      for (const message of fetchedMessages) {
        processedMessages.push(await decryptMessageObject(message));
      }
      set(state => {
        const existingMessages = state.messages[id] || [];
        const allMessages = processMessagesAndReactions(processedMessages, existingMessages);
        
        return {
          messages: { ...state.messages, [id]: allMessages },
          hasMore: { ...state.hasMore, [id]: fetchedMessages.length >= 50 },
          hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true }
        };
      });
    } catch (error) {
      console.error(`Failed to load messages for ${id}`, error);
    }
  },

  loadPreviousMessages: async (conversationId) => {
    const { isFetchingMore, hasMore, messages } = get();
    if (isFetchingMore[conversationId] || !hasMore[conversationId]) return;
    const oldestMessage = messages[conversationId]?.[0];
    if (!oldestMessage) return;
    set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: true } }));
    try {
      const res = await api<{ items: Message[] }>(`/api/messages/${conversationId}?cursor=${oldestMessage.id}`);
      const decryptedItems = await Promise.all((res.items || []).map(m => decryptMessageObject(m)));
      
      set(state => {
        const existingMessages = state.messages[conversationId] || [];
        const allMessages = processMessagesAndReactions(decryptedItems, existingMessages);

        if (decryptedItems.length < 50) set(state => ({ hasMore: { ...state.hasMore, [conversationId]: false } }));
        return { messages: { ...state.messages, [conversationId]: allMessages } };
      });
    } catch (error) {
      console.error("Failed to load previous messages", error);
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: false } }));
    }
  },

  addOptimisticMessage: (conversationId, message) => {
    set(state => ({ messages: { ...state.messages, [conversationId]: [...(state.messages[conversationId] || []), message] } }))
  },
  
  addIncomingMessage: async (conversationId, message) => {
      // Decrypt first
      const decrypted = await decryptMessageObject(message);
      
      // Check if reaction
      const reactionPayload = parseReaction(decrypted.content);
      if (reactionPayload) {
          const reaction = {
              id: decrypted.id,
              messageId: reactionPayload.targetMessageId,
              emoji: reactionPayload.emoji,
              userId: decrypted.senderId,
              createdAt: decrypted.createdAt,
              user: decrypted.sender,
              isMessage: true // Flag as message-based reaction
          };
          get().addLocalReaction(conversationId, reaction.messageId, reaction);
      } else {
          set(state => {
            const currentMessages = state.messages[conversationId] || [];
            if (currentMessages.some(m => m.id === message.id)) return state;
            return { messages: { ...state.messages, [conversationId]: [...currentMessages, decrypted] } };
          });
      }
  },

  replaceOptimisticMessage: (conversationId, tempId, newMessage) => set(state => {
    // Find the optimistic message to revoke its blob URL if it exists
    const optimisticMessage = state.messages[conversationId]?.find(m => m.tempId === tempId);
    if (optimisticMessage?.fileUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(optimisticMessage.fileUrl);
    }
    return {
      messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.tempId === tempId ? { ...m, ...newMessage, tempId: undefined, optimistic: false } : m) }
    };
  }),
  removeMessage: (conversationId, messageId) => set(state => {
    // Find the message to revoke its blob URL if it exists
    const messageToRemove = state.messages[conversationId]?.find(m => m.id === messageId);
    if (messageToRemove?.fileUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(messageToRemove.fileUrl);
    }
    return {
      messages: {
          ...state.messages,
          [conversationId]: (state.messages[conversationId] || []).filter(m => m.id !== messageId),
      }
    };
  }),
  updateMessage: (conversationId, messageId, updates) => set(state => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, ...updates } : m) } })),
  
  addLocalReaction: (conversationId, messageId, reaction: any) => set(state => ({
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] || []).map(m => {
        if (m.id === messageId) {
          const newReactions = [...(m.reactions || [])];
          // Prevent duplicates
          if (!newReactions.some(r => r.id === reaction.id)) {
            newReactions.push(reaction);
          }
          return { ...m, reactions: newReactions };
        }
        return m;
      })
    }
  })),
  
  removeLocalReaction: (conversationId, messageId, reactionId) => set(state => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, reactions: (m.reactions || []).filter(r => r.id !== reactionId) } : m) } })),
  
  replaceOptimisticReaction: (conversationId, messageId, tempId, finalReaction: any) => set(state => ({
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] || []).map(m => {
        if (m.id === messageId) {
          return {
            ...m,
            reactions: (m.reactions || []).map(r => r.id === tempId ? finalReaction : r),
          };
        }
        return m;
      })
    }
  })),
  updateSenderDetails: (user) => set(state => {
    const newMessages = { ...state.messages };
    for (const convoId in newMessages) {
      newMessages[convoId] = newMessages[convoId].map(m => m.sender?.id === user.id ? { ...m, sender: { ...(m.sender || { id: user.id, name: user.name || '', username: user.username || '' }), ...user } } : m) as Message[];
    }
    return { messages: newMessages };
  }),

  updateMessageStatus: (conversationId, messageId, userId, status) => set(state => {
    const newMessages = { ...state.messages };
    const convoMessages = newMessages[conversationId];
    if (!convoMessages) return state;
    newMessages[conversationId] = convoMessages.map(m => {
      if (m.id === messageId) {
        const existingStatus = m.statuses?.find(s => s.userId === userId);
        if (existingStatus) return { ...m, statuses: m.statuses!.map(s => s.userId === userId ? { ...s, status, updatedAt: new Date().toISOString() } : s) };
        else return { ...m, statuses: [...(m.statuses || []), { userId, status, messageId, id: `temp-status-${Date.now()}`, updatedAt: new Date().toISOString() }] };
      }
      return m;
    }) as Message[];
    return { messages: newMessages };
  }),

  clearMessagesForConversation: (conversationId) => set(state => {
    const newMessages = { ...state.messages };
    delete newMessages[conversationId];
    return { messages: newMessages };
  }),

  retrySendMessage: (message: Message) => {
    const { conversationId, tempId, preview, fileUrl, fileName, fileType, fileSize, repliedToId } = message;
    set(state => ({
      messages: { ...state.messages, [conversationId]: state.messages[conversationId]?.filter(m => m.tempId !== tempId) || [] },
    }));
    // Use the original content from the 'preview' field for the retry and preserve the original tempId
    get().sendMessage(conversationId, { content: preview, fileUrl, fileName, fileType, fileSize, repliedToId }, tempId);
  },

  // Resend all pending messages (for sync after reconnect)
  resendPendingMessages: () => {
    const state = get();
    Object.entries(state.messages).forEach(([conversationId, messages]) => {
      messages
        .filter(m => m.optimistic && !m.error) // Only optimistic messages that haven't failed yet
        .forEach(m => {
          // Retry sending the message
          get().retrySendMessage(m);
        });
    });
  },

  addSystemMessage: (conversationId, content) => {
    const systemMessage: Message = {
      id: `system_${Date.now()}`, type: 'SYSTEM', conversationId, content, createdAt: new Date().toISOString(), senderId: 'system' };
    set(state => ({ messages: { ...state.messages, [conversationId]: [...(state.messages[conversationId] || []), systemMessage] } }));
  },

  reDecryptPendingMessages: async (conversationId: string) => {
    console.log(`[ReDecrypt] Starting for conversation ${conversationId} after 1s delay...`);
    // Add a delay to ensure IndexedDB consistency after key storage
    await new Promise(r => setTimeout(r, 1000));

    const state = get();
    const conversationMessages = state.messages[conversationId];
    if (!conversationMessages) {
        console.log(`[ReDecrypt] No messages found in store for ${conversationId}`);
        return;
    }

    const pendingMessages = conversationMessages.filter(
      m => m.content === 'waiting_for_key' || m.content === '[Requesting key to decrypt...]'
    );

    console.log(`[ReDecrypt] Found ${pendingMessages.length} pending messages.`);

    if (pendingMessages.length === 0) {
      return;
    }

    const reDecryptedMessages = await Promise.all(
      pendingMessages.map(async (msg) => {
          console.log(`[ReDecrypt] Attempting to decrypt msg ${msg.id} (Session: ${msg.sessionId})`);
          console.log(`[ReDecrypt] Ciphertext len: ${msg.ciphertext?.length}, Sample: ${msg.ciphertext?.substring(0, 20)}...`);
          const res = await decryptMessageObject({ ...msg, content: msg.ciphertext });
          console.log(`[ReDecrypt] Result for ${msg.id}:`, res.content?.substring(0, 20));
          return res;
      })
    );

    const messageMap = new Map(conversationMessages.map(m => [m.id, m]));
    reDecryptedMessages.forEach(m => {
        // Only update if we actually managed to decrypt it or status changed
        if (m.content !== 'waiting_for_key' && m.content !== '[Requesting key to decrypt...]') {
             // Process potential reactions that were stuck in pending state
             const payload = parseReaction(m.content);
             if (payload) {
                 console.log(`[ReDecrypt] Message ${m.id} is a reaction! applying locally.`);
                 get().addLocalReaction(conversationId, payload.targetMessageId, {
                     id: m.id,
                     messageId: payload.targetMessageId,
                     emoji: payload.emoji,
                     userId: m.senderId,
                     createdAt: m.createdAt,
                     user: m.sender,
                     isMessage: true
                 });
                 // Don't add reaction message to the list (filter it out)
                 messageMap.delete(m.id);
                 return;
             }
             messageMap.set(m.id, m);
        } else {
             // Still pending, keep it in map
             console.log(`[ReDecrypt] Message ${m.id} still pending after retry.`);
             messageMap.set(m.id, m);
        }
    });
    
    const newMessagesForConvo = Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    set({
      messages: {
        ...state.messages,
        [conversationId]: newMessagesForConvo,
      },
    });
  },

  failPendingMessages: (conversationId: string, reason: string) => {
    set(state => {
      const conversationMessages = state.messages[conversationId];
      if (!conversationMessages) return state;

      const newMessages = conversationMessages.map(m => {
        if (m.content === 'waiting_for_key' || m.content === '[Requesting group key...]' || m.content === '[Requesting key to decrypt...]') {
          return { ...m, content: reason };
        }
        return m;
      });

      return {
        messages: {
          ...state.messages,
          [conversationId]: newMessages,
        },
      };
    });
  },
}));
