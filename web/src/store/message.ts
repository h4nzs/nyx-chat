// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { api, apiUpload, authFetch } from "@lib/api"; // Added authFetch
import { getSocket, emitSessionKeyRequest, emitGroupKeyDistribution } from "@lib/socket";
import { 
  encryptMessage, 
  decryptMessage, 
  ensureAndRatchetSession, 
  encryptFile, 
  ensureGroupSession,
  retrieveLatestSessionKeySecurely, 
  establishSessionFromPreKeyBundle, 
  getMyEncryptionKeyPair, 
  storeSessionKeySecurely, 
  deriveSessionKeyAsRecipient,
  storeRatchetStateSecurely,
  retrieveRatchetStateSecurely,
  PreKeyBundle 
} from "@utils/crypto";
import toast from "react-hot-toast";
import { useAuthStore, type User } from "./auth";
import type { Message } from "./conversation";
import useDynamicIslandStore, { UploadActivity } from './dynamicIsland';
import { useConversationStore } from "./conversation";
import { addToQueue, getQueueItems, removeFromQueue, updateQueueAttempt } from "@lib/offlineQueueDb";
import { useConnectionStore } from "./connection";
import { getSodium } from "@lib/sodiumInitializer";
import { shadowVault } from '@lib/shadowVaultDb';

/**
 * Logika Dekripsi Terpusat (Single Source of Truth)
 * Menangani dekripsi teks biasa DAN kunci file.
 */
