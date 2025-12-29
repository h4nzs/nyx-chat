import { createWithEqualityFn } from "zustand/traditional";
import { api, apiUpload } from "@lib/api";
import { getSocket, emitSessionKeyRequest, emitGroupKeyDistribution } from "@lib/socket";
import { encryptMessage, decryptMessage, ensureAndRatchetSession, encryptFile, ensureGroupSession } from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore, type User } from "./auth";
import type { Message } from "./conversation";
import useDynamicIslandStore from './dynamicIsland';
import { useConversationStore } from "./conversation";

/**
 * Logika Dekripsi Terpusat (Single Source of Truth)
 * Menangani dekripsi teks biasa DAN kunci file.
 */
export async function decryptMessageObject(message: Message): Promise<Message> {
  // 1. Clone pesan agar tidak memutasi state secara tidak sengaja
  const decryptedMsg = { ...message };

  try {
    // -------------------------------------------------------------------------
    // LOGIKA PENENTUAN KONTEKS (CRITICAL FIX)
    // Jangan mengandalkan state conversationStore untuk menentukan isGroup,
    // karena state tersebut mungkin belum sinkron saat pesan baru masuk (race condition).
    // Gunakan properti pesan itu sendiri sebagai kebenaran mutlak.
    // -------------------------------------------------------------------------
    
    // Jika sessionId ADA, ini PASTI 1-on-1 (Private).
    // Jika sessionId KOSONG, ini diasumsikan Group.
    const isGroup = !decryptedMsg.sessionId;

    // 2. Tentukan Payload yang Akan Didekripsi
    // Prioritas: Jika ada fileKey, itu yang harus didekripsi (untuk pesan File).
    // Jika tidak, baru cek content (untuk pesan Teks).
    const contentToDecrypt = decryptedMsg.fileKey || decryptedMsg.content;

    // Jika tidak ada yang perlu didekripsi, kembalikan apa adanya (misal pesan sistem)
    if (!contentToDecrypt) {
      return decryptedMsg;
    }

    // 3. Eksekusi Dekripsi
    // Kita simpan ciphertext asli untuk keperluan debugging jika perlu
    decryptedMsg.ciphertext = contentToDecrypt;

    const result = await decryptMessage(
      contentToDecrypt,
      decryptedMsg.conversationId,
      isGroup,
      decryptedMsg.sessionId
    );

    // 4. Proses Hasil
    if (result.status === 'success') {
      // PENTING: Untuk pesan file, 'value' ini adalah KUNCI FILE TERDEKRIPSI.
      // UI (FileAttachment) harus tahu bahwa jika pesan punya fileUrl,
      // maka message.content berisi kunci enkripsi file, bukan teks chat.
      decryptedMsg.content = result.value;
      
      // Opsional: Anda bisa menghapus field fileKey yang terenkripsi agar tidak membingungkan
      // decryptedMsg.fileKey = undefined; 
    } else if (result.status === 'pending') {
      // Kasus "waiting_for_key"
      decryptedMsg.content = result.reason || 'waiting_for_key';
    } else {
      // Kasus Error
      console.warn(`[Decrypt] Failed for msg ${message.id}:`, result.error);
      decryptedMsg.content = 'Decryption failed';
    }

    // 5. Dekripsi Replied Message (Nested)
    // Logika yang sama harus diterapkan secara rekursif jika ada reply
    if (decryptedMsg.repliedTo) {
        // Kita panggil fungsi ini lagi secara rekursif untuk pesan yang dibalas
        // (Pastikan tidak infinite loop, tapi struktur data message tree biasanya aman)
        decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo);
    }

    return decryptedMsg;

  } catch (e) {
    console.error("Critical error in decryptMessageObject:", e);
    return { ...message, content: "Error processing message" };
  }
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
  sendMessage: (conversationId: string, data: Partial<Message>) => Promise<void>;
  uploadFile: (conversationId: string, file: File) => Promise<void>;
  loadMessagesForConversation: (id: string) => Promise<void>;
  loadPreviousMessages: (conversationId: string) => Promise<void>;
  addOptimisticMessage: (conversationId: string, message: Message) => void;
  addIncomingMessage: (conversationId: string, message: Message) => void;
  replaceOptimisticMessage: (conversationId: string, tempId: number, newMessage: Message) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  addReaction: (conversationId: string, messageId: string, reaction: any) => void;
  removeReaction: (conversationId: string, messageId: string, reactionId: string) => void;
  replaceOptimisticReaction: (conversationId: string, messageId: string, tempId: string, finalReaction: any) => void;
  updateSenderDetails: (user: Partial<User>) => void;
  updateMessageStatus: (conversationId: string, messageId: string, userId: string, status: string) => void;
  clearMessagesForConversation: (conversationId: string) => void;
  retrySendMessage: (message: Message) => void;
  addSystemMessage: (conversationId: string, content: string) => void;
  reDecryptPendingMessages: (conversationId: string) => Promise<void>;
  reset: () => void;
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

  sendMessage: async (conversationId, data) => {
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

    // Ensure group session and distribute keys if necessary BEFORE sending the message
    if (isGroup) {
      try {
        const distributionKeys = await ensureGroupSession(conversationId, conversation.participants);
        if (distributionKeys && distributionKeys.length > 0) {
          console.log(`[message.ts] sendMessage: New group key generated, distributing ${distributionKeys.length} keys.`);
          emitGroupKeyDistribution(conversationId, distributionKeys);
        }
      } catch (e) {
        console.error("Failed to ensure group session, message will likely fail for others.", e);
        toast.error("Failed to establish group session.");
        // Optional: We could abort sending here, but for now we'll let it proceed to not block the user.
      }
    }

    const tempId = Date.now();
    try {
      const optimisticMessage: Message = {
        ...data,
        id: `temp_${tempId}`,
        tempId: tempId,
        optimistic: true,
        sender: user,
        senderId: user.id,
        createdAt: new Date().toISOString(),
        conversationId,
        reactions: [],
        statuses: [{ userId: user.id, status: 'READ', messageId: `temp_${tempId}`, id: `temp_status_${tempId}` }],
      };

      // Store original content for potential retry before encrypting
      if (data.content) {
        optimisticMessage.preview = data.content;
        const { ciphertext, sessionId } = await encryptMessage(data.content, conversationId, isGroup);
        optimisticMessage.content = ciphertext;
        optimisticMessage.sessionId = sessionId;
      }
      if (data.fileKey) {
        const { ciphertext, sessionId } = await encryptMessage(data.fileKey, conversationId, isGroup);
        optimisticMessage.fileKey = ciphertext;
        optimisticMessage.sessionId = sessionId;
      }

      get().addOptimisticMessage(conversationId, optimisticMessage);
      // Use original content for the last message preview
      useConversationStore.getState().updateConversationLastMessage(conversationId, { ...optimisticMessage, content: data.content, fileType: data.fileType, fileName: data.fileName });
      set({ replyingTo: null, typingLinkPreview: null });
      
      getSocket()?.emit("message:send", optimisticMessage, (res: { ok: boolean, msg?: Message, error?: string }) => {
        if (res.ok && res.msg) {
          get().replaceOptimisticMessage(conversationId, tempId, res.msg);
        } else {
          console.error("Failed to send message:", res.error);
          toast.error(`Failed to send message: ${res.error}`);
          set(state => ({
            messages: {
              ...state.messages,
              [conversationId]: state.messages[conversationId]?.map(m => m.tempId === tempId ? { ...m, error: true } : m) || [],
            },
          }));
        }
      });

    } catch (error) {
      console.error("Failed to encrypt and send message:", error);
      toast.error("Could not send secure message.");
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
    const isGroup = conversation.isGroup;

    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const uploadId = addActivity({ type: 'upload', fileName: file.name, progress: 0 });
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
      statuses: [{ userId: user.id, status: 'READ', messageId: `temp_${tempId}`, id: `temp_status_${tempId}` }],
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileUrl: URL.createObjectURL(file) // Use local blob URL for instant preview
    };
    get().addOptimisticMessage(conversationId, optimisticMessage);
    useConversationStore.getState().updateConversationLastMessage(conversationId, optimisticMessage);
    
    try {
      updateActivity(uploadId, { progress: 10 });
      // 2. Encrypt file and its key
      const { encryptedBlob, key: fileKey } = await encryptFile(file);
      const { ciphertext: encryptedFileKey, sessionId } = await encryptMessage(fileKey, conversationId, isGroup);
      updateActivity(uploadId, { progress: 40 });

      // 3. Upload file and send message data
      const formData = new FormData();
      formData.append('file', encryptedBlob, file.name);
      if (sessionId) formData.append('sessionId', sessionId);
      formData.append('fileKey', encryptedFileKey);
      formData.append('tempId', tempId.toString());
      // Append other relevant data
      formData.append('fileType', file.type);
      formData.append('fileSize', file.size.toString());
      
      await apiUpload<Message>({
        path: `/api/uploads/${conversationId}/upload`, 
        formData,
        onUploadProgress: (p) => updateActivity(uploadId, { progress: 40 + (p * 0.5) }) // Scale progress to 40-90 range
      });
      
      updateActivity(uploadId, { progress: 100 });
      // 4. Konfirmasi dan penggantian pesan optimistik sekarang ditangani oleh event listener 'message:new' di socket.ts
      // untuk menyatukan alur logika dan menghindari race condition.
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
    } else {
      console.log("Skipping session setup: No keys restored.");
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
        const messageMap = new Map(existingMessages.map(m => [m.id, m]));
        processedMessages.forEach(m => messageMap.set(m.id, m));
        const allMessages = Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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
      const decryptedItems = await Promise.all((res.items || []).map(decryptMessageObject));
      decryptedItems.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (decryptedItems.length < 50) set(state => ({ hasMore: { ...state.hasMore, [conversationId]: false } }));
      set(state => ({ messages: { ...state.messages, [conversationId]: [...decryptedItems, ...(state.messages[conversationId] || [])] } }));
    } catch (error) {
      console.error("Failed to load previous messages", error);
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: false } }));
    }
  },

  addOptimisticMessage: (conversationId, message) => {
    console.log("Adding optimistic message:", message);
    set(state => ({ messages: { ...state.messages, [conversationId]: [...(state.messages[conversationId] || []), message] } }))
  },
  addIncomingMessage: (conversationId, message) => set(state => {
    const currentMessages = state.messages[conversationId] || [];
    if (currentMessages.some(m => m.id === message.id)) return state;
    return { messages: { ...state.messages, [conversationId]: [...currentMessages, message] } };
  }),
  replaceOptimisticMessage: (conversationId, tempId, newMessage) => set(state => {
    // Find the optimistic message to revoke its blob URL if it exists
    const optimisticMessage = state.messages[conversationId]?.find(m => m.tempId === tempId);
    if (optimisticMessage?.fileUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(optimisticMessage.fileUrl);
    }
    return {
      messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.tempId === tempId ? { ...newMessage, tempId: undefined } : m) }
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
  addReaction: (conversationId, messageId, reaction) => set(state => ({
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
  removeReaction: (conversationId, messageId, reactionId) => set(state => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, reactions: (m.reactions || []).filter(r => r.id !== reactionId) } : m) } })),
  replaceOptimisticReaction: (conversationId, messageId, tempId, finalReaction) => set(state => ({
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
      newMessages[convoId] = newMessages[convoId].map(m => m.sender?.id === user.id ? { ...m, sender: { ...m.sender, ...user } } : m);
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
        if (existingStatus) return { ...m, statuses: m.statuses!.map(s => s.userId === userId ? { ...s, status } : s) };
        else return { ...m, statuses: [...(m.statuses || []), { userId, status, messageId, id: `temp-status-${Date.now()}` }] };
      }
      return m;
    });
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
    // Use the original content from the 'preview' field for the retry
    get().sendMessage(conversationId, { content: preview, fileUrl, fileName, fileType, fileSize, repliedToId });
  },

  addSystemMessage: (conversationId, content) => {
    const systemMessage: Message = {
      id: `system_${Date.now()}`, type: 'SYSTEM', conversationId, content, createdAt: new Date().toISOString(), senderId: 'system' };
    set(state => ({ messages: { ...state.messages, [conversationId]: [...(state.messages[conversationId] || []), systemMessage] } }));
  },

  reDecryptPendingMessages: async (conversationId: string) => {
    console.log(`[re-decrypt] Triggered for conversation ${conversationId}`);
    const state = get();
    const conversationMessages = state.messages[conversationId];
    if (!conversationMessages) return;

    const pendingMessages = conversationMessages.filter(
      m => m.content === 'waiting_for_key' || m.content === '[Requesting group key...]' || m.content === '[Requesting key to decrypt...]'
    );

    if (pendingMessages.length === 0) {
      console.log(`[re-decrypt] No pending messages found for ${conversationId}.`);
      return;
    }

    console.log(`[re-decrypt] Found ${pendingMessages.length} pending messages to re-decrypt.`);

    const reDecryptedMessages = await Promise.all(
      pendingMessages.map(msg => decryptMessageObject({ ...msg, content: msg.ciphertext }))
    );

    const messageMap = new Map(conversationMessages.map(m => [m.id, m]));
    reDecryptedMessages.forEach(m => messageMap.set(m.id, m));
    
    const newMessagesForConvo = Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    set({
      messages: {
        ...state.messages,
        [conversationId]: newMessagesForConvo,
      },
    });
    console.log(`[re-decrypt] Re-decryption complete for ${conversationId}.`);
  },
}));