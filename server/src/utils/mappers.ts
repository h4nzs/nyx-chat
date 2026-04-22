import { 
  asUserId,
  asConversationId,
  asMessageId,
  type RawServerMessage, 
  type Conversation, 
  type Participant, 
  type MinimalProfile
} from '@nyx/shared';

// --- 1. DEFINISI INPUT (Aman & Sesuai E2EE Schema) ---

export interface PrismaUserProfileInput {
  id: string;
  usernameHash?: string | null; // Sesuai schema baru
  encryptedProfile?: string | null;
  publicKey?: string | null;
  pqPublicKey?: string | null;
  signingKey?: string | null;
  devices?: { id: string; publicKey: string; pqPublicKey?: string | null; signingKey: string }[] | null;
}
export interface PrismaParticipantInput {
  id: string;
  userId: string;
  role: string;
  isPinned?: boolean;
  joinedAt?: Date | string; // Bisa Date atau ISO String
  user?: PrismaUserProfileInput | null; 
}

export interface PrismaMessageInput {
  id: string;
  tempId?: number | null;
  type?: string;
  conversationId: string;
  senderId: string;
  content?: string | null; // Pengganti ciphertext dalam E2EE payload
  fileKey?: string | null;
  sessionId?: string | null;
  encryptedSessionKey?: string | null;
  createdAt: Date | string; // Bisa Date atau ISO String
  expiresAt?: Date | string | null; // Bisa Date atau ISO String
  isViewOnce?: boolean | null;
  repliedToId?: string | null;
  sender?: PrismaUserProfileInput | null; 
  repliedTo?: PrismaMessageInput | null;  
}

export interface PrismaConversationInput {
  id: string;
  isGroup?: boolean | null;
  type?: string | null;
  encryptedMetadata?: string | null;
  creatorId?: string | null;
  createdAt: Date | string; // Bisa Date atau ISO String
  updatedAt: Date | string; // Bisa Date atau ISO String
  participants?: PrismaParticipantInput[]; 
}

// --- 2. MAPPER FUNCTIONS ---

export const toMinimalProfile = (user: PrismaUserProfileInput): MinimalProfile => ({
  id: asUserId(user.id),
  // Karena arsitektur ZKP, kita kembalikan usernameHash sebagai identifier darurat
  username: user.usernameHash ?? '', 
  name: '', // Selalu kosong dari server, didekripsi di klien
  avatarUrl: null, // Selalu null dari server, didekripsi di klien
  encryptedProfile: user.encryptedProfile,
});

export const toParticipant = (p: PrismaParticipantInput): Participant => ({
  // Frontend butuh `id` yang merepresentasikan User ID, bukan Participant ID!
  id: asUserId(p.userId || p.user?.id || p.id),
  userId: asUserId(p.userId || p.user?.id || p.id),
  role: (p.role === 'ADMIN' || p.role === 'MEMBER' || p.role === 'admin' || p.role === 'member') ? p.role as Participant['role'] : 'MEMBER',
  isPinned: p.isPinned ?? false,
  // Hapus name/username/avatarUrl yang tidak aman, klien akan mendekripsi encryptedProfile
  name: undefined,
  username: undefined,
  avatarUrl: undefined,
  encryptedProfile: p.user?.encryptedProfile ?? undefined,
  publicKey: p.user?.publicKey ?? undefined,
  pqPublicKey: p.user?.pqPublicKey ?? undefined,
  signingKey: p.user?.signingKey ?? undefined,
  devices: p.user?.devices ?? undefined,
});

export const toConversation = (conv: PrismaConversationInput): Conversation => ({
  id: asConversationId(conv.id),
  isGroup: conv.isGroup ?? (conv.type === 'GROUP'), 
  encryptedMetadata: conv.encryptedMetadata ?? undefined,
  creatorId: conv.creatorId ? asUserId(conv.creatorId) : undefined,
  // FIX: Aman memanggil toISOString meski input aslinya sudah berupa string
  createdAt: new Date(conv.createdAt).toISOString(),
  updatedAt: new Date(conv.updatedAt).toISOString(),
  participants: conv.participants ? conv.participants.map(toParticipant) : [],
  unreadCount: 0,
  lastMessage: null,
});

export const toRawServerMessage = (msg: PrismaMessageInput): RawServerMessage => ({
  id: asMessageId(msg.id),
  tempId: msg.tempId ?? undefined,
  type: (msg.type === 'USER' || msg.type === 'SYSTEM') ? msg.type : 'USER',
  conversationId: asConversationId(msg.conversationId),
  senderId: asUserId(msg.senderId),
  sender: msg.sender ? toMinimalProfile(msg.sender) : undefined,
  // Hapus map ciphertext yang salah, fokus ke content
  ciphertext: msg.content ?? '', 
  content: msg.content,
  fileKey: msg.fileKey,
  sessionId: msg.sessionId,
  encryptedSessionKey: msg.encryptedSessionKey,
  // FIX: Aman memanggil toISOString meski input aslinya sudah berupa string
  createdAt: new Date(msg.createdAt).toISOString(),
  expiresAt: msg.expiresAt ? new Date(msg.expiresAt).toISOString() : undefined,
  isViewOnce: msg.isViewOnce ?? false,
  repliedToId: msg.repliedToId ? asMessageId(msg.repliedToId) : undefined,
  repliedTo: msg.repliedTo ? toRawServerMessage(msg.repliedTo) : undefined,
});