// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { transportClient, emitSessionKeyRequest, fireGhostSync, emitGroupKeyDistribution, emitMetadataUpdated } from '@lib/transportClient';
// NOTE: useMessageStore & decryptMessageObject di-import DINAMIS di dalam aksi
// untuk memutus circular dependency (message.ts ⇄ conversation.ts).
import { useVerificationStore } from './verification';
import { useAuthStore, User } from './auth';
import { asConversationId, asMessageId } from '@nyx/shared';
import type { ConversationId, UserId, MessageId, MessageStatus, RawServerMessage, Message, Participant, ConversationUi as Conversation } from '@nyx/shared';
import { asUserId } from '@nyx/shared';
// Removed all crypto imports
import toast from 'react-hot-toast';
import { captureAndLog } from '@utils/feedback';

import { encryptGroupMetadata, decryptGroupMetadata, forceRotateGroupSenderKey, ensureGroupSession } from "@utils/crypto";
import i18n from '../i18n';
export type { MessageStatus, RawServerMessage, Message, Participant, Conversation };

function getToastErrorMessage(error: unknown, i18nKey: string, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return i18n.t(i18nKey, fallback);
}

// --- Helper Functions ---

// [FIX #98] Watermark anti re-count: id pesan yang SUDAH pernah menaikkan
// unreadCount tidak boleh menaikkannya lagi dalam satu sesi UI. Tanpa ini,
// pesan yang sama bisa dihitung 2× (live event `message:new` diproses oleh
// socketListeners DAN doAddIncomingMessage) atau dihitung ulang saat pesan
// lama di-emit ulang (re-delivery/sync race, edit pesan lama) — itulah bug
// "unread count keep reappearing" setelah reload. In-memory saja memang
// sengaja: setelah reload, loadConversations mereset unreadCount ke 0 dulu.
const unreadCountedMessageIds = new Set<string>();
const UNREAD_WATERMARK_MAX = 500;

function markUnreadCounted(messageId: string): void {
  if (unreadCountedMessageIds.size >= UNREAD_WATERMARK_MAX) {
    // Hapus entri tertua (Set mempertahankan urutan insert).
    const oldest = unreadCountedMessageIds.values().next().value;
    if (oldest !== undefined) unreadCountedMessageIds.delete(oldest);
  }
  unreadCountedMessageIds.add(messageId);
}

const sortConversations = (list: Conversation[], currentUserId: string | undefined) =>
  [...list].sort((a, b) => {
    // First, sort by pinned status (pinned conversations first)
    const aIsPinned = a.participants.some(p => p.id === currentUserId && p.isPinned);
    const bIsPinned = b.participants.some(p => p.id === currentUserId && p.isPinned);

    if (aIsPinned && !bIsPinned) return -1;
    if (!aIsPinned && bIsPinned) return 1;

    // Then, sort by latest activity
    return new Date(b.lastMessage?.createdAt || b.updatedAt || 0).getTime() - new Date(a.lastMessage?.createdAt || a.updatedAt || 0).getTime();
  });

