// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { useMessageStore, decryptMessageObject } from "./message";
import { getSocket, emitSessionKeyRequest, fireGhostSync, emitGroupKeyDistribution } from "@lib/socket";
import { useVerificationStore } from './verification';
import { useAuthStore, User } from './auth';
import type { ConversationId, UserId, MessageId, MessageStatus, RawServerMessage, Message, Participant, ConversationUi as Conversation } from '@nyx/shared';
// Removed all crypto imports
import toast from 'react-hot-toast';

import { encryptGroupMetadata, decryptGroupMetadata, forceRotateGroupSenderKey, ensureGroupSession } from "@utils/crypto";
import i18n from '../i18n';
export type { MessageStatus, RawServerMessage, Message, Participant, Conversation };

function getToastErrorMessage(error: unknown, i18nKey: string, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return i18n.t(i18nKey, fallback);
}

// --- Helper Functions ---

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
       } catch {}
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
  markKeyRotationNeeded: (conversationId: string, needed: boolean) => void;
  togglePinConversation: (conversationId: string) => Promise<void>;
  upgradeToPqDr: (conversationId: string) => Promise<void>;
  downgradeToSenderKey: (conversationId: string, isFromPeer?: boolean) => Promise<void>;
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

  upgradeToPqDr: async (conversationId: string) => {
    (window as any)[`pendingPqUpgrade_${conversationId}`] = true;
    
    const { authFetch } = await import('@lib/api');
    const { getSodiumLib, getMyEncryptionKeyPair } = await import('@utils/crypto');
    const authStore = (await import('./auth')).useAuthStore.getState();
    const myClassicalKeys = await getMyEncryptionKeyPair();
    const myPqKeys = await authStore.getPqEncryptionKeyPair();
    
    const myDevices = await authFetch<any[]>('/api/users/me/devices');
    const currentDevice = myDevices.find(d => d.isCurrent);
    const myDeviceId = currentDevice?.id || '';

    const sodium = await getSodiumLib();
    const hostClassicalPk = sodium.to_base64(myClassicalKeys.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const hostPqPk = sodium.to_base64(myPqKeys.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    const { useMessageStore } = await import('./message');
    await useMessageStore.getState().sendMessage(conversationId, {
      content: JSON.stringify({ 
          type: 'PROTOCOL_UPGRADE_REQ',
          deviceId: myDeviceId,
          hostClassicalPk,
          hostPqPk
      }),
      isSilent: true
    });
  },

  downgradeToSenderKey: async (conversationId: string, isFromPeer = false) => {
    const { shadowVault } = await import('@lib/shadowVaultDb');
    await shadowVault.deletePqDrSession(conversationId);
    
    get().updateConversation(conversationId, { encryptionMode: 'SENDER_KEY', activePqDeviceId: null });
    
    if (!isFromPeer) {
      const { useMessageStore } = await import('./message');
      await useMessageStore.getState().sendMessage(conversationId, {
        content: JSON.stringify({ type: 'PROTOCOL_DOWNGRADE' }),
        isSilent: true
      });
    }
  },

  loadConversations: async () => {
    if (sessionStorage.getItem('nyx_decoy_mode') === 'true') {
      const dummyConvo = {
         id: 'decoy-1', isGroup: false, unreadCount: 0,
         participants: [{ id: 'bot-1', username: 'system_bot', name: 'NYX Service' }],
         createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
         lastMessage: { id: 'msg-1', content: 'Welcome to NYX. No active chats found.', senderId: 'bot-1', createdAt: new Date().toISOString(), conversationId: 'decoy-1', type: 'SYSTEM' }
      };
      set({ conversations: [dummyConvo as unknown as Conversation], loading: false, initialLoadCompleted: true });
      return;
    }

    let shouldProceed = false;
    set(state => {
      if (state.loading) return state;
      shouldProceed = true;
      return { ...state, loading: true, error: null };
    });
    if (!shouldProceed) return;

    try {
      const rawConversations = await api<Conversation[]>("/api/conversations");
      if (!Array.isArray(rawConversations)) throw new Error('Invalid data from server.');

      const { shadowVault } = await import('@lib/shadowVaultDb');

      const conversations = await Promise.all(rawConversations.map(async c => {
        const participants = c.participants;

        let localLastMessage: Message | null = null;
        try {
            const localMsgs = await shadowVault.getMessagesByConversation(c.id, 1);
            if (localMsgs.length > 0) {
                localLastMessage = localMsgs[0];
            }
        } catch (_e) {}

        let lastMessage = c.lastMessage || null;
        
        if (lastMessage) {
            try {
              lastMessage = await decryptMessageObject(lastMessage);
            } catch (_e) {
              if (lastMessage.sessionId) emitSessionKeyRequest(lastMessage.conversationId, lastMessage.sessionId);
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
        
        let decryptedMetadata = undefined;
        if (c.isGroup && c.encryptedMetadata) {
             try {
                 const decrypted = await decryptGroupMetadata(c.encryptedMetadata, c.id);
                 if (decrypted) decryptedMetadata = decrypted;
             } catch (e) {
                 console.warn(`Failed to decrypt metadata for group ${c.id}`);
             }
        }

        return {
          ...c,
          lastMessage: finalLastMessage,
          participants,
          decryptedMetadata
        };
      }));

      const existingConversations = get().conversations;
      const reconciledConversations = await Promise.all(conversations.map(async fetched => {
          if (!fetched.isGroup) {
              const hasPqSession = await shadowVault.hasPqDrSession(fetched.id);
              if (hasPqSession) {
                  fetched.encryptionMode = 'PQ_DR';
              } else {
                  fetched.encryptionMode = 'SENDER_KEY';
              }
          }
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
      
      if (optimisticProfile) {
          const knownUsers = get().conversations.flatMap(c => c.participants);
          
          conv.participants = conv.participants.map(p => {
              if (p.id === peerId) {
                  const existing = knownUsers.find(u => u.id === peerId);
                  if (existing?.name && existing.name !== 'Unknown') {
                      return p; 
                  }
                  return { ...p, ...optimisticProfile }; 
              }
              return p;
          });
      }

      getSocket().emit("conversation:join", conv.id);
      get().addOrUpdateConversation(conv);
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
        conv = await authFetch<Conversation>("/api/conversations", {
            method: "POST",
            body: JSON.stringify({
                userIds,
                isGroup: true,
                encryptedMetadata: null 
            })
        });

        const distributionKeys = await ensureGroupSession(conv.id, conv.participants as unknown as Participant[], true);
        if (distributionKeys) {
            emitGroupKeyDistribution(conv.id, distributionKeys as { userId: string; key: string }[]);
        }
        
        const encryptedMetadata = await encryptGroupMetadata({ title: name, avatarUrl }, conv.id);
        
        await authFetch(`/api/conversations/${conv.id}/details`, {
            method: 'PUT',
            body: JSON.stringify({ encryptedMetadata })
        });
        
        const updatedConv: Conversation = {
            ...conv,
            decryptedMetadata: { title: name, avatarUrl },
            encryptedMetadata
        };
        
        getSocket().emit("conversation:join", conv.id);
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
    
    if (!decryptedMetadata && conversation.isGroup && conversation.encryptedMetadata) {
        try {
            const dec = await decryptGroupMetadata(conversation.encryptedMetadata as string, conversation.id);
            if (dec) decryptedMetadata = dec;
        } catch {}
    }

    set(state => {
      const existing = state.conversations.find(c => c.id === conversation.id);
      if (existing) {
        const updated = {
          ...existing,
          encryptedMetadata: conversation.encryptedMetadata,
          decryptedMetadata: decryptedMetadata || existing.decryptedMetadata,
          isGroup: conversation.isGroup,
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
          conversations: sortConversations([{ ...conversation, decryptedMetadata }, ...state.conversations], useAuthStore.getState().user?.id)
        };
      }
    });
  },

  removeConversation: (conversationId) => {
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

  updateConversation: async (id, data) => {
    let decryptedMetadata = undefined;
    if (data.encryptedMetadata) {
         try {
             const dec = await decryptGroupMetadata(data.encryptedMetadata, id);
             if (dec) decryptedMetadata = dec;
         } catch (e) {
             console.warn("Failed to decrypt updated metadata", e);
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
          import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(c.id).catch(console.error));
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
    import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(conversationId).catch(console.error));
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
    import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(conversationId).catch(console.error));
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

      if (newMsgTime < currentLastMsgTime) {
          // FIX: Pastikan kita tetap mengembalikan hasil array yang di-sort!
          if (!isMine && !isViewingChat) {
              const updatedConvos = state.conversations.map(c =>
                  c.id === conversationId
                      ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                      : c
              );
              return { conversations: sortConversations(updatedConvos, meId) };
          }
          return state;
      }

      const shouldIncrementUnread = !isMine && !isViewingChat;
      
      const updatedConversation = {
        ...conversation,
        lastMessage: withPreview(message),
        unreadCount: isViewingChat 
            ? 0 
            : (shouldIncrementUnread ? (conversation.unreadCount || 0) + 1 : conversation.unreadCount),
      };
      
      const otherConversations = state.conversations.filter(c => c.id !== conversationId);
      return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
    });
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