// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api"; // Added authFetch
import { getSocket, emitSessionKeyRequest, emitGroupKeyDistribution } from "@lib/socket";
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
import { useAuthStore, type User } from "./auth";
import type { Message, RawServerMessage } from "./conversation";
import useDynamicIslandStore, { UploadActivity } from './dynamicIsland';
import { useConversationStore } from "./conversation";
import { addToQueue, getQueueItems, removeFromQueue, updateQueueAttempt } from "@lib/offlineQueueDb";
import { useConnectionStore } from "./connection";
import { getSodium } from "@lib/sodiumInitializer";
import { shadowVault, saveStoryKey } from "../lib/shadowVaultDb";

import { useProfileStore } from './profile';

const incomingMessageLocks = new Map<string, Promise<void>>();

function enrichMessagesWithSenderProfile(conversationId: string, messages: Message[]): Message[] {
    const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conv) return messages;
    
    const participantsMap = new Map(conv.participants.map(p => [('userId' in p ? (p as unknown as {userId: string}).userId : p.id) || p.id, p]));
    const cachedProfiles = useProfileStore.getState().profiles;
    
    return messages.map(m => {
        const pInfo = participantsMap.get(m.senderId);
        
        // Dynamic search in RAM cache (Profile Store)
        const profileKey = Object.keys(cachedProfiles).find(k => k.startsWith(m.senderId));
        const globalProfile = profileKey ? cachedProfiles[profileKey] : null;

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
 * Logika Dekripsi Terpusat (Single Source of Truth)
 * Menangani dekripsi teks biasa DAN kunci file.
 */
export async function decryptMessageObject(
  rawMsg: RawServerMessage | Message,
  seenIds = new Set<string>(),
  depth = 0,
  options: { skipRetries?: boolean } = {}
): Promise<Message> {
  const currentUser = useAuthStore.getState().user;

  // Base message object derived from raw payload
  let finalMessage: Message = {
    id: rawMsg.id,
    tempId: rawMsg.tempId,
    type: rawMsg.type,
    conversationId: rawMsg.conversationId,
    senderId: rawMsg.senderId,
    sender: rawMsg.sender,
    createdAt: rawMsg.createdAt,
    content: rawMsg.content,
    repliedToId: rawMsg.repliedToId,
    linkPreview: rawMsg.linkPreview,
    expiresAt: rawMsg.expiresAt,
    isViewOnce: rawMsg.isViewOnce,
    reactions: [],
  };

  if (seenIds.has(rawMsg.id) || depth > 10) {
    return finalMessage;
  }
  seenIds.add(rawMsg.id);

  const conversation = useConversationStore.getState().conversations.find(c => c.id === rawMsg.conversationId);
  const isGroup = conversation?.isGroup || false;

  try {
    // 1. SELF-MESSAGE DECRYPTION
    if (currentUser && rawMsg.senderId === currentUser.id) {
        const { retrieveMessageKeySecurely } = await import('@utils/crypto');
        let mk = await retrieveMessageKeySecurely(rawMsg.id);
        if (!mk && rawMsg.tempId) {
            mk = await retrieveMessageKeySecurely(`temp_${rawMsg.tempId}`);
        }
        
        if (mk) {
            const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await import('@lib/crypto-worker-proxy');
            const sodium = await getSodium();
            
            let cipherTextToUse = 'ciphertext' in rawMsg ? rawMsg.ciphertext : rawMsg.content;
            
            const unwrap = (str: string): string => {
                 if (str && typeof str === 'string' && str.trim().startsWith('{')) {
                     try {
                         const p = JSON.parse(str);
                         if (p.ciphertext) return unwrap(p.ciphertext as string);
                     } catch (_e) {}
                     }
                     return str;
            }
            
            cipherTextToUse = unwrap(cipherTextToUse || '');

            if (cipherTextToUse) {
                try {
                    const combined = sodium.from_base64(cipherTextToUse, sodium.base64_variants.URLSAFE_NO_PADDING);
                    const nonce = combined.slice(0, 24);
                    const encrypted = combined.slice(24);
                    const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                    let plainText = sodium.to_string(decryptedBytes);
                    
                    if (plainText && plainText.trim().startsWith('{')) {
                        try {
                            const parsed = JSON.parse(plainText);
                            if (parsed.profileKey) {
                                delete parsed.profileKey;
                                if (parsed.text !== undefined && Object.keys(parsed).length === 1) {
                                    plainText = parsed.text;
                                } else {
                                    plainText = JSON.stringify(parsed);
                                }
                            }
                        } catch (_e) {}
                    }
                    
                    finalMessage = { ...finalMessage, content: plainText };
                    
                    if (finalMessage.content && finalMessage.content.startsWith('{') && finalMessage.content.includes('"type":"file"')) {
                        try {
                            const metadata = JSON.parse(finalMessage.content);
                            if (metadata.type === 'file') {
                                finalMessage = {
                                    ...finalMessage,
                                    fileUrl: metadata.url,
                                    fileKey: metadata.key,
                                    fileName: metadata.name,
                                    fileSize: metadata.size,
                                    fileType: metadata.mimeType,
                                    content: null,
                                    isBlindAttachment: true
                                };
                            }
                        } catch (_e) {}
                    } else if (finalMessage.content && finalMessage.content.startsWith('{') && finalMessage.content.includes('"type":"story_reply"')) {
                        try {
                            const metadata = JSON.parse(finalMessage.content);
                            if (metadata.type === 'story_reply') {
                                finalMessage = {
                                    ...finalMessage,
                                    content: metadata.text,
                                    repliedTo: {
                                        id: 'story_mock',
                                        conversationId: rawMsg.conversationId,
                                        senderId: metadata.storyAuthorId,
                                        sender: { id: metadata.storyAuthorId },
                                        content: metadata.storyText || (metadata.hasMedia ? '📷 Story' : 'Story'),
                                        createdAt: new Date().toISOString(),
                                        reactions: [],
                                    } as unknown as Message
                                };
                            }
                        } catch (_e) {}
                    }
                    if (rawMsg.repliedTo) {
                        finalMessage.repliedTo = await decryptMessageObject(rawMsg.repliedTo as RawServerMessage, seenIds, depth + 1, options);
                    }
                    return finalMessage;
                } catch (e) {
                    console.error("Self-decrypt failed with stored key:", e);
                }
            }
        }
        
        if (finalMessage.content && finalMessage.content.trim().startsWith('{')) {
             finalMessage.content = "🔒 You sent this message (Encrypted)";
        }
        if (rawMsg.repliedTo) {
            finalMessage.repliedTo = await decryptMessageObject(rawMsg.repliedTo as RawServerMessage, seenIds, depth + 1, options);
        }
        return finalMessage;
    }

    let contentToDecrypt = 'ciphertext' in rawMsg ? rawMsg.ciphertext : undefined;

    if (!contentToDecrypt) {
        contentToDecrypt = ('fileKey' in rawMsg ? rawMsg.fileKey : undefined) || rawMsg.content;
    }

    if (!contentToDecrypt || contentToDecrypt === 'waiting_for_key' || contentToDecrypt === '[Requesting key to decrypt...]') {
        return finalMessage;
    }

    const isLikelyEncrypted = (str: string) => {
        const trimmed = str.trim();
        if (trimmed.startsWith('{') && (trimmed.includes('"header"') || trimmed.includes('"ciphertext"') || trimmed.includes('"dr"'))) {
            return true;
        }
        const base64Regex = /^[A-Za-z0-9+/_-]+={0,2}$/;
        if (base64Regex.test(trimmed) && trimmed.length > 20) { 
            return true;
        }
        return false;
    };

    if (!isLikelyEncrypted(contentToDecrypt)) {
        return finalMessage;
    }

    if (!isGroup && contentToDecrypt.startsWith('{') && contentToDecrypt.includes('"x3dh":')) {
       try {
           const payload = JSON.parse(contentToDecrypt);
           const { retrieveMessageKeySecurely } = await import('@utils/crypto');
           const mk = await retrieveMessageKeySecurely(rawMsg.id);
           
           if (mk) {
               contentToDecrypt = payload.ciphertext;
           } else if (payload.x3dh && payload.ciphertext) {
               const { ik, ek, otpkId } = payload.x3dh;
               const ciphertext = payload.ciphertext;

               const myIdentityKeyPair = await getMyEncryptionKeyPair();
               const { getSignedPreKeyPair } = useAuthStore.getState();
               const mySignedPreKeyPair = await getSignedPreKeyPair();

               const sessionKey = await deriveSessionKeyAsRecipient(
                   myIdentityKeyPair,
                   mySignedPreKeyPair,
                   ik,
                   ek,
                   otpkId
               );

               let theirRatchetPublicKey: Uint8Array | undefined;
               
               try {
                   const innerPayload = JSON.parse(ciphertext);
                   if (innerPayload.dr) {
                        const epk = innerPayload.dr.dh || innerPayload.dr.epk;
                        if (epk) {
                            const sodium = await getSodium();
                            theirRatchetPublicKey = sodium.from_base64(epk, sodium.base64_variants.URLSAFE_NO_PADDING);
                        }
                   }
               } catch (_e) {}

               if (!theirRatchetPublicKey) {
                   throw new Error("Cannot initialize Bob: Missing sender's ratchet key in first message.");
               }

               const { worker_dr_init_bob } = await import('@lib/crypto-worker-proxy');
               const newState = await worker_dr_init_bob({
                   sk: sessionKey,
                   mySignedPreKey: mySignedPreKeyPair,
                   theirRatchetPublicKey: theirRatchetPublicKey
               });

               await storeRatchetStateSecurely(rawMsg.conversationId, newState);
               contentToDecrypt = ciphertext; 
           }
       } catch (e) {
           console.error("[X3DH] Failed to parse/derive from header:", e);
       }
    }

    let result;
    let attempts = 0;
    const MAX_ATTEMPTS = options.skipRetries ? 1 : 3;

    const sessionOrSenderId = isGroup ? rawMsg.senderId : (('sessionId' in rawMsg ? rawMsg.sessionId : '') || '');

    while (attempts < MAX_ATTEMPTS) {
        result = await decryptMessage(
          contentToDecrypt || '', 
          rawMsg.conversationId,
          isGroup,
          sessionOrSenderId, 
          rawMsg.id
        );

        if (result.status === 'success' || result.status === 'error') {
            break; 
        }

        if (result.status === 'pending') {
            attempts++;
            if (attempts < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, 800)); 
            }
        }
    }

    if (result?.status === 'success') {
      let plainText = result.value as string;

      if (plainText && plainText.trim().startsWith('{')) {
          try {
              const parsed = JSON.parse(plainText);
              if (parsed.profileKey) {
                  const { saveProfileKey } = await import('@lib/keychainDb');
                  const { useProfileStore } = await import('@store/profile');
                  
                  await saveProfileKey(rawMsg.senderId, parsed.profileKey);
                  useProfileStore.getState().decryptAndCache(rawMsg.senderId, rawMsg.sender?.encryptedProfile || null);
                  
                  delete parsed.profileKey;
                  
                  if (parsed.text !== undefined && Object.keys(parsed).length === 1) {
                      plainText = parsed.text;
                  } else {
                      plainText = JSON.stringify(parsed);
                  }
              }
          } catch (_e) {}
      }

      finalMessage = { ...finalMessage, content: plainText };

      if (plainText.startsWith('{') && plainText.includes('"type":"file"')) {
        try {
          const metadata = JSON.parse(plainText);
          if (metadata.type === 'file') {
            finalMessage = {
                ...finalMessage,
                fileUrl: metadata.url,
                fileKey: metadata.key,
                fileName: metadata.name,
                fileSize: metadata.size,
                fileType: metadata.mimeType,
                content: null,
                isBlindAttachment: true
            };
          }
        } catch (_e) { }
      }

      if (plainText.startsWith('{') && plainText.includes('"type":"story_reply"')) {
        try {
          const metadata = JSON.parse(plainText);
          if (metadata.type === 'story_reply') {
            finalMessage = {
                ...finalMessage,
                content: metadata.text,
                repliedTo: {
                    id: 'story_mock',
                    conversationId: rawMsg.conversationId,
                    senderId: metadata.storyAuthorId,
                    sender: { id: metadata.storyAuthorId },
                    content: metadata.storyText || (metadata.hasMedia ? '📷 Story' : 'Story'),
                    createdAt: new Date().toISOString(),
                    reactions: [],
                } as unknown as Message
            };
          }
        } catch (_e) { }
      }      
    } else if (result?.status === 'pending') {
      finalMessage.content = result.reason || 'waiting_for_key';
    } else {
      console.warn(`[Decrypt] Failed for msg ${rawMsg.id}:`, result?.error);
      const errMsg = (result?.error as Error)?.message || '';
      if (errMsg.includes('waiting for key') || errMsg.includes('Missing sender')) {
          finalMessage.content = 'waiting_for_key';
      } else {
          finalMessage.content = '[Decryption Failed: Key out of sync]';
          finalMessage.error = true;
      }
      finalMessage.type = 'SYSTEM';
    }

    if (rawMsg.repliedTo) {
        finalMessage.repliedTo = await decryptMessageObject(rawMsg.repliedTo as RawServerMessage, seenIds, depth + 1, options);
    }

    return finalMessage;

  } catch (e) {
    console.error("Critical error in decryptMessageObject:", e);
    return { ...finalMessage, content: "🔒 Decryption Error", type: 'SYSTEM' };
  }
}

