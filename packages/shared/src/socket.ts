import type { Conversation, Message, User } from './types.js';
import type { RawServerMessage } from './schemas.js';

// --- Type Definitions for Socket Payloads (Zero-Knowledge) ---
export interface TypingPayload {
  conversationId: string;
}

export interface DistributeKeysPayload {
  conversationId: string;
  keys: { userId: string; targetDeviceId?: string; key: string; senderDeviceKey?: string; type: string }[];
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
}

export interface GroupKeyRequestPayload {
  conversationId: string;
  targetSenderId?: string;
  targetDeviceKey?: string;
}

export interface KeyFulfillmentPayload {
  requesterId: string;
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
  targetDeviceId?: string;
  senderDeviceKey?: string;
}

export interface ServerToClientEvents {
    connect: () => void;
    disconnect: (reason: string) => void;
    "error": (payload: { message?: string, error?: string }) => void; // Added
    "message:new": (message: RawServerMessage) => void; // Must be RawServerMessage, not the internal Message
    "message:updated": (message: Partial<RawServerMessage> & { id: string }) => void;
    "message:deleted": (payload: { conversationId: string; id: string }) => void;
    "message:viewed": (payload: { messageId: string; conversationId: string }) => void;
    "messages:expired": (payload: { messageIds: string[] }) => void;
    "reaction:new": (payload: { conversationId: string; messageId: string; reaction: { id: string; userId: string; emoji: string; isMessage?: boolean; tempId?: string } }) => void;
    "reaction:deleted": (payload: { conversationId: string; messageId: string; reactionId: string }) => void;
    "conversation:new": (conversation: Conversation) => void;
    "conversation:updated": (conversation: Partial<Conversation> & { id: string }) => void;
    "conversation:deleted": (payload: { id: string }) => void;
    "conversation:participants_added": (payload: { conversationId: string; newParticipants: { id: string; role: 'ADMIN' | 'MEMBER'; user: User; isPinned: boolean }[] }) => void;
    "conversation:participant_removed": (payload: { conversationId: string; userId: string }) => void;
    "conversation:participant_updated": (payload: { conversationId: string; userId: string; role: string }) => void; // Added
    "user:updated": (user: Partial<User> & { id: string }) => void;
    "message:status_updated": (payload: {
        conversationId: string;
        messageId: string;
        deliveredTo?: string;
        readBy?: string;
        status: 'SENT' | 'DELIVERED' | 'READ';
    }) => void;
    "presence:init": (onlineUserIds: string[]) => void;
    "presence:user_joined": (userId: string) => void;
    "presence:user_left": (userId: string) => void;
    "typing:update": (payload: { userId: string; conversationId: string; isTyping: boolean }) => void;
    "session:new_key": (payload: {
        conversationId: string;
        sessionId?: string;
        encryptedKey: string;
        type?: 'GROUP_KEY' | 'SESSION_KEY';
        senderId?: string; // Added
        senderDeviceKey?: string;
    }) => void;
    "session:fulfill_request": (payload: {
        conversationId: string;
        sessionId: string;
        requesterId: string;
        requesterPublicKey: string;
        requesterPqPublicKey: string;
    }) => void;
    "session:key_requested": (payload: { // Added
        conversationId: string;
        sessionId: string;
        requesterId: string;
    }) => void;
    "group:fulfill_key_request": (payload: {
        conversationId: string;
        requesterId: string;
        requesterPublicKey: string;
        requesterPqPublicKey: string;
        requesterDeviceId?: string;
    }) => void;
    force_logout: (payload?: { jti?: string }) => void; // Updated
    'auth:banned': (payload: { reason: string }) => void; // Added
    'user:identity_changed': (data: { userId: string; name?: string }) => void; // Made name optional
    "group:participants_changed": (payload: { conversationId: string }) => void;
    "session:request_key": (payload: { conversationId: string; requesterId: string; sessionId: string }) => void;

    // --- WEBRTC E2EE SIGNALING ---
    "webrtc:secure_signal": (payload: { from: string; type: string; payload: string }) => void;

    // --- DEVICE MIGRATION TUNNEL (SERVER -> CLIENT) ---
    "migration:start": (payload: { roomId: string; totalChunks: number; sealedKey: string }) => void;
    "migration:chunk": (payload: { roomId: string; chunkIndex: number; chunk: ArrayBuffer }) => void;
    "migration:ack": (payload: { roomId: string; success: boolean }) => void;
    'message:deleted_remotely': (payload: { messageId: string; conversationId: string; deletedBy: string }) => void;
}

export interface ClientToServerEvents {
    "presence:update": (payload: { userId: string; online: boolean }) => void;
    "user:active": () => void;
    "user:away": () => void;
    "message:send": (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => void) => void;
    "message:ack_delivered": (payload: MarkAsReadPayload) => void;
    "message:mark_as_read": (payload: MarkAsReadPayload) => void;
    "typing:start": (payload: TypingPayload) => void;
    "typing:stop": (payload: TypingPayload) => void;
    "conversation:join": (conversationId: string) => void;
    "session:request_key": (payload: KeyRequestPayload) => void;
    "session:request_missing": (payload: { conversationId: string; sessionId: string }) => void; // Added
    "session:fulfill_response": (payload: KeyFulfillmentPayload) => void;
    "messages:distribute_keys": (payload: DistributeKeysPayload) => void;
    "group:request_key": (payload: GroupKeyRequestPayload) => void;
    "group:fulfilled_key": (payload: KeyFulfillmentPayload) => void;
    "push:subscribe": (payload: PushSubscribePayload) => void;
    "push:unsubscribe": () => void;
    "auth:request_linking_qr": (payload: { publicKey: string }, callback: (res: { ok: boolean, qrData?: string }) => void) => void; // Added
    
    // --- WEBRTC E2EE SIGNALING ---
    "webrtc:secure_signal": (payload: { to: string; type: string; payload: string }) => void;
    
    // --- DEVICE MIGRATION TUNNEL (CLIENT -> SERVER) ---
    "migration:join": (roomId: string) => void;
    "migration:start": (payload: { roomId: string; totalChunks: number; sealedKey: string }) => void;
    "migration:chunk": (payload: { roomId: string; chunkIndex: number; chunk: ArrayBuffer }) => void;
    "migration:ack": (payload: { roomId: string; success: boolean }) => void;
    'message:unsend': (payload: { messageId: string; conversationId: string }) => void;
    'message:view_once_opened': (payload: { messageId: string; conversationId: string }) => void;
}
