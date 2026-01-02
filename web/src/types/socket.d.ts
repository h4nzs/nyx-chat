import type { Conversation, Message, User } from '@store/conversation';

export interface ServerToClientEvents {
    connect: () => void;
    disconnect: (reason: string) => void;
    "message:new": (message: Message) => void;
    "message:updated": (message: Message) => void;
    "message:deleted": (payload: { conversationId: string; id: string }) => void;
    "reaction:new": (payload: { conversationId: string; messageId: string; reaction: any }) => void;
    "reaction:deleted": (payload: { conversationId: string; messageId: string; reactionId: string }) => void;
    "conversation:new": (conversation: Conversation) => void;
    "conversation:updated": (conversation: Partial<Conversation> & { id: string }) => void;
    "conversation:deleted": (payload: { id: string }) => void;
    "conversation:participants_added": (payload: { conversationId: string; newParticipants: any[] }) => void;
    "conversation:participant_removed": (payload: { conversationId: string; userId: string }) => void;
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
    }) => void;
    "session:fulfill_request": (payload: {
        conversationId: string;
        sessionId: string;
        requesterId: string;
        requesterPublicKey: string;
    }) => void;
    "group:fulfill_key_request": (payload: {
        conversationId: string;
        requesterId: string;
        requesterPublicKey: string;
    }) => void;
    force_logout: () => void;
    'user:identity_changed': (data: { userId: string; name: string }) => void;
}

export interface ClientToServerEvents {
    "presence:update": (payload: { userId: string; online: boolean }) => void;
    "message:send": (message: Partial<Message>, callback: (res: { ok: boolean, msg?: Message, error?: string }) => void) => void;
    "message:ack_delivered": (payload: { messageId: string; conversationId: string }) => void;
    "message:mark_as_read": (payload: { messageId: string; conversationId: string }) => void;
    "typing:start": (payload: { conversationId: string }) => void;
    "typing:stop": (payload: { conversationId: string }) => void;
    "conversation:join": (conversationId: string) => void;
    "session:request_key": (payload: { conversationId: string; sessionId: string }) => void;
    "session:fulfill_response": (payload: {
        requesterId: string;
        conversationId: string;
        sessionId: string;
        encryptedKey: string;
    }) => void;
    "messages:distribute_keys": (payload: {
        conversationId: string;
        keys: { userId: string; key: string }[];
    }) => void;
    "group:request_key": (payload: { conversationId: string }) => void;
    "group:fulfilled_key": (payload: {
        requesterId: string;
        conversationId: string;
        encryptedKey: string;
    }) => void;
    "push:subscribe": (payload: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
    }) => void;
    "push:unsubscribe": () => void;
    "linking:join_room": (roomId: string) => void;
    "linking:send_payload": (payload: {
        roomId: string;
        encryptedMasterKey: string;
    }) => void;
}
