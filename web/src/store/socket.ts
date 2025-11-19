import { createWithEqualityFn } from "zustand/traditional";
import { getSocket, emitSessionKeyRequest } from "@lib/socket";
import { useAuthStore } from "./auth";
import { useConversationStore, Message, Conversation } from "./conversation";
import { useMessageStore, decryptMessageObject } from "./message";
import { usePresenceStore } from "./presence";
import useNotificationStore from './notification';
import { api } from '@lib/api'; // Add this missing import
import { decryptSessionKeyForUser } from '@utils/keyManagement';
import { addSessionKey } from '@lib/keychainDb';
import { getSodium } from '@lib/sodiumInitializer';

let listenersInitialized = false;
export const resetListenersInitialized = () => { listenersInitialized = false; };

// --- Helper Functions ---

const getStores = () => ({
  auth: useAuthStore.getState(),
  convo: useConversationStore.getState(),
  msg: useMessageStore.getState(),
  presence: usePresenceStore.getState(),
});

type State = {
  isConnected: boolean;
  initSocketListeners: () => () => void; // Returns a cleanup function
};

export const useSocketStore = createWithEqualityFn<State>((set) => ({
  isConnected: false,

  initSocketListeners: () => {
    if (listenersInitialized) return () => {}; // Return an empty cleanup function if already initialized

    const socket = getSocket();
    // Set initial connection status based on current socket state
    set({ isConnected: socket.connected });

    // --- Register connection status listeners ---
    socket.on("connect", () => {
      console.log("✅ Socket connected (store)");
      set({ isConnected: true });
    });

    socket.on("disconnect", (reason) => {
      console.log("⚠️ Socket disconnected (store):", reason);
      set({ isConnected: false });
    });

    socket.on("reconnect", (attempt) => {
      console.log("🔄 Socket reconnected (store) after", attempt, "attempts");
      set({ isConnected: true });
      // Only resync if initial load hasn't completed to prevent loops
      const { initialLoadCompleted } = getStores().convo;
      if (!initialLoadCompleted) {
        getStores().convo.resyncState(); // Call resync function
      }
    });

    // --- Register all other listeners ---

    socket.on("presence:init", (onlineUserIds: string[]) => {
      getStores().presence.setPresence(onlineUserIds);
    });

    socket.on("presence:user_joined", (userId: string) => {
      getStores().presence.userJoined(userId);
    });

    socket.on("presence:user_left", (userId: string) => {
      getStores().presence.userLeft(userId);
    });

    socket.on("typing:update", ({ userId, conversationId, isTyping }) => {
      const { typing, setTyping } = getStores().presence;
      const currentTyping = typing[conversationId] || [];
      let newTypingUsers = [...currentTyping];

      if (isTyping && !currentTyping.includes(userId)) {
        newTypingUsers.push(userId);
      } else if (!isTyping) {
        newTypingUsers = newTypingUsers.filter(id => id !== userId);
      }
      setTyping(conversationId, newTypingUsers);
    });

    socket.on("message:new", async (newMessage: Message) => {
      const { convo, msg, auth } = getStores();
      const { activeId } = convo;
      const meId = auth.user?.id;

      let processedMessage: Message;
      try {
        processedMessage = await decryptMessageObject(newMessage);
      } catch (e) {
        console.error("Decryption failed for incoming real-time message. Requesting key.", e);
        processedMessage = { ...newMessage, content: '[Requesting key to decrypt...]' };
        if (newMessage.sessionId) {
          emitSessionKeyRequest(newMessage.conversationId, newMessage.sessionId);
        }
      }

      // Handle message state update
      if (processedMessage.senderId === meId && processedMessage.tempId) {
        msg.replaceOptimisticMessage(processedMessage.conversationId, processedMessage.tempId, processedMessage);
      } else {
        msg.addIncomingMessage(processedMessage.conversationId, processedMessage);
      }

      // Handle conversation list update
      const existingConversation = convo.conversations.find(c => c.id === processedMessage.conversationId);

      // Trigger in-app notification if the message is not from the current user and the conversation is not active
      if (processedMessage.senderId !== meId && activeId !== processedMessage.conversationId) {
        const senderName = processedMessage.sender?.name || 'Someone';
        const messageContent = processedMessage.content || (processedMessage.fileUrl ? 'Sent a file' : 'New message');
        
        const notificationPayload = {
          id: processedMessage.id,
          message: `${senderName}: ${messageContent}`,
          link: processedMessage.conversationId,
          sender: processedMessage.sender
        };

        useNotificationStore.getState().addNotification(notificationPayload);
      }

      if (existingConversation) {
        const newUnreadCount = activeId !== processedMessage.conversationId && processedMessage.senderId !== meId
          ? (existingConversation.unreadCount || 0) + 1
          : existingConversation.unreadCount;

        convo.addOrUpdateConversation({ 
          ...existingConversation,
          lastMessage: processedMessage,
          unreadCount: newUnreadCount
        });
      } else {
        // If conversation is not in the list, fetch it
        try {
          const newConversation = await api<Conversation>(`/api/conversations/${processedMessage.conversationId}`);
          if (newConversation) {
            convo.addOrUpdateConversation({
              ...newConversation,
              lastMessage: processedMessage,
              unreadCount: 1, // It's a new message, so unread count is at least 1
            });
          }
        } catch (error) {
          console.error("Failed to fetch new conversation:", error);
        }
      }
    });

    socket.on("conversation:new", (newConversation: Conversation) => {
      // When being re-added to a group, clear the old message history first
      getStores().msg.clearMessagesForConversation(newConversation.id);
      getStores().convo.addOrUpdateConversation(newConversation);

      // Also join the socket room to receive real-time updates for this new conversation
      socket.emit("conversation:join", newConversation.id);

      // Notify user they were added to a new group
      if (newConversation.isGroup) {
        useNotificationStore.getState().addNotification({
          message: `You have been added to the group: ${newConversation.title}`,
          link: `/` // Or a more specific link if available
        });
      }
    });

    socket.on("conversation:deleted", ({ id }) => {
      getStores().convo.removeConversation(id);
      getStores().msg.clearMessagesForConversation(id);
      useNotificationStore.getState().removeNotificationsForConversation(id);
    });

    socket.on("message:deleted", ({ messageId, conversationId }) => {
      getStores().msg.updateMessage(conversationId, messageId, {
        content: "[This message was deleted]",
        fileUrl: undefined,
        imageUrl: undefined,
        reactions: [],
      });
    });

    socket.on('message:status_updated', ({ messageId, conversationId, readBy, status }) => {
      getStores().msg.updateMessageStatus(conversationId, messageId, readBy, status);
    });

    socket.on("reaction:new", (reaction) => {
      const { messages } = getStores().msg;
      for (const cid in messages) {
        if (messages[cid].some(m => m.id === reaction.messageId)) {
          getStores().msg.addReaction(cid, reaction.messageId, reaction);
          break;
        }
      }
    });

    socket.on("reaction:remove", ({ reactionId, messageId }) => {
      const { messages } = getStores().msg;
      for (const cid in messages) {
        if (messages[cid].some(m => m.id === messageId)) {
          getStores().msg.removeReaction(cid, messageId, reactionId);
          break;
        }
      }
    });

    socket.on('user:updated', (updatedUser: any) => {
      const { auth, convo, msg } = getStores();
      if (updatedUser.id === auth.user?.id) return; // Ignore self-updates

      // Update user details in all relevant places
      convo.updateParticipantDetails(updatedUser);
      msg.updateSenderDetails(updatedUser);
    });

    // --- New listeners for group management ---

    socket.on("conversation:updated", (data) => {
      getStores().convo.updateConversation(data.id, { ...data, lastUpdated: Date.now() });
    });

    socket.on("conversation:participants_added", ({ conversationId, newParticipants }) => {
      getStores().convo.addParticipants(conversationId, newParticipants);
    });

    socket.on("conversation:participant_removed", ({ conversationId, userId }) => {
      getStores().convo.removeParticipant(conversationId, userId);
    });

    socket.on("conversation:participant_updated", ({ conversationId, userId, role }) => {
      const { auth, convo } = getStores();
      if (auth.user?.id === userId) {
        const conversation = convo.conversations.find(c => c.id === conversationId);
        if (conversation) {
          useNotificationStore.getState().addNotification({
            message: `You are now an ${role.toLowerCase()} in "${conversation.title}".`,
            link: `/`
          });
        }
      }
      getStores().convo.updateParticipantRole(conversationId, userId, role);
      getStores().convo.updateConversation(conversationId, { lastUpdated: Date.now() });
    });

    socket.on('session:new_key', async ({ conversationId, sessionId, encryptedKey }) => {
      try {
        console.log(`Received new session key ${sessionId} for conversation ${conversationId}`);
        const privateKey = await useAuthStore.getState().getPrivateKey(); // This needs to be implemented
        const publicKeyB64 = localStorage.getItem('publicKey');
        if (!privateKey || !publicKeyB64) {
          throw new Error("User keys not available to decrypt new session key.");
        }
        const sodium = await getSodium();
        const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);

        const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey, sodium);
        await addSessionKey(conversationId, sessionId, newSessionKey);
        console.log(`Successfully stored new session key ${sessionId}`);
        
      } catch (error) {
        console.error("Failed to process new session key:", error);
      }
    });

    listenersInitialized = true; // Set the flag

    // Return a cleanup function
    return () => {
      set({ isConnected: false });
      socket.off("presence:init");
      socket.off("presence:user_joined");
      socket.off("presence:user_left");
      socket.off("typing:update");
      socket.off("message:new");
      socket.off("conversation:new");
      socket.off("conversation:deleted");
      socket.off("reaction:new");
      socket.off("reaction:remove");
      socket.off("message:deleted");
      socket.off("message:status_updated");
      socket.off("user:updated");
      socket.off("conversation:updated");
      socket.off("conversation:participants_added");
      socket.off("conversation:participant_removed");
      socket.off("conversation:participant_updated");
    };
  },
}));