export async function decryptMessageObject(message: Message, seenIds = new Set<string>(), depth = 0, options: { skipRetries?: boolean } = {}): Promise<Message> {
  // 1. Clone pesan dan tambahkan recursion guard
  const decryptedMsg = { ...message };
  const currentUser = useAuthStore.getState().user;
  
  if (seenIds.has(decryptedMsg.id) || depth > 10) {
    decryptedMsg.repliedTo = undefined; // Putus rantai rekursif
    return decryptedMsg;
  }
  seenIds.add(decryptedMsg.id);

  const conversation = useConversationStore.getState().conversations.find(c => c.id === decryptedMsg.conversationId);
  const isGroup = conversation?.isGroup || false;

  try {
    // [FIX #1] SELF-MESSAGE DECRYPTION (Pesan Sendiri)
    // Jika ini pesan saya sendiri
    if (currentUser && decryptedMsg.senderId === currentUser.id) {
        // Coba ambil Message Key dari brankas lokal (MK Vault) - Works for BOTH Group & 1-on-1 now!
        const { retrieveMessageKeySecurely } = await import('@utils/crypto');
        const mk = await retrieveMessageKeySecurely(decryptedMsg.id);
        
        if (mk) {
            // Kita punya kuncinya! Dekripsi langsung secara statis.
            const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await import('@lib/crypto-worker-proxy');
            const sodium = await getSodium();
            
            // [FIX] Matryoshka Parsing Loop: Peel all JSON layers (X3DH, DR) until raw ciphertext
            let cipherTextToUse = decryptedMsg.ciphertext || decryptedMsg.content;
            
            // Helper to unwrap
            const unwrap = (str: string): string => {
                 if (str && typeof str === 'string' && str.trim().startsWith('{')) {
                     try {
                         const p = JSON.parse(str);
                         if (p.ciphertext) return unwrap(p.ciphertext);
                     } catch {}
                 }
                 return str;
            }
            
            cipherTextToUse = unwrap(cipherTextToUse!);

            if (cipherTextToUse) {
                try {
                    const combined = sodium.from_base64(cipherTextToUse, sodium.base64_variants.URLSAFE_NO_PADDING);
                    const nonce = combined.slice(0, 24);
                    const encrypted = combined.slice(24);
                    const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                    let plainText = sodium.to_string(decryptedBytes);
                    
                    // --- STRIP PROFILE KEY DARI PESAN SENDIRI ---
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
                        } catch (e) {}
                    }
                    
                    decryptedMsg.content = plainText;
                    
                    if (decryptedMsg.content && decryptedMsg.content.startsWith('{') && decryptedMsg.content.includes('"type":"file"')) {
                        try {
                            const metadata = JSON.parse(decryptedMsg.content);
                            if (metadata.type === 'file') {
                                decryptedMsg.fileUrl = metadata.url;
                                decryptedMsg.fileKey = metadata.key;
                                decryptedMsg.fileName = metadata.name;
                                decryptedMsg.fileSize = metadata.size;
                                decryptedMsg.fileType = metadata.mimeType;
                                decryptedMsg.content = null;
                                decryptedMsg.isBlindAttachment = true;
                            }
                        } catch {}
                    }
                    if (decryptedMsg.repliedTo) {
                        decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo, seenIds, depth + 1, options);
                    }
                    return decryptedMsg;
                } catch (e) {
                    console.error("Self-decrypt failed with stored key:", e);
                }
            }
        }
        
        // Fallback jika MK tidak ada (misal clear cache tapi DB pesan masih ada)
        // Kita tidak bisa mendekripsi pesan sendiri tanpa MK lokal.
        if (decryptedMsg.content && decryptedMsg.content.trim().startsWith('{')) {
             decryptedMsg.content = "🔒 You sent this message (Encrypted)";
        }
        if (decryptedMsg.repliedTo) {
            decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo, seenIds, depth + 1, options);
        }
        return decryptedMsg;
    }

    // 2. Tentukan Payload yang Akan Didekripsi
    let contentToDecrypt = decryptedMsg.ciphertext;

    if (!contentToDecrypt) {
        contentToDecrypt = decryptedMsg.fileKey || decryptedMsg.content;
    }

    if (!contentToDecrypt || contentToDecrypt === 'waiting_for_key' || contentToDecrypt === '[Requesting key to decrypt...]') {
        return decryptedMsg;
    }

    // [FIX] PREVENT RE-DECRYPTION LOOP
    const isLikelyEncrypted = (str: string) => {
        const trimmed = str.trim();
        // 1. Check for JSON payload containing encryption markers
        if (trimmed.startsWith('{') && (trimmed.includes('"header"') || trimmed.includes('"ciphertext"') || trimmed.includes('"dr"'))) {
            return true;
        }
        // 2. Check for legacy/base64 encoded ciphertexts
        // A valid base64 string shouldn't contain spaces and typically matches this regex
        const base64Regex = /^[A-Za-z0-9+/_-]+={0,2}$/;
        if (base64Regex.test(trimmed) && trimmed.length > 20) { // arbitrary min length for a real ciphertext
            return true;
        }
        return false;
    };

    if (!isLikelyEncrypted(contentToDecrypt)) {
        return decryptedMsg;
    }

    // -------------------------------------------------------------------------
    // FLOW BARU: X3DH HEADER DETECTION (RECEIVING - 1on1 Only)
    // -------------------------------------------------------------------------
    if (!isGroup && contentToDecrypt.startsWith('{') && contentToDecrypt.includes('"x3dh":')) {
       try {
           const payload = JSON.parse(contentToDecrypt);
           const { retrieveMessageKeySecurely } = await import('@utils/crypto');
           const mk = await retrieveMessageKeySecurely(message.id);
           
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
               } catch (e) { console.error("Failed to parse inner DR header for init:", e); }

               if (!theirRatchetPublicKey) {
                   throw new Error("Cannot initialize Bob: Missing sender's ratchet key in first message.");
               }

               const { worker_dr_init_bob } = await import('@lib/crypto-worker-proxy');
               const newState = await worker_dr_init_bob({
                   sk: sessionKey,
                   mySignedPreKey: mySignedPreKeyPair,
                   theirRatchetPublicKey: theirRatchetPublicKey
               });

               await storeRatchetStateSecurely(message.conversationId, newState);
               contentToDecrypt = ciphertext; 
           }
       } catch (e) {
           console.error("[X3DH] Failed to parse/derive from header:", e);
       }
    }

    // 3. Simpan ciphertext asli
    decryptedMsg.ciphertext = contentToDecrypt;

    // 4. Eksekusi Dekripsi dengan Retry Loop
    let result;
    let attempts = 0;
    const MAX_ATTEMPTS = options.skipRetries ? 1 : 3;

    // [PHASE 3 FIX] Correct Session ID / Sender ID mapping
    const sessionOrSenderId = isGroup ? decryptedMsg.senderId : decryptedMsg.sessionId;

    while (attempts < MAX_ATTEMPTS) {
        result = await decryptMessage(
          contentToDecrypt!, 
          decryptedMsg.conversationId,
          isGroup,
          sessionOrSenderId, // Updated Argument
          decryptedMsg.id
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

    // 5. Proses Hasil
    if (result?.status === 'success') {
      let plainText = result.value;

      // --- EKSTRAKSI PROFILE KEY ---
      if (plainText && plainText.trim().startsWith('{')) {
          try {
              const parsed = JSON.parse(plainText);
              if (parsed.profileKey) {
                  const { saveProfileKey } = await import('@lib/keychainDb');
                  const { useProfileStore } = await import('@store/profile');
                  
                  await saveProfileKey(decryptedMsg.senderId, parsed.profileKey);
                  useProfileStore.getState().decryptAndCache(decryptedMsg.senderId, decryptedMsg.sender?.encryptedProfile || null);
                  
                  delete parsed.profileKey;
                  
                  if (parsed.text !== undefined && Object.keys(parsed).length === 1) {
                      plainText = parsed.text;
                  } else {
                      plainText = JSON.stringify(parsed);
                  }
              }
          } catch (e) {}
      }

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
            decryptedMsg.isBlindAttachment = true; 
          }
        } catch (e) { }
      }
      
    } else if (result?.status === 'pending') {
      decryptedMsg.content = result.reason || 'waiting_for_key';
    } else {
      console.warn(`[Decrypt] Failed for msg ${decryptedMsg.id}:`, result?.error);
      const errMsg = result?.error?.message || '';
      if (errMsg.includes('waiting for key') || errMsg.includes('Missing sender')) {
          decryptedMsg.content = 'waiting_for_key';
      } else {
          decryptedMsg.content = '[Decryption Failed: Key out of sync]';
          decryptedMsg.error = true;
      }
      decryptedMsg.type = 'SYSTEM';
    }

    // 6. Dekripsi Replied Message
    if (decryptedMsg.repliedTo) {
        decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo, seenIds, depth + 1, options);
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
    if (!trimmed.startsWith('{') || !trimmed.includes('"type":"reaction"')) return null;
    
    const payload = JSON.parse(trimmed);
    if (payload.type === 'reaction' && payload.targetMessageId && payload.emoji) {
      return payload;
    }
  } catch (e) {}
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
  } catch (e) {}
  return null;
}

