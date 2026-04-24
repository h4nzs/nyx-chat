// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { z } from 'zod';
import io from "socket.io-client";
import type { Socket } from "socket.io-client";
import toast from "react-hot-toast";
import { useAuthStore } from "@store/auth";
import { useConversationStore, type Message } from "@store/conversation";
import { useMessageStore } from "@store/message";
import { useConnectionStore } from "@store/connection";
import { usePresenceStore } from "@store/presence";
import { fulfillKeyRequest, storeReceivedSessionKey, rotateGroupKey, fulfillGroupKeyRequest, schedulePeriodicGroupKeyRotation } from "@utils/crypto";
import { useKeychainStore } from "@store/keychain";
import { asUserId } from '@nyx/shared';
import { IncomingMessageSchema, RawServerMessageSchema } from '@nyx/shared';
import type { ServerToClientEvents, ClientToServerEvents } from "@nyx/shared";
import { triggerReceiveFeedback } from "@utils/feedback";
import i18n from '../i18n';

const WS_URL = import.meta.env.VITE_WS_URL || import.meta.env.VITE_API_URL;
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

// ✅ OPTIMASI: Mekanisme Batching untuk Mencegah "Socket Storm" (Offline Catch-up)
// Keranjang untuk menampung pesan masuk yang bertubi-tubi
const incomingMessageBuffer: Message[] = [];
let isProcessingBuffer = false;
let batchTimer: NodeJS.Timeout | null = null;

const processMessageBuffer = async () => {
    if (isProcessingBuffer || incomingMessageBuffer.length === 0) return;
    
    isProcessingBuffer = true;
    
    // Ambil isi keranjang dan kosongkan keranjangnya agar bisa menampung yang baru
    const messagesToProcess = [...incomingMessageBuffer];
    incomingMessageBuffer.length = 0;
    
    const { addIncomingMessage } = useMessageStore.getState();
    const meId = useAuthStore.getState().user?.id;

    // Proses semua pesan dalam keranjang secara teratur (sekuensial untuk menjaga Mutex & State)
    for (const safeMessage of messagesToProcess) {
        try {
            // THE SHIELD: Intelligent Echo Cancellation
            if (meId && safeMessage.senderId === meId) {
                // 1. Blokir echo dari pesan normal
                const isOptimisticEcho = useMessageStore.getState().messages[safeMessage.conversationId]?.some(
                    m => m.id === safeMessage.id || (m.tempId && String(m.tempId) === String(safeMessage.tempId))
                );
                if (isOptimisticEcho) {
                    continue; 
                }

                // 2. Blokir echo dari pesan SILENT (seperti Reaction/Edit/GhostSync yang kita kirim sendiri)
                if (safeMessage.content && safeMessage.content.startsWith('{')) {
                     try {
                         const meta = JSON.parse(safeMessage.content);
                         if (meta.type === 'reaction' || meta.type === 'edit' || meta.type === 'silent' || meta.type === 'GHOST_SYNC') {
                             continue;
                         }
                         // UNSEND tombstone TIDAK di-skip: perangkat sender juga perlu memprosesnya
                     } catch (_e) {}
                }
            }

            const decryptedMessage = await addIncomingMessage(safeMessage.conversationId, safeMessage);
              
            if (!decryptedMessage) continue; 

            if (!decryptedMessage.isSilent) {
               // Hanya putar notifikasi suara jika kita menerima kurang dari 3 pesan 
               // (Mencegah suara notifikasi bertumpuk-tumpuk saat offline catchup)
               if (messagesToProcess.length < 3) {
                   triggerReceiveFeedback();
               }
            }
            
            // Jeda sejenak setiap 5 pesan untuk membiarkan UI bernapas (mencegah Freeze)
            if (messagesToProcess.indexOf(safeMessage) % 5 === 0) {
                await new Promise(r => setTimeout(r, 20));
            }
            
        } catch (e: unknown) {
            console.error(`Failed to process buffered message ${safeMessage.id}`, e);
        }
    }
    
    isProcessingBuffer = false;
    
    // Jika selama pemrosesan tadi ada pesan baru yang masuk ke keranjang, proses lagi
    if (incomingMessageBuffer.length > 0) {
        processMessageBuffer();
    }
};