// Robust helper to parse reaction payload
function parseReaction(content: string | null | undefined): { targetMessageId: string, emoji: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"reaction"')) return null;
    
    const payload = JSON.parse(trimmed);
    if (payload.type === 'reaction' && payload.targetMessageId && payload.emoji) {
      return payload;
    }
  } catch (_e) {}
  return null;
}

function parseEdit(content: string | null | undefined): { targetMessageId: string, text: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"edit"')) return null;
    const payload = JSON.parse(trimmed);
    if (payload.type === 'edit' && payload.targetMessageId && payload.text) {
      return payload;
    }
  } catch (_e) {}
  return null;
}

function parseSilent(content: string | null | undefined): { text?: string, type?: string, key?: string, storyId?: string } | null {
  if (!content) return null;
  try {
    let trimmed = content.trim();
    if (trimmed.startsWith('STORY_KEY:')) {
        trimmed = trimmed.replace('STORY_KEY:', '');
    }
    if (!trimmed.startsWith('{')) return null;
    const payload = JSON.parse(trimmed);
    // DO NOT treat story_reply as silent. Let processMessagesAndReactions keep it.
    if (payload.type === 'story_reply') {
      return null;
    }
    if (payload.type === 'silent') {
      return payload;
    }
    if (payload.type === 'CALL_INIT' && typeof payload.key === 'string') {
      return payload;
    }
    if (payload.type === 'GHOST_SYNC') {
      return payload;
    }
    if (payload.type === 'STORY_KEY') {
      return payload; // Should contain storyId and key
    }
  } catch (_e) {}
  return null;
}

