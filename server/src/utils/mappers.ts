import { 
  asUserId,
  asConversationId,
  asMessageId,
  type RawServerMessage, 
  type Conversation, 
  type Participant, 
  type MinimalProfile
} from '@nyx/shared';

// --- 1. DEFINISI INPUT (Murni tanpa any) ---

export interface PrismaUserProfileInput {
  id: string;
  username?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  encryptedProfile?: string | null;
}

export interface PrismaParticipantInput {
  id: string;
  userId: string;
  role: string;
  isPinned?: boolean;
  user?: PrismaUserProfileInput | null; // Strict typing untuk relasi user
}

export interface PrismaMessageInput {
  id: string;
  tempId?: number | null;
  type?: string;
  conversationId: string;
  senderId: string;
  ciphertext?: string | null;
  content?: string | null;
  fileKey?: string | null;
  sessionId?: string | null;
  encryptedSessionKey?: string | null;
  createdAt: Date;
  expiresAt?: Date | null;
  isViewOnce?: boolean | null;
  repliedToId?: string | null;
  sender?: PrismaUserProfileInput | null; // Strict typing untuk pengirim
  repliedTo?: PrismaMessageInput | null;  // Strict typing REKURSIF untuk pesan balasan
}

export interface PrismaConversationInput {
  id: string;
  isGroup?: boolean | null;
  type?: string | null;
  encryptedMetadata?: string | null;
  creatorId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  participants?: PrismaParticipantInput[]; // Strict typing untuk array participant
}


// --- 2. MAPPER FUNCTIONS ---

export const toMinimalProfile = (user: PrismaUserProfileInput): MinimalProfile => ({
  id: asUserId(user.id),
  username: user.username ?? '',
  name: user.name ?? '',
  avatarUrl: user.avatarUrl,
  encryptedProfile: user.encryptedProfile,
});

export const toParticipant = (p: PrismaParticipantInput): Participant => ({
  id: asUserId(p.id),
  userId: asUserId(p.userId),
  role: (p.role === 'ADMIN' || p.role === 'MEMBER' || p.role === 'admin' || p.role === 'member') ? p.role as Participant['role'] : 'MEMBER',
  isPinned: p.isPinned ?? false,
  // Mapping langsung yang aman karena p.user sudah sesuai interface
  name: p.user?.name ?? undefined,
  username: p.user?.username ?? undefined,
  avatarUrl: p.user?.avatarUrl ?? undefined,
  encryptedProfile: p.user?.encryptedProfile ?? undefined,
});

export const toConversation = (conv: PrismaConversationInput): Conversation => ({
  id: asConversationId(conv.id),
  // Cek isGroup langsung, atau fallback ke logic type 'GROUP'
  isGroup: conv.isGroup ?? (conv.type === 'GROUP'), 
  encryptedMetadata: conv.encryptedMetadata ?? undefined,
  creatorId: conv.creatorId ? asUserId(conv.creatorId) : undefined,
  createdAt: conv.createdAt.toISOString(),
  updatedAt: conv.updatedAt.toISOString(),
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
  ciphertext: msg.ciphertext,
  content: msg.content,
  fileKey: msg.fileKey,
  sessionId: msg.sessionId,
  encryptedSessionKey: msg.encryptedSessionKey,
  createdAt: msg.createdAt.toISOString(),
  expiresAt: msg.expiresAt ? msg.expiresAt.toISOString() : undefined,
  isViewOnce: msg.isViewOnce ?? false,
  repliedToId: msg.repliedToId ? asMessageId(msg.repliedToId) : undefined,
  // Pemanggilan rekursif yang aman karena msg.repliedTo sesuai dengan PrismaMessageInput
  repliedTo: msg.repliedTo ? toRawServerMessage(msg.repliedTo) : undefined,
});