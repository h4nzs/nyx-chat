import { createWithEqualityFn } from "zustand/traditional";
import { api, apiUpload, handleApiError } from "@lib/api";
import { getSocket } from "@lib/socket";
import { encryptMessage, decryptMessage, ensureAndRatchetSession } from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore, type User } from "./auth";
import type { Message } from "./conversation"; // Import type from conversation store
import useDynamicIslandStore from './dynamicIsland';

// --- Helper Functions ---

export async function decryptMessageObject(message: Message): Promise<Message> {
  const decryptedMsg = { ...message };
  try {
    if (decryptedMsg.content) {
      // Store original ciphertext before attempting decryption
      decryptedMsg.ciphertext = decryptedMsg.content;
      decryptedMsg.content = await decryptMessage(decryptedMsg.content, decryptedMsg.conversationId, decryptedMsg.sessionId);
    }
    // Also handle repliedTo content if it exists
    if (decryptedMsg.repliedTo?.content) {
      // No need to store ciphertext for replies, they are just for display
      decryptedMsg.repliedTo.content = await decryptMessage(decryptedMsg.repliedTo.content, decryptedMsg.conversationId, decryptedMsg.repliedTo.sessionId);
    }
    return decryptedMsg;
  } catch (e) {
    console.error("Decryption failed in decryptMessageObject", e);
    decryptedMsg.content = '[Failed to decrypt message]';
    return decryptedMsg;
  }
}

// --- State Type ---

type State = {
  messages: Record<string, Message[]>;
  replyingTo: Message | null;
  isFetchingMore: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  typingLinkPreview: any | null; // For live link previews
  hasLoadedHistory: Record<string, boolean>;
  
  // Actions
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
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  addReaction: (conversationId: string, messageId: string, reaction: any) => void;
  removeReaction: (conversationId, string, reactionId: string) => void;
  updateSenderDetails: (user: Partial<User>) => void;
  updateMessageStatus: (conversationId: string, messageId: string, userId: string, status: string) => void;
  clearMessagesForConversation: (conversationId: string) => void;
  retrySendMessage: (message: Message) => void;
  addSystemMessage: (conversationId: string, content: string) => void;
};

// --- Zustand Store ---

