import { z } from 'zod';
import { 
  MinimalUserSchema, 
  IncomingMessageSchema, 
  MinimalConversationSchema,
  RawServerMessageSchema
} from './schemas.js';
import type { UserId, ConversationId, MessageId, StoryId, Pseudonym } from './brands.js';

// 1. Ekspor Branded Types
export type { UserId, ConversationId, MessageId, StoryId };

export type MinimalProfile = {
  id: UserId;
  name?: string;
  username?: string;
  usernameHash?: string;
  avatarUrl?: string | null;
  [key: string]: unknown;
};

// 2. Inferensi Tipe dari Zod Schemas (Single Source of Truth)
export type User = z.infer<typeof MinimalUserSchema> & {
  hasCompletedOnboarding?: boolean;
  usernameHash?: string;
  autoDestructDays?: number | null;
  systemAlert?: {
    type: 'subscription_expiring';
    daysLeft: number;
  };
};

import { SubscriptionTier } from './constants.js';

export type ProfileUser = {
  id: UserId;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  encryptedProfile?: string | null;
  publicKey?: string;
  pqPublicKey?: string;
  signingKey?: string;
  isVerified?: boolean;
  subscriptionTier?: SubscriptionTier;
};

export type MessageStatus = {
  id: string;
  messageId: MessageId;
  userId: UserId;
  status: 'SENT' | 'DELIVERED' | 'READ';
  updatedAt: string;
};

export interface SystemMessagePayload {
  type: string;
  conversationId?: string;
  senderId?: string;
  senderDeviceKey?: string;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim (bawaan envelope
  // fulfilled_key — diikat ke receiver state penerima).
  senderSigningKey?: string;
  deviceId?: string;
  hostClassicalPk?: string;
  hostPqPk?: string;
  savedCt?: string;
  guestClassicalPk?: string;
  distributions?: {
    userId: string;
    targetUserId?: string;
    targetDeviceId?: string;
    targetDeviceKey?: string;
    encryptedKey?: string;
    key?: string;
    senderDeviceKey?: string;
    senderSigningKey?: string;
  }[];
  targetUserId?: string;
  targetDeviceKey?: string;
  key?: string;
  encryptedKey?: string;
  storyId?: string;
  [key: string]: unknown;
}

export type GroupKeyDistributionPayload = SystemMessagePayload & { type: 'GROUP_KEY_DISTRIBUTION' };
export type SystemKeyRequestPayload = SystemMessagePayload & { type: 'SYSTEM_KEY_REQUEST' };

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
  deleteSecret?: string; // Secret for blind authorization of message deletion
};
export type Participant = {
  id: UserId;
  userId?: UserId;
  user?: { 
      id: UserId; 
      publicKey?: string; 
      pqPublicKey?: string; 
      signingKey?: string; 
      devices?: { id: string; publicKey: string; signingKey?: string; pqPublicKey?: string | null }[];
      [key: string]: unknown 
  };
  encryptedProfile?: string | null;
  publicKey?: string;
  pqPublicKey?: string;
  signingKey?: string;
  devices?: { id: string; publicKey: string; signingKey?: string; pqPublicKey?: string | null }[];
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  role: "ADMIN" | "MEMBER" | "admin" | "member";
  isPinned?: boolean;
  joinedAt?: number;
};

export type Conversation = z.infer<typeof MinimalConversationSchema> & {
  participants: Participant[];
  lastMessage: (Message & { preview?: string }) | null;
  lastUpdated?: number;
  authSecret?: string; // Secret for blind authorization of group management
};

// [T1 GROUP PSEUDONYMS — doc 26.2] Per-group sender pseudonyms. The mapping
// `pseudonym -> userId` lives ONLY inside encrypted metadata (v2); the server
// sees opaque `senderId` values that cannot be linked to accounts or across
// groups. Generation bumps on every full key rotation so pre/post-rotation
// messages are unlinkable server-side.
export interface GroupMetadataV2 {
  title?: string;
  description?: string;
  avatarUrl?: string;
  participants?: string[];
  /** version marker — metadata without this field is v1 (no pseudonyms). */
  v: 2;
  /** monotonically increasing per full key/membership rotation. */
  generation: number;
  /** pseudonym (22-char base64url of 16 random bytes) -> userId. */
  pseudonymMap: Record<string, string>;
  /** [T3b] Per-member delivery token (base64url of 16 random bytes) -> userId.
   *  Lives ONLY inside encrypted metadata; server stores the token for the
   *  member it was issued to, without learning the full roster. */
  deliveryTokenMap?: Record<string, string>;
}

export type ConversationUi = Conversation & {
  decryptedMetadata?: ({
    title?: string;
    description?: string;
    avatarUrl?: string;
    authSecret?: string; // Stored inside encrypted metadata for participants
  }) & Partial<GroupMetadataV2>;
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
  skippedKeys?: Record<string, string>;
  messageCount?: number;
  lastActivityTime?: number;
}

export interface ISignedPreKey {
  key: string;
  pqKey: string | null;
  signature: string;
  pqSignature: string | null;
}

export interface IOneTimePreKey {
  keyId: number;
  key: string;
  pqKey: string | null;
}

export interface IDeviceTemplate {
  id: string;
  identityKey: string;
  pqIdentityKey: string | null;
  signingKey: string;
  signedPreKey: ISignedPreKey | null;
}

export interface IPreKeyBundle {
  deviceId: string;
  identityKey: string;
  pqIdentityKey: string | null;
  signingKey: string;
  signedPreKey: ISignedPreKey | null;
  oneTimePreKey?: IOneTimePreKey;
}
