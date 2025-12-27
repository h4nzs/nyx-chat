import { io, Socket } from "socket.io-client";
import toast from "react-hot-toast";
import { useAuthStore } from "@store/auth";
import { useConversationStore } from "@store/conversation";
import { useMessageStore, decryptMessageObject } from "@store/message";
import { useConnectionStore } from "@store/connection";
import { usePresenceStore } from "@store/presence";
import useNotificationStore from '@store/notification';
import { fulfillKeyRequest, storeReceivedSessionKey, rotateGroupKey, fulfillGroupKeyRequest } from "@utils/crypto";
import { useKeychainStore } from "@store/keychain";
import type { Message } from "@store/conversation";

const WS_URL = (import.meta.env.VITE_WS_URL as string) || "http://localhost:4000";
let socket: Socket | null = null;

export function getSocket() {
  if (!socket) {
    socket = io(WS_URL, {
      withCredentials: true,
      transports: ["websocket", "polling"],
      autoConnect: false,
      path: "/socket.io",
    });

    const { setStatus } = useConnectionStore.getState();
    const { addOrUpdate, setOnlineUsers, userJoined, userLeft } = usePresenceStore.getState();
    const { addIncomingMessage, updateMessage, addReaction, removeReaction, updateMessageStatus } = useMessageStore.getState();
    const conversationStore = useConversationStore.getState();

    // --- System Listeners ---
    socket.on("connect", () => {
      setStatus('connected');
      const user = useAuthStore.getState().user;
      if (user) {
        socket?.emit("presence:update", { userId: user.id, online: true });
      }
      console.log("✅ Socket connected:", socket?.id);
    });

    socket.on("disconnect", (reason) => {
      setStatus('disconnected');
      if (reason !== "io client disconnect") toast.error("Disconnected. Reconnecting...");
      console.log("⚠️ Socket disconnected:", reason);
    });

    socket.on("connect_error", (err: any) => {
      setStatus('disconnected');
      console.error("❌ Socket connection error:", err?.message ?? err);
    });

    // --- Application-specific Listeners ---
    socket.on("message:new", async (newMessage: Message) => {
      // Defensive check: If the client receives a message for a conversation it's not in, ignore it.
      // This can happen briefly after being removed from a group.
      const convExists = useConversationStore.getState().conversations.some(c => c.id === newMessage.conversationId);
      if (!convExists) {
        console.warn(`[socket] Ignored message for unknown or removed conversation ${newMessage.conversationId}`);
        return;
      }

      try {
        const { user: me } = useAuthStore.getState();
        const { replaceOptimisticMessage, addIncomingMessage } = useMessageStore.getState();
        const decryptedMessage = await decryptMessageObject(newMessage);

        // If the message has a tempId AND is from the current user, it's a confirmation for an optimistic message.
        if (newMessage.tempId && me && newMessage.senderId === me.id) {
          replaceOptimisticMessage(decryptedMessage.conversationId, newMessage.tempId, decryptedMessage);
        } else {
          // Otherwise, it's a new incoming message from another user.
          addIncomingMessage(decryptedMessage.conversationId, decryptedMessage);
          
          // Trigger Notification store if the message is for an inactive conversation
          const activeId = useConversationStore.getState().activeId;
          if (decryptedMessage.conversationId !== activeId && decryptedMessage.sender) {
            const { addNotification } = useNotificationStore.getState();
            addNotification({
              sender: decryptedMessage.sender,
              message: decryptedMessage.content || 'Sent a file',
              link: decryptedMessage.conversationId,
            });
          }
        }

        conversationStore.updateConversationLastMessage(decryptedMessage.conversationId, decryptedMessage);
        socket?.emit('message:ack_delivered', { messageId: decryptedMessage.id, conversationId: decryptedMessage.conversationId });
      } catch (e) {
        console.error("Failed to process incoming message", e);
      }
    });

    socket.on("message:updated", (updatedMessage: Message) => {
      updateMessage(updatedMessage.conversationId, updatedMessage.id, updatedMessage);
    });

    socket.on("message:deleted", ({ conversationId, id }) => {
      const { removeMessage } = useMessageStore.getState();
      removeMessage(conversationId, id);
    });

    socket.on("presence:init", (onlineUserIds: string[]) => setOnlineUsers(onlineUserIds));
    socket.on("presence:user_joined", (userId: string) => userJoined(userId));
    socket.on("presence:user_left", (userId: string) => userLeft(userId));
    socket.on("typing:update", ({ userId, conversationId, isTyping }) => addOrUpdate({ id: userId, conversationId, isTyping }));
    socket.on("reaction:new", ({ conversationId, messageId, reaction }) => {
      const { user: me } = useAuthStore.getState();
      const { replaceOptimisticReaction, addReaction } = useMessageStore.getState();

      // If the reaction has a tempId AND is from the current user, it's a confirmation for an optimistic update.
      if (reaction.tempId && me && reaction.userId === me.id) {
        replaceOptimisticReaction(conversationId, messageId, reaction.tempId, reaction);
      } else {
        // Otherwise, it's a new reaction from another user.
        addReaction(conversationId, messageId, reaction);
      }
    });
    socket.on("reaction:deleted", ({ conversationId, messageId, reactionId }) => removeReaction(conversationId, messageId, reactionId));
    
    socket.on("conversation:new", (newConversation) => {
      conversationStore.addOrUpdateConversation(newConversation);
      socket?.emit("conversation:join", newConversation.id);
      toast.success(`You've been added to "${newConversation.title || 'a new chat'}"`);
    });

    socket.on("conversation:updated", (updates) => conversationStore.updateConversation(updates.id, updates));
    socket.on("conversation:deleted", ({ id }) => conversationStore.removeConversation(id));

    socket.on("conversation:participants_added", ({ conversationId, newParticipants }) => {
      console.log(`[socket] ${newParticipants.length} participant(s) added to ${conversationId}. Updating UI.`);
      useConversationStore.getState().addParticipants(conversationId, newParticipants);
    });

    socket.on("conversation:participant_removed", ({ conversationId, userId }) => {
      console.log(`[socket] Participant ${userId} removed from ${conversationId}. Rotating key and updating UI.`);
      
      // Remove participant from the UI state
      useConversationStore.getState().removeParticipant(conversationId, userId);
      
      // Rotate the group key for security
      rotateGroupKey(conversationId).catch(err => {
        console.error(`[socket] Failed to rotate group key for ${conversationId}`, err);
      });
    });

    socket.on('user:updated', (updatedUser) => {
      // Update the user's own info if it's them
      const { user, setUser } = useAuthStore.getState();
      if (user?.id === updatedUser.id) {
        setUser({ ...user, ...updatedUser });
      }
      // Update user details in conversation participants and message senders
      useConversationStore.getState().updateParticipantDetails(updatedUser);
      useMessageStore.getState().updateSenderDetails(updatedUser);
    });

    socket.on('message:status_updated', (payload) => {
      console.log('[STATUS] Received message:status_updated:', payload); // Diagnostic Log
      const { conversationId, messageId, deliveredTo, readBy, status } = payload;
      const userId = deliveredTo || readBy;
      if (userId) {
        updateMessageStatus(conversationId, messageId, userId, status);
      }
    });
    
    socket.on('session:fulfill_request', (data) => fulfillKeyRequest(data).catch(error => console.error('Failed to fulfill key request:', error)));
    socket.on('group:fulfill_key_request', (data) => fulfillGroupKeyRequest(data).catch(error => console.error('Failed to fulfill group key request:', error)));
    socket.on('session:new_key', (data) => {
      storeReceivedSessionKey(data)
        .then(() => {
          useKeychainStore.getState().keysUpdated();
          // After a new key is stored, try to re-decrypt any pending messages for that conversation
          useMessageStore.getState().reDecryptPendingMessages(data.conversationId);
        })
        .catch(error => console.error('Failed to store or process received session key:', error));
    });
    socket.on('force_logout', () => {
      toast.error("This session has been logged out remotely.");
      useAuthStore.getState().logout();
      disconnectSocket();
    });

    socket.on("user:identity_changed", (data: { userId: string; name: string }) => {
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
  if (socket && !socket.connected) socket.connect();
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
