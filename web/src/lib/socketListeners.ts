// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { transportClient, emitSessionKeyRequest } from './transportClient';
import { useMessageStore } from '../store/message';
import { useConversationStore } from '../store/conversation';
import { useAuthStore } from '../store/auth';
import { captureAndLog } from '@utils/feedback';
import { useConnectionStore } from '../store/connection';
import { usePresenceStore } from '../store/presence';
import { RawServerMessageSchema, type RawServerMessage, type Message, type Participant, type User, type BinaryPayload, type Conversation, asMessageId, asConversationId, asUserId } from '@nyx/shared';

let isInitialized = false;

// Module-level state for offline sync (lives across reconnects)
// Exported for unit tests only.
export let syncCompleted = false;
// Guard anti-overlap: doSyncMessages bisa dipicu bersamaan dari connect handler,
// polling, dan subscription Zustand. Tanpa ini, dua loop sync bisa jalan paralel.
let syncInProgress = false;
// ONE-shot delayed retry ketika sync loop gagal di tengah jalan (perbaikan #3).
// Berbeda dengan syncRetryTimer (polling conversations kosong), timer ini
// menangani kasus conversations SUDAH ada tapi loadMessagesForConversation gagal.
let syncFailureRetryTimer: ReturnType<typeof setTimeout> | null = null;
let unsubConversation: (() => void) | null = null;

// ONE-shot delayed retry for the offline sync poll. If the conversations list
// hasn't loaded after the normal 8×500ms polling window (e.g. during a reconnect
// storm), we schedule delayed retries with escalating backoff (15s → 30s → 60s)
// instead of silently giving up after a single 15s attempt (perbaikan #4). Still
// bounded: maksimal 3 retry per siklus koneksi, tidak ada loop tak terbatas.
// Timer dibersihkan/digantikan pada connect berikutnya atau saat sync nyata mulai.
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let finalRetryAttempts = 0;
const FINAL_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];

function clearSyncRetryTimer() {
  if (syncRetryTimer) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }
  if (syncFailureRetryTimer) {
    clearTimeout(syncFailureRetryTimer);
    syncFailureRetryTimer = null;
  }
}

// Captured at connect time so a force_logout event from a *previous* session
// (one established before the current login) is ignored as stale.
let connectionLoginGeneration = 0;

// Unit-test hook: reset the module-level sync flag between tests.
export function resetSocketSyncForTests() {
  syncCompleted = false;
  syncInProgress = false;
}

