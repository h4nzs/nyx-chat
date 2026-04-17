// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import type { UserId, ConversationId, MessageId, MessageSendPayload } from '@nyx/shared';
import { asUserId, asConversationId, asMessageId } from '@nyx/shared';
import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api"; 
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
import { useAuthStore } from "./auth";
import type { RawServerMessage } from "./conversation";
import type { User, Message } from '@nyx/shared';
import useDynamicIslandStore, { UploadActivity } from './dynamicIsland';
import { useConversationStore } from "./conversation";
import { addToQueue, getQueueItems, removeFromQueue, updateQueueAttempt } from "@lib/offlineQueueDb";
import { useConnectionStore } from "./connection";
import { getSodium } from "@lib/sodiumInitializer";
import { shadowVault, saveStoryKey } from "../lib/shadowVaultDb";

import { useProfileStore } from './profile';
import i18n from '../i18n';

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

  // ✅ FIX: Parse tempId agar selalu menjadi number | undefined
  let parsedTempId: number | undefined = undefined;
  if (typeof rawMsg.tempId === 'number' && Number.isSafeInteger(rawMsg.tempId)) {
      parsedTempId = rawMsg.tempId;
  } else if (typeof rawMsg.tempId === 'string' && /^\d+$/.test(rawMsg.tempId)) {
      const num = Number(rawMsg.tempId);
      if (Number.isSafeInteger(num)) parsedTempId = num;
  }

  // ✅ FIX: Konversi string mentah menjadi Branded Types
  let finalMessage: Message = {
    id: asMessageId(rawMsg.id),
    tempId: parsedTempId,
    type: rawMsg.type,
    conversationId: asConversationId(rawMsg.conversationId),
    senderId: asUserId(rawMsg.senderId),
    sender: rawMsg.sender ? {
        ...rawMsg.sender,
        id: asUserId(rawMsg.sender.id) // Lindungi ID di dalam objek sender
    } : undefined,
    createdAt: rawMsg.createdAt,
    content: rawMsg.content,
    repliedToId: rawMsg.repliedToId ? asMessageId(rawMsg.repliedToId) : undefined,
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
            
            let cipherTextToUse: string | null | undefined = ('ciphertext' in rawMsg ? rawMsg.ciphertext : rawMsg.content) as string | null | undefined;
            
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
        // JIKA TIDAK ADA MK, JANGAN RETURN DI SINI! 
        // Biarkan jatuh ke bawah (Fall-through) agar logika Dekripsi Receiver (Fan-Out) 
        // bisa mencoba mendekripsi pesan kita sendiri dari perangkat lain.
    }

    let contentToDecrypt: string | undefined = ('ciphertext' in rawMsg ? rawMsg.ciphertext : undefined) as string | undefined;

    if (!contentToDecrypt) {
        contentToDecrypt = (('fileKey' in rawMsg ? rawMsg.fileKey : undefined) || rawMsg.content) as string | undefined;
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
               const { getSignedPreKeyPair, getPqEncryptionKeyPair, getPqSignedPreKeyPair } = useAuthStore.getState();
               const mySignedPreKeyPair = await getSignedPreKeyPair();
               const myPqIdentityKeyPair = await getPqEncryptionKeyPair();
               const myPqSignedPreKeyPair = await getPqSignedPreKeyPair();

               const sessionKey = await deriveSessionKeyAsRecipient(
                   myIdentityKeyPair,
                   mySignedPreKeyPair,
                   myPqIdentityKeyPair,
                   myPqSignedPreKeyPair,
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
                   mySignedPreKey: mySignedPreKeyPair
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
    } else if (rawMsg.repliedToId) {
        const localRepliedMsg = await shadowVault.getMessage(rawMsg.repliedToId);
        if (localRepliedMsg) finalMessage.repliedTo = localRepliedMsg;
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

function parseSilent(content: string | null | undefined): { text?: string, type?: string, key?: string, storyId?: string, targetMessageId?: string, emoji?: string, url?: string } | null {
  if (!content) return null;
  try {
    let trimmed = content.trim();
    if (trimmed.startsWith('STORY_KEY:')) {
        trimmed = trimmed.replace('STORY_KEY:', '');
    }
    if (!trimmed.startsWith('{')) return null;
    const payload = JSON.parse(trimmed);
    
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
      return payload;
    }
    if (payload.type === 'HISTORY_SYNC' && payload.url && payload.key) {
      return payload;
    }
    // Tambahan untuk E2EE Unsend & Cabut Reaksi
    if (payload.type === 'UNSEND' || payload.type === 'reaction_remove') {
      return payload;
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
  broadcastHistorySync: (selfConversationId: string) => Promise<void>;
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

  broadcastHistorySync: async (selfConversationId) => {
    const { user } = useAuthStore.getState();
    if (!user) return;

    const toastId = toast.loading(i18n.t('common:preparing_history_sync_for_your_linked_d', 'Preparing history sync for your linked devices...'));
    try {
        const { exportDatabaseToJson } = await import('@lib/keychainDb');
        const jsonStr = await exportDatabaseToJson();
        const blob = new Blob([jsonStr], { type: 'application/json' });        
        // Enkripsi JSON dengan kunci simetris rahasia
        const { encryptFileViaWorker } = await import('@utils/crypto');
        const { encryptedBlob, key } = await encryptFileViaWorker(blob);
        
        const { api } = await import('@lib/api');
        const presignedRes = await api<{ uploadUrl: string, publicUrl: string, key: string }>('/api/uploads/presigned', {
            method: 'POST',
            body: JSON.stringify({
                fileName: `sync_${Date.now()}.enc`, 
                fileType: 'application/octet-stream', 
                folder: 'sync',
                fileSize: encryptedBlob.size 
            })
        });

        // Unggah ke Cloudflare R2
        await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', presignedRes.uploadUrl, true);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream'); 
            xhr.onload = () => { if (xhr.status === 200) resolve(); else reject(new Error('Upload failed')); };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(encryptedBlob);
        });

        const payload = {
            type: 'HISTORY_SYNC',
            url: presignedRes.publicUrl,
            key: key
        };
        
        // Kirim E2EE payload ini ke "Self-Chat" (Pesan Tersimpan)
        // Fan-Out Sender Key akan secara otomatis mendistribusikannya ke SEMUA perangkat Anda!
        await get().sendMessage(selfConversationId, {
            content: JSON.stringify(payload),
            isSilent: true
        });
        
        toast.success(i18n.t('common:history_sync_success', 'History securely synced to your linked devices!'), { id: toastId });
    } catch (e) {
        console.error(e);
        toast.error(i18n.t('common:history_sync_failure', 'Failed to sync history.'), { id: toastId });
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
      toast.error(i18n.t('errors:you_must_restore_your_keys_from_your_rec', 'You must restore your keys from your recovery phrase before you can send messages.'));
      return;
    }

    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (!conversation) {
      toast.error(i18n.t('errors:conversation_not_found', 'Conversation not found.'));
      return;
    }
    const forceRotate = conversation.requiresKeyRotation === true;

    // ✅ FASE 3: Selalu gunakan protokol Fan-Out Sender Key untuk SEMUA tipe percakapan (termasuk 1-on-1)
    if (useConnectionStore.getState().status === 'connected') {
      try {
        const distributionKeys = await ensureGroupSession(conversationId, conversation.participants, forceRotate);
        if (distributionKeys && distributionKeys.length > 0) {
          // ✅ FIX: Hapus any, gunakan tipe data ketat sesuai kembalian dari ensureGroupSession
          emitGroupKeyDistribution(
            conversationId, 
            distributionKeys as { userId: string; targetDeviceId: string; key: string; type: string }[]
          );
          if (forceRotate) {
              useConversationStore.getState().markKeyRotationNeeded(conversationId, false);
          }
          await new Promise(r => setTimeout(r, 300)); 
        }
      } catch (e) {
        console.error("Failed to ensure session", e);
        toast.error(i18n.t('errors:failed_to_establish_secure_session', 'Failed to establish secure session. Please try again.'));
        return; // ✅ FIX: Stop execution if session establishment fails
      }
    }

    const actualTempId = tempId !== undefined ? tempId : generateTempId();
    const isReactionPayload = !!parseReaction(data.content);
    const silentPayload = parseSilent(data.content);
    const isEditPayload = !!parseEdit(data.content);
    
    // [FIX] Detect CALL_INIT or GHOST_SYNC and force silence to prevent empty bubble
    const isCallInit = silentPayload?.type === 'CALL_INIT';
    const isGhostSync = silentPayload?.type === 'GHOST_SYNC';
    const isUnsend = silentPayload?.type === 'UNSEND';
    const isReactionRemove = silentPayload?.type === 'reaction_remove';
    const shouldBeSilent = isSilent || isCallInit || isGhostSync || isUnsend || isReactionRemove || isEditPayload || isReactionPayload;

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

        const result = await encryptMessage(contentToEncrypt, conversationId, true, undefined, `temp_${actualTempId}`);
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
            type ParticipantData = { id: string, userId?: string, user?: { devices?: {id: string, publicKey: string}[], publicKey?: string }, devices?: {id: string, publicKey: string}[], publicKey?: string };
            for (const p of conversation.participants as unknown as ParticipantData[]) {
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
                               const recipientPubBytes = sodium.from_base64(targetPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                               const sealed = await worker_crypto_box_seal(pushDataBytes, recipientPubBytes);
                               pushPayloads[device.id] = sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
                           } catch (e) {
                               console.error(`Failed to seal push for device ${device.id}`, e);
                           }
                       }
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
          sessionId: undefined,
          fileKey: undefined, fileName: undefined, fileType: undefined, fileSize: undefined,
          pushPayloads: Object.keys(pushPayloads).length > 0 ? pushPayloads : undefined
      };

      const socket = getSocket();
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
        isViewOnce: payload.isViewOnce ?? false
      };

      socket?.emit(
        "message:send",
        sendPayload, 
        async (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => {
          if (res.ok && res.msg) {
              
            // 1. Pindah Kunci Dekripsi Segera
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${actualTempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${actualTempId}`);
                }
            }).catch(console.error);

            // 2. Tangani Reaksi (Tanpa Gelembung Chat)
            if (isReactionPayload) {
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
                    const meta = JSON.parse(data.content);
                    if (meta.type === 'file' && meta.url) {
                        realFileUrl = meta.url;
                        realFileKey = meta.key;
                    }
                }
            } catch (e) {}

            let finalContent = existingMsg !== undefined ? existingMsg.content : res.msg!.content;
            
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
                             
                             const parsed = JSON.parse(res.msg!.content as string);
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
                 }).catch(console.error);
            }

            const updatedMsg = { 
                ...res.msg, 
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
            } as Partial<Message>;
            
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
                  toast.error(i18n.t('errors:failed_to_send_reaction', 'Failed to send reaction'));
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

      // PENGATURAN PAYLOAD DENGAN FALLBACK AMAN
      // queue item 'data' is basically the original payload mixed into a Message object
      const payloadData = data as Partial<Message> & { 
          sessionId?: string; 
          pushPayloads?: Record<string, string> 
      }; 
      const sendPayload: MessageSendPayload = {
          conversationId: asConversationId(conversationId),
          content: payloadData.content || "",
          tempId: tempId,
          sessionId: payloadData.sessionId ?? undefined,
          expiresAt: payloadData.expiresAt ?? undefined,
          pushPayloads: payloadData.pushPayloads ?? undefined,
          repliedToId: payloadData.repliedToId ?? undefined,
          isViewOnce: payloadData.isViewOnce ?? false
      };

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
          console.error(`[Queue] Timeout waiting for ACK for message ${tempId}`);
          updateQueueAttempt(tempId, attempt + 1).then(() => resolve());
        }, 5000);

        socket.emit("message:send", sendPayload, async (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => {
          clearTimeout(timeoutId);
          if (res.ok && res.msg) {
            await removeFromQueue(tempId);

            // 1. Pindah Kunci Dekripsi
            const msgId = res.msg.id;
            import('@utils/crypto').then(async ({ retrieveMessageKeySecurely, storeMessageKeySecurely, deleteMessageKeySecurely }) => {
                const mk = await retrieveMessageKeySecurely(`temp_${tempId}`);
                if (mk) {
                    await storeMessageKeySecurely(msgId, mk);
                    await deleteMessageKeySecurely(`temp_${tempId}`);
                }
            }).catch(console.error);

            // Tentukan status silent berdasarkan payload asli
            const silentPayload = parseSilent(payloadData.content);
            const isReactionPayload = !!parseReaction(payloadData.content);
            const isEditPayload = !!parseEdit(payloadData.content);
            
            const isCallInit = silentPayload?.type === 'CALL_INIT';
            const isGhostSync = silentPayload?.type === 'GHOST_SYNC';
            const isUnsend = silentPayload?.type === 'UNSEND';
            const isReactionRemove = silentPayload?.type === 'reaction_remove';
            
            const shouldBeSilent = payloadData.isSilent || isCallInit || isGhostSync || isUnsend || isReactionRemove || isEditPayload || isReactionPayload;

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
                    const meta = JSON.parse(payloadData.content);
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
                             
                             const parsed = JSON.parse(res.msg!.content as string);
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
                 }).catch(console.error);
            }

            const updatedMsg = { 
                ...res.msg, 
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
            } as Partial<Message>;
            
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
    if (sessionStorage.getItem('nyx_decoy_mode') === 'true') {
       set(state => ({
          messages: { ...state.messages, [id]: [{ id: 'msg-1', content: 'Welcome to NYX. No active chats found.', senderId: 'bot-1', createdAt: new Date().toISOString(), conversationId: id, type: 'SYSTEM' } as Message] },
          hasMore: { ...state.hasMore, [id]: false },
          hasLoadedHistory: { ...state.hasLoadedHistory, [id]: true }
       }));
       return;
    }

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

    // 2. SINKRONISASI BACKGROUND: Cek apakah ada surat tertunda di server
    try {
      set(state => ({ isFetchingMore: { ...state.isFetchingMore, [id]: true } }));

      const res = await api<{ items: Message[] }>(`/api/messages/${id}?limit=50`);
      const fetchedMessages = res.items || [];

      if (fetchedMessages.length > 0) {
        const processedMessages: Message[] = [];

        // 1. HANYA DEKRIPSI DI DALAM LOOP
        for (const message of fetchedMessages) {
          const decrypted = await decryptMessageObject(message, undefined, 0, { skipRetries: true });
          processedMessages.push(decrypted);
        }

        // 2. PROSES & GABUNGKAN DATA DI LUAR LOOP
        const existingMessages = get().messages[id] || [];
        const combined = [...existingMessages, ...processedMessages];
        const uniqueMessages = Array.from(new Map(combined.map(m => [m.id, m])).values());

        const allMessages = processMessagesAndReactions(uniqueMessages, []);
        const enrichedMessages = enrichMessagesWithSenderProfile(id, allMessages);

        // ✅ 3. AWAIT PENYIMPANAN LOKAL DULU (PENTING!)
        await shadowVault.upsertMessages(enrichedMessages);

        // ✅ 4. BARU TEMBAK KILL SWITCH SETELAH DATA AMAN
        const socket = getSocket();
        const { user } = useAuthStore.getState();
        if (socket?.connected && user) {
          for (const msg of processedMessages) {
            if (msg.senderId !== user.id) {
              socket.emit('message:mark_as_read', { messageId: msg.id, conversationId: id });
            }
          }
        }

        // 5. UPDATE UI
        set(state => {
          return {
            messages: { ...state.messages, [id]: enrichedMessages },
            hasMore: { ...state.hasMore, [id]: enrichedMessages.length >= 50 },
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
    const { isFetchingMore, hasMore, messages } = get();
    if (isFetchingMore[conversationId] || !hasMore[conversationId]) return;
    
    const currentMessages = messages[conversationId] || [];
    const oldestMessage = currentMessages[0];
    if (!oldestMessage) return;
    
    set(state => ({ isFetchingMore: { ...state.isFetchingMore, [conversationId]: true } }));
    
    try {
      // PAGINATION LOKAL: Server sudah tidak punya pesan lama kita (karena dihapus saat dibaca), 
      // jadi kita gulir ke atas murni mengambil dari Shadow Vault (IndexedDB).
      const localMessages = await shadowVault.getMessagesByConversation(conversationId, 50, oldestMessage.createdAt);
      
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
            // Jika IndexedDB mengembalikan kurang dari 50, berarti sudah sampai ujung (habis)
            hasMore: { ...state.hasMore, [conversationId]: localMessages.length === 50 } 
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

      // 1. ALWAYS decrypt to ensure cryptographic integrity
      let decrypted = await decryptMessageObject(message);

      if (currentUser && message.senderId === currentUser.id && message.tempId) {
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
          console.log(`[Ratchet] Decryption failed for ${message.id}. Retrying once in 500ms...`);
          await new Promise(r => setTimeout(r, 500));
          decrypted = await decryptMessageObject(message);
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

      if ((decrypted as Record<string, unknown>).type === 'STORY_KEY' || (decrypted.content && decrypted.content.startsWith('STORY_KEY:'))) {
          try {
              const payloadStr = decrypted.content ? decrypted.content.replace('STORY_KEY:', '') : '';
              const payload = JSON.parse(payloadStr);
              
              if (payload.storyId && payload.key) {
                  await saveStoryKey(payload.storyId, payload.key);
                  console.log(`[Stories] Received and securely stored key for story ${payload.storyId}`);
              }
          } catch (e) {
              console.error('[Stories] Failed to parse incoming story key message', e);
          }
          return null; 
      }

      if (decrypted.error || decrypted.content === 'waiting_for_key' || decrypted.content?.startsWith('[')) {
          const existing = await shadowVault.getMessage(decrypted.id);
          if (existing && !existing.isDeletedLocal && existing.content && !existing.content.startsWith('[')) {
              console.warn(`[Shield] Prevented overwriting valid local message ${decrypted.id} with failure.`);
              return existing;
          }
          
          // ✅ FIX: Auto-Heal Terpadu untuk semua jenis Chat (Multi-Device)
          // Tidak perlu lagi mengecek isGroup, langsung minta GroupKeyRequest (Sender Key)
          const now = Date.now();
          const repairKey = `last_repair_${conversationId}` as keyof Window;
          const lastRepair = (window[repairKey] as number) || 0;
          
          if (now - lastRepair > 15000) { // Limit permintaan perbaikan agar tidak spam (15 detik)
              (window as unknown as Record<string, number>)[repairKey] = now;
              console.warn(`[Auto-Heal] Kunci tidak sinkron untuk percakapan ${conversationId}. Meminta kunci ulang secara diam-diam...`);
              
              // Minta pengirim mem-broadcast ulang kunci distribusinya
              const { emitGroupKeyRequest } = await import('@lib/socket');
              emitGroupKeyRequest(conversationId);
          }
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
              console.log(`[Ghost Sync] Received sync from ${decrypted.senderId}. Settle ratchet state silently.`);
              return decrypted; 
          }

          if (silentPayload.type === 'HISTORY_SYNC' && silentPayload.url && silentPayload.key) {
              const currentUser = useAuthStore.getState().user;
              const { useConversationStore } = await import('@store/conversation');
              const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
              const isSelfChat = conversation?.participants.length === 1 && conversation.participants[0].id === currentUser?.id;

              if (!currentUser || decrypted.senderId !== currentUser.id || !isSelfChat) {
                  return decrypted;
              }

              cleanUpOptimisticBubble();
              console.log(`[History Sync] Received payload from ${decrypted.senderId}. Downloading...`);

              // Proses secara asinkron agar tidak membuat UI "freeze"
              setTimeout(async () => {
                  const toastId = toast.loading(i18n.t('common:receiving_history_sync_from_your_other_d', 'Receiving history sync from your other device...'));
                  try {
                      const { decryptFile } = await import('@utils/crypto');
                      const res = await fetch(silentPayload.url!);
                      const blob = await res.blob();
                      
                      const decryptedBlob = await decryptFile(blob, silentPayload.key!, 'application/json');
                      const jsonText = await decryptedBlob.text();
                      
                      // ✅ FIX: Gunakan importer Vault utama
                      const { importDatabaseFromJson } = await import('@lib/keychainDb');
                      await importDatabaseFromJson(jsonText);
                      
                      toast.success('History synchronized successfully! Reloading...', { id: toastId });
                      
                      // ✅ FIX: Cara paling bersih untuk merefresh Zustand Store dan UI
                      // setelah injeksi database massal adalah dengan hard reload.
                      setTimeout(() => {
                          window.location.reload();
                      }, 1500);

                  } catch (e) {
                      console.error('[History Sync] Failed to process history payload:', e);
                      toast.error('Failed to sync history payload.', { id: toastId });
                  }
              }, 1000);
              
              return null; 
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
                          shadowVault.upsertMessages([updatedMsg]).catch(console.error);
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
              }).catch(console.error);
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
                  }).catch(console.error);
              }
              
              return { messages: { ...state.messages, [conversationId]: updatedMessages } };
          });
      } else {
          // ==========================================
          // PESAN NORMAL (BUKAN SILENT, REAKSI, EDIT)
          // ==========================================
          const [enriched] = enrichMessagesWithSenderProfile(conversationId, [decrypted]);
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
              const socket = getSocket();
              if (socket?.connected && currentUser && finalDecrypted.senderId !== currentUser.id && !finalDecrypted.isSilent) {
                  socket.emit('message:mark_as_read', {
                      messageId: finalDecrypted.id,
                      conversationId: conversationId
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
                      const sender = finalDecrypted.sender as unknown as { encryptedProfile?: string };
                      const senderName = (sender as unknown as { name?: string, decryptedProfile?: { name?: string } })?.name || (sender as unknown as { decryptedProfile?: { name?: string } })?.decryptedProfile?.name || 'Someone'; 
                      let snippet = finalDecrypted.content || 'New secure message';
                      if (finalDecrypted.fileUrl || finalDecrypted.isBlindAttachment) snippet = 'Sent an attachment 📎';
                      if (finalDecrypted.content && finalDecrypted.content.startsWith('🔒')) snippet = 'System message';

                      useDynamicIslandStore.getState().addActivity({
                          type: 'notification',
                          sender: sender || { name: senderName },
                          message: snippet,
                          link: `/chat/${finalDecrypted.conversationId}`
                      } as Parameters<ReturnType<typeof useDynamicIslandStore.getState>['addActivity']>[0], 4000);                  
                  }).catch(console.error);
              }

              // --- Logika Update Preview Chat List ---
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
        content: oldMsg?.content !== undefined ? oldMsg.content : newMessage.content,
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

      return {
        messages: { 
            ...state.messages, 
            [conversationId]: [...filteredMessages, finalMessage].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
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
          shadowVault.upsertMessages([{ ...messageToRemove, content: null, fileUrl: undefined, isDeletedLocal: true }]).catch(console.error);
      } else {
          shadowVault.upsertMessages([{ id: messageId, conversationId, isDeletedLocal: true, createdAt: new Date().toISOString(), senderId: 'unknown' } as Message]).catch(console.error);
      }

      import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(console.error);

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
            import('@utils/crypto').then(m => m.deleteMessageKeySecurely(messageId)).catch(console.error);
            const tombstone = { ...updatedMsg, content: null, fileUrl: undefined, isDeletedLocal: true };
            shadowVault.upsertMessages([tombstone]).catch(console.error);
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
            newMessages[convoId] = newMessages[convoId].map(m => m.sender?.id === user.id ? { ...m, sender: { ...(m.sender || { id: user.id }), ...user } } : m) as Message[];
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
            id: asMessageId(`system_${Date.now()}`), type: 'SYSTEM', conversationId: asConversationId(conversationId), content, createdAt: new Date().toISOString(), senderId: asUserId('system') };
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