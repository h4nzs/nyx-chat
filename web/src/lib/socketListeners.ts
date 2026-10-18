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
// [docs/28 Tier 1.5 / D14] presence lazy: minta ulang langganan tiap koneksi baru.
import { resetPresenceSubscriptionCache } from './presenceSubscribe';
import { isForceLogoutForThisDevice } from './forceLogout';
import { RawServerMessageSchema, type RawServerMessage, type Message, type User, type BinaryPayload, type Conversation, type SubscriptionTier, asMessageId, asConversationId, asUserId } from '@nyx/shared';

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

// [ROBUSTNESS] Generasi koneksi: setiap connect menaikkan counter. Poll chain
// dari koneksi lama yang masih menggantung (disconnect di tengah polling)
// otomatis mati karena generasinya tidak cocok lagi — dulu chain lama bisa
// bertabrakan dengan chain koneksi baru (tidak fatal karena guard
// syncInProgress, tapi tetap noise).
let syncPollGeneration = 0;
// [ROBUSTNESS] Bound untuk failure retry: dulu setiap kegagalan sync
// menjadwalkan retry 5s berikutnya TANPA BATAS — saat server unreachable
// dengan conversations sudah termuat, loop gagal→5s→gagal berjalan terus
// selamanya (spam request + console). Sekarang maksimal 3 retry per siklus
// koneksi; connect berikutnya me-reset hitungan.
let syncFailureAttempts = 0;
const MAX_SYNC_FAILURE_RETRIES = 3;

