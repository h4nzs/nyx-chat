// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { transportClient, emitSessionKeyRequest } from './transportClient';
import { useMessageStore } from '../store/message';
import { useConversationStore } from '../store/conversation';
import { useAuthStore } from '../store/auth';
import { useConnectionStore } from '../store/connection';
import { usePresenceStore } from '../store/presence';
import type { RawServerMessage, Message, Participant, User, BinaryPayload } from '@nyx/shared';

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
    useMessageStore.getState().updateMessage(data.conversationId, data.id, data as any);
  });

  transportClient.on('message:deleted', (data: { conversationId: string; id: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.id, { isDeletedLocal: true, content: null });
  });

  transportClient.on('message:status_updated', (data: { conversationId: string; messageId: string; userId: string; status: string }) => {
    useMessageStore.getState().updateMessageStatus(data.conversationId, data.messageId, data.userId, data.status);
  });

  // 2. CONVERSATIONS
  transportClient.on('conversation:new', (conversation: any) => {
    useConversationStore.getState().addOrUpdateConversation(conversation);
  });

  transportClient.on('conversation:updated', (data: any) => {
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

  transportClient.on('conversation:participant_updated', (data: { conversationId: string; userId: string; role: any }) => {
    useConversationStore.getState().updateParticipantRole(data.conversationId, data.userId, data.role);
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
  transportClient.on('session:request_key_fulfillment', (data: any) => {
    // This is handled in transportClient helpers usually, but we can hook it here if needed
  });
}