const withPreview = (msg: Message): Message => {
  if (msg.content) {
    const contentToParse = msg.content.trim();
    if (contentToParse.startsWith('STORY_KEY:')) {
        return { ...msg, preview: '', isSilent: true };
    }
    
    // Check for Reaction, Silent, or Edit Payload
    if (contentToParse.startsWith('{')) {
       try {
         const payload = JSON.parse(contentToParse);
         if (payload.type === 'reaction') {
            return { ...msg, preview: `Reacted ${payload.emoji || ''}` };
         }
         if (payload.type === 'silent' && typeof payload.text === 'string') {
            return { ...msg, preview: payload.text, content: payload.text, isSilent: true };
         }
         if (payload.type === 'edit' && typeof payload.text === 'string') {
            return { ...msg, preview: `✎ ${payload.text}`, content: payload.text, isEdited: true };
         }
         if (payload.type === 'CALL_INIT' || payload.type === 'GHOST_SYNC') {
            return { ...msg, preview: '', isSilent: true };
         }
       } catch { /* not a JSON payload */ }
    }
    return { ...msg, preview: msg.content };
  }
  if (msg.fileUrl) {
    if (msg.fileType?.startsWith('image/')) return { ...msg, preview: "📷 Image" };
    if (msg.fileType?.startsWith('video/')) return { ...msg, preview: "🎥 Video" };
    return { ...msg, preview: `${msg.fileName || "File"}` };
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
  startConversation: (peerId: string, optimisticProfile?: { name: string; username: string }) => Promise<ConversationId>;
  createGroup: (name: string, userIds: string[], avatarUrl?: string) => Promise<ConversationId>;
  searchUsers: (query: string) => Promise<{ id: string; encryptedProfile?: string | null; isVerified?: boolean; publicKey?: string }[]>;
  addOrUpdateConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => Promise<void>;
  updateParticipantDetails: (user: Partial<User>) => void;
  addParticipants: (conversationId: string, participants: Participant[]) => void;
  removeParticipant: (conversationId: string, userId: string) => void;
  updateParticipantRole: (conversationId: string, userId: string, role: "ADMIN" | "MEMBER") => void;
  updateConversationLastMessage: (conversationId: string, message: Message) => void;
  performHandshake: (conversationId: string) => Promise<void>;
  markKeyRotationNeeded: (conversationId: string, needed: boolean) => void;
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

  markKeyRotationNeeded: (id, needed) => set(s => ({ 
    conversations: s.conversations.map(c => c.id === id ? { ...c, requiresKeyRotation: needed } : c) 
  })),

  searchUsers: async (query) => {
    try {
      if (!query.trim()) return [];

      const trimmedQuery = query.trim();
      const isAlreadyHash = /^[A-Za-z0-9_-]{43}$/.test(trimmedQuery);

      const searchQuery = isAlreadyHash
        ? trimmedQuery
        : await import('@lib/crypto-worker-proxy').then(m => m.hashUsername(trimmedQuery));

      const safeQuery = encodeURIComponent(searchQuery);
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
      const { shadowVault } = await import('@lib/shadowVaultDb');

      // 1. Get local conversations (participants stored client-side for Opaque Mailbox)
      const localConversations = await shadowVault.getAllConversations();
      const localIds = localConversations.map(c => c.id);

      // 2. Sync with server by local IDs (or discover new conversations for fresh users)
      let rawConversations: Conversation[] = [];
      if (localIds.length > 0) {
        rawConversations = await api<Conversation[]>(`/api/conversations/sync?ids=${localIds.join(',')}`);
      } else {
        // New user with no local conversations — discover from UserHiddenConversation
        rawConversations = await api<Conversation[]>('/api/conversations/sync');
      }
      if (!Array.isArray(rawConversations)) throw new Error('Invalid data from server.');

      // If server returned discovered conversations, persist them locally
      if (localIds.length === 0 && rawConversations.length > 0) {
        for (const conv of rawConversations) {
          await shadowVault.saveConversation({ ...conv, participants: [], encryptionMode: 'SENDER_KEY' as const } as Conversation);
        }
      }

      // 3. Merge: server metadata + local participants
      const serverMap = new Map(rawConversations.map(c => [c.id, c]));
      const mergedSource = localConversations.map(local => {
        const server = serverMap.get(local.id);
        return { ...local, ...server, participants: local.participants, unreadCount: 0 };
      });
      // Also include server-only conversations (newly created on another device)
      for (const server of rawConversations) {
        if (!mergedSource.find(c => c.id === server.id)) {
          mergedSource.push({ ...server, participants: [], unreadCount: 0 } as Conversation);
        }
      }

      const conversations = await Promise.all(mergedSource.map(async c => {
        const participants = c.participants || [];

        let localLastMessage: Message | null = null;
        try {
            const localMsgs = await shadowVault.getMessagesByConversation(c.id, 1);
            if (localMsgs.length > 0 && localMsgs[0]) {
                localLastMessage = localMsgs[0];
            }
        } catch (_e) {}

        let lastMessage = c.lastMessage || null;
        
        if (lastMessage) {
            const originalLastMsg = lastMessage;
            try {
              const { decryptMessageObject } = await import('./message');
              const decryptedLastMsg = await decryptMessageObject(lastMessage);
              lastMessage = decryptedLastMsg || c.lastMessage || null;
            } catch (_e) {
              if (originalLastMsg.sessionId) emitSessionKeyRequest(originalLastMsg.conversationId, originalLastMsg.sessionId);
              lastMessage = originalLastMsg;
              lastMessage.content = '[Requesting key to decrypt...]';
            }
        }

        const serverMsgTime = lastMessage ? new Date(lastMessage.createdAt).getTime() : 0;
        const localMsgTime = localLastMessage ? new Date(localLastMessage.createdAt).getTime() : 0;

        let finalLastMessage = localMsgTime > serverMsgTime ? localLastMessage : lastMessage;

        if (finalLastMessage) {
            const pInfo = participants.find(p => p.id === finalLastMessage!.senderId);
            if (pInfo) {
                finalLastMessage.sender = {
                    ...(finalLastMessage.sender || { id: finalLastMessage.senderId }),
                    ...pInfo
                };
            }
            finalLastMessage = withPreview(finalLastMessage);
        }
        
        // 🛡️ Guard: Use cached decryptedMetadata from ShadowVault if available.
        // If we always try to decrypt on every page load, the second load will fail
        // because the sender key ratchet has advanced past N=0 (messages were decrypted
        // in the previous session), while metadata was encrypted at N=0.
        // Result: decryptedMetadata gets overwritten with undefined → "Unknown Group".
        // BUGFIX: hasil dekripsi dipersist ke Shadow Vault (lihat lib/groupMetadata.ts).
        const { resolveGroupMetadata } = await import('@lib/groupMetadata');
        const decryptedMetadata = await resolveGroupMetadata(c, {
          decrypt: decryptGroupMetadata,
          save: async (conv) => {
            const { shadowVault } = await import('@lib/shadowVaultDb');
            await shadowVault.saveConversation(conv).catch(() => {});
          },
          cacheParticipants: (id, userIds) => {
            import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(id, userIds));
          },
        });

        return {
          ...c,
          lastMessage: finalLastMessage,
          participants,
          decryptedMetadata
        };
      }));

      const existingConversations = get().conversations;
      const reconciledConversations = await Promise.all(conversations.map(async fetched => {
          fetched.encryptionMode = fetched.isGroup ? 'SENDER_KEY' : 'SPQR';
          if (fetched.isGroup) {
              const existing = existingConversations.find(e => e.id === fetched.id);
              if (existing) {
                  const existingIds = existing.participants.map(p => p.id).sort().join(',');
                  const fetchedIds = fetched.participants.map(p => p.id).sort().join(',');
                  if (existingIds !== fetchedIds) {
                      fireGhostSync(fetched.id, 2000);
                      return { ...fetched, requiresKeyRotation: true };
                  }
              }
          }
          return fetched;
      }));

      set({ conversations: sortConversations(reconciledConversations, useAuthStore.getState().user?.id) });
      useVerificationStore.getState().loadInitialStatus(conversations);

      const socket = transportClient;

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
  },

  deleteConversation: async (id) => {
    if (id.startsWith('burner_')) {
      set((state) => {
        const newConvos = state.conversations.filter(c => c.id !== id);
        return { 
          conversations: newConvos,
          activeId: state.activeId === id ? null : state.activeId,
          isSidebarOpen: state.activeId === id ? true : state.isSidebarOpen
        };
      });
      try {
        const { shadowVault } = await import('@lib/shadowVaultDb');
        await shadowVault.deleteConversation(id);
      } catch (e) {
        console.error("Failed to delete burner conversation from local DB", e);
      }
      return;
    }
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: unknown) {
      console.error("Failed to delete conversation:", error);
      const errorMessage = (error instanceof Error ? error.message : undefined) || i18n.t('errors:failed_to_delete_conversation', "Failed to delete conversation.");
      toast.error(errorMessage);
    }
  },
  
  deleteGroup: async (id) => {
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: unknown) {
      console.error("Failed to delete group:", error);
      if (typeof error === 'object' && error !== null && 'status' in error && (error as Record<string, unknown>).status === 403) {
        toast.error(i18n.t('errors:only_the_group_creator_can_delete_the_gr', 'Only the group creator can delete the group.'));
      } else {
        toast.error(getToastErrorMessage(error, 'errors:failed_to_delete_group', "Failed to delete group."));
      }
    }
  },
  
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),

  startConversation: async (peerId: string, optimisticProfile?: { name: string; username: string }): Promise<ConversationId> => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error("Cannot start a conversation: user is not authenticated.");
    }

    try {
      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          userIds: [peerId],
          isGroup: false,
          initialSession: undefined, 
        }),
      });
      
      // Opaque Mailbox: server returns empty participants, reconstruct locally
      conv.participants = [
        { id: asUserId(user.id), name: '', username: '', role: 'MEMBER' as const },
        { id: asUserId(peerId), name: optimisticProfile?.name || '', username: optimisticProfile?.username || '', role: 'MEMBER' as const }
      ];

      get().addOrUpdateConversation({ ...conv, encryptionMode: 'SPQR' });
      set({ activeId: conv.id, isSidebarOpen: false });
      return conv.id;
    } catch (error: unknown) {
      console.error("Failed to start conversation:", error);
      throw new Error(`Failed to establish conversation. ${(error instanceof Error ? error.message : 'Unknown error') || ''}`);
    }
  },

  createGroup: async (name: string, userIds: string[], avatarUrl?: string): Promise<ConversationId> => {
    const { user } = useAuthStore.getState();
    if (!user) throw new Error("Not authenticated");

    let conv: Conversation | null = null;

    try {
        const createRes = await authFetch<Conversation & { authSecret: string }>("/api/conversations", {
            method: "POST",
            body: JSON.stringify({
                userIds,
                isGroup: true,
                encryptedMetadata: null 
            })
        });
        conv = createRes;
        const authSecret = createRes.authSecret;

        // Opaque Mailbox: server returns empty participants, reconstruct from userIds
        const constructedParticipants = userIds.map(id => ({ id, name: '', role: 'MEMBER' as const })) as Participant[];
        const distributionKeys = await ensureGroupSession(conv.id, constructedParticipants, true);
        if (distributionKeys && distributionKeys.length > 0) {
            await emitGroupKeyDistribution(conv.id, distributionKeys as { userId: string; key: string }[]);
        }
        
        // 🛡️ Fix: Include ALL participants (creator + invited users) in the encrypted metadata.
        // Previously only userIds (other members) were included, causing the decrypted metadata
        // to show only the member's own ID (count=1). This left conversation.participants incomplete
        // for Opaque Mailbox, which meant targetRecipients was empty and ensureGroupSessionIfNeeded
        // couldn't distribute the member's sender key to the creator.
        const allParticipantIds = Array.from(new Set([user.id, ...userIds]));
        const encryptedMetadata = await encryptGroupMetadata({ title: name, avatarUrl, participants: allParticipantIds, authSecret } as { title: string; avatarUrl?: string; participants: string[]; authSecret: string }, conv.id);
        
        await authFetch(`/api/conversations/${conv.id}/details`, {
            method: 'PUT',
            headers: { 'X-Group-Token': authSecret },
            body: JSON.stringify({ encryptedMetadata })
        });
        
        // Opaque Mailbox: explicitly notify all members about metadata update
        const myId = useAuthStore.getState().user?.id;
        if (myId) {
            const notifyTargets = userIds.filter(uid => uid !== myId);
            if (notifyTargets.length > 0) {
                emitMetadataUpdated(conv.id, encryptedMetadata, notifyTargets);
            }
        }
        
        const updatedConv: Conversation = {
            ...conv,
            participants: constructedParticipants as Participant[],
            decryptedMetadata: { title: name, avatarUrl, authSecret },
            encryptedMetadata
        };
        
  
        get().addOrUpdateConversation(updatedConv);
        set({ activeId: conv.id, isSidebarOpen: false });
        
        return conv.id;
    } catch (e) {
        if (conv) {
             console.error("Create group failed during setup. Rolling back...", e);
             try {
                 await authFetch(`/api/conversations/${conv!.id}`, { method: 'DELETE' });
             } catch (rollbackError) {
                 console.error("Rollback failed", rollbackError);
             }
        }
        throw e;
    }
  },

  addOrUpdateConversation: async (conversation) => {
    let decryptedMetadata = conversation.decryptedMetadata;
    
    // 🛡️ Guard: Skip re-decryption if the conversation already exists in store with
    // decrypted metadata and the encrypted payload hasn't changed. Without this guard,
    // redundant decryptGroupMetadata calls will ratchet the sender key state past N=0
    // while metadata was encrypted at N=0, causing permanent decrypt failure.
    if (!decryptedMetadata && conversation.isGroup && conversation.encryptedMetadata) {
        const existing = useConversationStore.getState().conversations.find(c => c.id === conversation.id);
        if (existing?.decryptedMetadata && existing.encryptedMetadata === conversation.encryptedMetadata) {
            decryptedMetadata = existing.decryptedMetadata;
            // Also forward participants from cached metadata to prevent overwrite with empty
            // (caller may pass conversation with empty participants in Opaque Mailbox)
            const metaParticipants = (decryptedMetadata as { participants?: string[] }).participants;
            if (Array.isArray(metaParticipants) && metaParticipants.length > 0 &&
                (!conversation.participants || conversation.participants.length === 0)) {
                const currentUser = useAuthStore.getState().user;
                conversation.participants = metaParticipants.map((pid: string) => ({
                    id: pid, name: pid === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                })) as Participant[];
            }
        } else {
            try {
                const dec = await decryptGroupMetadata(String(conversation.encryptedMetadata), conversation.id);
                if (dec) {
                    decryptedMetadata = dec;
                    // Opaque Mailbox: extract participants from encrypted metadata
                    const metaParticipants = (dec as { participants?: string[] }).participants;
                    if (Array.isArray(metaParticipants) && metaParticipants.length > 0 &&
                        (!conversation.participants || conversation.participants.length === 0)) {
                        const currentUser = useAuthStore.getState().user;
                        conversation.participants = metaParticipants.map((id: string) => ({
                            id, name: id === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                        })) as Participant[];
                        // Persist to IndexedDB so non-creator members can send messages even before metadata is re-decrypted
                        import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(conversation.id, metaParticipants));
                    }
                }
            } catch (e) {
                console.warn("Failed to decrypt metadata for conversation", e);
            }
        }
    }

    set(state => {
      const existing = state.conversations.find(c => c.id === conversation.id);
      let updatedConv: Conversation;
      if (existing) {
        updatedConv = {
          ...existing,
          encryptedMetadata: conversation.encryptedMetadata,
          decryptedMetadata: decryptedMetadata || existing.decryptedMetadata,
          isGroup: conversation.isGroup,
          participants: conversation.participants,
          lastMessage: conversation.lastMessage || existing.lastMessage,
          updatedAt: conversation.updatedAt,
          unreadCount: conversation.unreadCount ?? existing.unreadCount,
        } as Conversation;

        // PERSIST TO SHADOW VAULT (Opaque Mailbox)
        import('@lib/shadowVaultDb').then(m => m.shadowVault.saveConversation(updatedConv));

        return {
          conversations: sortConversations(state.conversations.map(c => c.id === conversation.id ? updatedConv : c), useAuthStore.getState().user?.id)
        };
      } else {
        updatedConv = { ...conversation, decryptedMetadata } as Conversation;

        // PERSIST TO SHADOW VAULT (Opaque Mailbox)
        import('@lib/shadowVaultDb').then(m => m.shadowVault.saveConversation(updatedConv));

        return {
          conversations: sortConversations([updatedConv, ...state.conversations], useAuthStore.getState().user?.id)
        };
      }
    });
  },

  removeConversation: (conversationId) => {
    (async () => {
      const { useMessageStore } = await import('./message');
      useMessageStore.getState().clearMessagesForConversation(conversationId);
      // Persist penghapusan ke Shadow Vault agar percakapan tidak "hidup kembali"
      // saat reload (loadConversations membaca dari IndexedDB).
      const { shadowVault } = await import('@lib/shadowVaultDb');
      await shadowVault.deleteConversation(conversationId);
    })();

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

  updateConversation: async (id, data) => {
    let decryptedMetadata = undefined;
    if (data.encryptedMetadata) {
         // 🛡️ Guard: Skip re-decryption if metadata is already cached and the encrypted payload
         // hasn't changed. Otherwise, the second call would ratchet the sender key state past N=0
         // while the metadata was encrypted at N=0, causing permanent decrypt failure:
         //   "Ratchet Advanced! Cannot decrypt old message (header.n=0, state.N=1)"
         const existing = get().conversations.find(c => c.id === id);
         if (existing?.decryptedMetadata && existing.encryptedMetadata === data.encryptedMetadata) {
             decryptedMetadata = existing.decryptedMetadata;
             if (Array.isArray((decryptedMetadata as { participants?: string[] }).participants) && (decryptedMetadata as { participants?: string[] }).participants!.length > 0) {
                 data.participants = (decryptedMetadata as { participants?: string[] }).participants!.map((pid: string) => ({
                     id: asUserId(pid), name: pid === useAuthStore.getState().user?.id ? useAuthStore.getState().user?.name || '' : '', role: 'MEMBER' as const
                 }));
             }
         } else {
         try {
             const dec = await decryptGroupMetadata(data.encryptedMetadata, id);
             if (dec) {
                 decryptedMetadata = dec;
                 // Opaque Mailbox: extract participants from decrypted metadata
                 const metaParticipants = (dec as { participants?: string[] }).participants;
                 if (Array.isArray(metaParticipants) && metaParticipants.length > 0) {
                     const currentUser = useAuthStore.getState().user;
                     data.participants = metaParticipants.map((pid: string) => ({
                         id: asUserId(pid), name: pid === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                     }));
                     // Persist to IndexedDB cache for offline/early message sending
                     import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(id, metaParticipants));
                 }
             } else {
                 console.warn("Failed to decrypt metadata");
             }
         } catch (e) {
             console.warn("Failed to decrypt updated metadata", e);
         }
         }
    }

    set((state) => {
        const oldConv = state.conversations.find((c) => c.id === id);
        
        if (oldConv && oldConv.isGroup && data.participants) {
          const oldIds = oldConv.participants.map(p => p.id).sort().join(',');
          const newIds = data.participants.map(p => p.id).sort().join(',');
          if (oldIds !== newIds) {
            forceRotateGroupSenderKey(id).catch(() => { console.warn('Key rotation deferred'); });
          }
        }

        return {
          conversations: state.conversations.map((c) =>
            c.id === id ? { 
                ...c, 
                ...data,
                decryptedMetadata: decryptedMetadata || c.decryptedMetadata 
            } : c
          ),
        };
    });
  },

  updateParticipantDetails: (user) => {
    const { role, ...userDetails } = user;
    
    set(state => {
      const affectedConvoIds: string[] = [];
      
      state.conversations.forEach(c => {
        const existingParticipant = c.participants.find(p => p.id === user.id);
        if (!existingParticipant) return;

        // Check for cryptographic or membership changes
        const hasCryptoChanged = 
          (userDetails.publicKey !== undefined && userDetails.publicKey !== existingParticipant.publicKey) ||
          (userDetails.pqPublicKey !== undefined && userDetails.pqPublicKey !== existingParticipant.pqPublicKey) ||
          (userDetails.signingKey !== undefined && userDetails.signingKey !== existingParticipant.signingKey) ||
          (userDetails.devices !== undefined && JSON.stringify(userDetails.devices) !== JSON.stringify(existingParticipant.devices)) ||
          (role !== undefined && role !== existingParticipant.role);

        if (hasCryptoChanged) {
          affectedConvoIds.push(c.id);
          import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(c.id).catch(captureAndLog));
        }
      });

      return {
        conversations: state.conversations.map(c => {
          if (!affectedConvoIds.includes(c.id) && !c.participants.some(p => p.id === user.id)) {
            return c;
          }
          
          return {
            ...c,
            requiresKeyRotation: affectedConvoIds.includes(c.id) ? true : c.requiresKeyRotation,
            participants: c.participants.map(p => {
              if (p.id !== user.id) return p;
              
              const updatedParticipant = { ...p, ...userDetails };
              if (role === "ADMIN" || role === "MEMBER" || role === "admin" || role === "member") {
                updatedParticipant.role = role;
              }
              return updatedParticipant;
            }),
          };
        })
      };
    });
  },

  addParticipants: (conversationId, newParticipants) => {
    import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(conversationId).catch(captureAndLog));
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          const merged = [...c.participants, ...newParticipants];
          
          // FIX: Type-safe unique map based on strict Participant ID
          const uniqueMap = new Map<string, Participant>();
          merged.forEach(p => {
             if (p && p.id) uniqueMap.set(p.id, p);
          });

          return { ...c, participants: Array.from(uniqueMap.values()), requiresKeyRotation: true };
        }
        return c;
      }),
    }));
  },

  removeParticipant: (conversationId, userId) => {
    import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(conversationId).catch(captureAndLog));
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          return { ...c, participants: c.participants.filter(p => p.id !== userId), requiresKeyRotation: true };
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

      const meId = useAuthStore.getState().user?.id;
      const isMine = message.senderId === meId;

      const newMsgTime = new Date(message.createdAt).getTime();
      const currentLastMsgTime = conversation.lastMessage ? new Date(conversation.lastMessage.createdAt).getTime() : 0;
      
      const isViewingChat = typeof window !== 'undefined' && window.location.pathname.includes(`/chat/${conversationId}`) && document.visibilityState === 'visible';

      // [FIX #98] Satu pesan hanya boleh menaikkan unread SEKALI per sesi.
      // Cek watermark SEBELUM cabang mana pun yang menaikkan counter.
      // Pesan milik sendiri tidak pernah masuk watermark (tidak relevan).
      const incrementsUnread = !isMine && !isViewingChat;
      if (incrementsUnread && unreadCountedMessageIds.has(message.id)) {
        // Pesan ini sudah pernah dihitung — jangan sentuh unreadCount lagi.
        // (Preview tetap boleh diperbarui.)
        if (newMsgTime >= currentLastMsgTime) {
          const updatedConversation = { ...conversation, lastMessage: withPreview(message) };
          const otherConversations = state.conversations.filter(c => c.id !== conversationId);
          return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
        }
        return state;
      }

      if (newMsgTime < currentLastMsgTime) {
          // FIX: Pastikan kita tetap mengembalikan hasil array yang di-sort!
          if (incrementsUnread) {
              markUnreadCounted(message.id);
              const updatedConvos = state.conversations.map(c =>
                  c.id === conversationId
                      ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                      : c
              );
              return { conversations: sortConversations(updatedConvos, meId) };
          }
          return state;
      }

      if (incrementsUnread) markUnreadCounted(message.id);
      
      const updatedConversation = {
        ...conversation,
        lastMessage: withPreview(message),
        unreadCount: (incrementsUnread ? (conversation.unreadCount || 0) + 1 : conversation.unreadCount),
      };
      
      const otherConversations = state.conversations.filter(c => c.id !== conversationId);
      return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
    });
  },

  performHandshake: async (conversationId: string) => {
    const { conversations } = get();
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv || conv.isGroup) return;

    // Set status to handshaking
    set(state => ({
        conversations: state.conversations.map(c => 
            c.id === conversationId ? { ...c, handshakeStatus: 'handshaking' } : c
        )
    }));

    try {
        const { getPreKeyBundle } = await import('@lib/api');
        const { establishSessionFromPreKeyBundle } = await import('@utils/crypto');
        const { shadowVault } = await import('@lib/shadowVaultDb');
        const { useAuthStore } = await import('./auth');
        
        const peerId = conv.participants.find(p => p.id !== useAuthStore.getState().user?.id)?.id;
        if (!peerId) throw new Error("Peer not found");

        const bundle = await getPreKeyBundle(peerId);
        const { getSodiumLib } = await import('@utils/crypto');
        const sodium = await getSodiumLib();
        
        const signingPrivateKey = await useAuthStore.getState().getSigningPrivateKey();
        if (!signingPrivateKey) throw new Error("My signing key missing");
        
        const mySigningKey = {
            publicKey: signingPrivateKey.slice(32),
            privateKey: signingPrivateKey
        };

        const { sessionKey, initiatorCiphertexts, identityChanged } = await establishSessionFromPreKeyBundle(mySigningKey, bundle, peerId);

        // [SECURITY WARNING] Insert system message if identity changed
        if (identityChanged) {
            const { useMessageStore } = await import('@store/message');
            const { t } = await import('i18next');
            const peer = conv.participants.find(p => p.id === peerId);
            const peerName = peer?.name || peer?.user?.name || t('common:defaults.unknown_user');
            const warningText = t('common:security_key_changed', { name: peerName });
            useMessageStore.getState().addSystemMessage(conversationId, warningText);
        }

        // Start Binary Handshake over WebTransport
        return new Promise<void>((resolve, reject) => {
            const handler = (success: boolean, error?: string) => {
                clearTimeout(timeoutId);
                transportClient.off('handshake:completed', handler);
                if (success) {
                    // Store Session Key
                    shadowVault.savePqDrSession({
                        conversationId,
                        peerClassicalPk: bundle.identityKey,
                        peerDeviceId: bundle.deviceId,
                        version: 1,
                        negotiationStatus: 'ESTABLISHED',
                        lastActivity: Date.now(),
                        state: {
                            RK: sodium.to_base64(sessionKey, sodium.base64_variants.URLSAFE_NO_PADDING),
                            CKs: null,
                            CKr: null,
                            KEMs_pub: null,
                            KEMs_priv: null,
                            KEMr: null,
                            savedCt: null,
                            Ns: 0,
                            Nr: 0,
                            PN: 0
                        }
                    }).then(() => {
                        set(state => ({
                            conversations: state.conversations.map(c => 
                                c.id === conversationId ? { ...c, handshakeStatus: 'secure', encryptionMode: 'SPQR' } : c
                            )
                        }));
                        resolve();
                    }).catch(reject);
                } else {
                    reject(new Error(error || "Handshake failed"));
                }
            };

            const timeoutId = setTimeout(() => {
                transportClient.off('handshake:completed', handler);
                reject(new Error("Handshake timed out"));
            }, 5000);

            transportClient.on('handshake:completed', handler);
            transportClient.startHandshake(initiatorCiphertexts);
        });

    } catch (e: unknown) {
        console.error("Handshake failed action:", e);
        set(state => ({
            conversations: state.conversations.map(c => 
                c.id === conversationId ? { ...c, handshakeStatus: 'failed' } : c
            )
        }));
        toast.error(`Handshake failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
    }
  },

  togglePinConversation: async (conversationId) => {
    const meId = useAuthStore.getState().user?.id;
    try {
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: !participant.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });

      const response = await authFetch<{ isPinned: boolean }>(`/api/conversations/${conversationId}/pin`, {
        method: 'POST',
      });

      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: response.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });
    } catch (error: unknown) {
      console.error("Failed to toggle pinned conversation", error);
      const errorMessage = (error instanceof Error ? error.message : undefined) || i18n.t('errors:failed_to_toggle_pinned_conversation', "Failed to toggle pinned conversation.");
      toast.error(errorMessage);
      
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: !participant.isPinned }; 
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });
    }
  },
}));