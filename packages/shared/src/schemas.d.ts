import { z } from 'zod';
export declare const UserIdSchema: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
export declare const ConversationIdSchema: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
export declare const MessageIdSchema: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
export declare const StoryIdSchema: z.ZodEffects<z.ZodString, import("./brands").StoryId, string>;
export declare const MinimalUserSchema: z.ZodObject<{
    id: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    username: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    role: z.ZodOptional<z.ZodString>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    username: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    role: z.ZodOptional<z.ZodString>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    username: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    role: z.ZodOptional<z.ZodString>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
export declare const MinimalConversationSchema: z.ZodObject<{
    id: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, import("./brands").UserId, string>>>;
    updatedAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, import("./brands").UserId, string>>>;
    updatedAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, import("./brands").UserId, string>>>;
    updatedAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
export declare const IncomingMessageSchema: z.ZodObject<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timestamp: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    createdAt: z.ZodEffects<z.ZodDefault<z.ZodString>, string, unknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timestamp: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    createdAt: z.ZodEffects<z.ZodDefault<z.ZodString>, string, unknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timestamp: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    createdAt: z.ZodEffects<z.ZodDefault<z.ZodString>, string, unknown>;
}, z.ZodTypeAny, "passthrough">>;
export declare const WebRTCSignalTypeSchema: z.ZodEnum<["request", "accept", "offer", "answer", "ice-candidate", "end", "reject"]>;
export declare const WebRTCSignalingSchema: z.ZodObject<{
    type: z.ZodEnum<["request", "accept", "offer", "answer", "ice-candidate", "end", "reject"]>;
    from: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    payload: z.ZodOptional<z.ZodAny>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodEnum<["request", "accept", "offer", "answer", "ice-candidate", "end", "reject"]>;
    from: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    payload: z.ZodOptional<z.ZodAny>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodEnum<["request", "accept", "offer", "answer", "ice-candidate", "end", "reject"]>;
    from: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    payload: z.ZodOptional<z.ZodAny>;
}, z.ZodTypeAny, "passthrough">>;
export declare const ShadowVaultMessageSchema: z.ZodObject<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    status: z.ZodDefault<z.ZodOptional<z.ZodEnum<["sending", "sent", "delivered", "read", "failed"]>>>;
    repliedToId: z.ZodOptional<z.ZodString>;
    repliedTo: z.ZodOptional<z.ZodString>;
    senderName: z.ZodOptional<z.ZodString>;
    senderUsername: z.ZodOptional<z.ZodString>;
    senderAvatarUrl: z.ZodOptional<z.ZodString>;
    isViewOnce: z.ZodOptional<z.ZodBoolean>;
    isDeletedLocal: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    status: z.ZodDefault<z.ZodOptional<z.ZodEnum<["sending", "sent", "delivered", "read", "failed"]>>>;
    repliedToId: z.ZodOptional<z.ZodString>;
    repliedTo: z.ZodOptional<z.ZodString>;
    senderName: z.ZodOptional<z.ZodString>;
    senderUsername: z.ZodOptional<z.ZodString>;
    senderAvatarUrl: z.ZodOptional<z.ZodString>;
    isViewOnce: z.ZodOptional<z.ZodBoolean>;
    isDeletedLocal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    id: z.ZodEffects<z.ZodString, import("./brands").MessageId, string>;
    conversationId: z.ZodEffects<z.ZodString, import("./brands").ConversationId, string>;
    senderId: z.ZodEffects<z.ZodString, import("./brands").UserId, string>;
    content: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown>;
    status: z.ZodDefault<z.ZodOptional<z.ZodEnum<["sending", "sent", "delivered", "read", "failed"]>>>;
    repliedToId: z.ZodOptional<z.ZodString>;
    repliedTo: z.ZodOptional<z.ZodString>;
    senderName: z.ZodOptional<z.ZodString>;
    senderUsername: z.ZodOptional<z.ZodString>;
    senderAvatarUrl: z.ZodOptional<z.ZodString>;
    isViewOnce: z.ZodOptional<z.ZodBoolean>;
    isDeletedLocal: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
//# sourceMappingURL=schemas.d.ts.map