// Shared sync function — accessible from both connect handler and subscription
// (exported for unit tests).
export async function doSyncMessages() {
  if (syncCompleted) return;
  // Anti-overlap: polling, connect handler, dan subscription bisa memicu sync
  // hampir bersamaan — jangan biarkan dua loop berjalan paralel.
  if (syncInProgress) return;
  // A real sync is starting (or being attempted) — supersede any pending retry.
  clearSyncRetryTimer();
  syncInProgress = true;
  try {
    const conversations = useConversationStore.getState().conversations;
    if (conversations.length === 0) return;

    const messageStore = useMessageStore.getState();
    const failed: string[] = [];
    for (const conv of conversations) {
      if (conv.id.startsWith('burner_')) continue;
      // BUGFIX: sebelumnya percakapan grup dengan metadata yang belum terdekripsi
      // di-skip, sehingga pesan grup yang masuk saat offline tidak pernah diambil
      // saat reconnect. loadMessagesForConversation memproses control message
      // (GROUP_KEY_DISTRIBUTION / METADATA_UPDATED) lebih dulu, jadi kunci + metadata
      // akan terpasang sebelum pesan didekripsi.
      try {
        await messageStore.loadMessagesForConversation(conv.id);
      } catch (convErr) {
        // Satu conversation gagal tidak boleh membatalkan sync lainnya.
        console.error(`[Offline Sync] Failed to sync conversation ${conv.id}:`, convErr);
        failed.push(conv.id);
      }
    }
    // Kirim pesan offline yang tertahan (idempotent, self-guarded).
    // Dijalankan meski sebagian conversation gagal — pesan keluar tak boleh
    // ikut tertahan karena kegagalan sync masuk. Promise.resolve() melindungi
    // dari implementasi yang tidak mengembalikan Promise.
    Promise.resolve(messageStore.processOfflineQueue()).catch((e) => {
      console.error('[Offline Queue] Failed to process after sync:', e);
    });

    if (failed.length > 0) {
      // Perbaikan #3: JANGAN set syncCompleted jika ada conversation yang gagal
      // di-sync — sebelumnya flag di-set SEBELUM loop, sehingga kegagalan apa pun
      // (jaringan putus di tengah, dekripsi error, dll.) membuat sync dianggap
      // selesai dan pesan yang tertinggal tidak pernah diambil sampai reconnect.
      // Jadwalkan SATU retry (bounded, tanpa loop tak terbatas).
      console.warn(`[Offline Sync] ${failed.length} conversation(s) failed to sync, scheduling one retry.`);
      if (!syncFailureRetryTimer) {
        syncFailureRetryTimer = setTimeout(() => {
          syncFailureRetryTimer = null;
          if (!syncCompleted && !syncInProgress) void doSyncMessages();
        }, 5000);
      }
    } else {
      // Semua conversation tersync — baru tandai selesai.
      syncCompleted = true;
    }
  } catch (e) {
    console.error('[Offline Sync] Failed to sync messages on connect:', e);
  } finally {
    syncInProgress = false;
  }
}

