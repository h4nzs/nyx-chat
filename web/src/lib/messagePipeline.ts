// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// web/src/lib/messagePipeline.ts
//
// PIPELINE DEKRIPSI & EVALUASI CONTROL MESSAGE (diekstrak dari store/message.ts).
// Berisi decryptMessageObject (single source of truth dekripsi) dan
// evaluateControlMessage (penanganan pesan kontrol E2EE).
// Semua akses ke store lain dilakukan via import dinamis agar tidak ada
// circular dependency dengan store/message.
import { useAuthStore } from '@store/auth';
import { useConversationStore } from '@store/conversation';
import { asMessageId, asConversationId, asUserId } from '@nyx/shared';
import type { Message, RawServerMessage } from '@nyx/shared';
import { captureAndLog } from '@utils/feedback';
import { getSodium } from '@lib/sodiumInitializer';
import { shadowVault } from '@lib/shadowVaultDb';
import { isPlainObject, isFileMetadata, isStoryReplyPayload, isSystemMessagePayload } from '@utils/typeGuards';

// [UI AUDIT 2026-10-05] Identitas PROFIL harus userId kanonik: profileKey di
// keychain & profileCache keyed by REAL userId. Di grup v2 `parsed.senderId`
// pada payload terenkripsi = PSEUDONYM — dulu langsung dipakai menyimpan
// profileKey & decryptAndCache → getProfileKey(pseudonym) selalu kosong →
// nama/avatar pengirim grup v2 jatuh ke "Encrypted User"/Anonymous.
// senderId WIRE pesan TIDAK diubah (receipt server keyed pseudonym);
// hanya `sender.id` + penyimpanan kunci profil yang diarahkan ke real userId.
export async function resolveCanonicalProfileIdentity(conversationId: string, rawId: string): Promise<string> {
    try {
        const { resolvePseudonymToUserId } = await import('@lib/groupPseudonyms');
        const real = resolvePseudonymToUserId(conversationId, rawId);
        return real || rawId;
    } catch {
        return rawId;
    }
}
import {
  decryptMessage,
  getMyEncryptionKeyPair,
  deriveSessionKeyAsRecipient,
  storeRatchetStateSecurely,
  retrieveRatchetStateSecurely
} from '@utils/crypto';