// Helper to separate messages and reactions
function processMessagesAndReactions(decryptedItems: Message[], existingMessages: Message[] = []) {
  const chatMessages: Message[] = [];
  interface ReactionPayload { id: string; messageId: string; emoji: string; userId: string; createdAt: string; user?: unknown; isMessage: boolean; }
  const reactions: ReactionPayload[] = [];
  interface EditPayload { targetMessageId: string; text: string; timestamp: number; }
  const edits: EditPayload[] = [];

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
              // Ignore this message in the UI completely
              continue;
          }
          msg.content = silentPayload.text;
          msg.isSilent = true;
          // [FIX] Filter out signaling messages (like CALL_INIT) that have no text content
          if (!msg.content) {
              continue; 
          }
      }
      chatMessages.push(msg);
    }
  }

  const messageMap = new Map([...existingMessages, ...chatMessages].map(m => [m.id, m]));
  
  for (const reaction of reactions) {
    const target = messageMap.get(reaction.messageId);
    if (target) {
      const existingReactions = target.reactions || [];
      if (!existingReactions.some(r => r.id === reaction.id)) {
        target.reactions = [...existingReactions, reaction];
      }
    }
  }

  // APPLY EDITS (Sort by timestamp so latest edit wins)
  edits.sort((a, b) => a.timestamp - b.timestamp);
  for (const edit of edits) {
     const target = messageMap.get(edit.targetMessageId);
     if (target) {
        target.content = edit.text;
        target.isEdited = true;
     }
  }

  return Array.from(messageMap.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

type State = {
  messages: Record<string, Message[]>;
  replyingTo: Message | null;
  isFetchingMore: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  typingLinkPreview: unknown | null;
  hasLoadedHistory: Record<string, boolean>;
  selectedMessageIds: string[];
};

type Actions = {
  setReplyingTo: (message: Message | null) => void;
  fetchTypingLinkPreview: (text: string) => void;
  clearTypingLinkPreview: () => void;
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
  addSystemMessage: (conversationId: string, content: string) => void;
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

let tempIdCounter = 0;
const generateTempId = () => Date.now() * 1000 + (++tempIdCounter) + Math.floor(Math.random() * 1000);

const initialState: State = {
  messages: {},
  isFetchingMore: {},
  hasMore: {},
  hasLoadedHistory: {},
  replyingTo: null,
  typingLinkPreview: null,
  selectedMessageIds: [],
};

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
      if (isGroup) {
        const { forceRotateGroupSenderKey, rotateGroupKey } = await import('@utils/crypto');
        await forceRotateGroupSenderKey(conversationId);
        await rotateGroupKey(conversationId, 'periodic_rotation');
      } else {
        const { deleteRatchetSession } = await import('@utils/crypto');
        await deleteRatchetSession(conversationId);
        // Send a silent system message to trigger the X3DH on the other side automatically,
        // and mark it as type 'GHOST_SYNC' so it renders as a center placeholder.
        get().sendMessage(conversationId, { content: JSON.stringify({ type: 'GHOST_SYNC' }), isSilent: true });
      }
      if (!isAuto) {
          toast.success("Secure session state reset. Next message will negotiate new keys.");
      }
    } catch (error) {
      console.error("Failed to repair session:", error);
      if (!isAuto) toast.error("Failed to repair session.");
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
                    const metadata = JSON.parse(message.content);
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

            api(`/api/messages/${message.id}${query}`, { method: 'DELETE' }).catch((error) => {
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
        import('@utils/crypto').then(m => m.deleteMessageKeySecurely(id)).catch(console.error);
    }
    shadowVault.upsertMessages(tombstones).catch(console.error);

    // 3. Remove from active state
    set(state => {
        const current = state.messages[conversationId] || [];
        return { 
          messages: { ...state.messages, [conversationId]: current.filter(m => !messageIds.includes(m.id)) },
          selectedMessageIds: [] // Clear selection after deletion
        };
    });
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

    // FAKE SEND FOR DECOY
    if (sessionStorage.getItem('nyx_decoy_mode') === 'true') {
        const actualTempId = tempId !== undefined ? tempId : Date.now();
        const msg = {
            id: `temp_${actualTempId}`, tempId: actualTempId, optimistic: true,
            content: data.content, senderId: user.id, sender: user,
            createdAt: new Date().toISOString(), conversationId, status: 'SENT'
        } as Message;
        if (!isSilent) {
            get().addOptimisticMessage(conversationId, msg);
        }
        return;
    }

    if (!hasRestoredKeys) {
      toast.error("You must restore your keys from your recovery phrase before you can send messages.");
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      console.error(`[SendMessage] Conversation NOT FOUND: ${conversationId}`);
      toast.error("Conversation not found.");
      return;
    }
    const isGroup = conversation.isGroup;
    const forceRotate = conversation.requiresKeyRotation === true;

    if (isGroup && useConnectionStore.getState().status === 'connected') {
      try {
        // Pass forceRotate if we suspect new members or requested by another peer
        const distributionKeys = await ensureGroupSession(conversationId, conversation.participants, forceRotate);
        if (distributionKeys && distributionKeys.length > 0) {
          emitGroupKeyDistribution(conversationId, distributionKeys as { userId: string; key: string }[]);
          if (forceRotate) {
              useConversationStore.getState().markKeyRotationNeeded(conversationId, false);
          }
          // Wait a tiny bit to ensure the socket emits the keys before the actual message
          await new Promise(r => setTimeout(r, 300)); 
        }
      } catch (e) {
        console.error("Failed to ensure group session", e);
      }
    }

    const actualTempId = tempId !== undefined ? tempId : generateTempId();
    const isReactionPayload = !!parseReaction(data.content);
    const silentPayload = parseSilent(data.content);
    
    // [FIX] Detect CALL_INIT or GHOST_SYNC and force silence to prevent empty bubble
    const isCallInit = silentPayload?.type === 'CALL_INIT';
    const isGhostSync = silentPayload?.type === 'GHOST_SYNC';
    const shouldBeSilent = isSilent || isCallInit || isGhostSync;

    if (!isReactionPayload && !shouldBeSilent) {
        let optimisticContent = data.content;
        let isOptimisticSilent = false;

        if (silentPayload) {
            optimisticContent = silentPayload.text;
            isOptimisticSilent = true;
        }

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
            repliedTo: data.repliedTo,
            isSilent: isOptimisticSilent || data.isSilent
        };

        // Parse optimistic content for special message types
        if (silentPayload) {
            optimisticMessage.isSilent = true;
        }

        // Handle story_reply type - parse and set proper content + repliedTo
        if (optimisticContent && typeof optimisticContent === 'string' && optimisticContent.startsWith('{') && optimisticContent.includes('"type":"story_reply"')) {
            try {
                const metadata = JSON.parse(optimisticContent);
                if (metadata.type === 'story_reply') {
                    optimisticMessage.content = metadata.text || 'Story reply';
                    optimisticMessage.repliedTo = {
                        id: 'story_mock',
                        senderId: metadata.storyAuthorId,
                        sender: { id: metadata.storyAuthorId },
                        content: metadata.storyText || (metadata.hasMedia ? '📷 Story' : 'Story')
                    } as unknown as Message;
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
               const meta = JSON.parse(lastMsgPreview);
               lastMsgPreview = `Replying to story: ${meta.text}`;
           }
        } catch {}
        useConversationStore.getState().updateConversationLastMessage(conversationId, { ...optimisticMessage, content: lastMsgPreview, fileType: data.fileType, fileName: data.fileName });
        set({ replyingTo: null, typingLinkPreview: null });
    }

    try {
      let ciphertext = '';
      let x3dhHeader: Record<string, unknown> | null = null;

      if (!isGroup && data.content) {
          const state = await retrieveRatchetStateSecurely(conversationId);
          if (!state) {
             const peerId = conversation.participants.find(p => p.id !== user.id)?.id;
             if (peerId) {
                 const theirBundle = await authFetch<PreKeyBundle>(`/api/keys/prekey-bundle/${peerId}`);
                 const myKeyPair = await getMyEncryptionKeyPair();
                 const { sessionKey, ephemeralPublicKey, otpkId } = await establishSessionFromPreKeyBundle(myKeyPair, theirBundle);
                 const sodium = await getSodium();
                 
                 const { worker_dr_init_alice } = await import('@lib/crypto-worker-proxy');
                 const newState = await worker_dr_init_alice({
                     sk: sessionKey,
                     theirSignedPreKeyPublic: sodium.from_base64(theirBundle.signedPreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING)
                 });
                 
                 await storeRatchetStateSecurely(conversationId, newState);

                 x3dhHeader = {
                     ik: sodium.to_base64(myKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
                     ek: ephemeralPublicKey,
                     otpkId: otpkId
                 };
             } else {
                 console.error(`[X3DH] Peer not found in participants for ${conversationId}.`);
                 toast.error("Encryption failed: Cannot identify recipient.");
                 return;
             }
          }
      }

      let mkToStore: Uint8Array | undefined;
      let contentToEncrypt = data.content;

      if (contentToEncrypt) {
        try {
            const profileKey = await import('@lib/keychainDb').then(m => m.getProfileKey(user.id));
            if (profileKey) {
                let parsedObj: Record<string, unknown> | null = null;
                if (contentToEncrypt.trim().startsWith('{')) {
                    try { parsedObj = JSON.parse(contentToEncrypt); } catch (e) {}
                }
                
                if (parsedObj && typeof parsedObj === 'object') {
                    parsedObj.profileKey = profileKey;
                    contentToEncrypt = JSON.stringify(parsedObj);
                } else {
                    contentToEncrypt = JSON.stringify({ text: contentToEncrypt, profileKey });
                }
            }
        } catch (e) {
            console.error("Failed to inject profile key", e);
        }

        const result = await encryptMessage(contentToEncrypt, conversationId, isGroup, undefined, `temp_${actualTempId}`);
        ciphertext = result.ciphertext;
        
        // [FIX PERSISTENCE] Store MK for ALL chats (Group + 1on1)
        if (result.mk) {
             mkToStore = result.mk;
             await import('@utils/crypto').then(({ storeMessageKeySecurely }) => 
                 storeMessageKeySecurely(`temp_${actualTempId}`, mkToStore!)
             );
        }
        
        if (!isGroup && result.drHeader) {
            ciphertext = JSON.stringify({
                dr: result.drHeader,
                ciphertext: ciphertext
            });
        }
      }
      
      if (x3dhHeader) {
          const payloadJson = JSON.stringify({
              x3dh: x3dhHeader,
              ciphertext: ciphertext 
          });
          ciphertext = payloadJson;
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
            // For file messages, show a generic description
            // For text messages, include the actual plaintext content
            let pushBody: string;
            
            // Check for story_reply type and extract the text
            if (typeof data.content === 'string' && data.content.startsWith('{') && data.content.includes('"type":"story_reply"')) {
                try {
                    const metadata = JSON.parse(data.content);
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
                // Truncate long messages for push notification preview
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
            for (const p of conversation.participants as {id: string, publicKey?: string}[]) {
               const targetUserId = ('userId' in p ? (p as { userId?: string }).userId! : p.id);
               const targetPublicKey = ('user' in p ? (p as { user?: { publicKey?: string } }).user?.publicKey : p.publicKey);

               if (targetUserId !== user.id && targetPublicKey) {
                   try {
                       const recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                       const sealed = await worker_crypto_box_seal(pushDataBytes, recipientPubBytes);
                       pushPayloads[targetUserId] = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
                   } catch (e) {
                       console.error(`Failed to seal push for ${targetUserId}`, e);
                   }
               }
            }
        }
      } catch (e) {
        console.error("Failed to generate push payloads", e);
      }

      const payload = {
          ...data,
          content: ciphertext,
          sessionId: undefined, // [PHASE 3 FIX] No session ID needed for group anymore, or managed by logic
          fileKey: undefined, fileName: undefined, fileType: undefined, fileSize: undefined,
          pushPayloads: Object.keys(pushPayloads).length > 0 ? pushPayloads : undefined
      };

      const socket = getSocket();
      const isConnected = socket?.connected;

      if (!isConnected && !isReactionPayload) {
        const queueMsg = { ...payload, id: `temp_${actualTempId}`, tempId: actualTempId, conversationId, senderId: user.id, createdAt: new Date().toISOString() } as Message;
        await addToQueue(conversationId, queueMsg, actualTempId);
        return;
      }

      socket?.emit("message:send", { ...payload, conversationId, tempId: actualTempId }, async (res: { ok: boolean, msg?: Message, error?: string }) => {
        if (res.ok && res.msg) {
            if (!isReactionPayload) {
                // Get the existing optimistic message to preserve its decrypted text and repliedTo object
                const existingMsg = get().messages[conversationId]?.find(m => m.id === `temp_${actualTempId}` || m.tempId === actualTempId || m.id === res.msg!.id);
                
                const updatedMsg = { 
                    ...res.msg, 
                    content: existingMsg !== undefined ? existingMsg.content : res.msg!.content, 
                    repliedTo: existingMsg?.repliedTo,
                    isBlindAttachment: existingMsg?.isBlindAttachment,
                    status: 'SENT' as const
                };
                
                // Update UI and Vault
                get().replaceOptimisticMessage(conversationId, actualTempId, updatedMsg);
            } else {
                const reactionData = parseReaction(contentToEncrypt);
                if (reactionData) {
                    const tempReactionId = `temp_react_${actualTempId}`;
                    get().replaceOptimisticReaction(conversationId, reactionData.targetMessageId, tempReactionId, {
                        ...reactionData,
                        id: res.msg.id, 
                        userId: user.id,
                        isMessage: true
                    });
                }
            }
              
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${actualTempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${actualTempId}`);
                }
            }).catch(console.error);
              
        } else if (!res.ok) {
            if (!isReactionPayload) {
                get().updateMessage(conversationId, `temp_${actualTempId}`, { error: true, status: 'FAILED' });
                // Show specific error for sandbox limit
                if (res.error?.includes('SANDBOX_LIMIT_REACHED')) {
                    toast.error("Sandbox limit reached! Verify your account to unlock unlimited messaging.");
                } else if (res.error) {
                    toast.error(res.error);
                }
            } else {
                toast.error("Failed to send reaction");
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

    for (const item of queue) {
      const { tempId, conversationId, data, attempt } = item;
      
      if (attempt > 5) {
        console.warn(`[Queue] Dropping message ${tempId} after too many retries.`);
        await removeFromQueue(tempId);
        get().updateMessage(conversationId, `temp_${tempId}`, { error: true, status: 'FAILED' });
        continue;
      }

      get().updateMessage(conversationId, `temp_${tempId}`, { status: 'SENDING', error: false });

      // Wrap emit in a Promise to strictly wait for server ACK
      await new Promise<void>((resolve) => {
        // Guard timeout: if server doesn't respond in 5 seconds, increment attempt and move on
        const timeoutId = setTimeout(() => {
          console.error(`[Queue] Timeout waiting for ACK for message ${tempId}`);
          updateQueueAttempt(tempId, attempt + 1).then(() => resolve());
        }, 5000);

        socket.emit("message:send", data, async (res: { ok: boolean, msg?: Message, error?: string }) => {
          clearTimeout(timeoutId);
          if (res.ok && res.msg) {
            await removeFromQueue(tempId);

            // Get the existing optimistic message to preserve its decrypted text and repliedTo object
            const existingMsg = get().messages[conversationId]?.find(m => m.id === `temp_${tempId}` || m.tempId === tempId || m.id === res.msg!.id);
            
            const updatedMsg = { 
                ...res.msg, 
                content: existingMsg !== undefined ? existingMsg.content : res.msg!.content, 
                repliedTo: existingMsg?.repliedTo,
                isBlindAttachment: existingMsg?.isBlindAttachment,
                status: 'SENT' as const
            };
            
            get().replaceOptimisticMessage(conversationId, tempId, updatedMsg);
            
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${tempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${tempId}`);
                }
            }).catch(console.error);
          } else {
            console.error(`[Queue] Failed to send queued message ${tempId}:`, res.error);
            await updateQueueAttempt(tempId, attempt + 1);
          }
          resolve(); // Unblock the loop to process the next message
        });
      });

      // Add a small delay between successful sends to not overwhelm the server
      await new Promise(r => setTimeout(r, 100));
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
      toast.error(`Failed to upload ${file.name}.`);
      set(state => ({
        messages: {
          ...state.messages,
          [conversationId]: state.messages[conversationId]?.map(m => m.tempId === tempId ? { ...m, error: true } : m) || [],
        },
      }));
    }
  },

  loadMessagesForConversation: async (id) => {
    // THE DISGUISE
    if (sessionStorage.getItem('nyx_decoy_mode') === 'true') {
       set(state => ({
          messages: { ...state.messages, [id]: [{ id: 'msg-1', content: 'Welcome to NYX. No active chats found.', senderId: 'bot-1', createdAt: new Date().toISOString(), conversationId: id, type: 'SYSTEM' } as Message] },
          hasMore: { ...state.hasMore, [id]: false },
          hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true }
       }));
       return;
    }

    if (get().hasLoadedHistory[id]) return;

    try {
      set(state => ({ hasMore: { ...state.hasMore, [id]: true }, isFetchingMore: { ...state.isFetchingMore, [id]: false } }));
      
      // 1. Load from local vault (including tombstones)
      const localMessages = await shadowVault.getMessagesByConversation(id);
      const localMap = new Map(localMessages.map(m => [m.id, m]));

      // 2. Fetch from server
      const res = await api<{ items: Message[] }>(`/api/messages/${id}`);
      const fetchedMessages = res.items || [];
      const processedMessages: Message[] = [];
      
      for (const message of fetchedMessages) {
        if (localMap.has(message.id)) {
            // ZK-Safe Merge: Keep local decrypted content and hydrated sender (avatar/name),
            // but update dynamic metadata from the fresh server fetch.
            const localMsg = localMap.get(message.id)!;
            processedMessages.push({
                ...localMsg,
                statuses: message.statuses,
                reactions: message.reactions,
                isEdited: message.isEdited,
                // Ensure repliedToId is present from server if local vault missed it
                repliedToId: message.repliedToId || localMsg.repliedToId,
                // If local message lost the decrypted repliedTo, but server has it, we should ideally decrypt it. 
                // For safety in ZK merge, we preserve the local one if it's valid.
                repliedTo: localMsg.repliedTo
            });
        } else {
            // Not in vault, decrypt it
            processedMessages.push(await decryptMessageObject(message, undefined, 0, { skipRetries: true }));
        }
      }

      set(state => {
        const existingMessages = state.messages[id] || [];
        const allMessages = processMessagesAndReactions(processedMessages, existingMessages);
        const enrichedMessages = enrichMessagesWithSenderProfile(id, allMessages);
        
        // Update vault with everything we just processed (if not already there)
        shadowVault.upsertMessages(enrichedMessages); 

        // [UI UPDATE] Keep tombstones in the UI state so we can render "Message Deleted" bubbles
        // const visibleMessages = allMessages.filter(m => !m.isDeletedLocal);

        return {
          messages: { ...state.messages, [id]: enrichedMessages },
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
      const fetchedItems = res.items || [];
      
      // Load local cache to skip decryption
      const localMessages = await shadowVault.getMessagesByConversation(conversationId);
      const localMap = new Map(localMessages.map(m => [m.id, m]));

      const processedItems: Message[] = [];
      for (const m of fetchedItems) {
          if (localMap.has(m.id)) {
              const localMsg = localMap.get(m.id)!;
              processedItems.push({
                  ...localMsg,
                  statuses: m.statuses,
                  reactions: m.reactions,
                  isEdited: m.isEdited,
                  // Ensure repliedToId is present from server if local vault missed it
                  repliedToId: m.repliedToId || localMsg.repliedToId,
                  // If local message lost the decrypted repliedTo, but server has it, we should ideally decrypt it. 
                  // For safety in ZK merge, we preserve the local one if it's valid.
                  repliedTo: localMsg.repliedTo
              });
          } else {
              processedItems.push(await decryptMessageObject(m, undefined, 0, { skipRetries: true }));
          }
      }
      
      set(state => {
        const existingMessages = state.messages[conversationId] || [];
        const allMessages = processMessagesAndReactions(processedItems, existingMessages);
        const enrichedMessages = enrichMessagesWithSenderProfile(conversationId, allMessages);

        shadowVault.upsertMessages(enrichedMessages); // Archive to shadow vault

        // [UI UPDATE] Keep tombstones visible
        // const visibleMessages = allMessages.filter(m => !m.isDeletedLocal);

        const newState: Partial<State> = { messages: { ...state.messages, [conversationId]: enrichedMessages } };

        if (fetchedItems.length < 50) {
            newState.hasMore = { ...state.hasMore, [conversationId]: false };
        }
        
        return newState;
      });
    } catch (error) {
      console.error("Failed to load previous messages", error);
    } finally {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: false } }));
    }
  },

  loadMessageContext: async (messageId: string) => {
    const state = get();
    try {
      // Show loading state if we want to handle it globally, but for now we just fetch
      const res = await api<{ items: Message[], conversationId: string }>(`/api/messages/context/${messageId}`);
      const fetchedMessages = res.items || [];
      const convoId = res.conversationId;

      if (!convoId) return;

      // Load local cache
      const localMessages = await shadowVault.getMessagesByConversation(convoId);
      const localMap = new Map(localMessages.map(m => [m.id, m]));

      const processedMessages: Message[] = [];
      for (const message of fetchedMessages) {
          if (localMap.has(message.id)) {
              const localMsg = localMap.get(message.id)!;
              processedMessages.push({
                  ...localMsg,
                  statuses: message.statuses,
                  reactions: message.reactions,
                  isEdited: message.isEdited,
                  // Ensure repliedToId is present from server if local vault missed it
                  repliedToId: message.repliedToId || localMsg.repliedToId,
                  // If local message lost the decrypted repliedTo, but server has it, we should ideally decrypt it. 
                  // For safety in ZK merge, we preserve the local one if it's valid.
                  repliedTo: localMsg.repliedTo
              });
          } else {
              processedMessages.push(await decryptMessageObject(message, undefined, 0, { skipRetries: true }));
          }
      }

      set(state => {
        const existingMessages = state.messages[convoId] || [];
        // Merge logic: Combine, remove duplicates by ID, then sort
        const combined = [...existingMessages, ...processedMessages];
        const uniqueMessages = Array.from(new Map(combined.map(m => [m.id, m])).values());
        
        // Separate reactions and normal messages
        const finalMessages = processMessagesAndReactions(uniqueMessages, []);
        const enrichedMessages = enrichMessagesWithSenderProfile(convoId, finalMessages);

        shadowVault.upsertMessages(enrichedMessages);

        // [UI UPDATE] Keep tombstones visible
        // const visibleMessages = finalMessages.filter(m => !m.isDeletedLocal);

        return {
          messages: { ...state.messages, [convoId]: enrichedMessages },
          // If we jump back, we might still have older messages to fetch later
          hasMore: { ...state.hasMore, [convoId]: true } 
        };
      });
    } catch (error) {
      console.error(`Failed to load context for message ${messageId}`, error);
    }
  },

  addOptimisticMessage: (conversationId, message) => {
    shadowVault.upsertMessages([message]); // Archive to shadow vault
    set(state => {
      const currentMessages = state.messages[conversationId] || [];
      if (currentMessages.some(m => m.id === message.id || (m.tempId && message.tempId && m.tempId === message.tempId))) {
        return state;
      }
      return { messages: { ...state.messages, [conversationId]: [...currentMessages, message] } };
    })
  },
  
  addIncomingMessage: async (conversationId, message) => {
      // MUTEX LOCK to prevent concurrent processing of messages in the same conversation
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
      let decrypted = message;

      if (currentUser && message.senderId === currentUser.id && message.tempId) {
          const optimistic = get().messages[conversationId]?.find(m => m.tempId && String(m.tempId) === String(message.tempId));
          if (optimistic) {
              decrypted = {
                  ...message,
                  content: optimistic.content,
                  fileUrl: optimistic.fileUrl,
                  /* fileKey removed */
                  fileName: optimistic.fileName,
                  fileSize: optimistic.fileSize,
                  fileType: optimistic.fileType,
                  isBlindAttachment: optimistic.isBlindAttachment,
                  repliedTo: optimistic.repliedTo,
                  isSilent: optimistic.isSilent,
                  id: message.id,
                  createdAt: message.createdAt,
                  statuses: message.statuses
              };
          } else {
              decrypted = await decryptMessageObject(message);
          }
      } else {
          decrypted = await decryptMessageObject(message);
      }

      // [FIX] BUG 1: Ratchet Sync Delay (Race Condition)
      // If decryption failed with 'waiting_for_key' or 'Key out of sync'
      // it might be because the state (X3DH or DR) hasn't finished saving to DB yet.
      // We retry once for BOTH Group and 1-on-1.
      if (decrypted.content === 'waiting_for_key' || decrypted.error) {
          console.log(`[Ratchet] Decryption failed for ${message.id}. Retrying once in 500ms...`);
          await new Promise(r => setTimeout(r, 500));
          decrypted = await decryptMessageObject(message);
      }

      // INTERCEPT STORY KEYS
      if ((decrypted as Record<string, unknown>).type === 'STORY_KEY' || (decrypted.content && decrypted.content.startsWith('STORY_KEY:'))) {
          try {
              // Expecting content format: "STORY_KEY:{storyId}:{base64Key}" or parsing from JSON
              const payloadStr = decrypted.content ? decrypted.content.replace('STORY_KEY:', '') : '';
              const payload = JSON.parse(payloadStr);
              
              if (payload.storyId && payload.key) {
                  await saveStoryKey(payload.storyId, payload.key);
                  console.log(`[Stories] Received and securely stored key for story ${payload.storyId}`);
              }
          } catch (e) {
              console.error('[Stories] Failed to parse incoming story key message', e);
          }
          // Return silently, do not add this message to the chat UI
          return null; 
      }

      // THE SHIELD: Prevent overwriting valid local data with decryption failures
      if (decrypted.error || decrypted.content === 'waiting_for_key' || decrypted.content?.startsWith('[')) {
          const existing = await shadowVault.getMessage(decrypted.id);
          if (existing && !existing.isDeletedLocal && existing.content && !existing.content.startsWith('[')) {
              console.warn(`[Shield] Prevented overwriting valid local message ${decrypted.id} with failure.`);
              return existing;
          }
          
          const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
          const isGroup = conversation?.isGroup || false;

          if (isGroup) {
              // Group: Request missing Group Chain Key directly from sender
              emitSessionKeyRequest(conversationId, decrypted.senderId, decrypted.senderId);
          } else {
              // 1-on-1: SIGNAL-STYLE AUTO HEAL (Silent Renegotiation)
              // If state is broken/missing (e.g., first message was swept), automatically resync.
              const now = Date.now();
              const repairKey = `last_repair_${conversationId}` as keyof Window;
              const lastRepair = (window[repairKey] as number) || 0;
              
              // 15-second cooldown to prevent spamming renegotiation requests
              if (now - lastRepair > 15000) {
                  (window as unknown as Record<string, number>)[repairKey] = now;
                  console.warn(`[Auto-Heal] Ratchet out of sync for ${conversationId}. Initiating silent repair...`);
                  get().repairSecureSession(conversationId, false, true); // isAuto = true
              }
          }
      }
      
      const reactionPayload = parseReaction(decrypted.content);
      const editPayload = parseEdit(decrypted.content);
      const silentPayload = parseSilent(decrypted.content);

      if (silentPayload) {
          decrypted.isSilent = true; // [FIX] Set early to suppress sound in socket.ts

          if (silentPayload.type === 'STORY_KEY' && silentPayload.key && silentPayload.storyId) {
             saveStoryKey(silentPayload.storyId, silentPayload.key).catch(e => console.error("Failed to save story key live", e));
             // Don't add to message store? Or add as silent system message?
             // Usually we drop it from UI by marking isSilent or not adding it.
             // But existing logic handles isSilent.
             // If we want to hide it completely from chat list:
             return null; 
          }

          if (silentPayload.type === 'CALL_INIT' && silentPayload.key) {
             // [FIX] Cleanup optimistic UI if it was mistakenly added
             if (message.tempId) {
                 const tempIdStr = `temp_${message.tempId}`;
                 set(state => ({
                     messages: {
                         ...state.messages,
                         [conversationId]: (state.messages[conversationId] || []).filter(m => m.id !== tempIdStr)
                     }
                 }));
             }

             import('@store/callStore').then(m => {
                // ✅ CORRECT: Only store the key silently, let the socket event trigger the ringing UI
                m.useCallStore.getState().setCallKey(silentPayload.key!);
             });
             return decrypted; // Stop processing, don't add to UI
          }
          
          if (silentPayload.type === 'GHOST_SYNC') {
              console.log(`[Ghost Sync] Received sync from ${decrypted.senderId}. Settle ratchet state silently.`);
              return decrypted; // Stop processing, don't add to UI
          }

          decrypted.content = silentPayload.text || '';
      }
      
      if (reactionPayload) {
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
      } else if (editPayload) {
          set(state => {
              const currentMessages = state.messages[conversationId] || [];
              const updatedMessages = currentMessages.map(m => 
                  m.id === editPayload.targetMessageId ? { ...m, content: editPayload.text, isEdited: true } : m
              );
              // Also update vault
              const editedMsg = updatedMessages.find(m => m.id === editPayload.targetMessageId);
              if (editedMsg) {
                  shadowVault.upsertMessages([editedMsg]);
                  
                  // Update conversation last message if this was it
                  import('@store/conversation').then(m => {
                      const conv = m.useConversationStore.getState().conversations.find(c => c.id === conversationId);
                      if (conv?.lastMessage?.id === editPayload.targetMessageId) {
                          m.useConversationStore.getState().updateConversationLastMessage(conversationId, editedMsg);
                      }
                  }).catch(console.error);
              }
              
              return { messages: { ...state.messages, [conversationId]: updatedMessages } };
          });
      } else {
          // Enrich with sender profile before adding to state
          const [enriched] = enrichMessagesWithSenderProfile(conversationId, [decrypted]);
          const finalDecrypted = enriched;

          if (message.tempId && currentUser && message.senderId === currentUser.id) {
              get().replaceOptimisticMessage(conversationId, message.tempId, finalDecrypted);
          } else {
              set(state => {
                const currentMessages = state.messages[conversationId] || [];
                if (currentMessages.some(m => m.id === message.id)) return state;
                shadowVault.upsertMessages([finalDecrypted]); // Archive to shadow vault
                return { messages: { ...state.messages, [conversationId]: [...currentMessages, finalDecrypted] } };
              });
              
              // --- DYNAMIC ISLAND NOTIFICATION ---
              const isViewingChat = window.location.pathname.includes(`/chat/${finalDecrypted.conversationId}`);
              if (!isViewingChat && !finalDecrypted.isSilent && finalDecrypted.senderId !== currentUser?.id) {
                  import('@store/dynamicIsland').then(({ default: useDynamicIslandStore }) => {
                      const sender = finalDecrypted.sender as unknown as { encryptedProfile?: string };
                      const senderName = (sender as any)?.name || (sender as any)?.decryptedProfile?.name || 'Someone'; 
                      let snippet = finalDecrypted.content || 'New secure message';
                      if (finalDecrypted.fileUrl || finalDecrypted.isBlindAttachment) snippet = 'Sent an attachment 📎';
                      if (finalDecrypted.content && finalDecrypted.content.startsWith('🔒')) snippet = 'System message';

                      useDynamicIslandStore.getState().addActivity({
                          type: 'notification',
                          sender: sender || { name: senderName },
                          message: snippet,
                          link: `/chat/${finalDecrypted.conversationId}`
                      } as any, 4000);
                  }).catch(console.error);
              }

              // --- CHAT LIST PREVIEW UPDATE ---
              if (!finalDecrypted.isSilent) {
                  import('@store/conversation').then(m => {
                      m.useConversationStore.getState().updateConversationLastMessage(conversationId, finalDecrypted);
                  }).catch(console.error);
              }
          }
      }
      
      return decrypted;
  },

  replaceOptimisticMessage: async (conversationId, tempId, newMessage) => {
    // THE SHIELD: Check if the user already deleted this message while it was sending
    const tempIdStr = `temp_${tempId}`;
    const existingTombstone = await shadowVault.getMessage(tempIdStr);
    
    if (existingTombstone && existingTombstone.isDeletedLocal) {
        // Message was deleted optimistically. Just remove tempId from state and save a tombstone for realId.
        await shadowVault.deleteMessage(tempIdStr);
        await shadowVault.upsertMessages([{ ...newMessage, id: newMessage.id!, conversationId, isDeletedLocal: true, content: null, fileUrl: undefined } as Message]);
        
        set(state => ({
            messages: {
                ...state.messages,
                [conversationId]: (state.messages[conversationId] || []).filter(m => String(m.tempId) !== String(tempId))
            }
        }));
        return; 
    }

    set(state => {
      const updatedMessages = (state.messages[conversationId] || []).map(m => {
        if (m.tempId && String(m.tempId) === String(tempId)) {
          return {
            ...m,
            ...newMessage,
            content: m.content !== undefined ? m.content : newMessage.content,
            fileUrl: m.fileUrl || newMessage.fileUrl,
            fileName: m.fileName || newMessage.fileName,
            fileType: m.fileType || newMessage.fileType,
            fileSize: m.fileSize || newMessage.fileSize,
            isBlindAttachment: m.isBlindAttachment || newMessage.isBlindAttachment,
            repliedTo: m.repliedTo || newMessage.repliedTo,
            tempId: undefined,
            optimistic: false
          };
        }
        return m;
      });
      const msg = updatedMessages.find(m => m.id === newMessage.id);
      if (msg) shadowVault.upsertMessages([msg]); // Archive to shadow vault
      return {
        messages: { ...state.messages, [conversationId]: updatedMessages }
      };
    })
  },
  removeMessage: (conversationId, messageId) => {
    // 1. TOMBSTONE in local storage (Async cleanup)
    set(state => {
      const messages = state.messages[conversationId] || [];
      const messageToRemove = messages.find(m => m.id === messageId);
      
      if (messageToRemove) {
          if (messageToRemove.fileUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(messageToRemove.fileUrl);
          }
          // Soft delete: Keep record in IDB but strip content
          shadowVault.upsertMessages([{ ...messageToRemove, content: null, fileUrl: undefined, isDeletedLocal: true }]).catch(console.error);
      } else {
          shadowVault.upsertMessages([{ id: messageId, conversationId, isDeletedLocal: true, createdAt: new Date().toISOString(), senderId: 'unknown' } as Message]).catch(console.error);
      }

      import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(console.error);

      // [UI UPDATE] Replace with Tombstone instead of filtering out
      const updatedMessages = messages.map(m => {
          if (m.id === messageId) {
              return { ...m, content: null, fileUrl: undefined, isDeletedLocal: true, reactions: [] };
          }
          // Also remove reactions pointing to this message
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
        // [FIX] If message is view-once and has been viewed, delete its content but keep the metadata as a tombstone
        let messageForPreview = updatedMsg;
        if (updatedMsg.isViewOnce && updatedMsg.isViewed) {
            // Delete the cryptographic material
            import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(console.error);
            // Create a tombstone version for the vault so the UI still knows it existed
            const tombstone = { ...updatedMsg, content: null, fileUrl: undefined, isDeletedLocal: true };
            shadowVault.upsertMessages([tombstone]).catch(console.error);
            // Replace the in-memory message with the tombstone
            updatedMessages = updatedMessages.map(m => m.id === messageId ? tombstone : m);
            messageForPreview = tombstone;
        } else {
            shadowVault.upsertMessages([updatedMsg]); // Archive to shadow vault
        }

        // Update conversation last message if this was it
        import('@store/conversation').then(m => {
            const conv = m.useConversationStore.getState().conversations.find(c => c.id === conversationId);
            if (conv?.lastMessage?.id === messageId) {
                m.useConversationStore.getState().updateConversationLastMessage(conversationId, messageForPreview);
            }
        }).catch(console.error);
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
            newReactions.push(reaction);
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
      newMessages[convoId] = newMessages[convoId].map(m => m.sender?.id === user.id ? { ...m, sender: { ...(m.sender || { id: user.id }), ...user } } : m) as Message[];
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

  clearMessagesForConversation: (conversationId) => {
    // 1. DELETE FROM LOCAL STORAGE
    shadowVault.deleteConversationMessages(conversationId).catch(console.error);
    import('@utils/crypto').then(m => m.deleteConversationKeychain(conversationId)).catch(console.error);

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

  addSystemMessage: (conversationId, content) => {
    const systemMessage: Message = {
      id: `system_${Date.now()}`, type: 'SYSTEM', conversationId, content, createdAt: new Date().toISOString(), senderId: 'system' };
    set(state => ({ messages: { ...state.messages, [conversationId]: [...(state.messages[conversationId] || []), systemMessage] } }));
  },

  reDecryptPendingMessages: async (conversationId: string) => {
    await new Promise(r => setTimeout(r, 1000));

    const state = get();
    const conversationMessages = state.messages[conversationId];
    if (!conversationMessages) return;

    const pendingMessages = conversationMessages.filter(
      m => m.content === 'waiting_for_key' || m.content === '[Requesting key to decrypt...]'
    );

    if (pendingMessages.length === 0) {
      return;
    }

    const reDecryptedMessages = await Promise.all(
      pendingMessages.map(async (msg) => {
          const decrypted = await decryptMessageObject(msg);
          // Enrich each recovered message
          const [enriched] = enrichMessagesWithSenderProfile(conversationId, [decrypted]);
          return enriched;
      })
    );

    const messageMap = new Map(conversationMessages.map(m => [m.id, m]));
    reDecryptedMessages.forEach(m => {
        if (m.content !== 'waiting_for_key' && m.content !== '[Requesting key to decrypt...]') {
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
