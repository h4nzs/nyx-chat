import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { decryptMessageObject } from "./message";
import { getSocket } from "@lib/socket";
import { useVerificationStore } from './verification';

// --- Type Definitions ---

export type Message = {
  id: string;
  tempId?: number;
  type?: 'USER' | 'SYSTEM'; // Add new type field
  conversationId: string;
  senderId: string;
  sender?: { id: string; name: string; username: string; avatarUrl?: string | null };
  content?: string | null;
  imageUrl?: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  fileType?: string;
  fileSize?: number;
  sessionId?: string | null;
  ciphertext?: string | null; // To store the original encrypted content
  createdAt: string;
  error?: boolean;
  preview?: string;
  reactions?: { id: string; emoji: string; userId: string }[];
  optimistic?: boolean;
  repliedTo?: Message;
  repliedToId?: string;
  linkPreview?: any; // For link preview data
};

export type Participant = {
  id: string;
  username: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  role: "ADMIN" | "MEMBER";
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
};

// --- Helper Functions ---

const sortConversations = (list: Conversation[]) =>
  [...list].sort((a, b) => new Date(b.lastMessage?.createdAt || b.updatedAt).getTime() - new Date(a.lastMessage?.createdAt || a.updatedAt).getTime());

const withPreview = (msg: Message): Message => {
  if (msg.content) {
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

// --- State Type ---

type State = {
  conversations: Conversation[];
  activeId: string | null;
  isSidebarOpen: boolean;
  error: string | null;
  loading: boolean;
  initialLoadCompleted: boolean; // Flag to prevent re-loading

  // Actions
  loadConversations: () => Promise<void>;
  openConversation: (id: string | null) => void;
  deleteConversation: (id: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  toggleSidebar: () => void;
  startConversation: (peerId: string) => Promise<string>;
  addOrUpdateConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => void;
  updateParticipantDetails: (user: Partial<User>) => void;
  addParticipants: (conversationId: string, participants: Participant[]) => void;
  removeParticipant: (conversationId: string, userId: string) => void;
  updateParticipantRole: (conversationId: string, userId: string, role: "ADMIN" | "MEMBER") => void;
  updateConversationLastMessage: (conversationId: string, message: Message) => void;
  resyncState: () => Promise<void>;
  clearError: () => void;
};

// --- Zustand Store ---

export const useConversationStore = createWithEqualityFn<State>((set, get) => ({
  conversations: [],
  activeId: null,
  isSidebarOpen: false,
  error: null,
  loading: false,
  initialLoadCompleted: false, // Default to false

  clearError: () => set({ error: null }),

  resyncState: async () => {
    // Only perform a full resync if the initial load has not completed yet.
    // This prevents a loop on socket reconnects, especially for users with no conversations.
    if (!get().initialLoadCompleted) {
      await get().loadConversations();
    }
  },

  loadConversations: async () => {
    // Prevent multiple simultaneous loads
    if (get().loading) return;

    try {
      set({ loading: true, error: null });
      const rawConversations = await api<any[]>("/api/conversations");

      if (!Array.isArray(rawConversations)) {
        throw new Error('Invalid data from server.');
      }

      const conversations = await Promise.all(rawConversations.map(async c => {
        let lastMessage = c.messages?.[0] || null;
        if (lastMessage) {
          try {
            lastMessage = await decryptMessageObject(lastMessage);
          } catch (e) {
            console.error(`Failed to decrypt last message for convo ${c.id}`, e);
            lastMessage.content = '[Failed to decrypt]';
          }
          lastMessage = withPreview(lastMessage);
        }

        return {
          ...c,
          lastMessage,
          participants: c.participants.map((p: any) => ({ ...p.user, description: p.user.description, role: p.role })),
        };
      }));

      set({ conversations: sortConversations(conversations) });

      // Initialize verification statuses from localStorage
      useVerificationStore.getState().loadInitialStatus(conversations);

      // After loading conversations, join their respective socket rooms
      const socket = getSocket();
      conversations.forEach(c => {
        socket.emit("conversation:join", c.id);
      });
    } catch (error) {
      console.error("Failed to load conversations", error);
      set({ error: "Failed to load conversations." });
    } finally {
      set({ loading: false, initialLoadCompleted: true }); // Mark as completed regardless of outcome
    }
  },

  openConversation: (id: string | null) => {
    if (!id) {
      set({ activeId: null });
      return;
    }

    // Optimistically update UI
    set(state => ({
      activeId: id,
      isSidebarOpen: false,
      conversations: state.conversations.map(c => 
        c.id === id ? { ...c, unreadCount: 0 } : c
      ),
    }));

    // Inform the backend that the conversation has been read
    authFetch(`/api/conversations/${id}/read`, { method: 'POST' }).catch(console.error);
  },

  deleteConversation: async (id) => { 
    await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    get().removeConversation(id);
  },
  deleteGroup: async (id) => { 
    await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    get().removeConversation(id);
  },
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),

  startConversation: async (peerId) => {
    const conv = await authFetch<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ userIds: [peerId], isGroup: false }),
    });
    
    // Join the socket room for real-time updates
    getSocket().emit("conversation:join", conv.id);

    get().addOrUpdateConversation(conv);
    set({ activeId: conv.id, isSidebarOpen: false });
    return conv.id;
  },

  // --- Actions to be called by socket store ---
  addOrUpdateConversation: (conversation) => {
    set(state => {
      const existingConversation = state.conversations.find(c => c.id === conversation.id);
      let updatedConversation: Conversation;

      if (existingConversation) {
        // Merge new data into existing conversation
        updatedConversation = {
          ...existingConversation,
          ...conversation,
        };
      } else {
        // This is a new conversation, add it as is
        updatedConversation = conversation;
      }

      return {
        conversations: sortConversations([updatedConversation, ...state.conversations.filter(c => c.id !== conversation.id)])
      };
    });
  },

  removeConversation: (conversationId) => {
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

  updateConversation: (conversationId, updates) => {
    set(state => ({
      conversations: state.conversations.map(c => 
        c.id === conversationId ? { ...c, ...updates } : c
      )
    }));
  },

  updateParticipantDetails: (user) => {
    set(state => ({
      conversations: state.conversations.map(c => ({
        ...c,
        participants: c.participants.map(p => 
          p.id === user.id ? { ...p, ...user } : p
        ),
      }))
    }));
  },

  addParticipants: (conversationId, participants) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          // Map the incoming participants to the correct frontend structure
          const newParticipants = participants.map((p: any) => ({ ...p.user, description: p.user.description, role: p.role }));
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
          return {
            ...c,
            participants: c.participants.filter(p => p.id !== userId),
          };
        }
        return c;
      }),
    }));
  },

  updateParticipantRole: (conversationId, userId, role) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          return {
            ...c,
            participants: c.participants.map(p => 
              p.id === userId ? { ...p, role } : p
            ),
          };
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
      const newConversations = sortConversations([updatedConversation, ...otherConversations]);

      return { conversations: newConversations };
    });
  },
}));
