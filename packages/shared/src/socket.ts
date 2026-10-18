import type { Conversation, Message, User } from './types.js';
import type { RawServerMessage } from './schemas.js';
import { SubscriptionTier } from './constants.js';

// --- Type Definitions for Socket Payloads (Zero-Knowledge) ---
export interface TypingPayload {
  conversationId: string;
}

export interface DistributeKeysPayload {
  conversationId: string;
  keys: { userId: string; targetDeviceId?: string; targetDeviceKey?: string; key: string; senderDeviceKey?: string; drHeader?: any }[];
  /** [T1] Opaque per-group sender pseudonym — relayed verbatim instead of the
   *  authenticated userId so the key-distribution graph stays unlinkable. */
  senderPseudonym?: string;
}

export interface MessageSendPayload {
  conversationId: string;
  content: string; // This is the ciphertext
  sessionId?: string;
  tempId: number;
  expiresAt?: string;
  pushPayloads?: Record<string, string>; // { userId: encryptedPushPayload }
  repliedToId?: string;
  isViewOnce?: boolean;
  targetRecipients?: string[]; // Opaque Mailbox: list of user IDs to receive this message
  deleteSecret?: string; // Secret for blind authorization of message deletion
  /** [T1] Opaque per-group sender pseudonym (doc 26.2). Absent → legacy. */
  senderPseudonym?: string;
  /** [T3b] Map userId -> delivery token, piggybacked on invite messages. */
  targetDeliveryTokens?: Record<string, string>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface MarkAsReadPayload {
  messageId: string;
  conversationId: string;
}

export interface KeyRequestPayload {
  conversationId: string;
  sessionId: string;
  targetId?: string;
  requesterId?: string;
  requesterPublicKey?: string;
  requesterPqPublicKey?: string;
  requesterDeviceId?: string;
}

export interface GroupKeyRequestPayload {
  conversationId: string;
  targetSenderId?: string;
  targetDeviceKey?: string;
  requesterId?: string;
  requesterDeviceId?: string;
  requesterPublicKey?: string;
}

export interface KeyFulfillmentPayload {
  requesterId: string;
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
  targetDeviceId?: string;
  senderDeviceKey?: string;
  drHeader?: any;
}

/**
 * [docs/28 Tier 1.5 / D14] Status presence balasan langganan (`type: 'sync'`
 * pada wire opcode PRESENCE). Hanya memuat peer yang benar-benar disubscribe.
 */
export interface PresenceSyncPayload {
    statuses: Array<{ userId: string; online: boolean }>;
}

export interface ServerToClientEvents {
    connect: () => void;
    disconnect: (reason: string) => void;
    "error": (payload: { message?: string, error?: string }) => void; // Added
    "message:new": (message: RawServerMessage) => void; // Must be RawServerMessage, not the internal Message
    // [CLEANUP 2026-10-18] `message:updated` DIHAPUS: tidak ada emitter di server
    // (edit pesan dikirim ulang sebagai `message:new` setelah diverifikasi, dan
    // perubahan lokal memakai aksi store langsung).
    "message:deleted": (payload: { conversationId: string; id: string }) => void;
    // [GAP 2026-10-18] `message:viewed` dikirim server (view-once dibuka peer) dan
    // kini punya listener di klien; tiga sequencer masal/expire juga:
    // `message:deleted_batch` (messageSweeper) dan `message:deleted_remotely`.
    "message:viewed": (payload: { messageId: string; conversationId: string }) => void;
    "conversation:new": (conversation: Conversation) => void;
    "conversation:updated": (conversation: Partial<Conversation> & { id: string }) => void;
    "conversation:deleted": (payload: { id: string }) => void;
    // [CLEANUP 2026-10-18] `conversation:participants_added` (nama payload
    // `newParticipants`) DIHAPUS: tidak ada emitter di server — keanggotaan baru
    // sampai lewat `conversation:updated` + refresh metadata terenkripsi.
    "conversation:participant_removed": (payload: { conversationId: string; userId: string }) => void;
    // [CLEANUP 2026-10-18] `conversation:participant_updated` DIHAPUS: tidak ada
    // emitter di server — perubahan peran diumumkan lewat `conversation:updated`
    // + refresh metadata terenkripsi.
    "user:updated": (user: Partial<User> & { id: string }) => void;
    "message:status_updated": (payload: {
        conversationId: string;
        messageId: string;
        deliveredTo?: string;
        readBy?: string;
        status: 'SENT' | 'DELIVERED' | 'READ';
    }) => void;
    // [CLEANUP 2026-10-18] `presence:init` / `presence:user_joined` /
    // `presence:user_left` DIHAPUS: sisa kontrak socket.io lama, tidak pernah
    // di-emit lagi (presence kini payload opcode PRESENCE `{type:'sync'|'join'|
    // 'leave'}` — lihat `PresenceSyncPayload` di bawah).
    // [CLEANUP 2026-10-18] `presence:sync` dan `typing:update` TIDAK PERNAH
    // di-emit: keduanya tiba sebagai payload opcode PRESENCE (`{type:'sync'}` /
    // `{type:'typing'}`) dan sudah ditangani klien di jalur itu. Bentuk wire-nya
    // tetap terlihat di `PresenceSyncPayload` di bawah.
    "session:new_key": (payload: {
        conversationId: string;
        sessionId?: string;
        encryptedKey: string;
        type?: 'GROUP_KEY' | 'SESSION_KEY';
        senderId?: string; // Added
        senderDeviceKey?: string;
    }) => void;
    // [CLEANUP 2026-10-18] `session:fulfill_request` (alias) dan
    // `session:key_requested` DIHAPUS: yang benar-benar di-emit server adalah
    // `session:request_key` (di bawah) — dulu klien mendengarkan nama yang salah,
    // sehingga permintaan kunci sesi 1:1 tidak pernah difulfil.
    "subscription_updated": (payload: {
        tier: SubscriptionTier;
        expiresAt: string;
    }) => void;
    "group:fulfill_key_request": (payload: {
        conversationId: string;
        requesterId: string;
        requesterPublicKey: string;
        requesterPqPublicKey: string;
        requesterDeviceId?: string;
    }) => void;
    "group:key_request_failed": (payload: { conversationId: string; reason: string }) => void;
    "session:request_key_failed": (payload: { sessionId: string; targetId: string; reason: string }) => void;
    force_logout: (payload?: { jti?: string }) => void; // Updated
    'auth:banned': (payload: { reason: string }) => void; // Added
    // [CLEANUP 2026-10-18] `user:identity_changed` DIHAPUS (tanpa emitter);
    // perubahan identitas diumumkan lewat `user:updated`.
    "group:participants_changed": (payload: { conversationId: string }) => void;
    "session:request_key": (payload: { 
        conversationId: string; 
        requesterId: string; 
        sessionId: string;
        requesterPublicKey?: string;
        requesterPqPublicKey?: string;
        requesterDeviceId?: string;
    }) => void;

