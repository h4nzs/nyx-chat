// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import type { UserId, ConversationId, MessageId, MessageSendPayload, SystemMessagePayload, GroupKeyDistributionPayload, SystemKeyRequestPayload } from '@nyx/shared';
import { asUserId, asConversationId, asMessageId } from '@nyx/shared';
import { createWithEqualityFn } from "zustand/traditional";
const uuidv4 = () => crypto.randomUUID();
import { api, authFetch } from "@lib/api"; 
import { transportClient, emitSessionKeyRequest, emitGroupKeyDistribution } from '@lib/transportClient';
import { captureAndLog } from '@utils/feedback';
import { 
  encryptMessage, 
  decryptMessage, 
  encryptFile, 
  ensureGroupSession,
  establishSessionFromPreKeyBundle, 
  getMyEncryptionKeyPair, 
  deriveSessionKeyAsRecipient,
  storeRatchetStateSecurely,
  retrieveRatchetStateSecurely,
  PreKeyBundle 
} from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore } from "./auth";
import type { RawServerMessage } from "./conversation";
import type { User, Message, Participant } from '@nyx/shared';
import useDynamicIslandStore, { UploadActivity } from './dynamicIsland';
import { useConversationStore } from "./conversation";
import { addToQueue, getQueueItems, removeFromQueue, updateQueueAttempt } from "@lib/offlineQueueDb";
import { useConnectionStore } from "./connection";
import { useKeychainStore } from "./keychain";
import { getSodium } from "@lib/sodiumInitializer";
import { shadowVault, saveStoryKey } from "../lib/shadowVaultDb";

import { useProfileStore, type DecryptedProfile } from './profile';

// Pipeline dekripsi & evaluasi control message (diekstrak ke lib/messagePipeline)
import { decryptMessageObject, evaluateControlMessage, createRepliedToForStoryReply } from '../lib/messagePipeline';
export { decryptMessageObject } from '../lib/messagePipeline';

import { isReactionPayload, isEditPayload, isSilentPayload, isStoryReplyPayload, isSystemMessagePayload, isFileMetadata, isPlainObject } from '@utils/typeGuards';
import { generateTempId as generateTempIdSafe } from '@utils/tempId';
import type { SilentPayload } from '@utils/typeGuards';import i18n from '../i18n';

const incomingMessageLocks = new Map<string, Promise<void>>();

function enrichMessagesWithSenderProfile(conversationId: string, messages: Message[]): Message[] {
    const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conv) return messages;
    
    const participantsMap = new Map(conv.participants.map(p => [('userId' in p ? (p.userId || p.id) : p.id), p]));
    const cachedProfiles = useProfileStore.getState().profiles;
    
    // O(profiles) sekali: petakan profile cache by userId (format key: `<userId>_<hash32>`).
    // Sebelumnya: Object.keys().find() per pesan → O(messages × profiles).
    const profilesByUser = new Map<string, DecryptedProfile>();
    for (const [key, profile] of Object.entries(cachedProfiles)) {
      const idPart = (key.length > 33 && key[key.length - 33] === '_') ? key.slice(0, key.length - 33) : key;
      if (!profilesByUser.has(idPart)) profilesByUser.set(idPart, profile);
    }
    
    return messages.map(m => {
        const pInfo = participantsMap.get(m.senderId);
        const globalProfile = profilesByUser.get(m.senderId) ?? null;

        const resolvedName = globalProfile?.name || pInfo?.name;
        const resolvedUsername = globalProfile?.username || pInfo?.username;
        const resolvedAvatar = globalProfile?.avatarUrl || pInfo?.avatarUrl;
        const encryptedProfile = pInfo?.encryptedProfile || (m.sender?.encryptedProfile);

        // If we found any real name, apply it and preserve metadata
        if (resolvedName && resolvedName !== 'Unknown' && resolvedName !== 'Encrypted User') {
            return {
                ...m,
                sender: { 
                    id: m.senderId, 
                    name: resolvedName, 
                    username: resolvedUsername, 
                    avatarUrl: resolvedAvatar,
                    encryptedProfile
                }
            };
        }
        
        // Ensure encryptedProfile is at least present for the UI hook to attempt decryption
        if (encryptedProfile && !(m.sender?.encryptedProfile)) {
            return {
                ...m,
                sender: {
                    ...(m.sender || { id: m.senderId }),
                    encryptedProfile
                }
            };
        }

        return m;
    });
}

/**
 * Reconstruct 1-1 conversation participants from message sender info.
 * Used in Opaque Mailbox when the server doesn't store participant lists.
 * Safe to call even if participants already exist (guarded by length check).
 */
function reconstructDirectParticipants(conversationId: string, messages: Message[]): void {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser || messages.length === 0) return;

    const firstMsgWithSender = messages.find(m => m.senderId && m.senderId !== currentUser.id);
    if (!firstMsgWithSender) return;

    const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conv || conv.isGroup || conv.participants.length > 0) return;

    const cachedProfiles = useProfileStore.getState().profiles;
    const profileKey = Object.keys(cachedProfiles).find(k => k.startsWith(firstMsgWithSender.senderId));
    const peerProfile = profileKey ? cachedProfiles[profileKey] : null;
    const peerEncryptedProfile = firstMsgWithSender.sender?.encryptedProfile;

    useConversationStore.getState().addOrUpdateConversation({
    ...conv,
    participants: [
      { id: currentUser.id, role: 'MEMBER' as const },
      {
        id: firstMsgWithSender.senderId,
        name: peerProfile?.name || '',
        encryptedProfile: peerEncryptedProfile,
        role: 'MEMBER' as const
      }
    ]
  });
}



// Robust helper to parse reaction payload
function parseReaction(content: string | null | undefined): { targetMessageId: string, emoji: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"reaction"')) return null;
    
    const parsed = JSON.parse(trimmed);
    if (isReactionPayload(parsed)) {
      return { targetMessageId: parsed.targetMessageId, emoji: parsed.emoji };
    }
  } catch (_e) {}
  return null;
}

function parseEdit(content: string | null | undefined): { targetMessageId: string, text: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"edit"')) return null;
    const parsed = JSON.parse(trimmed);
    if (isEditPayload(parsed)) {
      return { targetMessageId: parsed.targetMessageId, text: parsed.text };
    }
  } catch (_e) {}
  return null;
}

function parseSilent(content: string | null | undefined): SilentPayload | null {
  if (!content) return null;
  try {
    let trimmed = content.trim();
    if (trimmed.startsWith('STORY_KEY:')) {
        trimmed = trimmed.replace('STORY_KEY:', '');
    }
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed);
    
    if (isStoryReplyPayload(parsed)) {
      return null;
    }
    if (isSilentPayload(parsed)) {
      return parsed;
    }
  } catch (_e) {}
  return null;
}

