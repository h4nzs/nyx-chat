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

/** version marker — metadata tanpa field ini = v1 (tanpa pseudonym). */
export interface GroupMetadataBase {
  title?: string;
  description?: string;
  avatarUrl?: string;
  participants?: string[];
  /** monotonically increasing per full key/membership rotation. */
  generation: number;
  /** pseudonym (22-char base64url of 16 random bytes) -> userId. */
  pseudonymMap: Record<string, string>;
  /** [T3b] Per-member delivery token (base64url of 16 random bytes) -> userId.
   *  Lives ONLY inside encrypted metadata; server stores the token for the
   *  member it was issued to, without learning the full roster. */
  deliveryTokenMap?: Record<string, string>;
}

// [T1 GROUP PSEUDONYMS — doc 26.2] Per-group sender pseudonyms. The mapping
// `pseudonym -> userId` lives ONLY inside encrypted metadata (v2); the server
// sees opaque `senderId` values that cannot be linked to accounts or across
// groups. Generation bumps on every full key rotation so pre/post-rotation
// messages are unlinkable server-side.
export interface GroupMetadataV2 extends GroupMetadataBase {
  /** version marker — metadata tanpa field ini = v1 (tanpa pseudonym). */
  v: 2;
}

// [T4 GROUP ROSTER v3 — 2026-09-30] Roster keanggotaan hidup DI DALAM
// encrypted metadata (satu sumber kebenaran), mengikuti pola membersV2
// Signal: setiap entri membawa role eksplisit. Server Opaque Mailbox tetap
// tidak tahu siapa anggota grup, role-nya, maupun perubahan keanggotaan —
// hanya melihat blob metadata opaque + blind auth (X-Group-Token).
export type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface GroupMemberEntry {
  /** userId asli anggota (22-char). */
  userId: string;
  role: GroupRole;
  /** generation metadata saat anggota bergabung (audit + ordering). */
  joinedAtGeneration: number;
}

export interface GroupMetadataV3 extends GroupMetadataBase {
  /** version marker — metadata v3 membawa roster ber-role. */
  v: 3;
  /** Roster lengkap (termasuk creator sebagai OWNER). */
  members: GroupMemberEntry[];
}

// --- [T4] Role & roster helpers (kontrak lintas client/server) ---

/** Guard role dari input tak terpercaya (metadata terdekripsi / payload). */
export function isGroupRole(value: unknown): value is GroupRole {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER';
}

/** Urutan hierarki role: OWNER > ADMIN > MEMBER. */
export const GROUP_ROLE_RANK: Record<GroupRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

export function roleAtLeast(role: GroupRole, minimum: GroupRole): boolean {
  return GROUP_ROLE_RANK[role] >= GROUP_ROLE_RANK[minimum];
}

/**
 * Validasi & normalisasi roster v3 dari metadata terdekripsi. Entri tanpa
 * userId valid dibuang; role tidak dikenal → MEMBER (fail-safe, bukan fail
 * closed — anggota tak boleh hilang cuma karena field role korup).
 */
export function parseGroupMembers(input: unknown): GroupMemberEntry[] {
  if (!Array.isArray(input)) return [];
  const out: GroupMemberEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.userId !== 'string' || rec.userId.length === 0) continue;
    out.push({
      userId: rec.userId,
      role: isGroupRole(rec.role) ? rec.role : 'MEMBER',
      joinedAtGeneration:
        typeof rec.joinedAtGeneration === 'number' ? rec.joinedAtGeneration : 0,
    });
  }
  return out;
}

export type ConversationUi = Conversation & {
  decryptedMetadata?: ({
    title?: string;
    description?: string;
    avatarUrl?: string;
    authSecret?: string; // Stored inside encrypted metadata for participants
  }) & Partial<GroupMetadataV2 | GroupMetadataV3>;
  // [26.9 RBAC] Admin capability token grup ini (client-local, TIDAK pernah
  // dikirim ke server kecuali sebagai header X-Admin-Token saat mutasi admin).
  // Diisi: pembuatan grup (creator/OWNER) atau unseal amplop distribusi
  // pairwise (admin lain). Bukan bagian dari Conversation server.
  adminToken?: string;
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
  // [DR PROTOCOL 2026-10-05] Bidang klien-side (dipelihara crypto.ts, tidak
  // dibaca worker):
  //  - peerSessionConfirmed: balasan peer pertama sudah berhasil didekripsi →
  //    pengirim berhenti menyertakan x3dh di wrapper (self-heal msg1 hilang).
  //  - pendingHandshake: salinan x3dh awal sesi — dikirim ulang sampai
  //    terkonfirmasi; derivation deterministik membuat re-derive aman.
  //  - peerAckedKem: KEMr peer yang di-ack via payload terenkripsi → pengirim
  //    boleh menghilangkan `ct` (1120B) dari header saat ack = chain saat ini.
  peerSessionConfirmed?: boolean;
  pendingHandshake?: { initiatorSigningKey: string; initiatorCiphertexts: string; otpkId?: number };
  peerAckedKem?: string;
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