// Unit-test hook: reset the module-level sync flag between tests.
export function resetSocketSyncForTests() {
  syncCompleted = false;
  syncInProgress = false;
  syncFailureAttempts = 0;
  syncPollGeneration = 0;
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
      // Jadwalkan retry (bounded — lihat MAX_SYNC_FAILURE_RETRIES di atas).
      console.warn(`[Offline Sync] ${failed.length} conversation(s) failed to sync, scheduling one retry.`);
      if (syncFailureAttempts < MAX_SYNC_FAILURE_RETRIES) {
        syncFailureAttempts++;
        if (!syncFailureRetryTimer) {
          syncFailureRetryTimer = setTimeout(() => {
            syncFailureRetryTimer = null;
            if (!syncCompleted && !syncInProgress) void doSyncMessages();
          }, 5000);
        }
      } else {
        console.warn(`[Offline Sync] Batas ${MAX_SYNC_FAILURE_RETRIES} retry gagal tercapai — menunggu reconnect berikutnya.`);
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
    // [docs/28 Tier 1.5 / D14] Koneksi baru = langganan presence lama sudah
    // dibuang server (registry in-memory) → lupakan cache lokal supaya hook
    // presence mengirim ulang `presence:subscribe`.
    resetPresenceSubscriptionCache();
    transportClient.sendEvent('user:active');

    // Offline Sync: fetch pending messages for all active conversations
    // Reset sync flag on each connect so new messages are fetched
    syncCompleted = false;
    // Reset the one-shot retry state for this connection cycle.
    clearSyncRetryTimer();
    finalRetryAttempts = 0;
    syncFailureAttempts = 0;
    // Generasi baru mematikan poll chain dari koneksi sebelumnya.
    const pollGeneration = ++syncPollGeneration;
    // Capture the login generation so stale force_logout events from a prior
    // session can be ignored.
    connectionLoginGeneration = useAuthStore.getState().loginGeneration ?? 0;

    // Uses polling + Zustand subscription for reliable init regardless of load order
    let syncAttempts = 0;
    const maxSyncAttempts = 8;
    const pollSyncMessages = async () => {
      // [ROBUSTNESS] Koneksi ini sudah digantikan → jangan lanjutkan chain.
      if (pollGeneration !== syncPollGeneration) return;
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

    // [ROBUSTNESS] Matikan poll chain + retry timer milik siklus koneksi ini:
    // mencoba sync saat diskonek hanya menghasilkan request gagal berulang.
    // Connect berikutnya menyalakan semuanya lagi dari nol.
    syncPollGeneration++;
    clearSyncRetryTimer();

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

  // (listener `message:updated` dihapus: server tidak pernah meng-emit event itu;
  // edit pesan tiba sebagai `message:new` ulang / aksi store langsung.)
  transportClient.on('message:deleted', (data: { conversationId: string; id: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.id, { isDeletedLocal: true, content: null });
  });

  // [PARITY/GAP 2026-10-18] Server MENGIRIM keempat event ini, tetapi tidak ada
  // satu pun listener di klien (grep `web/` = 0 hasil) — jadi efeknya terlihat
  // "tidak nyata" di UI sampai reload, padahal datanya di server sudah berubah:
  //   - message:deleted_remotely → peer melakukan unsend (realtimeHandlers
  //     `message:unsend`); pengirim di sisi ini harus melihat pesannya hilang.
  //   - message:deleted_batch    → messageSweeper menghapus pesan kedaluwarsa
  //     (auto-delete / TTL 14 hari) untuk SEMUA penerima sekaligus.
  //   - message:viewed           → view-once dibuka peer; server MENGHAPUS barisnya
  //     (`message:view_once_opened`) — sisi pengirim menampilkannya sebagai sudah
  //     tidak ada, bukan konten yang bisa dibuka lagi.
  // Semuanya memakai jalur yang sama dengan `message:deleted` (updateMessage +
  // isDeletedLocal) supaya penyimpanan ter-seal di vault ikut mencatat.
  transportClient.on('message:deleted_remotely', (data: { conversationId: string; messageId: string; deletedBy?: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.messageId, { isDeletedLocal: true, content: null });
  });

  transportClient.on('message:deleted_batch', (data: { conversationId: string; messageIds: string[] }) => {
    if (!data?.conversationId || !Array.isArray(data.messageIds)) return;
    const store = useMessageStore.getState();
    for (const messageId of data.messageIds) {
      if (typeof messageId === 'string') {
        store.updateMessage(data.conversationId, messageId, { isDeletedLocal: true, content: null });
      }
    }
  });

  transportClient.on('message:viewed', (data: { conversationId: string; messageId: string }) => {
    useMessageStore.getState().updateMessage(data.conversationId, data.messageId, { isDeletedLocal: true, content: null });
  });

  transportClient.on('message:status_updated', (data: { conversationId: string; messageId: string; userId: string; status: string }) => {
    useMessageStore.getState().updateMessageStatus(data.conversationId, data.messageId, data.userId, data.status);
  });

  // 2. CONVERSATIONS
  transportClient.on('conversation:new', (conversation: Conversation) => {
    useConversationStore.getState().addOrUpdateConversation(conversation);
    // [CONTACT STORE LIVE 2026-10-09] Percakapan 1:1 baru (peer mengirim pesan
    // pertama) harus langsung masuk contact store — sebelumnya daftar kontak
    // hanya di-seed saat loadConversations sehingga picker (create grup, story)
    // tampak kosong sampai user reload. Server Opaque Mailbox mengirim
    // participants kosong; jalur pesan (doAddIncomingMessage) yang mengisi
    // sisanya, seeding di sini menangani bentuk data yang sudah membawa roster.
    if (!conversation.isGroup && conversation.participants?.length) {
      void import('@lib/contactStore')
        .then(({ seedContactsFromConversation }) => seedContactsFromConversation(conversation))
        .catch((e) => console.warn('[ContactStore] Seed dari conversation:new gagal:', e));
    }
  });

  transportClient.on('conversation:updated', (data: Partial<Conversation> & { id: string }) => {
    useConversationStore.getState().updateConversation(data.id, data);
  });

  transportClient.on('conversation:deleted', (data: { id: string; reason?: 'removed' | 'hidden' }) => {
    // [BUGFIX 2026-10-18] `reason: 'removed'` = kick. Riwayat lokal (pesan vault +
    // kunci era) dipertahankan supaya tetap terbaca bila anggota di-add kembali.
    // `'hidden'`/tanpa reason (server lama) = hapus lokal seperti biasa.
    useConversationStore.getState().removeConversation(data.id, {
      preserveHistory: data.reason === 'removed',
    });
  });

  transportClient.on('conversation:participant_removed', (data: { conversationId: string; userId: string }) => {
    useConversationStore.getState().removeParticipant(data.conversationId, data.userId);
    // [T1 FIX 2026-09-28] Kick/leave = perubahan keanggotaan: tandai perlu
    // rotasi agar kirim pesan berikutnya men-distribusikan kunci era baru
    // (jalur pasif untuk non-admin; admin melakukan rotasi aktif di UI).
    useConversationStore.getState().markKeyRotationNeeded(data.conversationId, true);
  });

  // [T1 FIX 2026-09-28] Sebelumnya TIDAK ADA listener untuk event ini (server
  // meng-emit-nya pada add/kick/leave) — member non-admin tak tahu keanggotaan
  // berubah sampai reload. Aksi: refresh metadata dari server (metadata baru
  // membawa peta pseudonym generation+1 dari admin) + tandai rotasi kunci.
  transportClient.on('group:participants_changed', (data: { conversationId: string }) => {
    void (async () => {
      const conversationId = data.conversationId;
      useConversationStore.getState().markKeyRotationNeeded(conversationId, true);
      try {
        const { authFetch } = await import('@lib/api');
        const serverConv = await authFetch<{ encryptedMetadata?: string }>(`/api/conversations/${conversationId}`);
        if (serverConv?.encryptedMetadata) {
          await useConversationStore.getState().updateConversation(conversationId, {
            encryptedMetadata: serverConv.encryptedMetadata
          });
        }
      } catch (e) {
        console.warn('[T1] Failed to refresh metadata after membership change:', e);
      }
    })();
  });

  // (listener `conversation:participant_updated` dihapus: tidak ada emitter di
  // server — peran berubah lewat `conversation:updated` + metadata terenkripsi.)

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
        // Warisan server lama (roster penuh) — tetap dikenali agar klien baru
        // tidak buta saat server belum di-upgrade.
        usePresenceStore.getState().setOnlineUsers(Array.from(data.userIds as unknown[], id => String(id)));
      } else if (data.type === 'sync' && Array.isArray(data.statuses)) {
        // [docs/28 Tier 1.5 / D14] balasan langganan presence per-kontak.
        const statuses = (data.statuses as unknown[])
          .map((raw) => {
            const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
            return { userId: typeof s.userId === 'string' ? s.userId : '', online: s.online === true };
          })
          .filter((s) => s.userId.length > 0);
        usePresenceStore.getState().applyStatuses(statuses);
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
  transportClient.on('force_logout', async (data: { jti?: string; deviceId?: string; reason?: string }) => {
     const auth = useAuthStore.getState();
     // Guard (a): already logged out / no active session → ignore (stale event).
     if (!auth.accessToken && !auth.user) return;
     // Guard (b): stale event from a prior session. If a newer login occurred
     // after this socket connection was established, the force_logout belongs to
     // the old session and must not log out the current one.
     if ((auth.loginGeneration ?? 0) > connectionLoginGeneration) return;
     // Guard (c) [BUGFIX 2026-10-18]: SCOPE DEVICE. Dulu event ini dikirim tanpa
     // deviceId ke semua socket milik user, jadi mencabut satu sesi (atau reuse
     // detection di satu tab) ikut me-logout perangkat lain yang sesinya masih
     // sah. Server sekarang menyertakan deviceId; abaikan bila bukan device ini.
     // Bila deviceId tidak ada (server lama), perilaku lama dipertahankan.
     const localDeviceId = typeof localStorage !== 'undefined' ? localStorage.getItem('deviceId') : null;
     if (!isForceLogoutForThisDevice(data?.deviceId, localDeviceId)) {
       console.info('[Auth] force_logout untuk device lain diabaikan');
       return;
     }
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

  // [GAP 2026-10-18] Server meng-emit `subscription_updated` setelah webhook
  // pembayaran selesai (routes/subscriptions.ts), tetapi klien tidak punya
  // listener-nya — tier baru baru terlihat setelah refetch profil. Sekarang
  // `user.subscriptionTier` langsung diperbarui lewat aksi store yang sudah ada
  // (dipakai juga oleh halaman langganan), jadi batas unggah/grup ikut berubah
  // tanpa reload.
  transportClient.on('subscription_updated', (data: { tier?: SubscriptionTier; expiresAt?: string }) => {
    if (!data?.tier) return;
    useAuthStore.getState().updateSubscription(data.tier);
  });

  // 6. KEY MANAGEMENT
  transportClient.on('session:new_key', (data: { conversationId: string; sessionId?: string; encryptedKey: string; type?: 'GROUP_KEY' | 'SESSION_KEY'; senderId?: string; senderDeviceKey?: string; senderSigningKey?: string }) => {
    import('../utils/crypto').then(m => m.storeReceivedSessionKey(data))
      .then(() => {
        import('../store/keychain').then(m => m.useKeychainStore.getState().keysUpdated());
        // storeReceivedSessionKey already schedules reDecryptPendingMessages internally
        // when metadata is decrypted. Don't call it here unconditionally — it would
        // advance the sender key ratchet (CK N=0→N=1) before group metadata decrypts.
      })
      .catch(captureAndLog);
  });
  
  // [GAP 2026-10-18] Nama event yang BENAR dari server adalah `session:request_key`
  // (realtimeHandlers → emitEventToUser ke target), sedangkan yang didengarkan di
  // sini dulu `session:fulfill_request` — event yang tidak pernah di-emit siapa pun
  // (grep server = 0). Akibatnya permintaan kunci sesi 1:1 (mis. lampiran blind)
  // tidak pernah difulfil walau payload-nya identik. Listener dipindah ke nama
  // yang sebenarnya; `fulfillKeyRequest` tetap memakai bentuk payload yang sama.
  transportClient.on('session:request_key', (data: { conversationId: string; sessionId: string; requesterId: string; requesterPublicKey?: string; requesterPqPublicKey?: string; requesterDeviceId?: string }) => {
    const { conversationId, sessionId, requesterId, requesterPublicKey, requesterPqPublicKey } = data ?? {};
    if (typeof conversationId !== 'string' || typeof sessionId !== 'string' || typeof requesterId !== 'string') return;
    // Server mengirim kedua kunci itu opsional (device peminta bisa belum punya
    // kunci PQ) — `fulfillKeyRequest` mensyaratkan keduanya untuk mencocokkan
    // device requester, jadi tanpa itu permintaan dilewati (bukan error).
    if (typeof requesterPublicKey !== 'string' || typeof requesterPqPublicKey !== 'string') {
      console.warn('[Session] Permintaan kunci tanpa public key peminta — dilewati.');
      return;
    }
    import('../utils/crypto')
      .then(m => m.fulfillKeyRequest({ conversationId, sessionId, requesterId, requesterPublicKey, requesterPqPublicKey }).catch(captureAndLog));
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
    // [ROBUSTNESS] Routing roomId: kalau payload membawa roomId, pakai itu
    // (receiveMessage sudah aman untuk room yang belum ter-restore). Tanpa
    // roomId, fallback ke sesi pertama HANYA bila tepat ada satu sesi aktif —
    // bila 0 atau >1, routing ambigu (pesan bisa masuk ke room yang salah dan
    // menggugurkan DR state-nya) → drop dengan warning.
    const sessionIds = Object.keys(useBurnerStore.getState().activeSessions);
    let roomId = payload.roomId;
    if (!roomId) {
      const onlySession = sessionIds.length === 1 ? sessionIds[0] : undefined;
      if (onlySession === undefined) {
        console.warn(`[Burner] Pesan tanpa roomId & ${sessionIds.length} sesi aktif — di-drop (routing ambigu).`);
        return;
      }
      roomId = onlySession;
    }
    await useBurnerStore.getState().receiveMessage(roomId, payload.ciphertext);
  });

  transportClient.on("burner:terminated", async (payload: { roomId: string }) => {
    const { useBurnerStore } = await import('../store/burner');
    if (payload?.roomId) {
      // [BURNER 2026-10-18] `markRoomDestroyed` menulis penanda lokal
      // (`burned_<roomId>`) + mengosongkan pesan RAM. Tanpa penanda itu, guest
      // yang me-refresh halaman `/drop` bisa masuk kembali ke room yang sudah
      // dihancurkan selama status server belum sempat diperiksa.
      useBurnerStore.getState().markRoomDestroyed(payload.roomId);
      useConversationStore.getState().removeConversation(payload.roomId);
    }
  });
}