// Helper story_reply repliedTo (dipindah dari store/message agar pipeline mandiri)
export function createRepliedToForStoryReply(
  conversationId: string,
  storyAuthorId: string,
  storyText: string | null | undefined,
  hasMedia: boolean | undefined
): Message {
  return {
    id: asMessageId('story_mock'),
    conversationId: asConversationId(conversationId),
    senderId: asUserId(storyAuthorId),
    sender: { id: asUserId(storyAuthorId) },
    content: storyText || (hasMedia ? '📷 Story' : 'Story'),
    createdAt: new Date().toISOString(),
    reactions: []
  } as Message;
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
): Promise<Message | null> {
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
    fileUrl: rawMsg.fileUrl,
    fileKey: rawMsg.fileKey,
    fileName: rawMsg.fileName,
    fileType: rawMsg.fileType,
    fileSize: rawMsg.fileSize,
    sessionId: rawMsg.sessionId,
    isBlindAttachment: rawMsg.isBlindAttachment,
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
    // 1. SELF-MESSAGE DECRYPTION (skip for group — uses sender key ratchet, not secretbox)
    if (currentUser && !isGroup && (rawMsg.senderId === currentUser.id || !rawMsg.senderId)) {
        const { retrieveMessageKeySecurely } = await import('@utils/crypto');
        let mk = await retrieveMessageKeySecurely(rawMsg.id);
        if (!mk && rawMsg.tempId) {
            mk = await retrieveMessageKeySecurely(`temp_${rawMsg.tempId}`);
        }

        // Self-message: decrypt with stored MK first, fallback to DR ratchet for own multi-device
        if (mk) {
            const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await import('@lib/crypto-worker-proxy');
            const sodium = await getSodium();
            
            const rawCipher: unknown = rawMsg.content;
            let cipherTextToUse: string | null | undefined = rawCipher === null ? null : rawCipher === undefined ? undefined : String(rawCipher);

            const unwrap = (str: string): string => {
                 if (str && typeof str === 'string' && str.trim().startsWith('{')) {
                     try {
                         const p = JSON.parse(str) as { ciphertext?: string };
                         if (p.ciphertext) return unwrap(String(p.ciphertext));
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
                    // [ECHO FIX 2026-10-05] Ciphertext DR = plaintext PADDED
                    // (marker 0x80 + zero-fill, lihat padBuffer worker).
                    // sodium.to_string (TextDecoder fatal) melempar pada byte
                    // 0x80 → SEMUA echo pesan sendiri gagal self-decrypt dan
                    // jatuh ke jalur DR (own-chain mismatch → [Decrypt]
                    // Failed; log 15:34). Pangkas padding sebelum decode.
                    const { trimPaddedPlaintext } = await import('@lib/drProtocol');
                    let plainText = sodium.to_string(trimPaddedPlaintext(decryptedBytes));
                    
                    if (plainText && plainText.trim().startsWith('{')) {
                        try {
                            const parsed = JSON.parse(plainText);
                            if (!isPlainObject(parsed)) return finalMessage;
                            if (parsed.senderId) {
                                finalMessage.senderId = asUserId(String(parsed.senderId));
                                if (!finalMessage.sender) finalMessage.sender = { id: asUserId(String(parsed.senderId)) };
                                else finalMessage.sender.id = asUserId(String(parsed.senderId));
                            }
                if (parsed.profileKey) {
                    const { saveProfileKey } = await import('@lib/keychainDb');
                    const profileKeyToSave = String(parsed.profileKey);
                    // [UI AUDIT 2026-10-05] Keyed REAL userId (dulu pseudonym di
                    // grup v2 → profileKey tak pernah ketemu saat dekripsi profil).
                    const canonicalId = await resolveCanonicalProfileIdentity(String(finalMessage.conversationId), String(finalMessage.senderId || ''));
                    await saveProfileKey(canonicalId, profileKeyToSave).catch(() => {});
                    delete parsed.profileKey;
                }
                            delete parsed.senderId;
                            delete parsed.senderDeviceKey;
                            const innerValue = parsed.content !== undefined ? String(parsed.content) : (parsed.text !== undefined ? String(parsed.text) : null);
                            if (innerValue !== null && Object.keys(parsed).length === 1) {
                                plainText = innerValue;
                                // Recursively strip profileKey from inner value
                                try {
                                    const innerParsed = JSON.parse(plainText);
                                    if (isPlainObject(innerParsed) && innerParsed.profileKey) {
                                        const { saveProfileKey } = await import('@lib/keychainDb');
                                        await saveProfileKey(finalMessage.senderId || '', String(innerParsed.profileKey)).catch(() => {});
                                        delete innerParsed.profileKey;
                                        if (innerParsed.text !== undefined && Object.keys(innerParsed).length === 1) {
                                            plainText = String(innerParsed.text);
                                        } else if (innerParsed.content !== undefined && Object.keys(innerParsed).length === 1) {
                                            plainText = String(innerParsed.content);
                                        } else {
                                            plainText = JSON.stringify(innerParsed);
                                        }
                                    }
                                } catch (_e) {}
                            } else {
                                plainText = JSON.stringify(parsed);
                            }
                        } catch (_e) {}
                    }
                    
                    finalMessage = { ...finalMessage, content: plainText };
                    
                    if (finalMessage.content && finalMessage.content.startsWith('{') && finalMessage.content.includes('"type":"file"')) {
                        try {
                            const parsed = JSON.parse(finalMessage.content);
                            if (isFileMetadata(parsed)) {
                                const metadata = parsed;
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
                            const parsed = JSON.parse(finalMessage.content);
                            if (isStoryReplyPayload(parsed)) {
                                const metadata = parsed;
                                finalMessage = {
                                    ...finalMessage,                content: metadata.text,
                repliedTo: createRepliedToForStoryReply(
                    rawMsg.conversationId,
                    metadata.storyAuthorId || '',
                    metadata.storyText,
                    metadata.hasMedia
                ),
                                };
                            }
                        } catch (_e) {}
                    }
                    if (rawMsg.repliedTo) {
                        const repl = await decryptMessageObject(rawMsg.repliedTo as RawServerMessage, seenIds, depth + 1, options);
                        if (repl) finalMessage.repliedTo = repl;
                    } else if (rawMsg.repliedToId) {
                        try {
                            const { shadowVault } = await import('@lib/shadowVaultDb');
                            const localRepliedMsg = await shadowVault.getMessage(rawMsg.repliedToId);
                            if (localRepliedMsg) finalMessage.repliedTo = localRepliedMsg;
                        } catch (e) {
                            console.error('[Vault] Failed to fetch replied message locally', e);
                        }
                    }
                    return finalMessage;
                } catch (e) {
                    console.error("Self-decrypt failed with stored key:", e);
                }
            }
        }
        // Self-message without stored MK: skip DR ratchet only for known senderId
        // (optimistic update handles it); sealed sender falls through to DR path
        if (rawMsg.senderId === currentUser.id) {
            return finalMessage;
        }
    }

    const rawContent: unknown = rawMsg.content;
    let contentToDecrypt: string | undefined = rawContent === undefined ? undefined : String(rawContent);

    if (!contentToDecrypt) {
        contentToDecrypt = (('fileKey' in rawMsg ? rawMsg.fileKey : undefined) || rawMsg.content) ?? undefined;
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

    // Skip X3DH re-processing if we already have a ratchet state
    // (prevents DR state corruption from sealed sender self-messages)
    if (!isGroup && contentToDecrypt.startsWith('{') && contentToDecrypt.includes('"x3dh":')) {
        const existingState = await retrieveRatchetStateSecurely(rawMsg.conversationId);
        if (!existingState) {
            try {
                const payload = JSON.parse(contentToDecrypt) as { ciphertext?: string, x3dh?: { initiatorSigningKey: string, initiatorCiphertexts: string, otpkId: number } };
                const { retrieveMessageKeySecurely } = await import('@utils/crypto');
                const mk = await retrieveMessageKeySecurely(rawMsg.id);
                
                if (mk) {
                    contentToDecrypt = payload.ciphertext;
                } else if (payload.x3dh && payload.ciphertext) {
                    const { initiatorSigningKey, initiatorCiphertexts, otpkId } = payload.x3dh;
                    const ciphertext = payload.ciphertext;

                    // [SECURITY] Fetch peer's PreKeyBundle to verify identity and update keychain
                    try {
                        const { fetchPreKeyBundle } = await import('@utils/crypto');
                        const myId = useAuthStore.getState().user?.id;
                        const conv = (await import('@store/conversation')).useConversationStore.getState().conversations.find(c => c.id === rawMsg.conversationId);
                        const peerId = conv?.participants.find(p => (('userId' in p ? p.userId : p.id) || p.id) !== myId)?.userId || rawMsg.senderId;

                        if (peerId) {
                            const bundle = await fetchPreKeyBundle(peerId);
                            const { getPeerIdentityKey, savePeerIdentityKey } = await import('@lib/keychainDb');
                            const existingKey = await getPeerIdentityKey(peerId);
                            if (existingKey && existingKey !== bundle.identityKey) {
                                const { t } = await import('i18next');
                                const { default: toast } = await import('react-hot-toast');
                                const useDynamicIslandStore = (await import('@store/dynamicIsland')).default;

                                const peerName = rawMsg.sender?.name || t('common:defaults.unknown_user');
                                const warningText = t('common:security_key_changed', { name: peerName });

                                (await import('@store/message')).useMessageStore.getState().addSystemMessage(rawMsg.conversationId, warningText);
                                toast.error(warningText, { icon: '🛡️', duration: 6000 });

                                useDynamicIslandStore.getState().addActivity({
                                    type: 'notification',
                                    sender: { name: 'NYX_SHIELD' },
                                    message: warningText,
                                    link: `/chat/${rawMsg.conversationId}`
                                }, 6000);
                            }
                            await savePeerIdentityKey(peerId, bundle.identityKey);
                        }
                    } catch (e) {
                        console.error("[X3DH] Failed to verify peer identity", e);
                    }

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
                        initiatorSigningKey,
                        initiatorCiphertexts,
                        otpkId
                    );
                    
                    const { worker_dr_init_bob } = await import('@lib/crypto-worker-proxy');
                    const newState = await worker_dr_init_bob({
                        sk: sessionKey,
                        myPqSignedPreKey: myPqSignedPreKeyPair
                    });

                    await storeRatchetStateSecurely(rawMsg.conversationId, newState);
                    contentToDecrypt = JSON.stringify(payload);
                }
            } catch (e) {
                console.error("[X3DH] Failed to parse/derive from header:", e);
                if (e instanceof Error && (e.message.includes("Account upgrade required") || e.message.includes("PQ keys missing"))) {
                    throw e;
                }
            }
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
        let plainText = String(result.value);

        const stripProfileKey = async (text: string): Promise<string> => {
            if (!text || !text.trim().startsWith('{')) return text;
            try {
                const parsed = JSON.parse(text);
            if (!isPlainObject(parsed)) return text;

                if (parsed.senderId) {
                    finalMessage.senderId = asUserId(String(parsed.senderId));
                    // [UI AUDIT 2026-10-05] sender.id = userId kanonik (bisa
                    // pseudonym di grup v2); senderId wire tetap.
                    const canonicalId = await resolveCanonicalProfileIdentity(String(finalMessage.conversationId), String(parsed.senderId));
                    if (!finalMessage.sender) finalMessage.sender = { id: asUserId(canonicalId) };
                    else finalMessage.sender.id = asUserId(canonicalId);
                }

                if (parsed.profileKey) {
                    const { saveProfileKey } = await import('@lib/keychainDb');
                    const { useProfileStore } = await import('@store/profile');
                    // [UI AUDIT 2026-10-05] Keyed REAL userId + dekripsi profil
                    // dengan id kanonik (dulu pseudonym → fallback "Encrypted User").
                    const canonicalId = await resolveCanonicalProfileIdentity(String(finalMessage.conversationId), String(finalMessage.senderId));
                    await saveProfileKey(canonicalId, String(parsed.profileKey));
                    const ep = typeof parsed.encryptedProfile === 'string' ? parsed.encryptedProfile : rawMsg.sender?.encryptedProfile || null;
                    useProfileStore.getState().decryptAndCache(canonicalId, ep);
                    if (ep && finalMessage.sender) {
                        finalMessage.sender.encryptedProfile = ep;
                        finalMessage.sender.id = asUserId(canonicalId);
                    }
                    delete parsed.profileKey;
                    delete parsed.encryptedProfile;
                }

                delete parsed.senderId;
                delete parsed.senderDeviceKey;

                if (parsed.text !== undefined && Object.keys(parsed).length === 1) return await stripProfileKey(String(parsed.text));
                if (parsed.content !== undefined && Object.keys(parsed).length === 1) return await stripProfileKey(String(parsed.content));

                if (parsed.content && typeof parsed.content === 'string') {
                    const inner = await stripProfileKey(parsed.content);
                    if (inner !== parsed.content) return inner;
                }
                if (parsed.text && typeof parsed.text === 'string') {
                    const inner = await stripProfileKey(parsed.text);
                    if (inner !== parsed.text) return inner;
                }

                return JSON.stringify(parsed);
            } catch { return text; }
        };

        plainText = await stripProfileKey(plainText);

        finalMessage = { ...finalMessage, content: plainText };

      if (plainText.startsWith('{') && plainText.includes('"type":"file"')) {
        try {
          const parsed = JSON.parse(plainText);
          if (isFileMetadata(parsed)) {
            const metadata = parsed;
            finalMessage = {
                ...finalMessage,
                fileUrl: metadata.url,
                fileKey: metadata.key,
                fileName: metadata.name,
                fileSize: metadata.size,
                fileType: metadata.mimeType,
                content: null,
                isBlindAttachment: metadata.type === 'file' ? (metadata as { isBlindAttachment?: boolean }).isBlindAttachment ?? finalMessage.isBlindAttachment : finalMessage.isBlindAttachment
            };
          }
        } catch (_e) { }
      }

      if (plainText.startsWith('{') && plainText.includes('"type":"story_reply"')) {
        try {
          const parsed = JSON.parse(plainText);
          if (isStoryReplyPayload(parsed)) {
            const metadata = parsed;
            finalMessage = {
                ...finalMessage,
                content: metadata.text,                    repliedTo: createRepliedToForStoryReply(
                        rawMsg.conversationId,
                        metadata.storyAuthorId || '',
                    metadata.storyText,
                    metadata.hasMedia
                ),
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
        } else if (errMsg.includes('Ratchet Advanced!') || errMsg.includes('ciphertext cannot be decrypted')) {
            if (rawMsg.type !== 'USER') {
                return null; // Drop system messages that fail decryption
            }
            // BUGFIX: echo pesan MILIK SENDIRI yang gagal self-decrypt (mis. MK belum
            // termigrasi / desync) jangan ditampilkan sebagai bubble "Pesan gagal
            // didekripsi" — tandai waiting_for_key (retryable). Shield di store akan
            // memakai salinan optimistik yang valid bila ada.
            if (currentUser && rawMsg.senderId === currentUser.id) {
                finalMessage.content = 'waiting_for_key';
            } else {
                finalMessage.content = '🔒 Pesan gagal didekripsi (Kunci kedaluwarsa)';
                finalMessage.error = true;
            }
        } else if (errMsg.includes('older than current state')) {
            if (rawMsg.type !== 'USER') {
                return null; // Drop system messages that are too old
            }
            finalMessage.content = '[Message too old to decrypt]';
            finalMessage.error = true;
        } else {
            if (rawMsg.type !== 'USER') {
                return null; // Drop system messages that fail decryption
            }
            finalMessage.content = '[Decryption Failed: Key out of sync]';
            finalMessage.error = true;
        }
      finalMessage.type = 'SYSTEM';
    }

    if (rawMsg.repliedTo) {
        const repl = await decryptMessageObject(rawMsg.repliedTo as RawServerMessage, seenIds, depth + 1, options);
        if (repl) finalMessage.repliedTo = repl;
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

// Helper for evaluating control messages
export const evaluateControlMessage = async (decrypted: Message, conversationId: string): Promise<boolean> => {
      if ((decrypted as Record<string, unknown>).type === 'STORY_KEY' || (decrypted.content && decrypted.content.startsWith('STORY_KEY:'))) {
          try {
              const payloadStr = decrypted.content ? decrypted.content.replace('STORY_KEY:', '') : '';
              const payload = JSON.parse(payloadStr) as { storyId?: string, key?: string };
              
              if (payload.storyId && payload.key) {
                  const { saveStoryKey } = await import('@lib/shadowVaultDb');
                  await saveStoryKey(payload.storyId, payload.key);
              }
          } catch (e) {
              console.error('[Stories] Failed to parse incoming story key message', e);
          }
          return true; 
      }

      if (decrypted.content && decrypted.content.startsWith('{')) {
          try {
              const parsed = JSON.parse(decrypted.content);
        if (!isSystemMessagePayload(parsed)) return true;
        const data = parsed;
              
              if (data.type === 'SYSTEM_KEY_REQUEST' && data.targetUserId) {
                  // [BUGFIX: PERSISTENT OFFLINE KEY REQUEST]
                  // Alice menerima pesan ini (yang sudah masuk database jika dia offline sebelumnya)
                  // dan secara diam-diam membagikan kembali kuncinya kepada peminta
                  const authStore = (await import('@store/auth')).useAuthStore.getState();
                  if (authStore.user?.id === data.targetUserId) {
                      const requestorId = decrypted.senderId || data.senderId;
                      if (!requestorId) return true;
                      
                      const rateLimitKey = `sys_key_req_reply_${conversationId}_${requestorId}` as keyof Window;
                      const lastReq = window[rateLimitKey] as number | undefined || 0;
                      if (Date.now() - lastReq < 10000) {
                              return true;
                      }
                      window[rateLimitKey] = Date.now() as never;

                      // [V2 — RENCANA #4] Satu jalur distribusi: reply key-request
                      // memanggil fulfillGroupKeyRequest (yang kini memakai jalur
                      // distribusi tunggal — envelope v2 dengan chainId +
                      // metadataKey). Salinan seal manual di sini DIHAPUS — dulu
                      // dua format berbeda, sumber desinkron state.
                      import('@utils/crypto').then(async ({ fulfillGroupKeyRequest }) => {
                           try {
                               await fulfillGroupKeyRequest({
                                   conversationId,
                                   requesterId: requestorId
                               });
                           } catch (err) {
                               console.error("[System Key Request] Error distributing key", err);
                           }
                      });
                  }
                  return true; // Cegah pesan ini masuk ke UI
              }
              
              if (data.type === 'PROTOCOL_RESET') {
                  console.warn(`[Protocol Reset] Received reset request for conversation ${conversationId}. Forcing key rotation...`);
                  const { useConversationStore } = await import('@store/conversation');
                  useConversationStore.getState().markKeyRotationNeeded(conversationId, true);
                  
                  // Clear local receiver state for this sender to ensure fresh keys are requested
                  const senderId = decrypted.senderId || data.senderId;
                  if (senderId) {
                      try {
                          const { db } = await import('@lib/db');
                          // [AUDIT FIX 2026-10-05] Index komposit [conversationId+senderId]
                          // TIDAK ADA di schema (hanya 'id') → Dexie SchemaError tiap
                          // PROTOCOL_RESET. Scan via id-prefix + filter senderId di
                          // state (id kini device-keyed — senderId ada DI DALAM state).
                          const { listGroupReceiverStates } = await import('@lib/keychainDb');
                          const staleStates = (await listGroupReceiverStates(conversationId))
                              .filter(s => s.senderId === senderId)
                              .map(s => s.id);
                          if (staleStates.length > 0) {
                              await db.groupReceiverStates.bulkDelete(staleStates);
                          }
                          await db.ratchetSessions.delete(conversationId);
                          
                          const { getSodiumLib, fetchPreKeyBundle, establishSessionFromPreKeyBundle } = await import('@utils/crypto');
                          const { getPeerIdentityKey } = await import('@lib/keychainDb');
                          const { useAuthStore } = await import('@store/auth');
                          const { t } = await import('i18next');
                          const { default: toast } = await import('react-hot-toast');
                          const useDynamicIslandStore = (await import('@store/dynamicIsland')).default;
                          const { useMessageStore } = await import('@store/message');
                          
                          const existingKey = await getPeerIdentityKey(senderId);
                          let retries = 6; // Max 6 attempts (9 seconds total)
                          
                          const pollForNewBundle = async () => {
                              try {
                                  const bundle = await fetchPreKeyBundle(senderId);
                                  
                                  if (existingKey && bundle.identityKey !== existingKey) {
                                      // The sender has finished uploading their new keys!
                                      const signingPrivateKey = await useAuthStore.getState().getSigningPrivateKey();
                                      if (!signingPrivateKey) throw new Error("Missing signing key");
                                      const mySigningKey = {
                                          publicKey: signingPrivateKey.slice(32),
                                          privateKey: signingPrivateKey
                                      };
                                      
                                      // Establish a new session proactively so we have their new identity key cached
                                      await establishSessionFromPreKeyBundle(mySigningKey, bundle, senderId);
                                      
                                      const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
                                      const peer = conv?.participants.find(p => (p.userId || p.user?.id || p.id) === senderId);
                                      const peerName = peer?.name || peer?.user?.name || t('common:defaults.unknown_user');
                                      const warningText = t('common:security_key_changed', { name: peerName });
                                      
                                      useMessageStore.getState().addSystemMessage(conversationId, warningText);
                                      toast.error(warningText, { icon: '🛡️', duration: 6000 });
                                      
                                      useDynamicIslandStore.getState().addActivity({
                                          type: 'notification',
                                          sender: { name: 'NYX_SHIELD' },
                                          message: warningText,
                                          link: `/chat/${conversationId}`
                                      }, 6000);
                                      
                                      // Proactively ask for their new group key if it's a group
                                      const { emitGroupKeyRequest } = await import('@lib/transportClient');
                                      emitGroupKeyRequest(conversationId);
                                  } else if (retries > 0) {
                                      retries--;
                                      setTimeout(pollForNewBundle, 1500); // Check again
                                  } else {
                                      console.warn("[Protocol Reset] Polling timed out waiting for the new PreKeyBundle.");
                                  }
                              } catch (err) {
                                  console.error("[Protocol Reset] Polling error:", err);
                              }
                          };
                          
                          // Wait 1 second before first poll to give sender time to upload
                          setTimeout(pollForNewBundle, 1000);
                          
                      } catch (e) {
                          console.error("Failed to perform real-time security check:", e);
                      }
                  }
                  return true;
              }

              if (data.type === 'GROUP_KEY_DISTRIBUTION' || data.type === 'GROUP_KEY') {
                  try {
                      const { getMyEncryptionKeyPair, getSodiumLib, storeReceivedSessionKey } = await import('@utils/crypto');
                      const sodium = await getSodiumLib();
                      const { publicKey } = await getMyEncryptionKeyPair();
                      const myIdentityKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

                      // Abaikan paket distribusi jika secara eksplisit ditujukan untuk perangkat lain
                      if (data.targetDeviceKey && data.targetDeviceKey !== myIdentityKeyB64) {
                              return true;
                      }

                      const authStore = (await import('@store/auth')).useAuthStore.getState();
                      const myId = authStore.user?.id;
                      
                      // Filter aman untuk distribusi batch dengan strict check
                      const myDistributions = data.distributions?.filter((d: { targetUserId?: string; userId: string; targetDeviceKey?: string; encryptedKey?: string; key?: string }) => 
                          (d.targetUserId === myId || d.userId === myId) &&
                          (!d.targetDeviceKey || d.targetDeviceKey === myIdentityKeyB64)
                      ) || [];

                      let success = false;
                      if (myDistributions.length > 0) {
                          for (const dist of myDistributions) {
                              const extractedKey = dist.encryptedKey || dist.key;
                              if (!extractedKey) continue;
                              try {
                                  await storeReceivedSessionKey({
                                      conversationId: data.conversationId || conversationId || "",
                                      encryptedKey: extractedKey,
                                      type: 'GROUP_KEY',
                                      senderId: decrypted.senderId || data.senderId || "",
                                      senderDeviceKey: dist.senderDeviceKey || data.senderDeviceKey,
                                      // [AUDIT FIX 2026-10-05] senderSigningKey WAJIB
                                      // diteruskan — tanpa ini receiver state tersimpan
                                      // tanpa signing key → decryptGroupMetadata v2
                                      // selamanya gagal "signing key pengirim belum
                                      // terikat" di jalur offline sync.
                                      senderSigningKey: (dist as { senderSigningKey?: string }).senderSigningKey || (data as { senderSigningKey?: string }).senderSigningKey
                                  });
                                  success = true;
                                  break;
                              } catch (e) {
                                  // Fail over gracefully
                              }
                          }
                      } else if (data.encryptedKey || data.key) {
                           await storeReceivedSessionKey({
                              conversationId: data.conversationId || conversationId || "",
                              encryptedKey: (data.encryptedKey || data.key || ""),
                              type: 'GROUP_KEY',
                              senderId: decrypted.senderId || data.senderId || "",
                              senderDeviceKey: data.senderDeviceKey,
                              // [AUDIT FIX 2026-10-05] Forward signing key pengirim
                              // (dipersist server di content GROUP_KEY SYSTEM).
                              senderSigningKey: (data as { senderSigningKey?: string }).senderSigningKey
                           });
                           success = true;
                      }

                      if (success) {
                                  (await import('@store/message')).useMessageStore.getState().reDecryptPendingMessages(data.conversationId || conversationId);
                      } else {
                          const requestorId = decrypted.senderId || data.senderId;
                          if (requestorId) {
                              const reqPayload = JSON.stringify({ type: 'SYSTEM_KEY_REQUEST', targetUserId: requestorId });
                                          (await import('@store/message')).useMessageStore.getState().sendMessage(conversationId, { content: reqPayload, type: 'SYSTEM' }, undefined, true);
                          }
                      }
                  } catch (e) {
                      console.error(`[Group Ratchet] Gagal memproses real-time group key`, e);
                  }
                  return true;
              }
          } catch (e) {
              console.error(`[Shield] Error processing protocol message for conversation ${conversationId}`, { error: e, content: decrypted.content });
          }
      }
      return false;
};
