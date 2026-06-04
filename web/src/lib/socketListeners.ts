// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { transportClient, emitSessionKeyRequest } from './transportClient';
import { useMessageStore } from '../store/message';
import { useConversationStore } from '../store/conversation';
import { useAuthStore } from '../store/auth';
import { useConnectionStore } from '../store/connection';
import { usePresenceStore } from '../store/presence';
import type { RawServerMessage, Message, Participant, User, BinaryPayload, Conversation } from '@nyx/shared';

let isInitialized = false;

export function initSocketListeners() {
  if (isInitialized) return;
  isInitialized = true;

  console.log('[Socket] Initializing listeners...');

  transportClient.on('connect', () => {
    console.log('[Socket] Connected');
    useConnectionStore.getState().setStatus('connected');
    
    // User is active by default on connect
    transportClient.sendEvent('user:active');
  });

  transportClient.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
    useConnectionStore.getState().setStatus('disconnected');
  });

  // 1. MESSAGES
  transportClient.on('message:new', async (payload: BinaryPayload | RawServerMessage) => {
    let rawMsg: RawServerMessage;
    if (payload instanceof Uint8Array) {
      try {
        rawMsg = JSON.parse(new TextDecoder().decode(payload));
      } catch (e) {
        console.error("[Socket] Failed to decode message:new payload");
        return;
      }
    } else {
      rawMsg = payload as RawServerMessage;
    }

    try {
      const msg = await useMessageStore.getState().addIncomingMessage(rawMsg.conversationId, rawMsg as unknown as Message);
      if (msg) {
        useConversationStore.getState().updateConversationLastMessage(rawMsg.conversationId, msg);
      }
    } catch (e) {
      console.error("[Socket] Error handling message:new:", e);
    }
  });

  transportClient.on('message:updated', (data: Partial<RawServerMessage> & { id: string, conversationId: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.id, data as unknown as Partial<Message>);
  });

  transportClient.on('message:deleted', (data: { conversationId: string; id: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.id, { isDeletedLocal: true, content: null });
  });

  transportClient.on('message:status_updated', (data: { conversationId: string; messageId: string; userId: string; status: string }) => {
    useMessageStore.getState().updateMessageStatus(data.conversationId, data.messageId, data.userId, data.status);
  });

  // 2. CONVERSATIONS
  transportClient.on('conversation:new', (conversation: Conversation) => {
    useConversationStore.getState().addOrUpdateConversation(conversation);
  });

  transportClient.on('conversation:updated', (data: Partial<Conversation> & { id: string }) => {
    useConversationStore.getState().updateConversation(data.id, data);
  });

  transportClient.on('conversation:deleted', (data: { id: string }) => {
    useConversationStore.getState().removeConversation(data.id);
  });

  transportClient.on('conversation:participants_added', (data: { conversationId: string; participants: Participant[] }) => {
    useConversationStore.getState().addParticipants(data.conversationId, data.participants);
  });

  transportClient.on('conversation:participant_removed', (data: { conversationId: string; userId: string }) => {
    useConversationStore.getState().removeParticipant(data.conversationId, data.userId);
  });

  transportClient.on('conversation:participant_updated', (data: { conversationId: string; userId: string; role: 'ADMIN' | 'MEMBER' | 'admin' | 'member' }) => {
    useConversationStore.getState().updateParticipantRole(data.conversationId, data.userId, data.role.toUpperCase() as 'ADMIN' | 'MEMBER');
  });

  // 3. USERS
  transportClient.on('user:updated', (user: Partial<User>) => {
    useConversationStore.getState().updateParticipantDetails(user);
    useMessageStore.getState().updateSenderDetails(user);
  });

  // 4. PRESENCE
  transportClient.on('presence:update', (payload: BinaryPayload) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(payload));
      if (data.type === 'bulk') {
        usePresenceStore.getState().setOnlineUsers(data.userIds);
      } else if (data.type === 'join') {
        usePresenceStore.getState().userJoined(data.userId);
      } else if (data.type === 'leave') {
        usePresenceStore.getState().userLeft(data.userId);
      } else if (data.type === 'typing') {
        usePresenceStore.getState().addOrUpdate({
          id: data.userId,
          conversationId: data.conversationId,
          isTyping: data.isTyping
        });
      }
    } catch (e) {}
  });

  // 5. SECURITY & SESSIONS
  transportClient.on('force_logout', async (data: { jti: string }) => {
     // Check if current session is revoked
     const { logout } = useAuthStore.getState();
     await logout();
     window.location.href = '/login?reason=revoked';
  });

  transportClient.on('auth:banned', async (data: { reason: string }) => {
     const { logout } = useAuthStore.getState();
     await logout();
     window.location.href = `/login?reason=banned&msg=${encodeURIComponent(data.reason)}`;
  });

  // 6. KEY MANAGEMENT
  transportClient.on('session:request_key_fulfillment', (data: unknown) => {
    // This is handled in transportClient helpers usually, but we can hook it here if needed
  });

  transportClient.on('session:new_key', (data: { conversationId: string; sessionId?: string; encryptedKey: string; type?: 'GROUP_KEY' | 'SESSION_KEY'; senderId?: string; senderDeviceKey?: string }) => {
    import('../utils/crypto').then(m => m.storeReceivedSessionKey(data))
      .then(() => {
        import('../store/keychain').then(m => m.useKeychainStore.getState().keysUpdated());
        useMessageStore.getState().reDecryptPendingMessages(data.conversationId);
      })
      .catch(console.error);
  });
  
  transportClient.on('session:fulfill_request', (data: { conversationId: string; sessionId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string }) => {
    import('../utils/crypto').then(m => m.fulfillKeyRequest(data).catch(console.error));
  });

  transportClient.on('group:fulfill_key_request', (data: { conversationId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string; requesterDeviceId?: string }) => {
    import('../utils/crypto').then(m => m.fulfillGroupKeyRequest(data).catch(console.error));
  });

  transportClient.on('group:key_request_failed', (data: { conversationId: string; reason: string }) => {
    console.error(`Group Key Request Failed for ${data.conversationId}:`, data.reason);
  });

  transportClient.on('session:request_key_failed', (data: { sessionId: string; targetId: string; reason: string }) => {
    console.error(`Session Key Request Failed for ${data.sessionId}:`, data.reason);
  });

  // 7. BURNER CHATS
  transportClient.on("burner:receive", async (payload: { roomId?: string, ciphertext: string }) => {
    const { useBurnerStore } = await import('../store/burner');
    const roomId = payload.roomId || Object.keys(useBurnerStore.getState().activeSessions)[0];
    if (roomId) {
      await useBurnerStore.getState().receiveMessage(roomId, payload.ciphertext);
    }
  });

  transportClient.on("burner:terminated", async (payload: { roomId: string }) => {
    const { useBurnerStore } = await import('../store/burner');
    if (payload?.roomId) {
      useBurnerStore.getState().terminateSession('This secure session has been terminated by the host.');
      useConversationStore.getState().removeConversation(payload.roomId);
    }
  });
}

