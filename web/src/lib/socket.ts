import io from "socket.io-client";
import type { Socket } from "socket.io-client";
import toast from "react-hot-toast";
import { useAuthStore, User } from "@store/auth";
import { useConversationStore, Conversation } from "@store/conversation";
import { useMessageStore, decryptMessageObject } from "@store/message";
import { useConnectionStore } from "@store/connection";
import { usePresenceStore } from "@store/presence";
import useNotificationStore from '@store/notification';
import { fulfillKeyRequest, storeReceivedSessionKey, rotateGroupKey, fulfillGroupKeyRequest, schedulePeriodicGroupKeyRotation } from "@utils/crypto";
import { useKeychainStore } from "@store/keychain";
import type { Message } from "@store/conversation";
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
    } catch (err: any) {
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
    const { updateMessage, addLocalReaction, removeLocalReaction, updateMessageStatus } = useMessageStore.getState();
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
    socket.on("message:new", async (newMessage) => {
      const convExists = useConversationStore.getState().conversations.some(c => c.id === newMessage.conversationId);
      if (!convExists) {
        return;
      }

      try {
        const { addIncomingMessage } = useMessageStore.getState();
        
        // Delegate EVERYTHING to the store. 
        // The store handles decryption, reaction parsing, and optimistic replacement internally.
        const decryptedMessage = await addIncomingMessage(newMessage.conversationId, newMessage);
          
        triggerReceiveFeedback();

        // Update notification/preview using decrypted content
        // TODO: Trigger Desktop/Push Notification here using decryptedMessage.content or decryptedMessage.fileName
        // e.g. showNotification(decryptedMessage.sender.name, decryptedMessage.content || "Sent a file");
        
        socket?.emit('message:ack_delivered', { messageId: newMessage.id, conversationId: newMessage.conversationId });
      } catch (e: any) {
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
        schedulePeriodicGroupKeyRotation(newConversation.id);
      }

      toast.success(`You've been added to "${newConversation.title || 'a new chat'}"`);
    });

    socket.on("conversation:updated", (updates) => conversationStore.updateConversation(updates.id, updates));
    socket.on("conversation:deleted", ({ id }) => conversationStore.removeConversation(id));

    socket.on("conversation:participants_added", ({ conversationId, newParticipants }) => {
      useConversationStore.getState().addParticipants(conversationId, newParticipants);
    });

    socket.on("conversation:participant_removed", ({ conversationId, userId }) => {
      useConversationStore.getState().removeParticipant(conversationId, userId);
      handleKeyRotation(conversationId);
    });

    socket.on('user:updated', (updatedUser) => {
      const { user, setUser } = useAuthStore.getState();
      if (user?.id === updatedUser.id) {
        // Prevent overwriting private fields (email) with undefined from public broadcast
        const preservedUser = { ...user, ...updatedUser };
        if (updatedUser.email === undefined && user.email) {
           preservedUser.email = user.email;
        }
        setUser(preservedUser as User);
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
    (socket.auth as any) = { token };

    // 4. Connect hanya jika belum connect
    if (!socket.connected) {
      socket.connect();
    }
  }
}

export function disconnectSocket() {
  if (socket?.connected) socket.disconnect();
}

export function emitSessionKeyRequest(conversationId: string, sessionId: string) {
  getSocket()?.emit('session:request_key', { conversationId, sessionId });
}

export function emitSessionKeyFulfillment(payload: { requesterId: string; conversationId: string; sessionId: string; encryptedKey: string; }) {
  getSocket()?.emit('session:fulfill_response', payload);
}

export function emitGroupKeyDistribution(conversationId: string, keys: any[]) {
  getSocket()?.emit('messages:distribute_keys', { conversationId, keys });
}

export function emitGroupKeyRequest(conversationId: string) {
  getSocket()?.emit('group:request_key', { conversationId });
}

export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; }) {
  getSocket()?.emit('group:fulfilled_key', payload);
}