const handleKeyRotation = async (conversationId: string) => {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await rotateGroupKey(conversationId);
      useConversationStore.getState().updateConversation(conversationId, { keyRotationPending: false });
      return; 
    } catch (err: unknown) {
      attempt++;
      console.error(`[socket] Key rotation attempt ${attempt} failed for ${conversationId}:`, err);
      if (attempt >= MAX_RETRIES) {
        console.error(`[socket] All key rotation retries failed for ${conversationId}. Marking as pending.`);
        useConversationStore.getState().updateConversation(conversationId, { keyRotationPending: true });
        toast.error(`CRITICAL: Failed to rotate keys for group. The chat is insecure.`, { duration: 10000 });
      } else {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
};

export const fireGhostSync = (conversationId: string, baseDelay: number = 1000) => {
    const randomDelay = Math.floor(Math.random() * 2500) + baseDelay;
    setTimeout(async () => {
        try {
            const messageStore = (await import('../store/message')).useMessageStore.getState();
            await messageStore.sendMessage(conversationId, {
                content: JSON.stringify({ type: 'GHOST_SYNC', ts: Date.now() }),
                isSilent: true
            });
            console.log(`[Ghost Sync] Fired for group ${conversationId}`);
        } catch (e) {
            console.error('[Ghost Sync] Failed to send', e);
        }
    }, randomDelay);
};

export function getSocket() {
  if (!socket) {
    const token = useAuthStore.getState().accessToken;

    socket = io(WS_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 2000,
      path: "/socket.io",
      auth: { token }
    });

    const { setStatus } = useConnectionStore.getState();
    const { addOrUpdate, setOnlineUsers, userJoined, userLeft } = usePresenceStore.getState();
    const { updateMessage, removeLocalReaction, updateMessageStatus } = useMessageStore.getState();
    const conversationStore = useConversationStore.getState();

    // --- System Listeners ---
    socket.on("connect", async () => {
      setStatus('connected');
      const user = useAuthStore.getState().user;
      if (user) {
        socket?.emit("presence:update", { userId: user.id, online: true });

        try {
          await useConversationStore.getState().loadConversations();
          await useMessageStore.getState().processOfflineQueue();
          useMessageStore.getState().resendPendingMessages();
        } catch (error) {
          console.error("socket connect sync failed", error);
        }
      }
    });

    socket.on("disconnect", (reason) => {
      setStatus('disconnected');
      if (reason !== "io client disconnect") toast.error(i18n.t('errors:disconnected_reconnecting', 'Disconnected. Reconnecting...'));
    });

    socket.on("connect_error", (err) => {
      setStatus('disconnected');
      console.error("❌ Socket connection error:", err?.message ?? err);
    });

    // --- Application-specific Listeners ---
    socket.on("message:new", (rawPayload: unknown) => {
      // ✅ FIX 1: Gunakan RawServerMessageSchema karena ini adalah format pasti dari server sekarang
      const parsed = RawServerMessageSchema.safeParse(rawPayload);

      if (!parsed.success) {
          const payloadSummary = typeof rawPayload === 'object' && rawPayload !== null ? Object.keys(rawPayload) : typeof rawPayload;
          console.error("[Zod Shield] Dropping invalid incoming message:", JSON.stringify(parsed.error.format(), null, 2), "Raw Payload Keys:", payloadSummary);
          return;
      }
      const safeMessage = parsed.data;

      // ✅ FIX 2: Kirim ACK "Delivered" ke server segera setelah diterima dengan aman!
      // Server butuh kepastian ini agar tidak menembakkan pesan yang sama berulang kali.
      socket?.emit("message:ack_delivered", { 
          messageId: safeMessage.id, 
          conversationId: safeMessage.conversationId 
      });

      // ✅ FIX 3: Lempar ke keranjang Batching
      incomingMessageBuffer.push(safeMessage as unknown as Message);
      
      // Reset timer. Kita tunggu "badai" reda selama 100ms. 
      // Jika dalam 100ms tidak ada pesan baru lagi yang masuk, proses semua yang ada di keranjang.
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
          processMessageBuffer();
      }, 100);
    });

    socket.on("message:updated", (updatedMessage) => {
      if (!updatedMessage.conversationId || !updatedMessage.id) return;

      // FILTER KEAMANAN E2EE:
      // Kita pisahkan (destructure) field yang berpotensi merusak plaintext lokal.
      // 'content', 'ciphertext', dan 'fileKey' dari server adalah data mentah/terenkripsi, 
      // jadi kita BUNGKAM dan tidak memasukkannya ke dalam safeUpdates.
      const { 
        content: _rawContent, 
        ciphertext: _rawCiphertext, 
        fileKey: _rawFileKey,
        encryptedSessionKey: _rawSessionKey,
        ...safeUpdates 
      } = updatedMessage;

      // Sekarang safeUpdates hanya berisi metadata yang aman (seperti status, isViewed, dll)
      updateMessage(
        updatedMessage.conversationId, 
        updatedMessage.id, 
        safeUpdates as Partial<Message>
      );
    });

    socket.on("message:deleted", ({ conversationId, id }) => {
      const { removeMessage } = useMessageStore.getState();
      removeMessage(conversationId, id);
    });

    socket.on("messages:expired", ({ messageIds }: { messageIds: string[] }) => {
      const { messages, removeMessage } = useMessageStore.getState();
      const expiredSet = new Set(messageIds);
      
      Object.keys(messages).forEach(conversationId => {
        const conversationMessages = messages[conversationId] || [];
        conversationMessages.forEach(msg => {
          if (expiredSet.has(msg.id)) {
            removeMessage(conversationId, msg.id);
          }
        });
      });
    });

    socket.on("message:viewed", ({ messageId, conversationId }) => {
      useMessageStore.getState().updateMessage(conversationId, messageId, { isViewed: true });
    });

    socket.on("presence:init", (onlineUserIds) => setOnlineUsers(onlineUserIds));
    socket.on("presence:user_joined", (userId) => userJoined(userId));
    socket.on("presence:user_left", (userId) => userLeft(userId));
    socket.on("typing:update", ({ userId, conversationId, isTyping }) => addOrUpdate({ id: userId, conversationId, isTyping }));
    socket.on("reaction:new", ({ conversationId, messageId, reaction }) => {
      const { user: me } = useAuthStore.getState();
      const { replaceOptimisticReaction, addLocalReaction } = useMessageStore.getState();

      if (reaction.tempId && me && reaction.userId === me.id) {
        replaceOptimisticReaction(conversationId, messageId, reaction.tempId, reaction);
      } else {
        addLocalReaction(conversationId, messageId, reaction);
      }
    });
    socket.on("reaction:deleted", ({ conversationId, messageId, reactionId }) => removeLocalReaction(conversationId, messageId, reactionId));
    
    socket.on("conversation:new", (newConversation) => {
      conversationStore.addOrUpdateConversation(newConversation);
      socket?.emit("conversation:join", newConversation.id);

      if (newConversation.isGroup) {
        useConversationStore.getState().markKeyRotationNeeded(newConversation.id, true);
        schedulePeriodicGroupKeyRotation(newConversation.id);
        fireGhostSync(newConversation.id, 3000);
      }

      toast.success(i18n.t('common:added_to_group', `You've been added to "${newConversation.title || 'a new chat'}"`, { groupName: newConversation.title || 'a new chat' }));
    });

    socket.on("conversation:updated", (updates) => conversationStore.updateConversation(updates.id, updates));
    socket.on("conversation:deleted", ({ id }) => conversationStore.removeConversation(id));
    socket.on('group:participants_changed', (data: { conversationId: string }) => {
        useConversationStore.getState().markKeyRotationNeeded(data.conversationId, true);
        import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(data.conversationId).catch(console.error));
        useConversationStore.getState().loadConversations();
        fireGhostSync(data.conversationId, 1000);
    });

    socket.on('session:request_key', async (data: { conversationId: string, requesterId: string }) => {
        useConversationStore.getState().markKeyRotationNeeded(data.conversationId, true);
    });

    socket.on("conversation:participants_added", ({ conversationId, newParticipants }) => {
      useConversationStore.getState().addParticipants(conversationId, newParticipants.map(p => ({ ...p, id: asUserId(p.id) })));
      useConversationStore.getState().markKeyRotationNeeded(conversationId, true);
      fireGhostSync(conversationId, 2000);
    });

    socket.on("conversation:participant_removed", ({ conversationId, userId }) => {
      useConversationStore.getState().removeParticipant(conversationId, userId);
      handleKeyRotation(conversationId);
    });

    socket.on('user:updated', (updatedUser) => {
      const { user, setUser } = useAuthStore.getState();
      if (user?.id === updatedUser.id) {
        setUser({ ...user, ...updatedUser });
      }
      useConversationStore.getState().updateParticipantDetails(updatedUser);
      useMessageStore.getState().updateSenderDetails(updatedUser);
    });

    socket.on('message:status_updated', (payload) => {
      const { conversationId, messageId, deliveredTo, readBy, status } = payload;
      const userId = deliveredTo || readBy;
      if (userId) {
        updateMessageStatus(conversationId, messageId, userId, status);
      }
    });
    
    socket.on('session:fulfill_request', (data) => fulfillKeyRequest(data).catch(console.error));
    socket.on('group:fulfill_key_request', (data) => fulfillGroupKeyRequest(data).catch(console.error));
    socket.on('session:new_key', (data) => {
      storeReceivedSessionKey(data)
        .then(() => {
          useKeychainStore.getState().keysUpdated();
          useMessageStore.getState().reDecryptPendingMessages(data.conversationId);
        })
        .catch(console.error);
    });
    socket.on('force_logout', (payload) => {
      const currentToken = useAuthStore.getState().accessToken;
      if (payload?.jti && currentToken) {
         try {
            const base64Url = currentToken.split('.')[1];
            let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4) {
              base64 += '=';
            }
            const decoded = JSON.parse(atob(base64));
            if (decoded.jti !== payload.jti) return;
         } catch(e) {
            console.error("Failed to decode token for force_logout", e);
            return;
         }
      }

      toast.error(i18n.t('errors:this_session_has_been_logged_out_remotel', 'This session has been logged out remotely.'));
      useAuthStore.getState().logout();
      disconnectSocket();
    });

    socket.on("message:deleted_remotely", async ({ conversationId, messageId }) => {
      
      const { removeMessage } = useMessageStore.getState();
      // Ini akan langsung menghapus pesan dari UI dan mengubahnya menjadi Tombstone di IndexedDB lokal
      removeMessage(conversationId, messageId);
      
      // Opsional: Berikan feedback visual kecil jika user sedang melihat chat
      const isViewingChat = window.location.pathname.includes(`/chat/${conversationId}`);
      if (isViewingChat) {
          toast.success(i18n.t('chat:messages.message_retracted', 'A message has been retracted by the sender.'), {
              icon: '🗑️',
              duration: 3000,
              position: 'bottom-center'
          });
      }
    });

    socket.on("user:identity_changed", (data) => {
      const message = `The security key for ${data.name} has changed. You may want to verify their identity.`;
      toast.success(message, { duration: 10000, icon: '🛡️' });
      const { conversations } = useConversationStore.getState();
      const { addSystemMessage } = useMessageStore.getState();
      conversations.forEach(convo => {
        if (convo.participants.some(p => p.id === data.userId)) {
          addSystemMessage(convo.id, message);
        }
      });
    });
  }
  return socket;
}