function parseSilent(content: string | null | undefined): { text?: string, type?: string, key?: string } | null {
  if (!content) return null;
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return null;
    const payload = JSON.parse(trimmed);
    if (payload.type === 'silent') {
      return payload;
    }
    if (payload.type === 'CALL_INIT' && typeof payload.key === 'string') {
      return payload;
    }
  } catch (e) {}
  return null;
}

// Helper to separate messages and reactions
function processMessagesAndReactions(decryptedItems: Message[], existingMessages: Message[] = []) {
  const chatMessages: Message[] = [];
  const reactions: any[] = [];
  const edits: any[] = [];

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
          msg.content = silentPayload.text;
          msg.isSilent = true;
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
  typingLinkPreview: any | null;
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
  addIncomingMessage: (conversationId: string, message: Message) => Promise<Message>;
  replaceOptimisticMessage: (conversationId: string, tempId: number, newMessage: Partial<Message>) => Promise<void>;
  removeMessage: (conversationId: string, messageId: string) => void;
  removeMessages: (conversationId: string, messageIds: string[]) => Promise<void>;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
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
  sendMessage: (conversationId: string, data: Partial<Message>, tempId?: number, isSilent?: boolean) => Promise<void>;
  toggleMessageSelection: (id: string) => void;
  clearMessageSelection: () => void;
  repairSecureSession: (conversationId: string, isGroup: boolean) => Promise<void>;
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

  repairSecureSession: async (conversationId, isGroup) => {
    try {
      if (isGroup) {
        const { forceRotateGroupSenderKey, rotateGroupKey } = await import('@utils/crypto');
        await forceRotateGroupSenderKey(conversationId);
        await rotateGroupKey(conversationId, 'periodic_rotation');
      } else {
        const { deleteRatchetSession } = await import('@utils/crypto');
        await deleteRatchetSession(conversationId);
        // Send a silent system message to trigger the X3DH on the other side automatically,
        // and mark it as type 'SYSTEM' so it renders as a center placeholder.
        get().sendMessage(conversationId, { content: "🔄 Secure session restarted.", isSilent: true, type: 'SYSTEM' });
      }
      toast.success("Secure session state reset. Next message will negotiate new keys.");
    } catch (error) {
      console.error("Failed to repair session:", error);
      toast.error("Failed to repair session.");
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
            } catch (e) {}

            if (targetUrl && !targetUrl.startsWith('blob:')) {
                try {
                    const url = new URL(targetUrl);
                    const key = url.pathname.substring(1);
                    if (key) query = `?r2Key=${encodeURIComponent(key)}`;
                } catch (e) {
                    console.error("Failed to parse file URL for deletion:", e);
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

    const actualTempId = tempId !== undefined ? tempId : generateTempId();
    const isReactionPayload = !!parseReaction(data.content);
    const silentPayload = parseSilent(data.content);

    if (!isReactionPayload && !isSilent) {
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
            content: optimisticContent,
            isSilent: isOptimisticSilent || data.isSilent
        };

        if (optimisticContent) {
            optimisticMessage.preview = optimisticContent;
        }

        get().addOptimisticMessage(conversationId, optimisticMessage);
        
        let lastMsgPreview = optimisticContent;
        try {
           if (lastMsgPreview?.startsWith('{') && lastMsgPreview.includes('"type":"file"')) {
               lastMsgPreview = '📎 Sent a file';
           }
        } catch {}
        useConversationStore.getState().updateConversationLastMessage(conversationId, { ...optimisticMessage, content: lastMsgPreview, fileType: data.fileType, fileName: data.fileName });
        set({ replyingTo: null, typingLinkPreview: null });
    }

    try {
      let ciphertext = '';
      let x3dhHeader: any = null;

      if (!isGroup && data.content) {
          const state = await retrieveRatchetStateSecurely(conversationId);
          if (!state) {
             const peerId = conversation.participants.find(p => p.id !== user.id)?.id;
             if (peerId) {
                 const theirBundle = await authFetch<any>(`/api/keys/prekey-bundle/${peerId}`);
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
                let parsedObj: any = null;
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
      
      let pushPayloads: Record<string, string> = {};
      try {
        const { getSodium } = await import('@lib/sodiumInitializer');
        const sodium = await getSodium();
        
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

        // Prepare the basic push content
        let pushBody = "Sent a secure message";
        if (data.fileUrl) pushBody = "Sent a file";
        else if (data.content && !data.content.startsWith('{')) {
           pushBody = data.content.substring(0, 50) + (data.content.length > 50 ? '...' : '');
        }

        const pushData = JSON.stringify({ title: myName, body: pushBody, conversationId });

        // Encrypt for each recipient
        for (const p of conversation.participants as any[]) {
           const targetUserId = p.userId || p.id;
           const targetPublicKey = p.user?.publicKey || p.publicKey;
           
           if (targetUserId !== user.id && targetPublicKey) {
               try {
                   const recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                   const sealed = sodium.crypto_box_seal(pushData, recipientPubBytes);
                   pushPayloads[targetUserId] = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
               } catch (e) {
                   console.error(`Failed to seal push for ${targetUserId}`, e);
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
                        createdAt: res.msg.createdAt,
                        user: user,
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
        
        // Update vault with everything we just processed (if not already there)
        shadowVault.upsertMessages(allMessages); 

        // [UI UPDATE] Keep tombstones in the UI state so we can render "Message Deleted" bubbles
        // const visibleMessages = allMessages.filter(m => !m.isDeletedLocal);

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

        shadowVault.upsertMessages(allMessages); // Archive to shadow vault

        // [UI UPDATE] Keep tombstones visible
        // const visibleMessages = allMessages.filter(m => !m.isDeletedLocal);

        const newState: any = { messages: { ...state.messages, [conversationId]: allMessages } };

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

        shadowVault.upsertMessages(finalMessages);

        // [UI UPDATE] Keep tombstones visible
        // const visibleMessages = finalMessages.filter(m => !m.isDeletedLocal);

        return {
          messages: { ...state.messages, [convoId]: finalMessages },
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
      const currentUser = useAuthStore.getState().user;
      let decrypted = message;

      if (currentUser && message.senderId === currentUser.id && message.tempId) {
          const optimistic = get().messages[conversationId]?.find(m => m.tempId && String(m.tempId) === String(message.tempId));
          if (optimistic) {
              decrypted = {
                  ...message,
                  content: optimistic.content,
                  fileUrl: optimistic.fileUrl,
                  fileKey: optimistic.fileKey,
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

      // THE SHIELD: Prevent overwriting valid local data with decryption failures
      if (decrypted.error || decrypted.content === 'waiting_for_key' || decrypted.content?.startsWith('[')) {
          const existing = await shadowVault.getMessage(decrypted.id);
          if (existing && !existing.isDeletedLocal && existing.content && !existing.content.startsWith('[')) {
              console.warn(`[Shield] Prevented overwriting valid local message ${decrypted.id} with failure.`);
              return existing;
          }
      }
      
      const reactionPayload = parseReaction(decrypted.content);
      const editPayload = parseEdit(decrypted.content);
      const silentPayload = parseSilent(decrypted.content);

      if (silentPayload) {
          if (silentPayload.type === 'CALL_INIT' && silentPayload.key) {
             import('@store/callStore').then(m => {
                // ✅ CORRECT: Only store the key silently, let the socket event trigger the ringing UI
                m.useCallStore.getState().setCallKey(silentPayload.key!);
             });
             return decrypted; // Stop processing, don't add to UI
          }
          decrypted.content = silentPayload.text || '';
          decrypted.isSilent = true;
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
              if (editedMsg) shadowVault.upsertMessages([editedMsg]);
              
              return { messages: { ...state.messages, [conversationId]: updatedMessages } };
          });
      } else {
          if (message.tempId && currentUser && message.senderId === currentUser.id) {
              get().replaceOptimisticMessage(conversationId, message.tempId, decrypted);
          } else {
              set(state => {
                const currentMessages = state.messages[conversationId] || [];
                if (currentMessages.some(m => m.id === message.id)) return state;
                shadowVault.upsertMessages([decrypted]); // Archive to shadow vault
                return { messages: { ...state.messages, [conversationId]: [...currentMessages, decrypted] } };
              });
              
              // --- DYNAMIC ISLAND NOTIFICATION ---
              const isViewingChat = window.location.pathname.includes(`/chat/${decrypted.conversationId}`);
              if (!isViewingChat && !decrypted.isSilent && decrypted.senderId !== currentUser?.id) {
                  import('@store/dynamicIsland').then(({ default: useDynamicIslandStore }) => {
                      const sender = decrypted.sender as any;
                      const senderName = sender?.name || sender?.decryptedProfile?.name || 'Someone'; 
                      let snippet = decrypted.content || 'New secure message';
                      if (decrypted.fileUrl || decrypted.isBlindAttachment) snippet = 'Sent an attachment 📎';
                      if (decrypted.content && decrypted.content.startsWith('🔒')) snippet = 'System message';

                      useDynamicIslandStore.getState().addActivity({
                          type: 'notification',
                          sender: sender || { name: senderName },
                          message: snippet,
                          link: `/chat/${decrypted.conversationId}`
                      } as any, 4000);
                  }).catch(console.error);
              }

              // --- CHAT LIST PREVIEW UPDATE ---
              if (!decrypted.isSilent) {
                  import('@store/conversation').then(m => {
                      m.useConversationStore.getState().updateConversationLastMessage(conversationId, decrypted);
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
      const updatedMessages = (state.messages[conversationId] || []).map(m => m.id === messageId ? { ...m, ...updates } : m);
      const updatedMsg = updatedMessages.find(m => m.id === messageId);
      
      if (updatedMsg) {
        // [FIX] If message is view-once and has been viewed, delete it from vault
        if (updatedMsg.isViewOnce && updatedMsg.isViewed) {
            shadowVault.deleteMessage(messageId).catch(console.error);
            import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(console.error);
        } else {
            shadowVault.upsertMessages([updatedMsg]); // Archive to shadow vault
        }
      }
      return { messages: { ...state.messages, [conversationId]: updatedMessages } };
    })
  },
  
  addLocalReaction: (conversationId, messageId, reaction: any) => set(state => ({
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
    Object.entries(state.messages).forEach(([conversationId, messages]) => {
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
          return await decryptMessageObject(msg);
      })
    );

    const messageMap = new Map(conversationMessages.map(m => [m.id, m]));
    reDecryptedMessages.forEach(m => {
        if (m.content !== 'waiting_for_key' && m.content !== '[Requesting key to decrypt...]') {
             const payload = parseReaction(m.content);
             if (payload) {
                 get().addLocalReaction(conversationId, payload.targetMessageId, {
                     id: m.id,
                     messageId: payload.targetMessageId,
                     emoji: payload.emoji,
                     userId: m.senderId,
                     createdAt: m.createdAt,
                     user: m.sender,
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