export function initSocketListeners() {
  if (isInitialized) return;
  isInitialized = true;

  // Register Zustand subscription ONCE (no leak on reconnect)
  unsubConversation = useConversationStore.subscribe((state, prevState) => {
    if (!syncCompleted && state.conversations.length > 0 && prevState.conversations.length === 0) {
      doSyncMessages();
    }
  });

  transportClient.on('connect', () => {
    useConnectionStore.getState().setStatus('connected');
    
    // User is active by default on connect
    transportClient.sendEvent('user:active');

    // Offline Sync: fetch pending messages for all active conversations
    // Reset sync flag on each connect so new messages are fetched
    syncCompleted = false;
    // Reset the one-shot retry state for this connection cycle.
    clearSyncRetryTimer();
    finalRetryAttempts = 0;
    // Capture the login generation so stale force_logout events from a prior
    // session can be ignored.
    connectionLoginGeneration = useAuthStore.getState().loginGeneration ?? 0;

    // Uses polling + Zustand subscription for reliable init regardless of load order
    let syncAttempts = 0;
    const maxSyncAttempts = 8;
    const pollSyncMessages = async () => {
      if (syncCompleted) return;
      const conversations = useConversationStore.getState().conversations;
      if (conversations.length === 0) {
        if (syncAttempts < maxSyncAttempts) {
          syncAttempts++;
          setTimeout(pollSyncMessages, 500);
        } else if (finalRetryAttempts < FINAL_RETRY_DELAYS_MS.length) {
          // Normal polling exhausted (conversations still empty after a reconnect
          // storm). Escalating backoff 15s → 30s → 60s, lalu berhenti — no infinite
          // loop. Cleared/superseded on the next connect or a real sync.
          const delay = FINAL_RETRY_DELAYS_MS[finalRetryAttempts];
          finalRetryAttempts++;
          syncRetryTimer = setTimeout(() => {
            syncRetryTimer = null;
            if (!syncCompleted) pollSyncMessages();
          }, delay);
        }
        return;
      }
      await doSyncMessages();
    };
    // Polling fallback: start after a short delay
    setTimeout(pollSyncMessages, 300);
  });

  transportClient.on('disconnect', (reason) => {
    useConnectionStore.getState().setStatus('disconnected');

    if (reason === 'Logged in on another device') {
      const { logout } = useAuthStore.getState();
      logout().then(() => {
        window.location.href = `/login?reason=kicked&msg=${encodeURIComponent(reason)}`;
      });
    }
  });

  // 1. MESSAGES
  transportClient.on('message:new', async (payload: BinaryPayload | RawServerMessage) => {
    let rawMsg: RawServerMessage;
    if (payload instanceof Uint8Array) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload));
        rawMsg = RawServerMessageSchema.parse(parsed);
      } catch (e) {
        console.error("[Socket] Failed to decode message:new payload", e);
        return;
      }
    } else {
      rawMsg = RawServerMessageSchema.parse(payload);
    }

    try {
      // Convert RawServerMessage to Message by applying branded types
      const msgForStore = {
        ...rawMsg,
        id: asMessageId(rawMsg.id),
        conversationId: asConversationId(rawMsg.conversationId),
        senderId: asUserId(rawMsg.senderId),
        createdAt: rawMsg.createdAt,
        reactions: [] as Message['reactions'],
        sender: rawMsg.sender ? { ...rawMsg.sender, id: asUserId(rawMsg.sender.id) } : undefined,
        repliedToId: rawMsg.repliedToId ? asMessageId(rawMsg.repliedToId) : undefined,
      } as Message;
      
      const msg = await useMessageStore.getState().addIncomingMessage(rawMsg.conversationId, msgForStore);
      if (msg) {
        useConversationStore.getState().updateConversationLastMessage(rawMsg.conversationId, msg);
      }
    } catch (e) {
      console.error("[Socket] Error handling message:new:", e);
    }
  });

  transportClient.on('message:updated', (data: Partial<RawServerMessage> & { id: string, conversationId: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.id, data as Partial<Message>);
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
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
      const data = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
      if (data.type === 'bulk' && Array.isArray(data.userIds)) {
        usePresenceStore.getState().setOnlineUsers(Array.from(data.userIds as unknown[], id => String(id)));
      } else if (data.type === 'join' && typeof data.userId === 'string') {
        usePresenceStore.getState().userJoined(data.userId);
      } else if (data.type === 'leave' && typeof data.userId === 'string') {
        usePresenceStore.getState().userLeft(data.userId);
      } else if (data.type === 'typing' && typeof data.userId === 'string') {
        usePresenceStore.getState().addOrUpdate({
          id: data.userId,
          conversationId: typeof data.conversationId === 'string' ? data.conversationId : '',
          isTyping: Boolean(data.isTyping)
        });
      }
    } catch (e) {}
  });

  // 5. SECURITY & SESSIONS
  transportClient.on('force_logout', async (data: { jti: string }) => {
     const auth = useAuthStore.getState();
     // Guard (a): already logged out / no active session → ignore (stale event).
     if (!auth.accessToken && !auth.user) return;
     // Guard (b): stale event from a prior session. If a newer login occurred
     // after this socket connection was established, the force_logout belongs to
     // the old session and must not log out the current one.
     if ((auth.loginGeneration ?? 0) > connectionLoginGeneration) return;
     // Check if current session is revoked
     const { logout } = auth;
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
        // storeReceivedSessionKey already schedules reDecryptPendingMessages internally
        // when metadata is decrypted. Don't call it here unconditionally — it would
        // advance the sender key ratchet (CK N=0→N=1) before group metadata decrypts.
      })
      .catch(captureAndLog);
  });
  
  transportClient.on('session:fulfill_request', (data: { conversationId: string; sessionId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string }) => {
    import('../utils/crypto').then(m => m.fulfillKeyRequest(data).catch(captureAndLog));
  });

  transportClient.on('group:fulfill_key_request', (data: { conversationId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string; requesterDeviceId?: string }) => {
    import('../utils/crypto').then(m => m.fulfillGroupKeyRequest(data).catch(captureAndLog));
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