// Helper to separate messages and reactions
// Helper to separate messages and reactions
function processMessagesAndReactions(decryptedItems: Message[], existingMessages: Message[] = []) {
  const chatMessages: Message[] = [];
  
  interface ReactionPayload { id: string; messageId: string; emoji: string; userId: string; createdAt: string; user?: unknown; isMessage: boolean; }
  const reactions: ReactionPayload[] = [];
  
  interface EditPayload { targetMessageId: string; text: string; timestamp: number; }
  const edits: EditPayload[] = [];

  // Keranjang penampung sinyal E2EE baru
  const unsends: { targetMessageId: string; senderId: string; createdAt: string; conversationId: string }[] = [];
  const reactionRemoves: { targetMessageId: string; emoji: string; senderId: string }[] = [];

  // ==========================================
  // TAHAP 1: EKSTRAKSI & PENGELOMPOKAN
  // ==========================================
  for (const msg of decryptedItems) {
    const reactionPayload = parseReaction(msg.content);
    const editPayload = parseEdit(msg.content);
    const silentPayload = parseSilent(msg.content);

    if (reactionPayload) {
        reactions.push({
          id: msg.id,
          messageId: reactionPayload.targetMessageId,
          emoji: reactionPayload.emoji,
          userId: msg.senderId,
          createdAt: msg.createdAt,
          user: msg.sender,
          isMessage: true
        });
    } else if (editPayload) {
        edits.push({
           targetMessageId: editPayload.targetMessageId, text: editPayload.text, timestamp: new Date(msg.createdAt).getTime()
        });
    } else {
      if (silentPayload) {
          if (silentPayload.type === 'STORY_KEY' && silentPayload.key && silentPayload.storyId) {
              // Save the story key
              saveStoryKey(silentPayload.storyId, silentPayload.key).catch(e => console.error("Failed to save story key from history", e));
              continue;
          }
          
          // Masukkan ke keranjang reactionRemoves
          if (silentPayload.type === 'reaction_remove' && silentPayload.targetMessageId && silentPayload.emoji) {
              reactionRemoves.push({
                  targetMessageId: silentPayload.targetMessageId,
                  emoji: silentPayload.emoji,
                  senderId: msg.senderId
              });
              continue; 
          }

          // Masukkan ke keranjang unsends
          if (silentPayload.type === 'UNSEND' && silentPayload.targetMessageId) {
             unsends.push({
                 targetMessageId: silentPayload.targetMessageId,
                 senderId: msg.senderId,
                 createdAt: msg.createdAt,
                 conversationId: msg.conversationId
             });
             continue;
          }
          
          msg.content = silentPayload.text;
          msg.isSilent = true;
          if (!msg.content) {
              continue; 
          }
      }
      chatMessages.push(msg);
    }
  }

  // ==========================================
  // TAHAP 2: MEMBUAT PETA PESAN
  // ==========================================
  const messageMap = new Map([...existingMessages, ...chatMessages].map(m => [m.id, m]));
  
  // ==========================================
  // TAHAP 3: MENERAPKAN SEMUA PERUBAHAN
  // ==========================================

  // 1. Terapkan Reaksi & Cabut Reaksi — ✅ FIX: Apply in order using last-action map
  // Build a map keyed by `${messageId}|${userId}|${emoji}` to track the final action
  const reactionActionMap = new Map<string, { action: 'add' | 'remove', ts: number }>();

  // First, mark all existing reactions as "add" baseline
  for (const msg of messageMap.values()) {
    for (const r of (msg.reactions || [])) {
      const key = `${msg.id}|${r.userId}|${r.emoji}`;
      const rObj = r as { createdAt?: string | Date };
      reactionActionMap.set(key, { action: 'add', ts: rObj.createdAt ? new Date(rObj.createdAt).getTime() : Date.now() });
    }
  }

  // Then apply incoming adds
  for (const reaction of reactions) {
    const key = `${reaction.messageId}|${reaction.userId}|${reaction.emoji}`;
    const rObj = reaction as { createdAt?: string | Date };
    const eventTs = rObj.createdAt ? new Date(rObj.createdAt).getTime() : Date.now();
    const existing = reactionActionMap.get(key);
    if (!existing || eventTs >= existing.ts) {
        reactionActionMap.set(key, { action: 'add', ts: eventTs });
    }
  }

  // Then apply removes
  for (const rr of reactionRemoves) {
    const key = `${rr.targetMessageId}|${rr.senderId}|${rr.emoji}`;
    const rrObj = rr as { createdAt?: string | Date };
    const eventTs = rrObj.createdAt ? new Date(rrObj.createdAt).getTime() : Date.now();
    const existing = reactionActionMap.get(key);
    if (!existing || eventTs >= existing.ts) {
        reactionActionMap.set(key, { action: 'remove', ts: eventTs });
    }
  }

  // Now rebuild reactions based on final state
  for (const msg of messageMap.values()) {
    const finalReactions: Message['reactions'] = [];
    for (const r of (msg.reactions || [])) {
      const key = `${msg.id}|${r.userId}|${r.emoji}`;
      if (reactionActionMap.get(key)?.action === 'add') {
        finalReactions.push(r);
      }
    }
    msg.reactions = finalReactions;
  }

  // Add new reactions that weren't in the original map
  for (const reaction of reactions) {
    const target = messageMap.get(asMessageId(reaction.messageId));
    if (target) {
      const key = `${reaction.messageId}|${reaction.userId}|${reaction.emoji}`;
      if (reactionActionMap.get(key)?.action === 'add' && !target.reactions?.some(r => r.id === reaction.id)) {
        target.reactions = [...(target.reactions || []), { ...reaction, userId: asUserId(reaction.userId) }];
      }
    }
  }

  // 3. Terapkan Editan (Diurutkan dari yang terbaru)
  edits.sort((a, b) => a.timestamp - b.timestamp);
  for (const edit of edits) {
     const target = messageMap.get(asMessageId(edit.targetMessageId));
     if (target) {
        target.content = edit.text;
        target.isEdited = true;
     }
  }

  // 4. Terapkan Tarik Pesan (Unsend Tombstones)
  for (const un of unsends) {
      const targetId = asMessageId(un.targetMessageId);
      const target = messageMap.get(targetId);

      // Keamanan E2EE: Hanya pengirim asli yang berhak menarik pesannya
      if (target && target.senderId === un.senderId) {
          target.content = null;
          target.fileUrl = undefined;
          target.fileKey = undefined;
          target.fileName = undefined;
          target.fileType = undefined;
          target.fileSize = undefined;
          target.duration = undefined;
          target.isBlindAttachment = false;
          target.isDeletedLocal = true;
          target.reactions = [];
      } else if (!target) {
          // Jika pesan aslinya belum ter-load ke UI, suntikkan nisannya langsung ke DB
          import('@lib/shadowVaultDb').then(m => m.shadowVault.upsertMessages([{
              id: targetId,
              conversationId: asConversationId(un.conversationId),
              isDeletedLocal: true,
              content: null,
              fileUrl: undefined,
              fileKey: undefined,
              fileName: undefined,
              fileType: undefined,
              fileSize: undefined,
              duration: undefined,
              isBlindAttachment: false,
              createdAt: un.createdAt,
              senderId: asUserId(un.senderId)
          } as Message]));
      }
  }

  return Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

type State = {
  messages: Record<string, Message[]>;
  pendingDecryptions: Message[];
  isFetchingMore: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  // [PAGINATION] Ada lagi pesan di SERVER yang belum ter-fetch (cursor belum
  // habis). Berbeda dengan hasMore yang murni status vault lokal — serverHasMore
  // memicu fallback fetch server di loadPreviousMessages ketika vault lokal
  // sudah habis tapi riwayat server masih panjang (user offline lama di grup
  // aktif yang window 250 pertamanya tidak cukup).
  serverHasMore: Record<string, boolean>;
  hasLoadedHistory: Record<string, boolean>;
  selectedMessageIds: string[];
};

type Actions = {
  sendReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  uploadFile: (conversationId: string, file: File) => Promise<void>;
  loadMessagesForConversation: (id: string) => Promise<void>;
  loadPreviousMessages: (conversationId: string) => Promise<void>;
  loadMessageContext: (messageId: string) => Promise<void>;
  addOptimisticMessage: (conversationId: string, message: Message) => void;
  addIncomingMessage: (conversationId: string, message: Message) => Promise<Message | null>;
  doAddIncomingMessage: (conversationId: string, message: Message) => Promise<Message | null>;
  replaceOptimisticMessage: (conversationId: string, tempId: number, newMessage: Partial<Message>) => Promise<void>;
  removeMessage: (conversationId: string, messageId: string) => void;
  removeMessages: (conversationId: string, messageIds: string[]) => Promise<void>;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  addLocalReaction: (conversationId: string, messageId: string, reaction: { id: string; emoji: string; userId: string; isMessage?: boolean }) => void;
  removeLocalReaction: (conversationId: string, messageId: string, reactionId: string) => void;
  replaceOptimisticReaction: (conversationId: string, messageId: string, tempId: string, finalReaction: { id: string; emoji: string; userId: string; isMessage?: boolean }) => void;
  updateSenderDetails: (user: Partial<User>) => void;
  updateMessageStatus: (conversationId: string, messageId: string, userId: string, status: string) => void;
  clearMessagesForConversation: (conversationId: string) => void;
  retrySendMessage: (message: Message) => void;
  addSystemMessage: (conversationId: string, content: string) => Promise<void>;
  reDecryptPendingMessages: (conversationId: string) => Promise<void>;
  failPendingMessages: (conversationId: string, reason: string) => void;
  processOfflineQueue: () => Promise<void>;
  reset: () => void;
  resendPendingMessages: () => void;
  sendMessage: (conversationId: string, data: Partial<Message>, tempId?: number, isSilent?: boolean) => Promise<void>;
  toggleMessageSelection: (id: string) => void;
  clearMessageSelection: () => void;
  repairSecureSession: (conversationId: string, isGroup: boolean, isAuto?: boolean) => Promise<void>;
};

// [Temuan #3] Generator tempId dipindah ke util bersama — skema packing bit
// (epoch-detik | counter per-tab | boot-random) tahan collision antar-tab.
// Kontrak retry-dengan-tempId-sama untuk dedupe server tidak berubah.
const generateTempId = () => generateTempIdSafe();

const initialState: State = {
  messages: {},
  pendingDecryptions: [],
  isFetchingMore: {},
  hasMore: {},
  serverHasMore: {},
  hasLoadedHistory: {},
  selectedMessageIds: [],
};

// ✅ FIX: Use composite key `${conversationId}:${messageId}` to prevent race overwrites
const pendingStatuses: Record<string, { conversationId: string; userId: string, status: string }> = {};

export const useMessageStore = createWithEqualityFn<State & Actions>((set, get) => ({
  ...initialState,

  reset: () => {
    set(initialState);
  },

  toggleMessageSelection: (id) => set(state => ({
      selectedMessageIds: state.selectedMessageIds.includes(id)
          ? state.selectedMessageIds.filter(x => x !== id)
          : [...state.selectedMessageIds, id]
  })),

  clearMessageSelection: () => set({ selectedMessageIds: [] }),

  repairSecureSession: async (conversationId, isGroup, isAuto = false) => {
    try {
      // ✅ FIX: Karena semua chat (1-on-1 maupun grup) kini menggunakan Sender Key Fan-Out,
      // kita perbaiki sesinya dengan cara yang sama. Tidak ada lagi X3DH GHOST_SYNC.
      const { forceRotateGroupSenderKey, rotateGroupKey } = await import('@utils/crypto');
      await forceRotateGroupSenderKey(conversationId);
      await rotateGroupKey(conversationId, 'periodic_rotation');
      
      if (!isAuto) {
          toast.success(i18n.t('common:secure_session_state_reset_next_message_', 'Secure session state reset. Next message will negotiate new keys.'));
      }
    } catch (error) {
      console.error("Failed to repair session:", error);
      if (!isAuto) toast.error(i18n.t('errors:failed_to_repair_session', 'Failed to repair session.'));
    }
  },

  removeMessages: async (conversationId, messageIds) => {
    const { user } = useAuthStore.getState();
    const currentMessages = get().messages[conversationId] || [];
    const selectedMessages = currentMessages.filter(m => messageIds.includes(m.id));
    
    // Check if all selected messages are mine
    const allMine = user && selectedMessages.every(m => m.senderId === user.id);

    // 1. Delete from Server (only if all are mine)
    if (allMine) {
        selectedMessages.forEach(message => {
            let query = '';
            let targetUrl = message.fileUrl;
            try {
                if (message.content && message.content.startsWith('{')) {
                    const metadata = JSON.parse(message.content) as { url?: string };
                    if (metadata.url) targetUrl = metadata.url;
                }
            } catch (_e) {}

            if (targetUrl && !targetUrl.startsWith('blob:')) {
                try {
                    const url = new URL(targetUrl);
                    const key = url.pathname.substring(1);
                    if (key) query = `?r2Key=${encodeURIComponent(key)}`;
                } catch (_e) {
                    console.error("Failed to parse file URL for deletion:", _e);
                }
            }

            api(`/api/messages/${message.id}${query}`, { 
                method: 'DELETE',
                headers: message.deleteSecret ? { 'X-Delete-Token': message.deleteSecret } : undefined
            }).catch((error) => {
                console.error(`Failed to delete message ${message.id} from server:`, error);
            });
        });
    }

    // 2. TOMBSTONE in local vault & Wipe MK (Always)
    const tombstones: Message[] = [];
    for (const id of messageIds) {
        const existing = selectedMessages.find(m => m.id === id);
        if (existing) {
            // Soft delete: Keep record but strip content
            tombstones.push({ ...existing, content: null, fileUrl: undefined, isDeletedLocal: true });
        } else {
            tombstones.push({ id, conversationId, isDeletedLocal: true, createdAt: new Date().toISOString(), senderId: 'unknown' } as Message);
        }
        import('@utils/crypto').then(m => m.deleteMessageKeySecurely(id)).catch(captureAndLog);
    }
    shadowVault.upsertMessages(tombstones).catch(captureAndLog);

    // 3. Remove from active state
    set(state => {
        const current = state.messages[conversationId] || [];
        return { 
          messages: { ...state.messages, [conversationId]: current.filter(m => !messageIds.includes(m.id)) },
          selectedMessageIds: [] // Clear selection after deletion
        };
    });
  },

  sendReaction: async (conversationId: string, messageId: string, emoji: string) => {
      const { user } = useAuthStore.getState();
      if (!user) return;

      const timestamp = Date.now();
      const tempReactionId = `temp_react_${timestamp}`;
      const optimisticReaction = {
          id: tempReactionId,
          messageId,
          emoji,
          userId: user.id,
          createdAt: new Date().toISOString(),
          user: user,
          isMessage: true
      };
      get().addLocalReaction(conversationId, messageId, optimisticReaction);

      const metadata = {
          type: 'reaction',
          targetMessageId: messageId,
          emoji
      };
      
      await get().sendMessage(conversationId, {
          content: JSON.stringify(metadata)
      }, timestamp);
  },

  sendMessage: async (conversationId, data, tempId?: number, isSilent = false) => {
    const { user, hasRestoredKeys } = useAuthStore.getState();
    if (!user) return;

    if (conversationId.startsWith('burner_')) {
      const actualTempId = tempId !== undefined ? tempId : generateTempId();
      
      const { useBurnerStore } = await import('./burner');
      const burnerState = useBurnerStore.getState();
      const session = burnerState.activeSessions[conversationId];
      const state = session?.drState;

      if (!state) {
        toast.error("Waiting for guest to connect first.");
        return;
      }
      
      let lastMsgPreview = data.content;
      try {
         if (lastMsgPreview?.startsWith('{') && lastMsgPreview.includes('"type":"file"')) {
             lastMsgPreview = '📎 Sent a file';
         }
      } catch {}

      const msg: Message = {
          id: asMessageId(`temp_${actualTempId}`), tempId: actualTempId, optimistic: true,
          content: data.content, senderId: asUserId(user.id), sender: user,
          createdAt: new Date().toISOString(), conversationId: asConversationId(conversationId), status: 'SENDING' as const,
          isSilent: isSilent, reactions: [],
      };

      if (!isSilent) {
        get().addOptimisticMessage(conversationId, msg);
        const { useConversationStore } = await import('./conversation');
        useConversationStore.getState().updateConversationLastMessage(conversationId, { ...msg, content: lastMsgPreview, fileType: data.fileType, fileName: data.fileName });
      }
      
      try {
        const { worker_burner_dr_encrypt } = await import('../lib/crypto-worker-proxy');
        const { state: newState, header, ciphertext } = await worker_burner_dr_encrypt({
          state,
          plaintext: data.content || ""
        });
        useBurnerStore.setState((s) => ({
          activeSessions: {
            ...s.activeSessions,
            [conversationId]: { ...session, drState: newState }
          }
        }));
        
        const { getSodiumLib } = await import('../utils/crypto');
        const sodium = await getSodiumLib();
        const ciphertextB64 = sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        const payload = { header, ciphertext: ciphertextB64 };
        
        const socket = (await import('../lib/transportClient')).transportClient;
        transportClient.sendEvent('burner:reply', { roomId: conversationId, ciphertext: JSON.stringify(payload) });
        
        // Update local status to SENT
        get().updateMessage(conversationId, `temp_${actualTempId}`, { status: 'SENT' });
      } catch (e) {
        console.error('Burner encrypt failed:', e);
        toast.error("Failed to send burner message");
        get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true });
      }
        return;
    }

    if (!hasRestoredKeys) {
      toast.error(i18n.t('errors:you_must_restore_your_keys_from_your_rec', 'You must restore your keys from your recovery phrase before you can send messages.'));
      return;
    }

    let conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      toast.error(i18n.t('errors:conversation_not_found', 'Conversation not found.'));
      return;
    }

    // [OPAQUE MAILBOX FIX] Populate participants from IndexedDB cache if empty,
    // so non-creator members can send messages before metadata is re-decrypted.
    if (conversation.isGroup && (!conversation.participants || conversation.participants.length === 0)) {
        const { getCachedGroupParticipants } = await import('@lib/keychainDb');
        const cachedUserIds = await getCachedGroupParticipants(conversationId);
        if (cachedUserIds && cachedUserIds.length > 0) {
            const currentUser = useAuthStore.getState().user;
            const reconstructedParticipants = cachedUserIds.map(id => ({
                id, name: id === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
            })) as Participant[];
            // Update the store so both ensureGroupSession and targetRecipients use the correct list
            await useConversationStore.getState().updateConversation(conversationId, { participants: reconstructedParticipants });
            conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
        } else {
            // Fallback: try to fetch encryptedMetadata from server and decrypt to get participants
            try {
                const { authFetch } = await import('@lib/api');
                const serverConv: any = await authFetch(`/api/conversations/${conversationId}`);
                if (serverConv?.encryptedMetadata) {
                    await useConversationStore.getState().updateConversation(conversationId, {
                        encryptedMetadata: serverConv.encryptedMetadata
                    });
                    conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
                }
            } catch (e) {
                console.warn(`[OpaqueMailbox] Failed to fetch conversation ${conversationId} from server`, e);
            }
        }
    }

    if (!conversation) {
      toast.error(i18n.t('errors:conversation_not_found', 'Conversation not found.'));
      return;
    }
    const forceRotate = conversation.requiresKeyRotation === true;

    // ✅ FASE 3: Distribusi Sender Key (hanya untuk grup, SPQR 1-1 pakai DR langsung)
    if (conversation.isGroup) {
      try {
        const distributionKeys = await ensureGroupSession(conversationId, conversation.participants, forceRotate);
        if (distributionKeys && distributionKeys.length > 0) {
          await emitGroupKeyDistribution(
            conversationId,
            distributionKeys as { userId: string; key: string }[]
          );
          if (forceRotate) {
              useConversationStore.getState().markKeyRotationNeeded(conversationId, false);
          }
          await new Promise(r => setTimeout(r, 300)); 
        }
      } catch (e) {
        console.error("Failed to ensure session", e);
        toast.error(i18n.t('errors:failed_to_establish_secure_session', 'Failed to establish secure session. Please try again.'));
        return;
      }
    }

    const actualTempId = tempId !== undefined ? tempId : generateTempId();
    const deleteSecret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');

    const isReactionPayload = !!parseReaction(data.content);
    const silentPayload = parseSilent(data.content);
    const isEditPayload = !!parseEdit(data.content);
    
    // [FIX] Detect CALL_INIT or GHOST_SYNC and force silence to prevent empty bubble
    const isCallInit = silentPayload?.type === 'CALL_INIT';
    const isGhostSync = silentPayload?.type === 'GHOST_SYNC';
    const isUnsend = silentPayload?.type === 'UNSEND';
    const isReactionRemove = silentPayload?.type === 'reaction_remove';
    const isSystemKeyRequest = silentPayload?.type === 'SYSTEM_KEY_REQUEST' || (typeof data.content === 'string' && data.content.includes('SYSTEM_KEY_REQUEST')) || (typeof data.content === 'string' && data.content.includes('GROUP_KEY_DISTRIBUTION'));
    const shouldBeSilent = isSilent || data.isSilent || isCallInit || isGhostSync || isUnsend || isReactionRemove || isEditPayload || isReactionPayload || isSystemKeyRequest;

    if (!shouldBeSilent) {
        let optimisticContent = data.content;
        let isOptimisticSilent = false;

        if (silentPayload) {
            optimisticContent = silentPayload.text;
            isOptimisticSilent = true;
        }

        const optimisticMessage: Message = {
            ...data,
            id: asMessageId(`temp_${actualTempId}`),
            tempId: actualTempId,
            optimistic: true,
            sender: user,
            senderId: asUserId(user.id),
            createdAt: new Date().toISOString(),
            conversationId: asConversationId(conversationId),
            reactions: [],
            statuses: [{ userId: asUserId(user.id), status: 'READ', messageId: asMessageId(`temp_${actualTempId}`), id: `temp_status_${actualTempId}`, updatedAt: new Date().toISOString() }],
            status: 'SENDING',
            repliedTo: data.repliedTo,
            isSilent: isOptimisticSilent || data.isSilent,
            deleteSecret // Persist locally for blind deletion auth
        };

        // Parse optimistic content for special message types
        if (silentPayload) {
            optimisticMessage.isSilent = true;
        }

        // Handle story_reply type - parse and set proper content + repliedTo
        if (optimisticContent && typeof optimisticContent === 'string' && optimisticContent.startsWith('{') && optimisticContent.includes('"type":"story_reply"')) {
            try {
                const metadata = JSON.parse(optimisticContent) as { type?: string, text?: string, storyAuthorId?: string, storyText?: string, hasMedia?: boolean };
                if (metadata.type === 'story_reply') {
                    optimisticMessage.content = metadata.text || 'Story reply';
                    optimisticMessage.repliedTo = createRepliedToForStoryReply(
                        conversationId,
                        metadata.storyAuthorId || '',
                        metadata.storyText,
                        metadata.hasMedia
                    );
                }
            } catch (e) {
                console.error('Failed to parse story_reply metadata:', e);
            }
        } else {
            optimisticMessage.content = optimisticContent;
        }

        if (optimisticMessage.content) {
            optimisticMessage.preview = optimisticMessage.content;
        }

        get().addOptimisticMessage(conversationId, optimisticMessage);

        // Update conversation last message with proper preview
        let lastMsgPreview = optimisticMessage.content;
        try {
           if (lastMsgPreview?.startsWith('{') && lastMsgPreview.includes('"type":"file"')) {
               lastMsgPreview = '📎 Sent a file';
           } else if (lastMsgPreview?.startsWith('{') && lastMsgPreview.includes('"type":"story_reply"')) {
               const meta = JSON.parse(lastMsgPreview) as { text?: string };
               lastMsgPreview = `Replying to story: ${meta.text}`;
           }
        } catch {}
        useConversationStore.getState().updateConversationLastMessage(conversationId, { ...optimisticMessage, content: lastMsgPreview, fileType: data.fileType, fileName: data.fileName });

    }

    // [BUG-FIX H1] Watchdog untuk menjamin bubble optimistik mencapai status
    // terminal (FAILED) bila callback emit transport tidak pernah fire.
    let sendWatchdog: ReturnType<typeof setTimeout> | undefined;
    const clearSendWatchdog = () => {
      if (sendWatchdog) {
        clearTimeout(sendWatchdog);
        sendWatchdog = undefined;
      }
    };

    try {
      let ciphertext = '';
      let mkToStore: Uint8Array | undefined;
      let contentToEncrypt = data.content;

      if (contentToEncrypt) {
        try {
            const profileKey = await import('@lib/keychainDb').then(m => m.getProfileKey(user.id));
            if (profileKey) {
                let parsedObj: Record<string, unknown> | null = null;
                if (contentToEncrypt.trim().startsWith('{')) {
                    try { const _parsedObj = JSON.parse(contentToEncrypt); parsedObj = isPlainObject(_parsedObj) ? _parsedObj : null; } catch (e) {}
                }
                
                const myUser = useAuthStore.getState().user;
                const myEncryptedProfile = myUser?.encryptedProfile;
                
                if (parsedObj && typeof parsedObj === 'object') {
                    parsedObj.profileKey = profileKey;
                    if (myEncryptedProfile) parsedObj.encryptedProfile = myEncryptedProfile;
                    contentToEncrypt = JSON.stringify(parsedObj);
                } else {
                    const obj: Record<string, unknown> = { text: contentToEncrypt, profileKey };
                    if (myEncryptedProfile) obj.encryptedProfile = myEncryptedProfile;
                    contentToEncrypt = JSON.stringify(obj);
                }
            }
        } catch (e) {
            console.error("Failed to inject profile key", e);
        }

        // Save sender state before silent group message encryption to prevent
        // SYSTEM/GHOST messages from ratcheting the state used for user messages.
        const isSilentGroupMsg = conversation.isGroup && shouldBeSilent;
        let savedSenderState: any = null;
        if (isSilentGroupMsg) {
            const { getGroupSenderState } = await import('@lib/keychainDb');
            savedSenderState = await getGroupSenderState(conversationId);
        }
        const result = await encryptMessage(contentToEncrypt, conversationId, !!conversation.isGroup, undefined, `temp_${actualTempId}`);
        if (isSilentGroupMsg && savedSenderState) {
            const { saveGroupSenderState } = await import('@lib/keychainDb');
            await saveGroupSenderState(savedSenderState).catch(e => console.warn("Failed to restore sender state after silent msg", e));
        }
        ciphertext = result.ciphertext;
        
        // [FIX PERSISTENCE] Store MK for ALL chats (Group + 1on1)
        if (result.mk) {
             mkToStore = result.mk;
             await import('@utils/crypto').then(({ storeMessageKeySecurely }) => 
                 storeMessageKeySecurely(`temp_${actualTempId}`, mkToStore!)
             );
        }
      }

      const pushPayloads: Record<string, string> = {};
      try {
        const { getSodium } = await import('@lib/sodiumInitializer');
        const sodium = await getSodium();
        const { worker_crypto_box_seal } = await import('@lib/crypto-worker-proxy');

        const myAuthUser = useAuthStore.getState().user;
        let myName = 'Someone';

        if (myAuthUser?.encryptedProfile) {
           try {
              const profileStore = (await import('@store/profile')).useProfileStore.getState();
              // We pass null for profileKey fallback internally inside decryptAndCache
              const myDecrypted = await profileStore.decryptAndCache(myAuthUser.id, myAuthUser.encryptedProfile);
              if (myDecrypted && myDecrypted.name !== "Encrypted User") {
                  myName = myDecrypted.name;
              }
           } catch (e) {
              console.error("Failed to decrypt own profile for push", e);
           }
        }

        // DO NOT generate push payload for silent messages (STORY_KEY, CALL_INIT, GHOST_SYNC, etc.)
        const silentPayload = parseSilent(data.content);
        const isSilentMessage = data.isSilent || silentPayload !== null;
        
        if (!isSilentMessage) {
            // Prepare the push content securely
            let pushBody: string;
            
            // Check for story_reply type and extract the text
            if (typeof data.content === 'string' && data.content.startsWith('{') && data.content.includes('"type":"story_reply"')) {
                try {
                    const metadata = JSON.parse(data.content) as { type?: string, text?: string };
                    if (metadata.type === 'story_reply' && metadata.text) {
                        pushBody = `📖 Story reply: ${metadata.text}`;
                    } else {
                        pushBody = '📖 Replied to your story';
                    }
                } catch (e) {
                    pushBody = '📖 Replied to your story';
                }
            } else if (data.fileUrl || data.fileName) {
                pushBody = `Sent a file: ${data.fileName || 'Attachment'}`;
            } else if (data.isViewOnce) {
                pushBody = 'Sent a view-once message';
            } else if (typeof data.content === 'string' && data.content.trim()) {
                const maxLength = 100;
                pushBody = data.content.length > maxLength
                    ? data.content.substring(0, maxLength) + '...'
                    : data.content;
            } else {
                pushBody = 'Sent a secure message';
            }

            const pushData = JSON.stringify({ title: myName, body: pushBody, conversationId });
            const pushDataBytes = new TextEncoder().encode(pushData);

            // Encrypt for each recipient using Web Worker
            type PublicKeyInput = string | Uint8Array | { type: 'Buffer'; data: number[] } | ArrayBufferView;
            type ParticipantData = { 
                id: string, 
                userId?: string, 
                user?: { 
                    devices?: {id: string, publicKey: PublicKeyInput}[], 
                    publicKey?: PublicKeyInput 
                }, 
                devices?: {id: string, publicKey: PublicKeyInput}[], 
                publicKey?: PublicKeyInput 
            };

            // Kumpulkan semua (deviceId → publicKey bytes) dulu, lalu seal
            // PARALEL via Promise.all — sebelumnya sequential per device.
            const sealTargets: { deviceId: string; pubBytes: Uint8Array }[] = [];

            for (const p of conversation.participants as ParticipantData[]) {
               const targetUserId = p.userId || p.id;
               const userObj = p.user || p;

               if (targetUserId !== user.id) {
                   const targetDevices = userObj.devices || [];
                   // Fallback for legacy schema or if devices array is empty
                   if (targetDevices.length === 0 && userObj.publicKey) {
                       targetDevices.push({ id: 'legacy', publicKey: userObj.publicKey });
                   }

                   for (const device of targetDevices) {
                       const targetPublicKey = device.publicKey;
                       if (targetPublicKey) {
                           try {
                               let recipientPubBytes: Uint8Array;
                               
                               if (typeof targetPublicKey !== 'string') {
                                   if (typeof targetPublicKey === 'object' && targetPublicKey !== null && 'type' in targetPublicKey && (targetPublicKey as Record<string, unknown>).type === 'Buffer' && Array.isArray((targetPublicKey as Record<string, unknown>).data)) {
                                       recipientPubBytes = new Uint8Array((targetPublicKey as Record<string, unknown>).data as number[]);
                                   } else if (targetPublicKey instanceof Uint8Array || ArrayBuffer.isView(targetPublicKey)) {
                                       recipientPubBytes = new Uint8Array(targetPublicKey.buffer, targetPublicKey.byteOffset, targetPublicKey.byteLength);
                                   } else {
                                       throw new Error("Invalid public key type: " + typeof targetPublicKey);
                                   }
                               } else {
                                   try {
                                       recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                                   } catch (e1) {
                                       try {
                                           recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.ORIGINAL);
                                       } catch (e2) {
                                           recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.URLSAFE);
                                       }
                                   }
                               }

                               sealTargets.push({ deviceId: device.id, pubBytes: recipientPubBytes });
                           } catch (e) {
                               console.error(`Failed to parse public key for device ${device.id}`, e);
                           }
                       }
                   }
               }
            }

            await Promise.all(sealTargets.map(async ({ deviceId, pubBytes }) => {
                try {
                    const sealed = await worker_crypto_box_seal(pushDataBytes, pubBytes);
                    pushPayloads[deviceId] = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
                } catch (e) {
                    console.error(`Failed to seal push for device ${deviceId}`, e);
                }
            }));
        }
      } catch (e) {
        console.error("Failed to generate push payloads", e);
      }

      const payload = {
          ...data,
          content: ciphertext,
          sessionId: undefined,
          fileKey: undefined, fileName: undefined, fileType: undefined, fileSize: undefined,
          pushPayloads: Object.keys(pushPayloads).length > 0 ? pushPayloads : undefined
      };

      const socket = transportClient;
      const isConnected = socket?.connected;

      if (!isConnected && !isReactionPayload) {
        const queueMsg = { ...payload, id: asMessageId(`temp_${actualTempId}`), tempId: actualTempId, conversationId: asConversationId(conversationId), senderId: asUserId(user.id), createdAt: new Date().toISOString() } as Message;
        await addToQueue(conversationId, queueMsg, actualTempId);
        return;
      }

      const sendPayload: MessageSendPayload = {
        conversationId: asConversationId(conversationId),
        content: payload.content || "", 
        tempId: actualTempId,
        sessionId: payload.sessionId ?? undefined,
        expiresAt: payload.expiresAt ?? undefined,
        pushPayloads: payload.pushPayloads ?? undefined,
        repliedToId: payload.repliedToId ?? undefined,
        isViewOnce: payload.isViewOnce ?? false,
        targetRecipients: conversation.participants.map(p => p.userId || p.id),
        deleteSecret
      };

      // [BUG-FIX H1] Sabuk-dan-gesper: jika callback emit transport tidak pernah
      // fired (mis. transport mati di tengah pengiriman), paksa bubble optimistik
      // menuju status terminal FAILED agar tidak menggantung di 'SENDING' selamanya.
      sendWatchdog = setTimeout(() => {
        if (!isReactionPayload && !shouldBeSilent) {
          const pending = get().messages[conversationId]?.find(
            (m) => m.id === `temp_${actualTempId}` || m.tempId === actualTempId
          );
          if (pending && pending.status === 'SENDING') {
            get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
            toast.error(i18n.t('errors:failed_to_send_message_timeout', 'Failed to send message (Timeout).'));
          }
        }
        sendWatchdog = undefined;
      }, 20000);

      socket?.timeout(15000).emit(
        "message:send",
        sendPayload, 
        async (err: Error | null, res: { ok: boolean, msg?: RawServerMessage, error?: string }) => {
          clearSendWatchdog();
          if (err) {
              console.error("Socket timeout or error:", err);
              if (!isReactionPayload && !shouldBeSilent) {
                  get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
                  toast.error(i18n.t('errors:failed_to_send_message_timeout', 'Failed to send message (Timeout).'));
              } else if (isReactionPayload) {
                  const reactionData = parseReaction(data.content);
                  if (reactionData) {
                      get().removeLocalReaction(conversationId, reactionData.targetMessageId, `temp_react_${actualTempId}`);
                  }
              }
              return;
          }

          if (res.ok && res.msg) {
              
            // 1. Pindah Kunci Dekripsi Segera
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${actualTempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${actualTempId}`);
                }
            }).catch(captureAndLog);

            // 2. Tangani Reaksi (Tanpa Gelembung Chat)
            if (isReactionPayload) {
                const reactionData = parseReaction(data.content);
                if (reactionData) {
                    const tempReactionId = `temp_react_${actualTempId}`;
                    get().replaceOptimisticReaction(conversationId, reactionData.targetMessageId, tempReactionId, {
                        ...reactionData,
                        id: res.msg.id, 
                        userId: user.id,
                        isMessage: true
                    });
                }
                return; // KELUAR DI SINI (Jangan buat bubble chat)
            }

            // 3. Tangani Pesan Siluman (Edit/Unsend/Story/Call)
            if (shouldBeSilent) {
                return; // KELUAR DI SINI (Jangan buat bubble chat agar JSON mentah tidak bocor)
            }

            // 4. Proses Pesan Chat Normal
            const tempIdStr = `temp_${actualTempId}`;
            const existingMsg = get().messages[conversationId]?.find(m => 
                 m.id === tempIdStr || m.tempId === actualTempId
            );

            let realFileUrl = existingMsg?.fileUrl;
            let realFileKey = existingMsg?.fileKey;
            try {
                if (data.content && typeof data.content === 'string' && data.content.startsWith('{')) {
                    const meta = JSON.parse(data.content) as { type?: string, url?: string, key?: string, name?: string, size?: number, mimeType?: string, text?: string, storyAuthorId?: string, isReply?: boolean, storyText?: string, hasMedia?: boolean };
                    if (meta.type === 'file' && meta.url) {
                        realFileUrl = meta.url;
                        realFileKey = meta.key;
                    }
                }
            } catch (e) {}

            let finalContent = existingMsg !== undefined ? existingMsg.content : res.msg!.content;
            
            // Sealed Sender: pastikan senderId pesan kita sendiri tidak kosong
            if (!res.msg!.senderId && existingMsg?.senderId) {
                res.msg!.senderId = existingMsg.senderId;
            }

            // Jaring pengaman: Dekripsi Diri Sendiri
            if (finalContent && typeof finalContent === 'string' && finalContent.trim().startsWith('{') && finalContent.includes('"ciphertext"')) {
                 finalContent = "🔒 You sent this message (Encrypted)";
                 import('@utils/crypto').then(async ({ retrieveMessageKeySecurely }) => {
                     try {
                         // Kita ambil dari msgId karena kunci sudah dipindah di langkah 1
                         const mk = await retrieveMessageKeySecurely(msgId);
                         if (mk) {
                             const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await import('@lib/crypto-worker-proxy');
                             const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
                             
                             const parsed = JSON.parse(String(res.msg!.content)) as { ciphertext?: string };
                             const ciphertext = parsed.ciphertext;
                             if (ciphertext) {
                                 const combined = sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
                                 const nonce = combined.slice(0, 24);
                                 const encrypted = combined.slice(24);
                                 const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                                 const plainText = sodium.to_string(decryptedBytes);
                                 get().updateMessage(conversationId, res.msg!.id, { content: plainText });
                             }
                         }
                     } catch (e) {
                         console.error("Async self-decrypt failed in callback:", e);
                     }
                 }).catch(captureAndLog);
            }            const updatedMsg: Partial<Message> = {
                ...res.msg,
                id: asMessageId(res.msg.id),
                conversationId: asConversationId(res.msg.conversationId),
                senderId: asUserId(res.msg.senderId),
                sender: res.msg.sender ? { ...res.msg.sender, id: asUserId(res.msg.sender.id) } : undefined,
                repliedToId: res.msg.repliedToId ? asMessageId(res.msg.repliedToId) : undefined,
                tempId: typeof res.msg.tempId === 'number' ? res.msg.tempId : undefined,
                content: finalContent,
                repliedTo: existingMsg?.repliedTo,
                isBlindAttachment: existingMsg?.isBlindAttachment,
                fileUrl: realFileUrl,
                fileKey: realFileKey,
                fileName: existingMsg?.fileName,
                fileType: existingMsg?.fileType,
                fileSize: existingMsg?.fileSize,
                duration: existingMsg?.duration,
                status: 'SENT' as const
            };
            
            // Ubah bubble optimistik menjadi bubble permanen
            get().replaceOptimisticMessage(conversationId, actualTempId, updatedMsg);

          } else if (!res.ok) {
              if (!isReactionPayload && !shouldBeSilent) {
                  get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
                  if (res.error?.includes('SANDBOX_LIMIT_REACHED')) {
                      toast.error(i18n.t('errors:sandbox_limit_reached_verify_your_accoun', 'Sandbox limit reached! Verify your account to unlock unlimited messaging.'));
                  } else if (res.error) {
                      toast.error(res.error);
                  }
              } else if (isReactionPayload) {
                  const reactionData = parseReaction(data.content);
                  if (reactionData) {
                      get().removeLocalReaction(conversationId, reactionData.targetMessageId, `temp_react_${actualTempId}`);
                  }
                  toast.error(i18n.t('errors:failed_to_send_reaction', 'Failed to send reaction'));
              }
          }
        });

    } catch (error) {
      clearSendWatchdog();
      console.error("Failed to encrypt/send:", error);
      if (!isReactionPayload) {
         get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
      } else {
          const reactionData = parseReaction(data.content);
          if (reactionData) {
              get().removeLocalReaction(conversationId, reactionData.targetMessageId, `temp_react_${actualTempId}`);
          }
      }
    }
  },

  processOfflineQueue: async () => {
    const queue = await getQueueItems();
    if (queue.length === 0) return;

    const socket = transportClient;
    if (!socket?.connected) return;

    // BATCH: tandai semua item queue sebagai SENDING dalam 1 set() + 1 vault write
    // (sebelumnya: updateMessage per item → N set + N persist).
    const sendingBatch: Message[] = [];
    for (const item of queue) {
      const existing = get().messages[item.conversationId]?.find(m => m.id === `temp_${item.tempId}`);
      if (existing) sendingBatch.push({ ...existing, status: 'SENDING', error: false });
    }
    if (sendingBatch.length > 0) {
      set(state => {
        const convUpdates = new Map<string, Message[]>();
        for (const m of sendingBatch) {
          const list = convUpdates.get(m.conversationId) || [...(state.messages[m.conversationId] || [])];
          const idx = list.findIndex(x => x.id === m.id);
          if (idx !== -1) { list[idx] = m; convUpdates.set(m.conversationId, list); }
        }
        return { messages: { ...state.messages, ...Object.fromEntries(convUpdates) } };
      });
      shadowVault.upsertMessages(sendingBatch).catch(captureAndLog);
    }

    for (const item of queue) {
      const { tempId, conversationId, data, attempt } = item;
      
      if (attempt > 5) {
        console.warn(`[Queue] Dropping message ${tempId} after too many retries.`);
        await removeFromQueue(tempId);
        get().updateMessage(conversationId, `temp_${tempId}`, { error: true, status: 'FAILED' });
        continue;
      }

      // PENGATURAN PAYLOAD DENGAN FALLBACK AMAN
      // queue item 'data' is basically the original payload mixed into a Message object
      const payloadData = data as Partial<Message> & { 
          sessionId?: string; 
          pushPayloads?: Record<string, string> 
      };

      // [OPAQUE MAILBOX FIX] Populate targetRecipients for ALL conversations
      // so offline-queued messages get forwarded to the right participants.
      let targetRecipients: string[] | undefined;
      const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
      if (conv?.participants && conv.participants.length > 0) {
          targetRecipients = conv.participants.map(p => p.userId || p.id);
      } else if (conv?.isGroup) {
          // Group with empty participants: fallback to cache (Opaque Mailbox)
          const { getCachedGroupParticipants } = await import('@lib/keychainDb');
          const cachedUserIds = await getCachedGroupParticipants(conversationId);
          if (cachedUserIds && cachedUserIds.length > 0) {
              targetRecipients = cachedUserIds;
          }
      }

      const sendPayload: MessageSendPayload = {
          conversationId: asConversationId(conversationId),
          content: payloadData.content || "",
          tempId: tempId,
          sessionId: payloadData.sessionId ?? undefined,
          expiresAt: payloadData.expiresAt ?? undefined,
          pushPayloads: payloadData.pushPayloads ?? undefined,
          repliedToId: payloadData.repliedToId ?? undefined,
          isViewOnce: payloadData.isViewOnce ?? false,
          targetRecipients
      };

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
          console.error(`[Queue] Timeout waiting for ACK for message ${tempId}`);
          updateQueueAttempt(tempId, attempt + 1).then(() => resolve());
        }, 5000);

        transportClient.sendEvent("message:send", sendPayload, async (err: unknown, res: { ok: boolean, msg?: RawServerMessage, error?: string }) => {
          clearTimeout(timeoutId);
          if (!err && res && res.ok && res.msg) {
            await removeFromQueue(tempId);

            // 1. Pindah Kunci Dekripsi
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${tempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${tempId}`);
                }
            }).catch(captureAndLog);

            // Tentukan status silent berdasarkan payload asli
            const silentPayload = parseSilent(payloadData.content);
            const isReactionPayload = !!parseReaction(payloadData.content);
            const isEditPayload = !!parseEdit(payloadData.content);
            
            const isCallInit = silentPayload?.type === 'CALL_INIT';
            const isGhostSync = silentPayload?.type === 'GHOST_SYNC';
            const isUnsend = silentPayload?.type === 'UNSEND';
            const isReactionRemove = silentPayload?.type === 'reaction_remove';
            const isSystemKeyRequest = silentPayload?.type === 'SYSTEM_KEY_REQUEST' || (typeof payloadData.content === 'string' && payloadData.content.includes('SYSTEM_KEY_REQUEST')) || (typeof payloadData.content === 'string' && payloadData.content.includes('GROUP_KEY_DISTRIBUTION'));

            const shouldBeSilent = payloadData.isSilent || isCallInit || isGhostSync || isUnsend || isReactionRemove || isEditPayload || isReactionPayload || isSystemKeyRequest;

            // 2. Tangani Reaksi (Tanpa Bubble)
            if (isReactionPayload) {
                const reactionData = parseReaction(payloadData.content);
                if (reactionData) {
                    const tempReactionId = `temp_react_${tempId}`;
                    get().replaceOptimisticReaction(conversationId, reactionData.targetMessageId, tempReactionId, {
                        id: res.msg.id, 
                        emoji: reactionData.emoji,
                        userId: useAuthStore.getState().user!.id,
                        isMessage: true
                    });
                }
                resolve();
                return;
            }

            // 3. Tangani Pesan Siluman (Keluarkan dari antrean layar)
            if (shouldBeSilent) {
                resolve();
                return;
            }

            // 4. Proses Pesan Normal
            const existingMsg = get().messages[conversationId]?.find(m => m.id === `temp_${tempId}` || m.tempId === tempId || m.id === res.msg!.id);
            
            let realFileUrl = existingMsg?.fileUrl;
            let realFileKey = existingMsg?.fileKey;
            try {
                if (payloadData.content && typeof payloadData.content === 'string' && payloadData.content.startsWith('{')) {
                    const meta = JSON.parse(payloadData.content) as { type?: string, url?: string, key?: string, name?: string, size?: number, mimeType?: string, text?: string, storyAuthorId?: string, isReply?: boolean, storyText?: string, hasMedia?: boolean };
                    if (meta.type === 'file' && meta.url) {
                        realFileUrl = meta.url;
                        realFileKey = meta.key;
                    }
                }
            } catch (e) {}

            let finalContent = existingMsg !== undefined ? existingMsg.content : res.msg!.content;
            
            if (finalContent && typeof finalContent === 'string' && finalContent.trim().startsWith('{') && finalContent.includes('"ciphertext"')) {
                 finalContent = "🔒 You sent this message (Encrypted)";
                 import('@utils/crypto').then(async ({ retrieveMessageKeySecurely }) => {
                     try {
                         const mk = await retrieveMessageKeySecurely(msgId);
                         if (mk) {
                             const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await import('@lib/crypto-worker-proxy');
                             const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
                             
                             const parsed = JSON.parse(String(res.msg!.content)) as { ciphertext?: string };
                             const ciphertext = parsed.ciphertext;
                             if (ciphertext) {
                                 const combined = sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
                                 const nonce = combined.slice(0, 24);
                                 const encrypted = combined.slice(24);
                                 const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                                 const plainText = sodium.to_string(decryptedBytes);
                                 get().updateMessage(conversationId, res.msg!.id, { content: plainText });
                             }
                         }
                     } catch (e) {
                         console.error("Async self-decrypt failed in offline queue callback:", e);
                     }
                 }).catch(captureAndLog);
            }            const updatedMsg: Partial<Message> = {
                ...res.msg,
                id: asMessageId(res.msg.id),
                conversationId: asConversationId(res.msg.conversationId),
                senderId: asUserId(res.msg.senderId),
                sender: res.msg.sender ? { ...res.msg.sender, id: asUserId(res.msg.sender.id) } : undefined,
                repliedToId: res.msg.repliedToId ? asMessageId(res.msg.repliedToId) : undefined,
                tempId: typeof res.msg.tempId === 'number' ? res.msg.tempId : undefined,
                content: finalContent,
                repliedTo: existingMsg?.repliedTo,
                isBlindAttachment: existingMsg?.isBlindAttachment,
                fileUrl: realFileUrl,
                fileKey: realFileKey,
                fileName: existingMsg?.fileName,
                fileType: existingMsg?.fileType,
                fileSize: existingMsg?.fileSize,
                duration: existingMsg?.duration,
                status: 'SENT' as const
            };
            
            get().replaceOptimisticMessage(conversationId, tempId, updatedMsg);

          } else {
            console.error(`[Queue] Failed to send queued message ${tempId}:`, res.error);
            await updateQueueAttempt(tempId, attempt + 1);
          }
          resolve(); 
        });
      });

      await new Promise(r => setTimeout(r, 100));
    }
  },

  uploadFile: async (conversationId, file) => {
    const { user, hasRestoredKeys } = useAuthStore.getState();
    if (!user) return;

    if (!hasRestoredKeys) {
      toast.error(i18n.t('errors:you_must_restore_your_keys_from_your_rec', 'You must restore your keys from your recovery phrase before you can send files.'));
      return;
    }
    
    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      toast.error(i18n.t('errors:conversation_not_found', 'Conversation not found.'));
      return;
    }

    const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore.getState();
    const activity: Omit<UploadActivity, 'id'> = { type: 'upload', fileName: file.name, progress: 0 };
    const uploadId = addActivity(activity);
    const tempId = Date.now();
    
    const optimisticMessage: Message = {
      id: asMessageId(`temp_${tempId}`),
      tempId: tempId,
      optimistic: true,
      sender: user,
      senderId: asUserId(user.id),
      createdAt: new Date().toISOString(),
      conversationId: asConversationId(conversationId),
      reactions: [],
      statuses: [{ userId: asUserId(user.id), status: 'READ', messageId: asMessageId(`temp_${tempId}`), id: `temp_status_${tempId}`, updatedAt: new Date().toISOString() }],
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileUrl: URL.createObjectURL(file) 
    };
    get().addOptimisticMessage(conversationId, optimisticMessage);
    useConversationStore.getState().updateConversationLastMessage(conversationId, optimisticMessage);
    
    try {
      updateActivity(uploadId, { progress: 5 });

      const { encryptedBlob, key: fileKey } = await encryptFile(file);
      
      updateActivity(uploadId, { progress: 20 });

      const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
          method: 'POST',
          body: JSON.stringify({
              fileName: file.name, 
              fileType: 'application/octet-stream', 
              folder: 'attachments',
              fileSize: encryptedBlob.size 
          })
      });

      updateActivity(uploadId, { progress: 30 });

      await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', presignedRes.uploadUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream'); 
          
          xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                  const percentComplete = (e.loaded / e.total) * 60; 
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

      const metadata = {
          type: 'file',
          url: presignedRes.publicUrl,
          key: fileKey, 
          name: file.name,
          size: file.size,
          mimeType: file.type
      };

      await get().sendMessage(conversationId, {
          content: JSON.stringify(metadata),
          fileName: file.name,
          fileType: file.type
      }, tempId);
      
      updateActivity(uploadId, { progress: 100 });
      setTimeout(() => removeActivity(uploadId), 1000);

    } catch (error) {
      removeActivity(uploadId);
      console.error("File upload failed:", error);
      toast.error(i18n.t('errors:failed_to_upload_file', `Failed to upload ${file.name}.`, { filename: file.name }));
      set(state => ({
        messages: {
          ...state.messages,
          [conversationId]: state.messages[conversationId]?.map(m => m.tempId === tempId ? { ...m, error: true } : m) || [],
        },
      }));
    }
  },

  loadMessagesForConversation: async (id) => {
    if (id.startsWith('burner_')) return;

    // ✅ FIX: Mencegah eksekusi ganda (misal karena React StrictMode / useEffect ganda) yang merusak state ratchet
    if (get().isFetchingMore[id]) return;
    
    // Set lock synchronously sebelum await apapun!
    set(state => ({ isFetchingMore: { ...state.isFetchingMore, [id]: true } }));



    // 1. TAMPILKAN DARI LOCAL VAULT (INDEXEDDB) DULU (Instan 0ms!)
    let localWasEmpty = true;
    try {
      const localMessagesRaw = await shadowVault.getMessagesByConversation(id, 50);
      if (localMessagesRaw.length > 0) {
          localWasEmpty = false;
          const localProcessed = processMessagesAndReactions(localMessagesRaw, []);
          const localEnriched = enrichMessagesWithSenderProfile(id, localProcessed);
          set(state => ({
              messages: { ...state.messages, [id]: localEnriched },
              hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true }
          }));
      }
    } catch (e) {
      console.error("[Local Vault] Failed to load messages from IndexedDB:", e);
    }

    // 2. SINKRONISASI BACKGROUND: Cek apakah ada surat tertunda di server.
    // [PAGINATION] Backfill bounded: user yang offline lama di grup aktif bisa
    // punya >250 pesan tertunda. Fetch berulang dengan cursor ?before sampai
    // hasMore=false ATAU batas MAX_BACKFILL_PAGES tercapai — sisanya di-fetch
    // lazy via loadPreviousMessages (server fallback) saat user scroll ke atas.
    try {
      const MAX_BACKFILL_PAGES = 4;   // 4 × 250 = 1000 pesan per sync cycle
      const MERGE_WINDOW = 150;       // selaras MAX_MESSAGES_IN_RAM

      let allFetched: Message[] = [];
      let serverHasMore = false;
      let cursor: string | null = null;

      for (let pageIndex = 0; pageIndex < MAX_BACKFILL_PAGES; pageIndex++) {
        const cursorParam: string = cursor ? `&before=${encodeURIComponent(cursor)}` : '';
        const res = await api<{ items: Message[]; hasMore?: boolean; nextCursor?: string | null }>(
          `/api/messages/${id}?limit=250${cursorParam}`
        );
        const pageItems = res.items || [];
        allFetched = allFetched.concat(pageItems);
        serverHasMore = res.hasMore === true;
        cursor = res.nextCursor || null;
        if (!serverHasMore || !cursor || pageItems.length === 0) break;
      }
      // Backfill berhenti karena batas halaman (bukan karena habis) → tandai
      // agar scroll-to-top bisa melanjutkan dari server.
      if (serverHasMore && cursor) {
        set(state => ({ serverHasMore: { ...state.serverHasMore, [id]: true } }));
      }

      // Dedupe antar halaman (system messages di-include di setiap halaman).
      const fetchedMessages = allFetched.length > 1
        ? Array.from(new Map(allFetched.map(m => [m.id, m])).values())
        : allFetched;

      if (fetchedMessages.length > 0) {
        const processedMessages: Message[] = [];

        // ✅ FIX: URUTKAN KRONOLOGIS SEBELUM DEKRIPSI (Gunakan ID sebagai tie-breaker untuk stabilitas)
        fetchedMessages.sort((a, b) => {
            const timeA = new Date(a.createdAt).getTime();
            const timeB = new Date(b.createdAt).getTime();
            if (timeA !== timeB) return timeA - timeB;
            
            // Jika di detik yang sama, proses Control Message DULUAN agar kunci terdistribusi sebelum mendekripsi normal message
            const aIsMeta = a.type === 'SYSTEM' && (typeof a.content === 'string' && a.content.includes('"type":"METADATA_UPDATED"'));
            const bIsMeta = b.type === 'SYSTEM' && (typeof b.content === 'string' && b.content.includes('"type":"METADATA_UPDATED"'));
            if (aIsMeta && !bIsMeta) return -1;
            if (!aIsMeta && bIsMeta) return 1;
            const aIsControl = a.type === 'SYSTEM' && (typeof a.content === 'string' && (a.content.includes('GROUP_KEY_DISTRIBUTION') || a.content.includes('"type":"GROUP_KEY"')));
            const bIsControl = b.type === 'SYSTEM' && (typeof b.content === 'string' && (b.content.includes('GROUP_KEY_DISTRIBUTION') || b.content.includes('"type":"GROUP_KEY"')));
            if (aIsControl && !bIsControl) return -1;
            if (!aIsControl && bIsControl) return 1;

            if (a.tempId && b.tempId) {
                const tempA = Number(a.tempId);
                const tempB = Number(b.tempId);
                if (!isNaN(tempA) && !isNaN(tempB) && tempA !== tempB) {
                    return tempA - tempB;
                }
            }

            return a.id.localeCompare(b.id);
        });

        // 1. PROSES SEMUA PESAN DALAM SATU LOOP UNTUK MENJAGA URUTAN KRONOLOGIS STATE KRIPTOGRAFI
        for (const message of fetchedMessages) {
          try {
            // Tangani Pesan Kontrol Langsung
            if (message.type === 'SYSTEM' && message.content && (message.content.includes('GROUP_KEY_DISTRIBUTION') || message.content.includes('"type":"GROUP_KEY"'))) {
                 try {
                    const payload = JSON.parse(message.content || '{}') as SystemMessagePayload;
                    if (payload.type === 'GROUP_KEY_DISTRIBUTION' || payload.type === 'GROUP_KEY') {
                      console.debug('[Offline Sync] Memproses Kunci Distribusi untuk conversation:', message.conversationId || payload.conversationId);

                      const { getMyEncryptionKeyPair, getSodiumLib } = await import('@utils/crypto');
                      const sodium = await getSodiumLib();
                      const { publicKey } = await getMyEncryptionKeyPair();
                      const myIdentityKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

                      const myId = useAuthStore.getState().user?.id;
                      const myDistributions = payload.distributions?.filter((d: { targetUserId?: string; userId: string; encryptedKey?: string; key?: string; senderDeviceKey?: string; targetDeviceKey?: string; }) => 
                          (d.targetUserId === myId || d.userId === myId) &&
                          (!d.targetDeviceKey || d.targetDeviceKey === myIdentityKeyB64)
                      ) || [];
                      let success = false;

                      if (myDistributions.length > 0) {
                          for (const dist of myDistributions) {
                              const extractedKey = dist.encryptedKey || dist.key;
                              if (!extractedKey) continue;
                              try {
                                  const { storeReceivedSessionKey } = await import('@utils/crypto');
                                  const senderIdToUse = message.senderId || payload.senderId || "";
                                  await storeReceivedSessionKey({
                                      ...payload,
                                      type: 'GROUP_KEY',
                                      conversationId: message.conversationId || payload.conversationId || "",
                                      senderId: senderIdToUse,
                                      encryptedKey: extractedKey,
                                      senderDeviceKey: dist.senderDeviceKey || payload.senderDeviceKey
                                  });
                                  success = true;
                                  break; // Kunci valid untuk device ini
                              } catch (e) {
                                  // Abaikan jika device salah
                              }
                          }
                    } else if (payload.encryptedKey || payload.key) {
                        try {
                            const finalConvId = message.conversationId || payload.conversationId || "";
                            const finalSenderId = message.senderId || payload.senderId || "";
                            const finalEncKey = (payload.encryptedKey || payload.key || "");
                            const { storeReceivedSessionKey } = await import('@utils/crypto');
                            await storeReceivedSessionKey({
                                ...payload,
                                type: 'GROUP_KEY',
                                conversationId: finalConvId,
                                senderId: finalSenderId,
                                encryptedKey: finalEncKey,
                            });
                            success = true;
                        } catch(e) {
                            console.warn(`[Offline Sync] Gagal decrypt key for conv ${message.conversationId || payload.conversationId}: senderId=${payload.senderId}, senderDeviceKey=${payload.senderDeviceKey}, hasDrHeader=${!!payload.drHeader}`, e);
                        }
                    }

                      if (success) {
                          useKeychainStore.getState().keysUpdated();
                          // Beri jeda sebentar untuk memastikan IndexedDB menyelesaikan flush sinkronisasinya
                          await new Promise(r => setTimeout(r, 50));
                      } else {
                          console.warn(`[Offline Sync] Kunci tidak dapat di-unseal. Mungkin dienkripsi untuk device lain.`);
                      }
                    }
                  } catch (e) {
                     console.error("Failed to process control message", e);
                  }
                  continue; // Selesai memproses pesan kontrol, lanjut ke pesan berikutnya
             }

              // Opaque Mailbox: process persisted metadata updates from offline sync
              if (message.type === 'SYSTEM' && message.content && message.content.includes('"type":"METADATA_UPDATED"')) {
                  try {
                      const payload = JSON.parse(message.content);
                      if (payload.encryptedMetadata) {
                          console.debug(`[Offline Sync] Memproses Metadata Update untuk conversation: ${message.conversationId}`);
                          const { useConversationStore } = await import('@store/conversation');
                          await useConversationStore.getState().updateConversation(message.conversationId, {
                              encryptedMetadata: payload.encryptedMetadata
                          });
                      }
                  } catch (e) {
                      console.error("Failed to process metadata update", e);
                  }
                  continue;
              }

             // --- DEKRIPSI NORMAL MESSAGES (termasuk PROTOCOL_UPGRADE_REQ yg masih terenkripsi) ---
            
            // Cek Local Cache Lebih Dulu
            const localMessage = await shadowVault.getMessage(message.id);
            
            // Gunakan Plaintext Lokal jika sudah terdekripsi dengan baik
            const isLocalValid = localMessage && localMessage.content && !['waiting_for_key', '[Decryption Failed: Key out of sync]', '🔒 Decryption Error', '<Decryption Failed>'].includes(localMessage.content || '');
            
            if (isLocalValid) {
              processedMessages.push({ ...message, ...localMessage });
              continue;
            }

            // Dekripsi Hanya Pesan Baru
            const decrypted = await decryptMessageObject(message, undefined, 0, { skipRetries: true });
            if (!decrypted) continue;

            // Evaluasi in-line control message setelah didekripsi
            if (await evaluateControlMessage(decrypted, id)) {
                continue; // Jangan masukkan ke UI
            }

            processedMessages.push(decrypted);
          } catch (err) {
            console.error(`[Decrypt] Error decrypting message ${message.id}:`, err);
            // Error Boundary pada Dekripsi
            processedMessages.push({
              ...message,
              content: '<Decryption Failed>',
              error: true
            } as Message);
          }
        }

        // 2. PROSES & GABUNGKAN DATA DI LUAR LOOP
        const existingMessages = get().messages[id] || [];
        const combined = [...existingMessages, ...processedMessages];
        const uniqueMessagesMap = new Map<string, Message>();
        for (const m of combined) {
            const existing = uniqueMessagesMap.get(m.id);
            if (existing) {
                const existingIsValid = (existing.content || existing.fileMeta || existing.fileUrl) && !['waiting_for_key', '[Decryption Failed: Key out of sync]', '🔒 Decryption Error'].includes(existing.content || '');
                const mIsFailure = (!m.content && !m.fileMeta && !m.fileUrl) || ['waiting_for_key', '[Decryption Failed: Key out of sync]', '🔒 Decryption Error'].includes(m.content || '');
                if (existingIsValid && mIsFailure) {
                    uniqueMessagesMap.set(m.id, { ...existing, repliedTo: existing.repliedTo || m.repliedTo });
                } else if (!existingIsValid && !mIsFailure) {
                    uniqueMessagesMap.set(m.id, { ...m, repliedTo: m.repliedTo || existing.repliedTo });
                } else {
                    uniqueMessagesMap.set(m.id, { ...existing, ...m, repliedTo: m.repliedTo || existing.repliedTo });
                }
            } else {
                uniqueMessagesMap.set(m.id, m);
            }
        }
        const uniqueMessages = Array.from(uniqueMessagesMap.values());

        const allMessages = processMessagesAndReactions(uniqueMessages, []);

        // Opaque Mailbox: reconstruct 1-1 participants from first valid message's senderId
        reconstructDirectParticipants(id, allMessages);

        const enrichedMessages = enrichMessagesWithSenderProfile(id, allMessages);

        // ✅ 3. AWAIT PENYIMPANAN LOKAL DULU (PENTING!)
        await shadowVault.upsertMessages(enrichedMessages);

        const hasFailedDecryption = processedMessages.some(m =>      m.type !== 'SYSTEM' && String(m.type) !== 'SYSTEM_KEY_REQUEST' && 
            (m.error || m.content === 'waiting_for_key' || m.content?.startsWith('['))
        );
        if (hasFailedDecryption) {
            const now = Date.now();
            const repairKey = `last_repair_history_${id}` as const;
            const lastRepair = window[repairKey as keyof Window] as number | undefined || 0;
            if (now - lastRepair > 15000) {
                window[repairKey as keyof Window] = now as never;
                console.warn(`[Offline Sync] Meminta pengiriman ulang kunci yang hilang secara diam-diam untuk ${id}...`);
                import('@lib/transportClient').then(m => m.emitGroupKeyRequest(id));
            }
        }

        // ✅ 4. BARU TEMBAK KILL SWITCH SETELAH DATA AMAN
        // [FIX OFFLINE-LOSS] Receipt READ hanya untuk pesan yang BERHASIL didekripsi.
        // Server menghapus ciphertext 1:1 saat READ; receipt prematur untuk pesan
        // 'waiting_for_key'/gagal dekrip menghancurkan satu-satunya salinan yang bisa
        // dipulihkan saat kunci datang belakangan. Gunakan senderId HASIL DEKRIPSI
        // (raw senderId dari server adalah '' untuk 1:1 sealed-sender), bukan raw.
        const isUndecryptable = (m: Message): boolean =>
            !!m.error ||
            !m.content ||
            m.content === 'waiting_for_key' ||
            m.content === '[Requesting key to decrypt...]' ||
            (typeof m.content === 'string' && m.content.startsWith('['));
        const socket = transportClient;
        const { user } = useAuthStore.getState();
        if (socket?.connected && user) {
          // [BATCH] Satu event plural (chunk 100 = BATCH_RECEIPT_MAX server)
          // alih-alih N event per-pesan. targets (Opaque Mailbox) dipetakan per
          // messageId karena DB 1:1 sealed-sender menyimpan senderId null.
          const receiptable = processedMessages.filter(
            (m) => !isUndecryptable(m) && m.senderId && m.senderId !== user.id
          );
          const CHUNK = 100;
          for (let i = 0; i < receiptable.length; i += CHUNK) {
            const chunk = receiptable.slice(i, i + CHUNK);
            transportClient.sendEvent('messages:mark_as_read', {
              conversationId: id,
              messageIds: chunk.map((m) => m.id),
              targets: Object.fromEntries(chunk.map((m) => [m.id, m.senderId as string])),
            });
          }
        }

        // 5. UPDATE UI
      const visibleMessages = enrichedMessages.filter(
        m => m.type !== 'SYSTEM' && String(m.type) !== 'SYSTEM_KEY_REQUEST'
      );
        // [PAGINATION] Backfill bisa jauh melebihi window RAM (4×250). Simpan
        // SEMUA ke vault lokal, tampilkan hanya window terbaru di RAM — pesan
        // lebih lama tetap bisa di-scroll dari IndexedDB oleh loadPreviousMessages.
        if (enrichedMessages.length > MERGE_WINDOW) {
          await shadowVault.upsertMessages(enrichedMessages.slice(0, enrichedMessages.length - MERGE_WINDOW));
        }
        const ramWindow = enrichedMessages.length > MERGE_WINDOW
          ? enrichedMessages.slice(enrichedMessages.length - MERGE_WINDOW)
          : enrichedMessages;
        const visibleRamMessages = ramWindow.filter(
          m => m.type !== 'SYSTEM' && String(m.type) !== 'SYSTEM_KEY_REQUEST'
        );
        set(state => {
          return {
            messages: { ...state.messages, [id]: visibleRamMessages },
            hasMore: { ...state.hasMore, [id]: ramWindow.length >= 50 },
            // Cursor server habis → scroll-to-top cukup baca vault lokal.
            serverHasMore: { ...state.serverHasMore, [id]: state.serverHasMore[id] === true },
            hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true }
          };
        });
      } else {
         // Jika server kosong, jangan sentuh state.messages agar UI tidak hilang
         // (Cukup tandai hasLoadedHistory)
         set(state => ({ hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true } }));
      }
    } catch (error) {
      console.error(`Failed to sync pending messages for ${id}`, error);
      // ✅ FIX: Jika server sync gagal dan local vault kosong, tandai sebagai loaded
      // agar UI tidak stuck loading selamanya
      if (localWasEmpty) {
        set(state => ({ hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true } }));
      }
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [id]: false } }));
    }
  },

  loadPreviousMessages: async (conversationId) => {
    if (conversationId.startsWith('burner_')) return;

    const { isFetchingMore, hasMore, messages } = get();
    if (isFetchingMore[conversationId] || !hasMore[conversationId]) return;
    
    const currentMessages = messages[conversationId] || [];
    const oldestMessage = currentMessages[0];
    if (!oldestMessage) return;
    
    set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: true } }));
    
    try {
      // PAGINATION LOKAL: ambil dari Shadow Vault (IndexedDB) dulu — pesan lama
      // yang sudah pernah didekripsi tersimpan di sana.
      const localMessages = await shadowVault.getMessagesByConversation(conversationId, 50, oldestMessage.createdAt);

      // [PAGINATION] VAULT HABIS + SERVER MASIH PUNYA STOK → fallback fetch
      // server dengan cursor ?before. Kasus ini terjadi saat backfill reconnect
      // berhenti di MAX_BACKFILL_PAGES (riwayat > 1000 pesan) atau user ganti
      // device — pesan lebih lama ada di server tapi belum pernah tersimpan
      // lokal. Tanpa fallback ini, scroll-to-top macet selamanya.
      if (localMessages.length === 0 && get().serverHasMore[conversationId]) {
        const before = oldestMessage.createdAt;
        const res = await api<{ items: Message[]; hasMore?: boolean; nextCursor?: string | null }>(
          `/api/messages/${conversationId}?limit=50&before=${encodeURIComponent(before)}`
        );
        const fetched = res.items || [];
        // serverHasMore untuk conversation ini ikuti halaman terakhir.
        set(state => ({ serverHasMore: { ...state.serverHasMore, [conversationId]: res.hasMore === true } }));

        if (fetched.length > 0) {
          // Oldest→newest sebelum dekripsi (alasan urutan: control message/key
          // distribution harus terproses sebelum pesan yang bergantung padanya).
          fetched.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          const processed: Message[] = [];
          for (const message of fetched) {
            // Pesan kontrol diserap (kunci/metadata), tidak masuk UI.
            if (message.type === 'SYSTEM' && message.content && (message.content.includes('GROUP_KEY_DISTRIBUTION') || message.content.includes('"type":"GROUP_KEY"') || message.content.includes('"type":"METADATA_UPDATED"'))) {
              try {
                const payload = JSON.parse(message.content || '{}') as SystemMessagePayload;
                if (payload.type === 'GROUP_KEY_DISTRIBUTION' || payload.type === 'GROUP_KEY') {
                  const { getMyEncryptionKeyPair, getSodiumLib, storeReceivedSessionKey } = await import('@utils/crypto');
                  const sodium = await getSodiumLib();
                  const { publicKey } = await getMyEncryptionKeyPair();
                  const myIdentityKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                  const myId = useAuthStore.getState().user?.id;
                  const myDistributions = payload.distributions?.filter((d: { targetUserId?: string; userId: string; encryptedKey?: string; key?: string; senderDeviceKey?: string; targetDeviceKey?: string; }) =>
                      (d.targetUserId === myId || d.userId === myId) &&
                      (!d.targetDeviceKey || d.targetDeviceKey === myIdentityKeyB64)
                  ) || [];
                  for (const dist of myDistributions) {
                    const extractedKey = dist.encryptedKey || dist.key;
                    if (!extractedKey) continue;
                    try {
                      await storeReceivedSessionKey({
                          ...payload,
                          type: 'GROUP_KEY',
                          conversationId: message.conversationId || payload.conversationId || "",
                          senderId: message.senderId || payload.senderId || "",
                          encryptedKey: extractedKey,
                          senderDeviceKey: dist.senderDeviceKey || payload.senderDeviceKey
                      });
                      useKeychainStore.getState().keysUpdated();
                      break;
                    } catch { /* device lain, coba dist berikutnya */ }
                  }
                } else if (payload.encryptedKey || payload.key) {
                  try {
                    const { storeReceivedSessionKey } = await import('@utils/crypto');
                    await storeReceivedSessionKey({
                        ...payload,
                        type: 'GROUP_KEY',
                        conversationId: message.conversationId || payload.conversationId || "",
                        senderId: message.senderId || payload.senderId || "",
                        encryptedKey: (payload.encryptedKey || payload.key || ""),
                    });
                    useKeychainStore.getState().keysUpdated();
                  } catch (e) {
                    console.warn('[Scroll Pagination] Gagal decrypt key:', e);
                  }
                } else if (payload.encryptedMetadata) {
                  const { useConversationStore } = await import('@store/conversation');
                  await useConversationStore.getState().updateConversation(String(message.conversationId || conversationId), {
                      encryptedMetadata: String(payload.encryptedMetadata)
                  });
                }
              } catch (e) {
                console.error('[Scroll Pagination] Gagal memproses pesan kontrol:', e);
              }
              continue;
            }

            // Cek vault lokal dulu (pesan mungkin sudah pernah didekripsi).
            const localMessage = await shadowVault.getMessage(message.id);
            const isLocalValid = localMessage && localMessage.content && !['waiting_for_key', '[Decryption Failed: Key out of sync]', '🔒 Decryption Error', '<Decryption Failed>'].includes(localMessage.content || '');
            if (isLocalValid) {
              processed.push({ ...message, ...localMessage });
              continue;
            }

            const decrypted = await decryptMessageObject(message, undefined, 0, { skipRetries: true });
            if (!decrypted) continue;
            if (await evaluateControlMessage(decrypted, conversationId)) continue;
            processed.push(decrypted);
          }

          if (processed.length > 0) {
            await shadowVault.upsertMessages(processed);
            set(state => {
              const existingMessages = state.messages[conversationId] || [];
              const combined = [...processed, ...existingMessages];
              const uniqueMessages = Array.from(new Map(combined.map(m => [m.id, m])).values());
              const allMessages = processMessagesAndReactions(uniqueMessages, []);
              const enrichedMessages = enrichMessagesWithSenderProfile(conversationId, allMessages);
              const MAX_MESSAGES_IN_RAM = 150;
              const prunedMessages = enrichedMessages.length > MAX_MESSAGES_IN_RAM
                ? enrichedMessages.slice(enrichedMessages.length - MAX_MESSAGES_IN_RAM)
                : enrichedMessages;
              return {
                messages: { ...state.messages, [conversationId]: prunedMessages },
                hasMore: { ...state.hasMore, [conversationId]: true }, // server masih punya / baru sebagian terload
              };
            });
          }
        }
        return; // Selesai (baik fetch sukses maupun kosong) — jangan lanjut ke path lokal di bawah.
      }

      // Opaque Mailbox: reconstruct 1-1 participants from first valid message's senderId
      reconstructDirectParticipants(conversationId, localMessages);

      set(state => {
        const existingMessages = state.messages[conversationId] || [];
        
        // Gabungkan dan filter
        const combined = [...localMessages, ...existingMessages];
        const uniqueMessages = Array.from(new Map(combined.map(m => [m.id, m])).values());

        const allMessages = processMessagesAndReactions(uniqueMessages, []);
        const enrichedMessages = enrichMessagesWithSenderProfile(conversationId, allMessages);

        const MAX_MESSAGES_IN_RAM = 150;
        let prunedMessages = enrichedMessages;
        
        if (enrichedMessages.length > MAX_MESSAGES_IN_RAM) {
           prunedMessages = enrichedMessages.slice(enrichedMessages.length - MAX_MESSAGES_IN_RAM);
        }

        return { 
            messages: { ...state.messages, [conversationId]: prunedMessages },
            // Jika IndexedDB mengembalikan kurang dari 50, berarti sudah sampai ujung (habis).
            // [PAGINATION] Kecuali server masih punya stok → biarkan hasMore true agar
            // scroll berikutnya mencoba fallback server lagi.
            hasMore: { ...state.hasMore, [conversationId]: localMessages.length === 50 || !!state.serverHasMore[conversationId] } 
        };
      });
    } catch (error) {
      console.error("Failed to load previous messages from Local Vault", error);
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: false } }));
    }
  },

  loadMessageContext: async (messageId: string) => {
    try {
      // 1. Cari pesan target langsung di dalam IndexedDB (Local Vault)
      const targetMessage = await shadowVault.getMessage(messageId);
      
      if (!targetMessage || !targetMessage.conversationId) {
        console.warn(`[Local Vault] Pesan ${messageId} tidak ditemukan di database lokal.`);
        return;
      }

      const convoId = targetMessage.conversationId;

      // 2. Ambil pesan di sekitarnya dari IndexedDB.
      // (Bisa memuat ulang 50-100 pesan terakhir atau membuat fungsi khusus di shadowVault
      // untuk mengambil pesan berdasarkan rentang waktu targetMessage.createdAt)
      // Untuk amannya, kita muat porsi yang mencukupi dari memori lokal:
      const localMessages = await shadowVault.getMessagesByConversation(convoId, 100);

      // Opaque Mailbox: reconstruct 1-1 participants from first valid message's senderId
      reconstructDirectParticipants(convoId, localMessages);

      // 3. Proses dan tampilkan ke UI secara instan
      set(state => {
        const existingMessages = state.messages[convoId] || [];
        
        // Gabungkan pesan yang sedang tampil dengan pesan konteks yang baru ditarik dari IndexedDB
        const combined = [...existingMessages, ...localMessages];
        
        // Hilangkan duplikasi
        const uniqueMessages = Array.from(new Map(combined.map(m => [m.id, m])).values());
        
        const finalMessages = processMessagesAndReactions(uniqueMessages, []);
        const enrichedMessages = enrichMessagesWithSenderProfile(convoId, finalMessages);

        return {
          messages: { ...state.messages, [convoId]: enrichedMessages },
          hasMore: { ...state.hasMore, [convoId]: true } 
        };
      });

    } catch (error) {
      console.error(`Failed to load context for message ${messageId} from Local Vault`, error);
    }
  },

  addOptimisticMessage: (conversationId, message) => {
    shadowVault.upsertMessages([message]); 
    set(state => {
      const currentMessages = state.messages[conversationId] || [];
      if (currentMessages.some(m => m.id === message.id || (m.tempId && message.tempId && m.tempId === message.tempId))) {
        return state;
      }
      return { messages: { ...state.messages, [conversationId]: [...currentMessages, message] } };
    })
  },
  
  addIncomingMessage: async (conversationId, message) => {
      while (get().isFetchingMore[conversationId]) {
          await new Promise(resolve => setTimeout(resolve, 100));
      }

      const previousLock = incomingMessageLocks.get(conversationId) || Promise.resolve();
      let release: () => void;
      const currentLock = new Promise<void>(resolve => { release = resolve; });
      incomingMessageLocks.set(conversationId, currentLock);

      try {
          await previousLock;
          return await get().doAddIncomingMessage(conversationId, message);
      } finally {
          release!();
          if (incomingMessageLocks.get(conversationId) === currentLock) {
              incomingMessageLocks.delete(conversationId);
          }
      }
  },

  doAddIncomingMessage: async (conversationId, message) => {
      const currentUser = useAuthStore.getState().user;

      // 0. DEDUP: pesan dengan id yang sama mungkin datang dua kali (race antara
      // live event `message:new` dan REST sync saat reconnect). Skip kalau sudah ada di state.
      if (!message.tempId) {
          const existing = get().messages[conversationId]?.find(m => m.id === message.id);
          if (existing) return existing;
      }

      // 1. PENCEGAHAN GHOST MESSAGE (Bypass UI/Storage untuk Pesan Kontrol)
      if (typeof message.content === 'string' && (message.content.includes('SYSTEM_KEY_REQUEST') || message.content.includes('GROUP_KEY_DISTRIBUTION'))) {
          // Hanya tangkap payload kontrol, jangan simpan / kembalikan objek pesannya ke UI
          try {
              const decryptedControl = await decryptMessageObject(message);
              // Tetap proses secara internal, misal evaluateControlMessage
              if (decryptedControl) {
                  await evaluateControlMessage(decryptedControl, conversationId);
              }
          } catch (e) {
              console.warn(`[Control Message] Failed to process ${message.type} silently.`, e);
          }
          return null; 
      }

      // 1. ALWAYS decrypt to ensure cryptographic integrity
      let decrypted = await decryptMessageObject(message);
      if (!decrypted) return null;
      const decryptedMsg = decrypted;

      // Opaque Mailbox: reconstruct conversation participants if empty,
      // so the peer's name is resolvable and outbound messages have valid targetRecipients
      reconstructDirectParticipants(conversationId, [decryptedMsg]);

      // Opaque Mailbox: reconstruct group participants from encrypted metadata if empty
      if (currentUser) {
          const groupConv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
          if (groupConv?.isGroup && groupConv.participants.length === 0) {
              useConversationStore.getState().addOrUpdateConversation(groupConv);
          }
      }

      if (currentUser && decrypted.senderId === currentUser.id && message.tempId) {
          const optimistic = get().messages[conversationId]?.find(m => m.tempId && String(m.tempId) === String(message.tempId));
          if (optimistic) {
              // 2. Do NOT copy optimistic.content. Only merge UI statuses.
              decrypted = {
                  ...decrypted,
                  id: message.id,
                  tempId: message.tempId,
                  createdAt: message.createdAt,
                  statuses: (message.statuses && message.statuses.length > 0) ? message.statuses : (optimistic.statuses || [])
              };
          }
      }

      if (decrypted.content === 'waiting_for_key' || decrypted.error) {
          const existing = await shadowVault.getMessage(decrypted.id);
          if (existing && !existing.isDeletedLocal && existing.content && !existing.content.startsWith('[') && existing.content !== 'waiting_for_key') {
              console.warn(`[Shield] Prevented overwriting valid local message ${decrypted.id} with failure.`);
              return existing;
          }

          console.debug(`[Ratchet] Decryption failed for ${message.id}. Retrying once in 500ms...`);
          await new Promise(r => setTimeout(r, 500));
          const retriedDecrypted = await decryptMessageObject(message);
          if (!retriedDecrypted) return null;
          decrypted = retriedDecrypted;
      }

      if (decrypted.repliedToId && !decrypted.repliedTo) {
          try {
              const repliedMessage = await shadowVault.getMessage(decrypted.repliedToId);
              if (repliedMessage) {
                  decrypted.repliedTo = repliedMessage;
              }
          } catch (e) {
              console.error('[Vault] Failed to fetch replied message locally', e);
          }
      }

      if (await evaluateControlMessage(decrypted, conversationId)) {
          return null;
      }

      // --- HYBRID OPPORTUNISTIC PCS TRIGGER ---
      // Jika menerima pesan asli (bukan silent/system) dari orang lain di chat 1-on-1, 
      // tandai bahwa kunci kita saat ini sudah "opportunistically expired".
      const conversation = (await import('@store/conversation')).useConversationStore.getState().conversations.find(c => c.id === conversationId);
      const isGroup = conversation?.isGroup ?? false;

      if (!isGroup && currentUser && decrypted.senderId !== currentUser.id && !decrypted.isSilent && decrypted.type !== 'SYSTEM') {
          try {
              const { getGroupSenderState, saveGroupSenderState } = await import('@lib/keychainDb');
              const senderState = await getGroupSenderState(conversationId);
              if (senderState) {
                  await saveGroupSenderState({
                      ...senderState,
                      requiresImmediateRotation: true
                  });
              }
          } catch (e) {
              console.warn('[PCS] Failed to mark opportunistic rotation:', e);
          }
      }

      if (
          decrypted.type !== 'SYSTEM' && 
          String(decrypted.type) !== 'SYSTEM_KEY_REQUEST' && 
          (decrypted.error || decrypted.content === 'waiting_for_key' || decrypted.content?.startsWith('['))
      ) {
          const existing = await shadowVault.getMessage(decrypted.id);
          if (existing && !existing.isDeletedLocal && existing.content && !existing.content.startsWith('[')) {
              console.warn(`[Shield] Prevented overwriting valid local message ${decrypted.id} with failure.`);
              return existing;
          }
          
          set(state => ({
              pendingDecryptions: [...state.pendingDecryptions, decrypted]
          }));
          
          // ✅ FIX: Auto-Heal Terpadu untuk semua jenis Chat (Per-Device)
          // Tidak perlu lagi mengecek isGroup, langsung minta GroupKeyRequest (Sender Key)
          const now = Date.now();
          const repairKey = `last_repair_${conversationId}` as const;
          const failCountKey = `fail_count_${conversationId}`;
          const lastRepair = (window[repairKey as keyof Window] as number) || 0;
          const currentFailCount = parseInt(sessionStorage.getItem(failCountKey) || '0', 10);

          const isTooOld = decrypted.content === '[Message too old to decrypt]';

          if (!isTooOld && now - lastRepair > 15000) { // Limit permintaan perbaikan agar tidak spam (15 detik)
              window[repairKey as keyof Window] = now as never;
              const newFailCount = currentFailCount + 1;
              sessionStorage.setItem(failCountKey, newFailCount.toString());

              if (newFailCount > 3) {
                  console.error(`[Auto-Heal] Kritis! Dekripsi gagal >3x untuk percakapan ${conversationId}. Memicu PROTOCOL_RESET penuh...`);
                  sessionStorage.setItem(failCountKey, '0');

                  // Force a hard rotation of keys and trigger an upgrade/reset
                  get().sendMessage(conversationId, {
                      content: JSON.stringify({ type: "PROTOCOL_RESET" }),
                      isSilent: true
                  });
              } else {
                  console.warn(`[Auto-Heal] Kunci tidak sinkron untuk percakapan ${conversationId} (Gagal ${newFailCount}x). Meminta kunci ulang secara diam-diam...`);
                  // Minta pengirim mem-broadcast ulang kunci distribusinya
                  const { emitGroupKeyRequest } = await import('@lib/transportClient');
                  emitGroupKeyRequest(conversationId);
              }
          }
          } else {
          // Reset fail count on successful decryption
          sessionStorage.setItem(`fail_count_${conversationId}`, '0');
          }

          const reactionPayload = parseReaction(decrypted.content);
      const editPayload = parseEdit(decrypted.content);
      const silentPayload = parseSilent(decrypted.content);

      const cleanUpOptimisticBubble = () => {
          if (message.tempId && currentUser && message.senderId === currentUser.id) {
              const tempIdStr = `temp_${message.tempId}`;
              const tempIdDashStr = `temp-${message.tempId}`;
              
              // Hapus bubble instruksi dari layar seketika
              set(state => ({
                  messages: {
                      ...state.messages,
                      [conversationId]: (state.messages[conversationId] || []).filter(m => 
                          m.id !== tempIdStr && m.id !== tempIdDashStr
                      )
                  }
              }));
              
              // Hapus nisan sementaranya dari IndexedDB
              import('@lib/shadowVaultDb').then(({ shadowVault }) => {
                  shadowVault.deleteMessage(tempIdStr).catch(() => {});
                  shadowVault.deleteMessage(tempIdDashStr).catch(() => {});
              });
          }
      };

      if (silentPayload) {
          decrypted.isSilent = true;

          if (silentPayload.type === 'STORY_KEY' && silentPayload.key && silentPayload.storyId) {
             cleanUpOptimisticBubble(); // ✅ Bersihkan
             saveStoryKey(silentPayload.storyId, silentPayload.key).catch(e => console.error("Failed to save story key live", e));
             return null; 
          }

          if (silentPayload.type === 'CALL_INIT' && silentPayload.key) {
             cleanUpOptimisticBubble(); // ✅ Bersihkan
             import('@store/callStore').then(m => {
                m.useCallStore.getState().setCallKey(silentPayload.key!);
             });
             return decrypted; 
          }
          
          if (silentPayload.type === 'GHOST_SYNC') {
              cleanUpOptimisticBubble(); // ✅ Bersihkan
              console.debug(`[Ghost Sync] Received sync from ${decrypted.senderId}. Settle ratchet state silently.`);
              return decrypted; 
          }

          if (silentPayload.type === 'UNSEND' && silentPayload.targetMessageId) {
              cleanUpOptimisticBubble(); // ✅ Bersihkan Bubble Hantu Hapus Pesan
              const targetId = asMessageId(silentPayload.targetMessageId);
              // Pastikan hanya pengirim yang bisa menghapus pesannya sendiri
              const currentMessages = get().messages[conversationId] || [];
              const target = currentMessages.find(m => m.id === targetId);
              
              if (target && target.senderId === decrypted.senderId) {
                  get().removeMessage(conversationId, targetId);
              } else if (!target) {
                  // Jika pesan belum di-load di memori, inject nisannya langsung ke DB
                  import('@lib/shadowVaultDb').then(m => m.shadowVault.upsertMessages([{ 
                      id: targetId, 
                      conversationId: asConversationId(conversationId), 
                      isDeletedLocal: true, 
                      content: null, 
                      createdAt: decrypted.createdAt, 
                      senderId: asUserId(decrypted.senderId) 
                  } as Message]));
              }
              return null;
          }

          if (silentPayload.type === 'reaction_remove' && silentPayload.targetMessageId && silentPayload.emoji) {
              cleanUpOptimisticBubble(); // ✅ Bersihkan
              set(state => {
                  const currentMessages = state.messages[conversationId] || [];
                  const updatedMessages = currentMessages.map(m => {
                      if (m.id === silentPayload.targetMessageId) {
                          const newReactions = m.reactions?.filter(r => r.userId !== decrypted.senderId || r.emoji !== silentPayload.emoji) || [];
                          const updatedMsg = { ...m, reactions: newReactions };
                          shadowVault.upsertMessages([updatedMsg]).catch(captureAndLog);
                          return updatedMsg;
                      }
                      return m;
                  });
                  return { messages: { ...state.messages, [conversationId]: updatedMessages } };
              });
              return null;
          }

          decrypted.content = silentPayload.text || '';
      }
      
      if (reactionPayload) {
          cleanUpOptimisticBubble(); // ✅ Bersihkan Bubble Hantu Reaksi
          const reaction = {
              id: decrypted.id,
              messageId: reactionPayload.targetMessageId,
              emoji: reactionPayload.emoji,
              userId: decrypted.senderId,
              createdAt: decrypted.createdAt,
              user: decrypted.sender,
              isMessage: true
          };
          
          if (message.tempId && currentUser && message.senderId === currentUser.id) {
              const optimisticId = `temp_react_${message.tempId}`;
              get().replaceOptimisticReaction(conversationId, reaction.messageId, optimisticId, reaction);
          } else {
              get().addLocalReaction(conversationId, reaction.messageId, reaction);
          }
          import('@lib/shadowVaultDb').then(({ shadowVault }) => {
              const targetId = String(reaction.messageId);
              shadowVault.getMessage(targetId).then(targetMsg => {
                  if (targetMsg) {
                      const existingReactions = targetMsg.reactions || [];
                      // Timpa reaksi dari user yang sama jika ada, lalu tambahkan reaksi baru
                      const updatedReactions = [...existingReactions.filter(r => r.userId !== reaction.userId), reaction];
                      shadowVault.upsertMessages([{ ...targetMsg, reactions: updatedReactions }]);
                  }
              }).catch(captureAndLog);
          });
      } else if (editPayload) {
          cleanUpOptimisticBubble(); // ✅ Bersihkan Bubble Hantu Edit Pesan
          set(state => {
              const currentMessages = state.messages[conversationId] || [];
              const updatedMessages = currentMessages.map(m => 
                  m.id === editPayload.targetMessageId ? { ...m, content: editPayload.text, isEdited: true } : m
              );
              const editedMsg = updatedMessages.find(m => m.id === editPayload.targetMessageId);
              if (editedMsg) {
                  shadowVault.upsertMessages([editedMsg]);
                  
                  import('@store/conversation').then(m => {
                      const conv = m.useConversationStore.getState().conversations.find(c => c.id === conversationId);
                      if (conv?.lastMessage?.id === editPayload.targetMessageId) {
                          m.useConversationStore.getState().updateConversationLastMessage(conversationId, editedMsg);
                      }
                  }).catch(captureAndLog);
              }
              
              return { messages: { ...state.messages, [conversationId]: updatedMessages } };
          });
      } else {
          // ==========================================
          // PESAN NORMAL (BUKAN SILENT, REAKSI, EDIT)
          // ==========================================
          const [enriched] = enrichMessagesWithSenderProfile(conversationId, [decrypted]);
          if (!enriched) return decrypted;
          const finalDecrypted = enriched;

          // JIKA PESAN DARI DIRI SENDIRI (SINKRONISASI / OPTIMISTIC UI)
          if (message.tempId && currentUser && message.senderId === currentUser.id) {
              get().replaceOptimisticMessage(conversationId, message.tempId, finalDecrypted);
          } else {
              // ✅ 1. AWAIT PENYIMPANAN LOKAL DULU (DI LUAR SET)
              const currentMessagesBeforeSave = get().messages[conversationId] || [];
              if (!currentMessagesBeforeSave.some(m => m.id === message.id)) {
                  await shadowVault.upsertMessages([finalDecrypted]);
              }

              // ✅ 2. TEMBAK KILL SWITCH SETELAH AMAN DI LOKAL
              // [FIX OFFLINE-LOSS] Jangan receipt pesan yang gagal didekripsi —
              // server menghapus ciphertext 1:1 saat READ, dan pendingDecryptions
              // (in-memory) hilang saat reload. Tunggu reDecrypt sukses; pesan yang
              // belum terbaca tetap aman di server untuk catch-up berikutnya.
              const socket = transportClient;
              const isLiveReadSafe = !finalDecrypted.error && !!finalDecrypted.content
                  && finalDecrypted.content !== 'waiting_for_key'
                  && !(typeof finalDecrypted.content === 'string' && finalDecrypted.content.startsWith('['));
              if (socket?.connected && currentUser && finalDecrypted.senderId !== currentUser.id && !finalDecrypted.isSilent && isLiveReadSafe) {
                  transportClient.sendEvent('message:mark_as_read', {
                      messageId: finalDecrypted.id,
                      conversationId: conversationId,
                      targetRecipient: finalDecrypted.senderId
                  });
              }

              // ✅ 3. UPDATE STATE UI ZUSTAND (Synchronous)
              set(state => {
                const currentMessages = state.messages[conversationId] || [];
                if (currentMessages.some(m => m.id === message.id)) return state;
                return { messages: { ...state.messages, [conversationId]: [...currentMessages, finalDecrypted] } };
              });
              
              // --- Logika Notifikasi Dynamic Island ---
              const isViewingChat = window.location.pathname.includes(`/chat/${finalDecrypted.conversationId}`);
              if (!isViewingChat && !finalDecrypted.isSilent && finalDecrypted.senderId !== currentUser?.id) {
                  import('@store/dynamicIsland').then(({ default: useDynamicIslandStore }) => {
            const sender = finalDecrypted.sender;
            const senderName = sender?.name || (sender as typeof sender & { decryptedProfile?: { name?: string } }).decryptedProfile?.name || 'Someone'; 
                      let snippet = finalDecrypted.content || 'New secure message';
                      if (finalDecrypted.fileUrl || finalDecrypted.isBlindAttachment) snippet = 'Sent an attachment 📎';
                      if (finalDecrypted.content && finalDecrypted.content.startsWith('🔒')) snippet = 'System message';

                      useDynamicIslandStore.getState().addActivity({
                          type: 'notification',
                          sender: sender || { name: senderName },
                          message: snippet,
                          link: `/chat/${finalDecrypted.conversationId}`
                      } as Parameters<ReturnType<typeof useDynamicIslandStore.getState>['addActivity']>[0], 4000);                  
                  }).catch(captureAndLog);
              }

              // --- Logika Update Preview Chat List ---
              if (!finalDecrypted.isSilent) {
                  import('@store/conversation').then(m => {
                      m.useConversationStore.getState().updateConversationLastMessage(conversationId, finalDecrypted);
                  }).catch(captureAndLog);
              }
          }
      }
      
      return decrypted;
  },

  replaceOptimisticMessage: async (conversationId, tempId, newMessage) => {
    // Tangkap kedua jenis Typo ID
    const tempIdStr = `temp_${tempId}`;
    const tempIdDashStr = `temp-${tempId}`;

    const existingTombstone = await shadowVault.getMessage(tempIdStr) || await shadowVault.getMessage(tempIdDashStr);
    
    if (existingTombstone && existingTombstone.isDeletedLocal) {
        await shadowVault.deleteMessage(tempIdStr);
        await shadowVault.deleteMessage(tempIdDashStr);
        await shadowVault.upsertMessages([{ ...newMessage, id: newMessage.id!, conversationId, isDeletedLocal: true, content: null, fileUrl: undefined } as Message]);
        
        set(state => ({
            messages: {
                ...state.messages,
                [conversationId]: (state.messages[conversationId] || []).filter(m => 
                    String(m.tempId) !== String(tempId) && 
                    m.id !== tempIdStr && 
                    m.id !== tempIdDashStr &&
                    m.id !== newMessage.id
                )
            }
        }));
        return; 
    }

    // === BASMI HANTU DARI INDEXEDDB ===
    await shadowVault.deleteMessage(tempIdStr);
    await shadowVault.deleteMessage(tempIdDashStr);

    set(state => {
      const currentMessages = state.messages[conversationId] || [];
      
      const oldMsg = currentMessages.find(m => 
          (tempId && String(m.tempId) === String(tempId)) || 
          m.id === tempIdStr || 
          m.id === tempIdDashStr ||
          m.id === newMessage.id
      );
      
      const filteredMessages = currentMessages.filter(m => 
          String(m.tempId) !== String(tempId) && 
          m.id !== tempIdStr && 
          m.id !== tempIdDashStr && 
          m.id !== newMessage.id
      );
      
      const newMsgIdStr = newMessage.id ? String(newMessage.id) : '';
      // ✅ FIX: Use composite key for pendingStatuses lookup
      const pendingKey = newMsgIdStr ? `${newMessage.conversationId}:${newMsgIdStr}` : '';
      const pending = pendingKey ? pendingStatuses[pendingKey] : undefined;

      const finalStatuses = pending
          ? [{
              userId: asUserId(pending.userId),
              status: pending.status as 'SENT' | 'DELIVERED' | 'READ',
              messageId: asMessageId(newMsgIdStr),
              id: `temp-status-${Date.now()}`,
              updatedAt: new Date().toISOString()
            }]
          : (newMessage.statuses && newMessage.statuses.length > 0)
              ? newMessage.statuses
              : (oldMsg?.statuses || []);

      if (pending && pendingKey) {
          delete pendingStatuses[pendingKey];
      }

      const finalMessage: Message = {
        ...(oldMsg || {}), 
        ...(newMessage as Message), 
        // === FIX CENTANG BIRU HILANG ===
        statuses: finalStatuses,
        content: newMessage.content !== undefined ? newMessage.content : oldMsg?.content,
        fileUrl: newMessage.fileUrl !== undefined ? newMessage.fileUrl : oldMsg?.fileUrl,
        fileKey: newMessage.fileKey !== undefined ? newMessage.fileKey : oldMsg?.fileKey,
        fileName: newMessage.fileName !== undefined ? newMessage.fileName : oldMsg?.fileName,
        fileType: newMessage.fileType !== undefined ? newMessage.fileType : oldMsg?.fileType,
        fileSize: newMessage.fileSize !== undefined ? newMessage.fileSize : oldMsg?.fileSize,
        duration: newMessage.duration !== undefined ? newMessage.duration : oldMsg?.duration,
        isBlindAttachment: newMessage.isBlindAttachment !== undefined ? newMessage.isBlindAttachment : oldMsg?.isBlindAttachment,
        repliedTo: newMessage.repliedTo !== undefined ? newMessage.repliedTo : oldMsg?.repliedTo,
        tempId: oldMsg?.tempId || tempId, 
        optimistic: false
      };

      // Simpan pembaruan utuh ke IndexedDB
      shadowVault.upsertMessages([finalMessage]); 

      const newMessages = [...filteredMessages, finalMessage]
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .filter(m => m.type !== 'SYSTEM' && String(m.type) !== 'SYSTEM_KEY_REQUEST');

      return {
        messages: {
            ...state.messages,
            [conversationId]: newMessages
        }
      };
    })
  },

  removeMessage: (conversationId, messageId) => {
    set(state => {
      const messages = state.messages[conversationId] || [];
      const messageToRemove = messages.find(m => m.id === messageId);
      
      if (messageToRemove) {
          if (messageToRemove.fileUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(messageToRemove.fileUrl);
          }
          shadowVault.upsertMessages([{ ...messageToRemove, content: null, fileUrl: undefined, isDeletedLocal: true }]).catch(captureAndLog);
      } else {
          shadowVault.upsertMessages([{ id: messageId, conversationId, isDeletedLocal: true, createdAt: new Date().toISOString(), senderId: 'unknown' } as Message]).catch(captureAndLog);
      }

      import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(captureAndLog);

      const updatedMessages = messages.map(m => {
          if (m.id === messageId) {
              return { ...m, content: null, fileUrl: undefined, isDeletedLocal: true, reactions: [] };
          }
          if (m.reactions && m.reactions.some(r => r.id === messageId)) {
              return {
                  ...m,
                  reactions: m.reactions.filter(r => r.id !== messageId)
              };
          }
          return m;
      });

      return {
        messages: {
            ...state.messages,
            [conversationId]: updatedMessages,
        }
      };
    });
  },

  updateMessage: (conversationId, messageId, updates) => {
    set(state => {
      let updatedMessages = (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, ...updates } : m);
      const updatedMsg = updatedMessages.find(m => m.id === messageId);

      if (updatedMsg) {
        let messageForPreview = updatedMsg;
        if (updatedMsg.isViewOnce && updatedMsg.isViewed) {
            import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(captureAndLog);
            const tombstone = { ...updatedMsg, content: null, fileUrl: undefined, isDeletedLocal: true };
            shadowVault.upsertMessages([tombstone]).catch(captureAndLog);
            updatedMessages = updatedMessages.map(m => m.id === messageId ? tombstone : m);
            messageForPreview = tombstone;
        } else {
            shadowVault.upsertMessages([updatedMsg]); 
        }

        import('@store/conversation').then(m => {
            const conv = m.useConversationStore.getState().conversations.find(c => c.id === conversationId);
            if (conv?.lastMessage?.id === messageId) {
                m.useConversationStore.getState().updateConversationLastMessage(conversationId, messageForPreview);
            }
        }).catch(captureAndLog);
      }
      return { messages: { ...state.messages, [conversationId]: updatedMessages } };
    })
  },
  
  addLocalReaction: (conversationId, messageId, reaction: { id: string; emoji: string; userId: string; isMessage?: boolean }) => set(state => ({
    messages: {
      ...state.messages,
      [conversationId]: (state.messages[conversationId] || []).map(m => {
        if (m.id === messageId) {
          const newReactions = [...(m.reactions || [])];
          if (!newReactions.some(r => r.id === reaction.id)) {
            newReactions.push({ ...reaction, userId: asUserId(reaction.userId) });
            }
            return { ...m, reactions: newReactions };
            }
            return m;
            })
            }
            })),

            removeLocalReaction: (conversationId, messageId, reactionId) => set(state => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, reactions: (m.reactions || []).filter(r => r.id !== reactionId) } : m) } })),

            replaceOptimisticReaction: (conversationId, messageId, tempId, finalReaction) => set(state => ({
            messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] || []).map(m => {
            if (m.id === messageId) {
            return {
            ...m,
            reactions: (m.reactions || []).map(r => r.id === tempId ? { ...finalReaction, userId: asUserId(finalReaction.userId) } : r),
            };
            }
            return m;
            })
            }
            })),
            
            updateSenderDetails: (user) => set(state => {
            const newMessages = { ...state.messages };
            for (const convoId in newMessages) {
            const list = newMessages[convoId];
            if (list) {
              newMessages[convoId] = list.map(m => m.sender?.id === user.id ? { ...m, sender: { ...(m.sender || { id: user.id }), ...user } } : m) as Message[];
            }
            }
            return { messages: newMessages };
            }),

            updateMessageStatus: (conversationId, messageId, userId, status) => {
            set(state => {
              const newMessages = { ...state.messages };
              const convoMessages = newMessages[conversationId];
              if (!convoMessages) return state;
            
              let msgToSave: Message | null = null;
              let found = false;
              
              // 1. Pastikan status adalah tipe literal (bukan sembarang string)
              const validStatus = status as 'SENT' | 'DELIVERED' | 'READ';
            
              newMessages[conversationId] = convoMessages.map(m => {
                if (m.id === messageId) {
                  found = true;
                  const existingStatus = m.statuses?.find(s => s.userId === userId);
                  const updatedMsg = { ...m };
                  
                  if (existingStatus) {
                     updatedMsg.statuses = updatedMsg.statuses!.map(s => 
                       s.userId === userId 
                         ? { ...s, status: validStatus, updatedAt: new Date().toISOString() } 
                         : s
                     );
                  } else {
                     // 2. Bungkus parameter string ke dalam Branded Type menggunakan asUserId dan asMessageId
                     updatedMsg.statuses = [
                       ...(updatedMsg.statuses || []), 
                       { 
                         userId: asUserId(userId), 
                         status: validStatus, 
                         messageId: asMessageId(messageId), 
                         id: `temp-status-${Date.now()}`, 
                         updatedAt: new Date().toISOString() 
                       }
                     ];
                  }
                  
                  msgToSave = updatedMsg;
                  return updatedMsg;
                }
                return m;
              }) as Message[];
            
              if (!found) {
                  // Jika pesan belum ditemukan (masih berstatus temp_id), simpan ke pendingStatuses
                  // ✅ FIX: Use composite key to prevent race overwrites across conversations
                  const compositeKey = `${conversationId}:${messageId}`;
                  pendingStatuses[compositeKey] = { conversationId, userId, status: validStatus };
              }

              if (msgToSave) {
                 // Ambil objeknya dengan aman, hindari operator '!'
                 const savedObj = msgToSave as Message;
                 import('@lib/shadowVaultDb').then(m => m.shadowVault.upsertMessages([savedObj]));
              }
            
              return { messages: newMessages };
            });
          },

            clearMessagesForConversation: (conversationId) => {
            shadowVault.deleteConversationMessages(conversationId).catch(captureAndLog);
            import('@utils/crypto').then(m => m.deleteConversationKeychain(conversationId)).catch(captureAndLog);

            set(state => {
            const newMessages = { ...state.messages };
            delete newMessages[conversationId];
            return { messages: newMessages };
            });
            },

            retrySendMessage: (message: Message) => {
            const { conversationId, tempId, preview, fileUrl, fileName, fileType, fileSize, repliedToId } = message;
            set(state => ({
            messages: { ...state.messages, [conversationId]: state.messages[conversationId]?.filter(m => m.tempId !== tempId) || [] },
            }));
            get().sendMessage(conversationId, { content: preview, fileUrl, fileName, fileType, fileSize, repliedToId }, tempId);
            },

            resendPendingMessages: () => {
            const state = get();
            Object.entries(state.messages).forEach(([_conversationId, messages]) => {
            messages
            .filter(m => m.optimistic && !m.error)
            .forEach(m => {
            get().retrySendMessage(m);
            });
            });
            },

    addSystemMessage: async (conversationId, content) => {
        const systemMessage: Message = {
            id: asMessageId(`system_${Date.now()}_${Math.random().toString(36).substring(7)}`),
            type: 'SYSTEM',
            conversationId: asConversationId(conversationId),
            content,
            createdAt: new Date().toISOString(),
            senderId: asUserId('system'),
            reactions: []
        };

        // Persistent save
        const { shadowVault } = await import('@lib/shadowVaultDb');
        await shadowVault.upsertMessages([systemMessage]);

        set(state => ({
            messages: {
                ...state.messages,
                [conversationId]: [...(state.messages[conversationId] || []), systemMessage]
            }
        }));
    },
            
  reDecryptPendingMessages: async (conversationId: string) => {
    // Process without delay as we are called strictly after key is stored
    const state = get();
    const conversationMessages = state.messages[conversationId] || [];

    const mainPending = conversationMessages.filter(
      m => m.content === 'waiting_for_key' || m.content === '[Requesting key to decrypt...]' || m.content === '<Decryption Failed>' || (m.content && m.content.includes('[Decryption Failed'))
    );

    const queuePending = state.pendingDecryptions.filter(m => m.conversationId === conversationId);

    const pendingMessages = [...mainPending, ...queuePending];

    if (pendingMessages.length === 0) {
      return;
    }

    const reDecryptedMessages: Message[] = [];
    for (const msg of pendingMessages) {
        try {
            const decrypted = await decryptMessageObject(msg);
            if (decrypted) {
                const [enriched] = enrichMessagesWithSenderProfile(conversationId, [decrypted]);
                if (enriched) reDecryptedMessages.push(enriched);
            }
        } catch (e) {
            console.error(`[Re-Decrypt] Failed for msg ${msg.id}:`, e);
            reDecryptedMessages.push(msg);
        }
    }

    const processedIds = new Set(reDecryptedMessages.map(m => m.id));
    set(state => ({
        pendingDecryptions: state.pendingDecryptions.filter(m => m.conversationId !== conversationId || !processedIds.has(m.id))
    }));

    const messageMap = new Map(conversationMessages.map(m => [m.id, m]));
    reDecryptedMessages.forEach(m => {
        if (m.content !== 'waiting_for_key' && m.content !== '[Requesting key to decrypt...]' && m.content !== '<Decryption Failed>' && !(m.content && m.content.includes('[Decryption Failed'))) {
             const payload = parseReaction(m.content);
             if (payload) {
                 get().addLocalReaction(conversationId, payload.targetMessageId, {
                     id: m.id,
                     
                     emoji: payload.emoji,
                     userId: m.senderId,
                     isMessage: true
                 });
                 messageMap.delete(m.id);
                 return;
             }
             messageMap.set(m.id, m);
        } else {
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