import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { decryptMessageObject } from "./message";
import { getSocket, emitSessionKeyRequest } from "@lib/socket";
import { useVerificationStore } from './verification';
import { useAuthStore, User } from './auth';
import { getSodium } from '@lib/sodiumInitializer';
import { establishSessionFromPreKeyBundle } from '@utils/crypto';
import { addSessionKey } from '@lib/keychainDb';

// --- Type Definitions ---

export type Message = {
  id: string;
  tempId?: number;
  type?: 'USER' | 'SYSTEM';
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
  ciphertext?: string | null;
  createdAt: string;
  error?: boolean;
  preview?: string;
  reactions?: { id: string; emoji: string; userId: string }[];
  optimistic?: boolean;
  repliedTo?: Message;
  repliedToId?: string;
  linkPreview?: any;
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
          participants: c.participants.map((p: any) => ({ ...p.user, description: p.user.description, role: p.role })),
        };
      }));

      set({ conversations: sortConversations(conversations) });
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
    await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    get().removeConversation(id);
  },
  deleteGroup: async (id) => { 
    await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
    get().removeConversation(id);
  },
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),

  startConversation: async (peerId: string): Promise<string> => {
    const { user, getEncryptionKeyPair } = useAuthStore.getState();
    if (!user) {
      throw new Error("Cannot start a conversation: user is not authenticated.");
    }

    try {
      const theirBundle = await authFetch<any>(`/api/keys/prekey-bundle/${peerId}`);
      if (!theirBundle) throw new Error("User does not have a pre-key bundle available.");

      const myKeyPair = await getEncryptionKeyPair();
      const { sessionKey, ephemeralPublicKey } = await establishSessionFromPreKeyBundle(myKeyPair, theirBundle);

      const sodium = await getSodium();
      const myPublicKey = myKeyPair.publicKey;
      const theirPublicKey = sodium.from_base64(theirBundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      const encryptedKeyForSelf = sodium.crypto_box_seal(sessionKey, myPublicKey);
      const encryptedKeyForPeer = sodium.crypto_box_seal(sessionKey, theirPublicKey);
      const sessionId = `session_${sodium.to_hex(sodium.randombytes_buf(16))}`;

      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          userIds: [peerId],
          isGroup: false,
          initialSession: {
            sessionId,
            ephemeralPublicKey,
            initialKeys: [
              { userId: user.id, key: sodium.to_base64(encryptedKeyForSelf, sodium.base64_variants.URLSAFE_NO_PADDING) },
              { userId: peerId, key: sodium.to_base64(encryptedKeyForPeer, sodium.base64_variants.URLSAFE_NO_PADDING) },
            ],
          },
        }),
      });
      
      await addSessionKey(conv.id, sessionId, sessionKey);

      getSocket().emit("conversation:join", conv.id);
      get().addOrUpdateConversation(conv);
      set({ activeId: conv.id, isSidebarOpen: false });
      return conv.id;
    } catch (error: any) {
      console.error("Failed to start conversation using pre-keys:", error);
      throw new Error(`Failed to establish secure conversation. ${error.message || ''} The recipient may not have encryption keys set up.`);
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
          participants: conversation.participants,
          lastMessage: conversation.lastMessage || existing.lastMessage,
          updatedAt: conversation.updatedAt,
          unreadCount: conversation.unreadCount ?? existing.unreadCount,
        };
        return {
          conversations: sortConversations(state.conversations.map(c => c.id === conversation.id ? updated : c))
        };
      } else {
        return {
          conversations: sortConversations([conversation, ...state.conversations])
        };
      }
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
      return { conversations: sortConversations([updatedConversation, ...otherConversations]) };
    });
  },
}));