export const useMessageStore = createWithEqualityFn<State>((set, get) => ({
  messages: {},
  isFetchingMore: {},
  hasMore: {},
  hasLoadedHistory: {},

  addSystemMessage: (conversationId, content) => {
    const systemMessage: Message = {
      id: `system_${Date.now()}`,
      type: 'SYSTEM',
      conversationId,
      content,
      createdAt: new Date().toISOString(),
      senderId: 'system', // Assign a special senderId
    };
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: [...(state.messages[conversationId] || []), systemMessage],
      },
    }));
  },

  loadMessagesForConversation: async (id) => {
    if (get().hasLoadedHistory[id]) return;

    // Ensure a session key exists before fetching messages
    try {
      await ensureAndRatchetSession(id);
    } catch (ratchetError) {
      console.error("Failed to establish session, decryption may fail:", ratchetError);
      toast.error("Could not establish a secure session. Messages may not decrypt.");
      // We can still try to load messages, they will just fail to decrypt individually
    }

    try {
      set(state => ({ 
        hasMore: { ...state.hasMore, [id]: true },
        isFetchingMore: { ...state.isFetchingMore, [id]: false },
      }));
      const res = await api<{ items: Message[] }>(`/api/messages/${id}`);
      const fetchedMessages = res.items || [];
      const processedMessages: Message[] = [];
      const failedSessionIds = new Set<string>();

      for (const message of fetchedMessages) {
        try {
          const decryptedMessage = await decryptMessageObject(message);
          processedMessages.push(decryptedMessage);
        } catch (e) {
          console.error(`Decryption failed for message ${message.id} during initial load. Requesting key.`, e);
          // Add message with placeholder and mark session for key request
          processedMessages.push({ ...message, content: '[Requesting key to decrypt...]' });
          if (message.sessionId) {
            failedSessionIds.add(message.sessionId);
          }
        }
      }

      // Emit key requests for all unique failed session IDs
      for (const sessionId of failedSessionIds) {
        emitSessionKeyRequest(id, sessionId);
      }
      
      set(state => {
        const existingMessages = state.messages[id] || [];
        const messageMap = new Map(existingMessages.map(m => [m.id, m]));
        processedMessages.forEach(m => messageMap.set(m.id, m));
        
        const allMessages = Array.from(messageMap.values());
        allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        const newState = {
          ...state,
          messages: {
            ...state.messages,
            [id]: allMessages,
          },
          hasMore: {
            ...state.hasMore,
            [id]: fetchedMessages.length >= 50,
          },
          hasLoadedHistory: { // Mark history as loaded
            ...state.hasLoadedHistory,
            [id]: true,
          }
        };

        // Immediately try to load the previous page if the screen isn't full
        if (fetchedMessages.length >= 50) {
          get().loadPreviousMessages(id);
        }
        
        return newState;
      });

    } catch (error) {
      console.error(`Failed to load messages for ${id}`, error);
      set(state => ({ 
        messages: { ...state.messages, [id]: [] },
        hasLoadedHistory: { ...state.hasLoadedHistory, [id]: false }, // Allow retry on failure
      }));
    }
  },

  loadPreviousMessages: async (conversationId) => {
    const { isFetchingMore, hasMore, messages } = get();
    if (isFetchingMore[conversationId] || !hasMore[conversationId]) return;

    const currentMessages = messages[conversationId] || [];
    const oldestMessage = currentMessages[0];
    if (!oldestMessage) return;

    set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: true } }));

    try {
      const res = await api<{ items: Message[] }>(`/api/messages/${conversationId}?cursor=${oldestMessage.id}`);
      const decryptedItems = await Promise.all((res.items || []).map(decryptMessageObject));
      decryptedItems.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      if (decryptedItems.length < 50) {
        set(state => ({ hasMore: { ...state.hasMore, [conversationId]: false } }));
      }

      set(state => ({
        messages: {
          ...state.messages,
          [conversationId]: [...decryptedItems, ...currentMessages],
        },
      }));
    } catch (error) {
      console.error("Failed to load previous messages", error);
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: false } }));
    }
  },

  // --- Actions to be called by socket store ---
  addOptimisticMessage: (conversationId, message) => {
    set(state => ({ 
      messages: { 
        ...state.messages, 
        [conversationId]: [...(state.messages[conversationId] || []), message]
      }
    }));
  },

  addIncomingMessage: (conversationId, message) => {
    set(state => {
      const currentMessages = state.messages[conversationId] || [];
      if (currentMessages.some(m => m.id === message.id)) return state; // Prevent duplicates
      // Explicitly build the message object to ensure all properties are kept
      const messageWithPreview = {
        ...message,
        linkPreview: message.linkPreview,
      };
      return {
        messages: { 
          ...state.messages, 
          [conversationId]: [...currentMessages, messageWithPreview]
        }
      };
    });
  },

  replaceOptimisticMessage: (conversationId, tempId, newMessage) => {
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).map(m => {
          if (m.tempId === tempId) {
            // Preserve optimistic data but update with server confirmation
            return { 
              ...m, 
              id: newMessage.id,
              createdAt: newMessage.createdAt,
              optimistic: false, 
              error: false, 
              linkPreview: newMessage.linkPreview // Explicitly carry over the preview
            };
          }
          return m;
        })
      }
    }));
  },

  updateMessage: (conversationId, messageId, updates) => {
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).map(m => 
          m.id === messageId ? { ...m, ...updates } : m
        )
      }
    }));
  },

  addReaction: (conversationId, messageId, reaction) => {
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).map(m => {
          if (m.id === messageId) {
            return { ...m, reactions: [...(m.reactions || []), reaction] };
          }
          return m;
        })
      }
    }));
  },

  removeReaction: (conversationId, messageId, reactionId) => {
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).map(m => {
          if (m.id === messageId) {
            return { ...m, reactions: (m.reactions || []).filter(r => r.id !== reactionId) };
          }
          return m;
        })
      }
    }));
  },

  updateSenderDetails: (user) => {
    set(state => {
      const newMessages = { ...state.messages };
      for (const convoId in newMessages) {
        newMessages[convoId] = newMessages[convoId].map(m => {
          if (m.sender?.id === user.id) {
            return { ...m, sender: { ...m.sender, ...user } };
          }
          return m;
        });
      }
      return { messages: newMessages };
    });
  },

  updateMessageStatus: (conversationId, messageId, userId, status) => {
    set(state => {
      const newMessages = { ...state.messages };
      const convoMessages = newMessages[conversationId];
      if (!convoMessages) return state;

      newMessages[conversationId] = convoMessages.map(m => {
        if (m.id === messageId) {
          const existingStatus = m.statuses?.find(s => s.userId === userId);
          if (existingStatus) {
            return { ...m, statuses: m.statuses!.map(s => s.userId === userId ? { ...s, status } : s) };
          } else {
            return { ...m, statuses: [...(m.statuses || []), { userId, status, messageId, id: `temp-status-${Date.now()}` }] };
          }
        }
        return m;
      });

      return { messages: newMessages };
    });
  },

  clearMessagesForConversation: (conversationId) => {
    set(state => {
      const newMessages = { ...state.messages };
      delete newMessages[conversationId];
      return { messages: newMessages };
    });
  },

  retrySendMessage: (message: Message) => {
    const { conversationId, tempId, content, fileUrl, fileName, fileType, fileSize, repliedToId } = message;
    
    // Hapus pesan yang gagal dari state
    set(state => ({
      messages: {
        ...state.messages,
        [conversationId]: state.messages[conversationId]?.filter(m => m.tempId !== tempId) || [],
      },
    }));

    // Kirim ulang pesan
    get().sendMessage(conversationId, { content, fileUrl, fileName, fileType, fileSize, repliedToId });
  },
}));
