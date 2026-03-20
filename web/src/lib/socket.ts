// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
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
import { asUserId } from "../types/brands";
import { IncomingMessageSchema } from "../schemas/core";
import type { ServerToClientEvents, ClientToServerEvents } from "../types/socket";
import { triggerReceiveFeedback } from "@utils/feedback";

// FIX: Gunakan VITE_WS_URL (Koyeb) jika ada, kalau tidak ada (dev) baru pakai API_URL
const WS_URL = import.meta.env.VITE_WS_URL || import.meta.env.VITE_API_URL;
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

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
    // Inisialisasi awal (token mungkin masih null, tidak apa-apa)
    const token = useAuthStore.getState().accessToken;

    socket = io(WS_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'], // Prioritaskan WebSocket
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 2000,
      path: "/socket.io",
      auth: {
        token: token 
      }
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
          // === THE SYNC PROTOCOL: Sync data on connect/reconnect ===
          // 1. Refetch Conversation List (Biar urutan chat bener & snippet update)
          await useConversationStore.getState().loadConversations();

          // 2. Process Offline Queue (Kirim pesan yg pending saat offline)
          await useMessageStore.getState().processOfflineQueue();

          // 3. Resend pending messages that might have failed during disconnection (InMemory Fallback)
          useMessageStore.getState().resendPendingMessages();

          // 4. Update Status Online User Lain
          // (Handled by presence:init event that's already implemented)
        } catch (error) {
          console.error("socket connect sync failed", error);
        }
      }
    });

    socket.on("disconnect", (reason) => {
      setStatus('disconnected');
      // Jangan toast jika disconnect manual/navigasi
      if (reason !== "io client disconnect") toast.error("Disconnected. Reconnecting...");
    });

    socket.on("connect_error", (err) => {
      setStatus('disconnected');
      console.error("❌ Socket connection error:", err?.message ?? err);
    });

    // --- Application-specific Listeners ---
    socket.on("message:new", async (rawPayload: unknown) => {
      // 1. Zod memeriksa dan mengubah data mentah menjadi Branded Types
      const parsed = IncomingMessageSchema.safeParse(rawPayload);

      // 2. Fail Gracefully (Jangan biarkan aplikasi crash)
      if (!parsed.success) {
          console.error("[Zod Shield] Dropping invalid incoming message:", parsed.error.format());
          return; 
      }

      // 3. Data sudah dijamin aman dan memiliki Opaque Types yang benar
      const safeMessage = parsed.data;

      const meId = useAuthStore.getState().user?.id;
      
      // THE SHIELD: Intelligent Echo Cancellation
      // Only block messages from ourselves IF they match a pending optimistic update on this device.
      // This allows messages from our *other* devices to pass through and be synced.
      if (meId && safeMessage.senderId === meId) {
        const isOptimisticEcho = useMessageStore.getState().messages[safeMessage.conversationId]?.some(
            m => m.tempId && String(m.tempId) === String(safeMessage.tempId)
        );
        
        if (isOptimisticEcho) {
            // It's an echo of a message we just sent from this tab. Ignore it.
            return;
        }
        // If no match, it's a sync from another device (or a re-send we lost track of). Process it.
      }

      const convExists = useConversationStore.getState().conversations.some(c => c.id === safeMessage.conversationId);
      if (!convExists) {
        return;
      }

      try {
        const { addIncomingMessage } = useMessageStore.getState();
        
        // Delegate EVERYTHING to the store. 
        // The store handles decryption, reaction parsing, and optimistic replacement internally.
        const decryptedMessage = await addIncomingMessage(safeMessage.conversationId, safeMessage);
          
        if (!decryptedMessage) return; // Message intercepted (e.g. STORY_KEY)

        if (!decryptedMessage.isSilent) {
           triggerReceiveFeedback();
        }

        // Update notification/preview using decrypted content
        // TODO: Trigger Desktop/Push Notification here using decryptedMessage.content or decryptedMessage.fileName
        // e.g. showNotification(decryptedMessage.sender.name, decryptedMessage.content || "Sent a file");
        
        socket?.emit('message:ack_delivered', { messageId: safeMessage.id, conversationId: safeMessage.conversationId });
      } catch (e: unknown) {
        console.error("Failed to process incoming message", e);
      }
    });

    socket.on("message:updated", (updatedMessage) => {
      updateMessage(updatedMessage.conversationId, updatedMessage.id, updatedMessage);
    });

    socket.on("message:deleted", ({ conversationId, id }) => {
      const { removeMessage } = useMessageStore.getState();
      removeMessage(conversationId, id);
    });

    socket.on("messages:expired", ({ messageIds }: { messageIds: string[] }) => {
      const { messages, removeMessage } = useMessageStore.getState();
      // Optimization: create a set for faster lookup
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

      // Jika ini adalah percakapan grup, jadwalkan rotasi kunci berkala
      if (newConversation.isGroup) {
        useConversationStore.getState().markKeyRotationNeeded(newConversation.id, true);
        schedulePeriodicGroupKeyRotation(newConversation.id);
        // The new user fires a Ghost Sync too, but with a slightly longer base delay 
        // to ensure they have fully joined the socket room first.
        fireGhostSync(newConversation.id, 3000);
      }

      toast.success(`You've been added to "${newConversation.title || 'a new chat'}"`);
    });

    socket.on("conversation:updated", (updates) => conversationStore.updateConversation(updates.id, updates));
    socket.on("conversation:deleted", ({ id }) => conversationStore.removeConversation(id));

    socket.on('group:participants_changed', (data: { conversationId: string }) => {
        // Force key rotation on the next message sent
        useConversationStore.getState().markKeyRotationNeeded(data.conversationId, true);
        // Also reload conversation details to get the new participant list
        useConversationStore.getState().loadConversations();

        // [NEW] GHOST SYNC: Trigger a silent message to settle ratchet state
        fireGhostSync(data.conversationId, 1000);
    });

    socket.on('session:request_key', async (data: { conversationId: string, requesterId: string }) => {
        // Someone failed to decrypt our message, they need our sender key.
        // By marking rotation needed, our next message will force a fresh key distribution to them.
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
    socket.on('force_logout', () => {
      toast.error("This session has been logged out remotely.");
      useAuthStore.getState().logout();
      disconnectSocket();
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
  // 1. Pastikan instance ada
  if (!socket) getSocket();

  // 2. AMBIL TOKEN TERBARU DARI STORE
  const token = useAuthStore.getState().accessToken;

  if (socket) {
    // 3. UPDATE TOKEN DI SOCKET AUTH (FIX UTAMA)
    // Ini memastikan socket menggunakan token baru hasil refresh, bukan token null saat init
    socket.auth = { token };

    // 4. Connect hanya jika belum connect
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

export function emitGroupKeyRequest(conversationId: string) {
  getSocket()?.emit('group:request_key', { conversationId });
}

export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; }) {
  getSocket()?.emit('group:fulfilled_key', payload);
}