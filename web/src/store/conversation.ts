import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { useMessageStore, decryptMessageObject } from "./message";
import { getSocket, emitSessionKeyRequest } from "@lib/socket";
import { useVerificationStore } from './verification';
import { useAuthStore, User } from './auth';
// Removed all crypto imports
import toast from 'react-hot-toast';

// --- Type Definitions ---
export type MessageStatus = {
  id: string;
  messageId: string;
  userId: string;
  status: 'SENT' | 'DELIVERED' | 'READ';
  updatedAt: string;
};

export type Message = {
  id: string;
  tempId?: number;
  type?: 'USER' | 'SYSTEM';
  conversationId: string;
  senderId: string;
  sender?: { id: string; encryptedProfile?: string | null };
  content?: string | null;
  imageUrl?: string | null;
  fileUrl?: string | null;
  fileKey?: string | null;
  fileName?: string | null;
  fileType?: string;
  fileSize?: number;
  sessionId?: string | null;
  ciphertext?: string | null;
  createdAt: string;
  error?: boolean;
  preview?: string;
  reactions?: { id: string; emoji: string; userId: string; isMessage?: boolean }[];
  optimistic?: boolean;
  repliedTo?: Message;
  repliedToId?: string;
  linkPreview?: any;
  duration?: number;
  statuses?: MessageStatus[]; // Server delivery statuses (for other users)
  status?: 'SENDING' | 'SENT' | 'FAILED'; // Local status for UI
  deletedAt?: string | Date | null;
  expiresAt?: string | null; // New: Disappearing messages
  isBlindAttachment?: boolean; // New: Flag for Blind Attachments (raw key in fileKey)
  isViewOnce?: boolean;
  isViewed?: boolean;
};

export type Participant = {
  id: string;
  encryptedProfile?: string | null;
  publicKey?: string;
  signingKey?: string; // New: Ed25519 Signing Key for Sender Keys
  role: "ADMIN" | "MEMBER";
  isPinned?: boolean;
};

export type Conversation = {
  id: string;
  isGroup: boolean;
  title?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  creatorId?: string | null;
  participants: Participant[];
  lastMessage: (Message & { preview?: string }) | null;
  updatedAt: string;
  unreadCount: number;
  lastUpdated?: number;
  keyRotationPending?: boolean;
};

// --- Helper Functions ---

const sortConversations = (list: Conversation[], currentUserId: string | undefined) =>
  [...list].sort((a, b) => {
    // First, sort by pinned status (pinned conversations first)
    const aIsPinned = a.participants.some(p => p.id === currentUserId && p.isPinned);
    const bIsPinned = b.participants.some(p => p.id === currentUserId && p.isPinned);

    if (aIsPinned && !bIsPinned) return -1;
    if (!aIsPinned && bIsPinned) return 1;

    // If both are pinned or both are not pinned, sort by last message time
    return new Date(b.lastMessage?.createdAt || b.updatedAt).getTime() - new Date(a.lastMessage?.createdAt || a.updatedAt).getTime();
  });

const withPreview = (msg: Message): Message => {
  if (msg.content) {
    // Check for Reaction Payload
    if (msg.content.trim().startsWith('{') && msg.content.includes('"type":"reaction"')) {
       try {
         const payload = JSON.parse(msg.content);
         if (payload.type === 'reaction') {
            return { ...msg, preview: `Reacted ${payload.emoji || ''}` };
         }
       } catch {}
    }
    return { ...msg, preview: msg.content };
  }
  if (msg.fileUrl) {
    if (msg.fileType?.startsWith('image/')) return { ...msg, preview: "📷 Image" };
    if (msg.fileType?.startsWith('video/')) return { ...msg, preview: "🎥 Video" };
    return { ...msg, preview: `📎 ${msg.fileName || "File"}` };
  }
  return msg;
};

// --- State Type ---

type State = {
  conversations: Conversation[];
  activeId: string | null;
  isSidebarOpen: boolean;
  error: string | null;
  loading: boolean;
  initialLoadCompleted: boolean;
};