    // --- WEBRTC E2EE SIGNALING ---
    "webrtc:secure_signal": (payload: { from: string; type: string; payload: string }) => void;

    // --- DEVICE MIGRATION TUNNEL (SERVER -> CLIENT) ---
    // [docs/31 §31.6c] `chunk` = base64url dari potongan arsip `.nyxbak`.
    // BUKAN `ArrayBuffer`: transport men-serialize payload dengan JSON, jadi
    // `ArrayBuffer` mentah menjadi `{}` dan bagian isi hilang. Tipe ini dulu
    // masih `ArrayBuffer` (sisa desain lama) dan karena klien memakai map event
    // sendiri di `transportClient.ts` perbedaan itu tidak terdeteksi compiler —
    // tipe yang menyesatkan, sampai diselaraskan di sini.
    "migration:start": (payload: { roomId: string; totalChunks: number; sealedKey: string }) => void;
    "migration:chunk": (payload: { roomId: string; chunkIndex: number; chunk: string }) => void;
    "migration:ack": (payload: { roomId: string; success: boolean }) => void;
    'message:deleted_remotely': (payload: { messageId: string; conversationId: string; deletedBy: string }) => void;
    /** [GAP 2026-10-18] messageSweeper menghapus pesan kedaluwarsa massal. */
    'message:deleted_batch': (payload: { conversationId: string; messageIds: string[] }) => void;
    "burner:receive": (payload: { roomId: string; ciphertext: string }) => void;
    "burner:terminated": (payload: { roomId: string }) => void;
}

export interface ClientToServerEvents {
    "presence:update": (payload: { userId: string; online: boolean }) => void;
    /**
     * [docs/28 Tier 1.5 / D14] Presence lazy/opt-in: klien meminta status untuk
     * kontak yang sedang ia tampilkan. Server hanya menerima id yang benar-benar
     * peer (diturunkan dari membership), jadi endpoint ini tidak bisa dipakai
     * untuk memetakan pengguna lain.
     */
    "presence:subscribe": (payload: { userIds: string[] }) => void;
    "user:active": () => void;
    "user:away": () => void;
    "message:send": (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => void) => void;
    "message:ack_delivered": (payload: MarkAsReadPayload) => void;
    "message:mark_as_read": (payload: MarkAsReadPayload) => void;
    "typing:start": (payload: TypingPayload) => void;
    "typing:stop": (payload: TypingPayload) => void;
    // [CLEANUP 2026-10-18] `conversation:join` DIHAPUS: tidak ada handler di
    // server dan tidak ada pemanggil di klien (routing memakai keanggotaan di DB).
    "session:request_key": (payload: KeyRequestPayload) => void;
    // [CLEANUP 2026-10-18] `session:request_missing` (dan balasannya
    // `session:key_requested`) DIHAPUS: tidak ada klien yang mengirimnya, dan
    // permintaan kunci yang nyata dikirim lewat `session:request_key`
    // (+ `targetId`, yang diwajibkan server Opaque Mailbox).
    "session:fulfill_response": (payload: KeyFulfillmentPayload) => void;
    "messages:distribute_keys": (payload: DistributeKeysPayload, callback: (res: { ok: boolean }) => void) => void;
    "group:request_key": (payload: GroupKeyRequestPayload) => void;
    "group:fulfilled_key": (payload: KeyFulfillmentPayload) => void;
    "push:subscribe": (payload: PushSubscribePayload) => void;
    "push:unsubscribe": () => void;
    // [CATATAN 2026-10-18] Handler server untuk event ini ADA dan ber-rate-limit,
    // tetapi belum ada klien yang memanggilnya (fitur QR device-linking belum
    // dibangun di UI). Dibiarkan sebagai kontrak; jangan dianggap terpakai.
    "auth:request_linking_qr": (payload: { publicKey: string }, callback: (res: { ok: boolean, qrData?: string }) => void) => void; // Added
    