export function connectSocket() {
  if (!socket) getSocket();
  const token = useAuthStore.getState().accessToken;

  if (socket) {
    socket.auth = { token };
    if (!socket.connected) {
      socket.connect();
    }
  }
}

export function disconnectSocket() {
  if (socket?.connected) socket.disconnect();
}

export function emitSessionKeyRequest(conversationId: string, sessionId: string, targetId?: string) {
  const meId = useAuthStore.getState().user?.id;
  getSocket()?.emit('session:request_key', { 
      conversationId, 
      sessionId, 
      targetId,
      requesterId: meId
  });
}

export function emitSessionKeyFulfillment(payload: { requesterId: string; conversationId: string; sessionId: string; encryptedKey: string; }) {
  getSocket()?.emit('session:fulfill_response', payload);
}

export function emitGroupKeyDistribution(conversationId: string, keys: { userId: string; key: string }[]) {
  getSocket()?.emit('messages:distribute_keys', { conversationId, keys });
}

export function emitGroupKeyRequest(conversationId: string, targetSenderId?: string, targetDeviceKey?: string) {
  getSocket()?.emit('group:request_key', { conversationId, targetSenderId, targetDeviceKey });
}

export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; targetDeviceId?: string; senderDeviceKey?: string; }) {
  getSocket()?.emit('group:fulfilled_key', payload);
}