type Actions = {
  loadConversations: () => Promise<void>;
  openConversation: (id: string | null) => void;
  deleteConversation: (id: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  toggleSidebar: () => void;
  startConversation: (peerId: string) => Promise<string>;
  searchUsers: (query: string) => Promise<{ id: string; encryptedProfile?: string | null; isVerified?: boolean; publicKey?: string }[]>;
  addOrUpdateConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => void;
  updateParticipantDetails: (user: Partial<User>) => void;
  addParticipants: (conversationId: string, participants: Participant[]) => void;
  removeParticipant: (conversationId: string, userId: string) => void;
  updateParticipantRole: (conversationId: string, userId: string, role: "ADMIN" | "MEMBER") => void;
  updateConversationLastMessage: (conversationId: string, message: Message) => void;
  togglePinConversation: (conversationId: string) => Promise<void>;
  resyncState: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

// --- Zustand Store ---

const initialState: State = {
  conversations: [],
  activeId: null,
  isSidebarOpen: false,
  error: null,
  loading: false,
  initialLoadCompleted: false,
};

export const useConversationStore = createWithEqualityFn<State & Actions>((set, get) => ({
  ...initialState,

  clearError: () => set({ error: null }),

  reset: () => {
    set(initialState);
  },

  searchUsers: async (query) => {
    try {
      if (!query.trim()) return [];
      const { hashUsername } = await import('@lib/crypto-worker-proxy');
      const hashedQuery = await hashUsername(query.trim());
      const safeQuery = encodeURIComponent(hashedQuery);
      const users = await api<{ id: string; encryptedProfile?: string | null; isVerified?: boolean; publicKey?: string }[]>(`/api/users/search?q=${safeQuery}`);
      return users;
    } catch (error) {
      console.error("Failed to search users", error);
      throw error;
    }
  },

  resyncState: async () => {
    if (!get().initialLoadCompleted) {
      await get().loadConversations();
    }
  },

  loadConversations: async () => {
    let shouldProceed = false;
    set(state => {
      if (state.loading) return state;
      shouldProceed = true;
      return { ...state, loading: true, error: null };
    });
    if (!shouldProceed) return;

    try {
      const rawConversations = await api<any[]>("/api/conversations");
      if (!Array.isArray(rawConversations)) throw new Error('Invalid data from server.');

      const conversations = await Promise.all(rawConversations.map(async c => {
        let lastMessage = c.messages?.[0] || null;
        if (lastMessage) {
          try {
            lastMessage = await decryptMessageObject(lastMessage);
          } catch (e) {
            if (lastMessage.sessionId) {
              emitSessionKeyRequest(lastMessage.conversationId, lastMessage.sessionId);
            }
            lastMessage.content = '[Requesting key to decrypt...]';
          }
          lastMessage = withPreview(lastMessage);
        }
        return {
          ...c,
          lastMessage,
          participants: c.participants.map((p: any) => ({
            ...p.user,
            description: p.user.description,
            role: p.role,
            isPinned: p.isPinned  // Include the pinned status
          })),
        };
      }));

      set({ conversations: sortConversations(conversations, useAuthStore.getState().user?.id) });
      useVerificationStore.getState().loadInitialStatus(conversations);

      const socket = getSocket();
      conversations.forEach(c => socket.emit("conversation:join", c.id));
    } catch (error) {
      console.error("Failed to load conversations", error);
      set({ error: "Failed to load conversations." });
    } finally {
      set({ loading: false, initialLoadCompleted: true });
    }
  },

  openConversation: (id: string | null) => {
    if (!id) {
      set({ activeId: null });
      return;
    }
    set(state => ({
      activeId: id,
      isSidebarOpen: false,
      conversations: state.conversations.map(c => 
        c.id === id ? { ...c, unreadCount: 0 } : c
      ),
    }));
    authFetch(`/api/conversations/${id}/read`, { method: 'POST' }).catch(console.error);
  },

  deleteConversation: async (id) => {
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: any) {
      console.error("Failed to delete conversation:", error);
      const errorMessage = error.message || "Failed to delete conversation.";
      toast.error(errorMessage);
    }
  },
  deleteGroup: async (id) => {
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: any) {
      console.error("Failed to delete group:", error);
      // Check if error is an ApiError with status property
      if (error.status === 403) {
        toast.error("Only the group creator can delete the group.");
      } else {
        const errorMessage = error.message || "Failed to delete group.";
        toast.error(errorMessage);
      }
    }
  },
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),

  startConversation: async (peerId: string): Promise<string> => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error("Cannot start a conversation: user is not authenticated.");
    }

    try {
      // STATELESS INITIALIZATION (Pure Lazy Init)
      // No crypto here. Just create room container.
      
      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          userIds: [peerId],
          isGroup: false,
          // [FIX] Don't send dummy session. Let sendMessage create real X3DH session later.
          initialSession: null, 
        }),
      });
      
      getSocket().emit("conversation:join", conv.id);
      get().addOrUpdateConversation(conv);
      set({ activeId: conv.id, isSidebarOpen: false });
      return conv.id;
    } catch (error: any) {
      console.error("Failed to start conversation:", error);
      throw new Error(`Failed to establish conversation. ${error.message || ''}`);
    }
  },

  addOrUpdateConversation: (conversation) => {
    set(state => {
      const existing = state.conversations.find(c => c.id === conversation.id);
      if (existing) {
        const updated = {
          ...existing,
          title: conversation.title,
          description: conversation.description,
          avatarUrl: conversation.avatarUrl,
          isGroup: conversation.isGroup, // Ensure isGroup is updated
          participants: conversation.participants,
          lastMessage: conversation.lastMessage || existing.lastMessage,
          updatedAt: conversation.updatedAt,
          unreadCount: conversation.unreadCount ?? existing.unreadCount,
        };
        return {
          conversations: sortConversations(state.conversations.map(c => c.id === conversation.id ? updated : c), useAuthStore.getState().user?.id)
        };
      } else {
        return {
          conversations: sortConversations([conversation, ...state.conversations], useAuthStore.getState().user?.id)
        };
      }
    });
  },

  removeConversation: (conversationId) => {
    // Also clear messages from the message store
    useMessageStore.getState().clearMessagesForConversation(conversationId);

    set(state => {
      const wasActive = state.activeId === conversationId;
      if (wasActive) {
        return {
          conversations: state.conversations.filter(c => c.id !== conversationId),
          activeId: null,
          isSidebarOpen: true,
        };
      }
      return { conversations: state.conversations.filter(c => c.id !== conversationId) };
    });
  },

  updateConversation: (id, data) => set((state) => {
    const oldConv = state.conversations.find((c) => c.id === id);
    
    // Check for membership changes in groups to trigger Key Rotation
    if (oldConv && oldConv.isGroup && data.participants) {
      const oldIds = oldConv.participants.map(p => p.id).sort().join(',');
      const newIds = data.participants.map(p => p.id).sort().join(',');
      if (oldIds !== newIds) {
        import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(id));
      }
    }

    return {
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, ...data } : c
      ),
    };
  }),

  updateParticipantDetails: (user) => {
    // Destructure role to exclude it, preventing conflict with Participant role type
    const { role, ...userDetails } = user;
    set(state => ({
      conversations: state.conversations.map(c => ({
        ...c,
        participants: c.participants.map(p => 
          p.id === user.id ? { ...p, ...userDetails } : p
        ),
      }))
    }));
  },

  addParticipants: (conversationId, participants) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          const newParticipants = participants.map((p: any) => ({
            ...p.user,
            description: p.user.description,
            role: p.role,
            isPinned: p.isPinned  // Include the pinned status
          }));
          return {
            ...c,
            participants: [...c.participants, ...newParticipants],
          };
        }
        return c;
      }),
    }));
  },

  removeParticipant: (conversationId, userId) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          return { ...c, participants: c.participants.filter(p => p.id !== userId) };
        }
        return c;
      }),
    }));
  },

  updateParticipantRole: (conversationId, userId, role) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          return { ...c, participants: c.participants.map(p => p.id === userId ? { ...p, role } : p) };
        }
        return c;
      }),
    }));
  },

  updateConversationLastMessage: (conversationId, message) => {
    set(state => {
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) return state;
      const updatedConversation = {
        ...conversation,
        lastMessage: withPreview(message),
        unreadCount: state.activeId === conversationId ? 0 : (conversation.unreadCount || 0) + 1,
      };
      const otherConversations = state.conversations.filter(c => c.id !== conversationId);
      return { conversations: sortConversations([updatedConversation, ...otherConversations], useAuthStore.getState().user?.id) };
    });
  },

  togglePinConversation: async (conversationId) => {
    try {
      // Optimistically update the UI
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === useAuthStore.getState().user?.id) {
                return { ...participant, isPinned: !participant.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, useAuthStore.getState().user?.id) };
      });

      // Call the API to update the server
      const response = await authFetch<{ isPinned: boolean }>(`/api/conversations/${conversationId}/pin`, {
        method: 'POST',
      });

      // Update the UI based on the server response
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === useAuthStore.getState().user?.id) {
                return { ...participant, isPinned: response.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, useAuthStore.getState().user?.id) };
      });
    } catch (error: any) {
      console.error("Failed to toggle pinned conversation", error);
      // Show error toast
      const errorMessage = error.message || "Failed to toggle pinned conversation.";
      toast.error(errorMessage);
      // If the API call fails, revert the optimistic update
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === useAuthStore.getState().user?.id) {
                return { ...participant, isPinned: !participant.isPinned }; // Revert to original state
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, useAuthStore.getState().user?.id) };
      });
    }
  },
}));