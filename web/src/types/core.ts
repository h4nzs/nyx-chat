import type { UserId, ConversationId, MessageId, StoryId } from './brands';

// --- 1. CRYPTO & RATCHET STATE ---
export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export interface DoubleRatchetState {
  DHs: { publicKey: string; privateKey: string } | null;
  DHr: string | null;
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
}

// --- 2. CORE ENTITIES (Branded) ---

export interface User {
  id: UserId;
  usernameHash?: string;
  encryptedProfile?: string | null;
  role?: string;
  isVerified?: boolean;
  hasCompletedOnboarding?: boolean;
  name?: string;
  username?: string;
  autoDestructDays?: number | null;
}

export interface UserProfile {
  id: UserId;
  encryptedProfile?: string | null;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
}

export interface Participant {
  userId: UserId;
  role: "ADMIN" | "MEMBER";
  isPinned?: boolean;
  encryptedProfile?: string | null;
  publicKey?: string;
  signingKey?: string;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
}

export interface Conversation {
  id: ConversationId;
  isGroup: boolean;
  title?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  creatorId?: UserId | null;
  participants: UserId[]; // Normalized as per instructions
  lastMessage: (Message & { preview?: string }) | null;
  updatedAt: string;
  unreadCount: number;
  lastUpdated?: number;
  keyRotationPending?: boolean;
  requiresKeyRotation?: boolean;
}

export interface Message {
  id: MessageId;
  tempId?: number;
  type?: 'USER' | 'SYSTEM' | 'TEXT' | 'IMAGE' | 'FILE'; // Merging types seen in store and core
  conversationId: ConversationId;
  senderId: UserId;
  content?: string | null;
  payload?: EncryptedPayload; // From ServerMessage
  fileUrl?: string | null;
  fileKey?: string | null;
  fileName?: string | null;
  fileType?: string;
  fileSize?: number;
  sessionId?: string | null;
  encryptedSessionKey?: string | null;
  createdAt: string | Date; // Supporting both for now to reduce noise, or should I be strict? User didn't specify. I'll stick to string as usually JSON is string.
  timestamp?: Date; // From ServerMessage
  
  replyToId?: MessageId;
  repliedTo?: Message;
  
  error?: boolean;
  preview?: string;
  reactions?: { id: string; emoji: string; userId: UserId; isMessage?: boolean }[];
  optimistic?: boolean;
  
  status?: 'SENDING' | 'SENT' | 'FAILED' | 'DELIVERED' | 'READ';
  statuses?: any[];
  
  expiresAt?: string | null;
  isBlindAttachment?: boolean;
  isViewOnce?: boolean;
  isViewed?: boolean;
  isEdited?: boolean;
  isSilent?: boolean;
  isDeletedLocal?: boolean;
}

// Deprecated or Legacy interfaces (kept for compatibility if needed, or I could remove them if they clash)
// I will comment them out or remove them to force usage of the new types as per "Biarkan TypeScript meledak"
// export interface ServerMessage { ... } 
// export interface DecryptedMessage { ... }