    // --- WEBRTC E2EE SIGNALING ---
    "webrtc:secure_signal": (payload: { to: string; type: string; payload: string }) => void;
    
    // --- DEVICE MIGRATION TUNNEL (CLIENT -> SERVER) ---
    // Lihat catatan `ServerToClientEvents`: `chunk` adalah base64url (string).
    "migration:join": (roomId: string) => void;
    "migration:start": (payload: { roomId: string; totalChunks: number; sealedKey: string }) => void;
    "migration:chunk": (payload: { roomId: string; chunkIndex: number; chunk: string }) => void;
    "migration:ack": (payload: { roomId: string; success: boolean }) => void;
    'message:unsend': (payload: { messageId: string; conversationId: string }) => void;
    'message:view_once_opened': (payload: { messageId: string; conversationId: string }) => void;
    "burner:send": (payload: { roomId: string; targetDeviceId: string; ciphertext: string; hostUserId: string }, callback: (res: { ok: boolean; error?: string }) => void) => void;
    // [BURNER 2026-10-18] ACK wajib: join mengembalikan status room (guest bisa
    // tahu room sudah dihancurkan tanpa menunggu event realtime), reply/destroy
    // memberi umpan balik supaya kegagalan tidak lagi hening di UI.
    "burner:join": (
      payload: { roomId: string },
      callback: (res: { ok: boolean; terminated?: boolean }) => void
    ) => void;
    "burner:reply": (
      payload: { roomId: string; ciphertext: string },
      callback: (res: { ok: boolean; error?: string; notified?: number }) => void
    ) => void;
    "burner:destroy": (
      payload: { roomId: string; hostUserId?: string },
      callback: (res: { ok: boolean; notified?: number }) => void
    ) => void;
}
