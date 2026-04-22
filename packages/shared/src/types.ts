import { z } from 'zod';
import { 
  MinimalUserSchema, 
  IncomingMessageSchema, 
  MinimalConversationSchema,
  RawServerMessageSchema
} from './schemas.js';
import type { UserId, ConversationId, MessageId, StoryId } from './brands.js';

// 1. Ekspor Branded Types
export type { UserId, ConversationId, MessageId, StoryId };

export type MinimalProfile = {
  id: UserId;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
};

// 2. Inferensi Tipe dari Zod Schemas (Single Source of Truth)
export type User = z.infer<typeof MinimalUserSchema> & {
  hasCompletedOnboarding?: boolean;
  usernameHash?: string;
  autoDestructDays?: number | null;
};

export type MessageStatus = {
  id: string;
  messageId: MessageId;
  userId: UserId;
  status: 'SENT' | 'DELIVERED' | 'READ';
  updatedAt: string;
};

export type Message = z.infer<typeof IncomingMessageSchema> & {
  tempId?: number;
  type?: 'USER' | 'SYSTEM';
  sender?: { 
    id: UserId; 
    encryptedProfile?: string | null; 
    name?: string; 
    username?: string; 
    avatarUrl?: string | null; 
  };
  imageUrl?: string | null;
  fileUrl?: string | null;
  fileKey?: string | null;
  fileName?: string | null;
  fileType?: string;
  fileSize?: number;
  sessionId?: string | null;
  createdAt: string;
  error?: boolean;
  preview?: string;
  reactions?: { id: string; emoji: string; userId: UserId; isMessage?: boolean }[];
  optimistic?: boolean;
  repliedTo?: Message;
  repliedToId?: MessageId;
  linkPreview?: unknown;
  duration?: number;
  statuses?: MessageStatus[];
  status?: 'SENDING' | 'SENT' | 'FAILED';
  deletedAt?: string | Date | null;
  expiresAt?: string | null;
  isBlindAttachment?: boolean;
  isViewOnce?: boolean;
  isViewed?: boolean;
  isEdited?: boolean;
  isSilent?: boolean;
  isDeletedLocal?: boolean;
};
export type Participant = {
  id: UserId;
  userId?: UserId;
  user?: { id: string; publicKey?: string; pqPublicKey?: string; signingKey?: string; [key: string]: unknown };
  encryptedProfile?: string | null;
  publicKey?: string;
  signingKey?: string;
  devices?: { id: string; publicKey: string; signingKey: string }[];
  role: "ADMIN" | "MEMBER" | "admin" | "member";
  isPinned?: boolean;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  joinedAt?: number;
};

export type Conversation = z.infer<typeof MinimalConversationSchema> & {
  participants: Participant[];
  lastMessage: (Message & { preview?: string }) | null;
  lastUpdated?: number;
  decryptedMetadata?: {
    title?: string;
    description?: string;
    avatarUrl?: string;
  };
};

export type Story = {
  id: StoryId;
  senderId: UserId;
  encryptedPayload: string;
  createdAt: string;
  expiresAt: string;
  decryptedData?: {
    text?: string;
    mediaUrl?: string;
    mimeType?: string;
    fileKey?: string;
  };
};

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export interface AuthJwtPayload {
  id: string;
  role?: string;
  deviceId?: string; // Sekarang resmi menjadi bagian dari JWT Payload aplikasi
}

export interface DoubleRatchetState {
  KEMs: { publicKey: string; privateKey: string } | null;
  KEMr: string | null;
  savedCt: string | null;
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
}
