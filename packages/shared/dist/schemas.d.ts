import { z } from 'zod';
export declare const Base64StringSchema: z.ZodString;
export declare const PayloadStringSchema: z.ZodString;
export declare const UserIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
export declare const ConversationIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
export declare const MessageIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").MessageId, string>>;
export declare const StoryIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").StoryId, string>>;
export declare const EncryptionModeEnum: z.ZodEnum<{
    SENDER_KEY: "SENDER_KEY";
    PQ_DR: "PQ_DR";
}>;
export type EncryptionMode = z.infer<typeof EncryptionModeEnum>;
export declare const MinimalUserSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
    username: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    role: z.ZodOptional<z.ZodString>;
    isVerified: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const MinimalConversationSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    encryptedMetadata: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>>;
    updatedAt: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
    encryptionMode: z.ZodDefault<z.ZodEnum<{
        SENDER_KEY: "SENDER_KEY";
        PQ_DR: "PQ_DR";
    }>>;
    activePqDeviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ParticipantSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
    userId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>;
    user: z.ZodOptional<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
        publicKey: z.ZodOptional<z.ZodString>;
        pqPublicKey: z.ZodOptional<z.ZodString>;
        signingKey: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    publicKey: z.ZodOptional<z.ZodString>;
    pqPublicKey: z.ZodOptional<z.ZodString>;
    signingKey: z.ZodOptional<z.ZodString>;
    devices: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        publicKey: z.ZodString;
        pqPublicKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        signingKey: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    role: z.ZodEnum<{
        ADMIN: "ADMIN";
        MEMBER: "MEMBER";
        admin: "admin";
        member: "member";
    }>;
    isPinned: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ConversationSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    encryptedMetadata: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>>;
    updatedAt: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
    encryptionMode: z.ZodDefault<z.ZodEnum<{
        SENDER_KEY: "SENDER_KEY";
        PQ_DR: "PQ_DR";
    }>>;
    activePqDeviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    participants: z.ZodArray<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
        userId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>;
        user: z.ZodOptional<z.ZodObject<{
            id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
            publicKey: z.ZodOptional<z.ZodString>;
            pqPublicKey: z.ZodOptional<z.ZodString>;
            signingKey: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        publicKey: z.ZodOptional<z.ZodString>;
        pqPublicKey: z.ZodOptional<z.ZodString>;
        signingKey: z.ZodOptional<z.ZodString>;
        devices: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            publicKey: z.ZodString;
            pqPublicKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            signingKey: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        role: z.ZodEnum<{
            ADMIN: "ADMIN";
            MEMBER: "MEMBER";
            admin: "admin";
            member: "member";
        }>;
        isPinned: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    lastMessage: z.ZodNullable<z.ZodLazy<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").MessageId, string>>;
        conversationId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
        senderId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
        content: z.ZodNullable<z.ZodOptional<z.ZodString>>;
        timestamp: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        createdAt: z.ZodPreprocess<z.ZodDefault<z.ZodString>>;
    }, z.core.$loose>>>;
    lastUpdated: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const ConversationUiSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
    isGroup: z.ZodDefault<z.ZodBoolean>;
    encryptedMetadata: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creatorId: z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>>;
    updatedAt: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    keyRotationPending: z.ZodOptional<z.ZodBoolean>;
    requiresKeyRotation: z.ZodOptional<z.ZodBoolean>;
    encryptionMode: z.ZodDefault<z.ZodEnum<{
        SENDER_KEY: "SENDER_KEY";
        PQ_DR: "PQ_DR";
    }>>;
    activePqDeviceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    participants: z.ZodArray<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
        userId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>>;
        user: z.ZodOptional<z.ZodObject<{
            id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
            publicKey: z.ZodOptional<z.ZodString>;
            pqPublicKey: z.ZodOptional<z.ZodString>;
            signingKey: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        publicKey: z.ZodOptional<z.ZodString>;
        pqPublicKey: z.ZodOptional<z.ZodString>;
        signingKey: z.ZodOptional<z.ZodString>;
        devices: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            publicKey: z.ZodString;
            pqPublicKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            signingKey: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        role: z.ZodEnum<{
            ADMIN: "ADMIN";
            MEMBER: "MEMBER";
            admin: "admin";
            member: "member";
        }>;
        isPinned: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    lastMessage: z.ZodNullable<z.ZodLazy<z.ZodObject<{
        id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").MessageId, string>>;
        conversationId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
        senderId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
        content: z.ZodNullable<z.ZodOptional<z.ZodString>>;
        timestamp: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
        createdAt: z.ZodPreprocess<z.ZodDefault<z.ZodString>>;
    }, z.core.$loose>>>;
    lastUpdated: z.ZodOptional<z.ZodNumber>;
    decryptedMetadata: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        avatarUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const IncomingMessageSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").MessageId, string>>;
    conversationId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
    senderId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
    content: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    timestamp: z.ZodPreprocess<z.ZodOptional<z.ZodString>>;
    createdAt: z.ZodPreprocess<z.ZodDefault<z.ZodString>>;
}, z.core.$loose>;
export declare const WebRTCSignalTypeSchema: z.ZodEnum<{
    request: "request";
    accept: "accept";
    offer: "offer";
    answer: "answer";
    "ice-candidate": "ice-candidate";
    end: "end";
    reject: "reject";
}>;
export declare const WebRTCSignalingSchema: z.ZodObject<{
    type: z.ZodEnum<{
        request: "request";
        accept: "accept";
        offer: "offer";
        answer: "answer";
        "ice-candidate": "ice-candidate";
        end: "end";
        reject: "reject";
    }>;
    from: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
    payload: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
declare const RawServerMessageBaseSchema: z.ZodObject<{
    id: z.ZodString;
    tempId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    type: z.ZodOptional<z.ZodEnum<{
        USER: "USER";
        SYSTEM: "SYSTEM";
    }>>;
    conversationId: z.ZodString;
    senderId: z.ZodString;
    sender: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        encryptedProfile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        name: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
        avatarUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    ciphertext: z.ZodString;
    content: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    fileKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    encryptedSessionKey: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    createdAt: z.ZodString;
    repliedToId: z.ZodOptional<z.ZodString>;
    linkPreview: z.ZodOptional<z.ZodUnknown>;
    expiresAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isViewOnce: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type RawServerMessage = z.infer<typeof RawServerMessageBaseSchema> & {
    repliedTo?: RawServerMessage;
};
export declare const RawServerMessageSchema: z.ZodType<RawServerMessage>;
export declare const ShadowVaultMessageSchema: z.ZodObject<{
    id: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").MessageId, string>>;
    conversationId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").ConversationId, string>>;
    senderId: z.ZodPipe<z.ZodString, z.ZodTransform<import("./brands.js").UserId, string>>;
    content: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    createdAt: z.ZodPreprocess<z.ZodDefault<z.ZodString>>;
    status: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        sending: "sending";
        sent: "sent";
        delivered: "delivered";
        read: "read";
        failed: "failed";
    }>>>;
    repliedToId: z.ZodOptional<z.ZodString>;
    repliedTo: z.ZodOptional<z.ZodString>;
    senderName: z.ZodOptional<z.ZodString>;
    senderUsername: z.ZodOptional<z.ZodString>;
    senderAvatarUrl: z.ZodOptional<z.ZodString>;
    isViewOnce: z.ZodOptional<z.ZodBoolean>;
    isDeletedLocal: z.ZodOptional<z.ZodBoolean>;
    fileMeta: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export {};
//# sourceMappingURL=schemas.d.ts.map