import { z } from 'zod';
import { asUserId, asConversationId, asMessageId, asStoryId } from './brands.js';

// --- Validasi Kriptografi Khusus ---
// Memastikan string hanya berisi karakter Base64 atau URL-Safe Base64 yang valid (dan max len wajar)
export const Base64StringSchema = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'Invalid base64/base64url format').max(1000000, 'Payload too large');
export const PayloadStringSchema = z.string().max(1000000, 'Payload too large');

// --- Base ID Schemas (Transforming to Branded Types) ---
export const UserIdSchema = z.string().min(1).transform((val) => asUserId(val));
export const ConversationIdSchema = z.string().min(1).transform((val) => asConversationId(val));
export const MessageIdSchema = z.string().min(1).transform((val) => asMessageId(val));
export const StoryIdSchema = z.string().min(1).transform((val) => asStoryId(val));

// --- Minimal Shared Schemas ---
// Digunakan sebagai pondasi awal sebelum kita memvalidasi seluruh entitas
export const MinimalUserSchema = z.object({
  id: UserIdSchema,
  username: z.string().optional(),
  name: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  encryptedProfile: Base64StringSchema.nullable().optional(),
  role: z.string().optional(),
  isVerified: z.boolean().optional(),
}).passthrough();

export const MinimalConversationSchema = z.object({
  id: ConversationIdSchema,
  isGroup: z.boolean().default(false),
  encryptedMetadata: Base64StringSchema.nullable().optional(),
  creatorId: UserIdSchema.nullable().optional(),
  updatedAt: z.preprocess((val) => { if (val == null) return undefined; try { const d = new Date(val as string | number | Date); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } }, z.string().optional()),
  unreadCount: z.number().default(0),
  keyRotationPending: z.boolean().optional(),
  requiresKeyRotation: z.boolean().optional(),
}).passthrough();

export const ParticipantSchema = z.object({
  id: UserIdSchema,
  userId: UserIdSchema.optional(),
  encryptedProfile: Base64StringSchema.nullable().optional(),
  publicKey: z.string().optional(),
  signingKey: z.string().optional(),
  devices: z.array(z.object({
    id: z.string(),
    publicKey: z.string(),
    signingKey: z.string()
  })).optional(),
  role: z.enum(["ADMIN", "MEMBER", "admin", "member"]),
  isPinned: z.boolean().optional(),
  name: z.string().optional(),
  username: z.string().optional(),
  avatarUrl: z.string().nullable().optional()
}).passthrough();

export const ConversationSchema = MinimalConversationSchema.extend({
  participants: z.array(ParticipantSchema),
  lastMessage: z.any().nullable(),
  lastUpdated: z.number().optional(),
  decryptedMetadata: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    avatarUrl: z.string().optional()
  }).optional()
}).passthrough();

export const IncomingMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: PayloadStringSchema.optional().nullable(),
  timestamp: z.preprocess((val) => { if (val == null) return undefined; try { const d = new Date(val as string | number | Date); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } }, z.string().optional()),
  createdAt: z.preprocess((val) => {
    if (val === null || val === undefined) return undefined;
    
    // ✅ FIX: Lindungi toISOString() dari Date yang invalid (Invalid Date / NaN)
    if (val instanceof Date) {
      return Number.isNaN(val.getTime()) ? String(val) : val.toISOString();
    }
    
    if (typeof val === 'number') {
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? String(val) : d.toISOString();
    }
    
    if (typeof val === 'string') return val;
    return String(val); // Fallback ke string agar bisa dicek oleh refine
  }, z.string().default(() => new Date().toISOString()).refine((val) => !isNaN(Date.parse(val)), {
    message: "Invalid date format",
  })),
}).passthrough();

// --- WebRTC Signaling Schemas ---
export const WebRTCSignalTypeSchema = z.enum(['request', 'accept', 'offer', 'answer', 'ice-candidate', 'end', 'reject']);

export const WebRTCSignalingSchema = z.object({
  type: WebRTCSignalTypeSchema,
  from: UserIdSchema,
  // Using passthrough because payload is often an encrypted string during 'webrtc:secure_signal' 
  // but could be object if not fully encrypted at the transport layer
  payload: z.unknown().optional(), 
}).passthrough();

const RawServerMessageBaseSchema = z.object({
  id: z.string(),
  tempId: z.union([z.string(), z.number()]).optional(),
  type: z.enum(['USER', 'SYSTEM']).optional(),
  conversationId: z.string(),
  senderId: z.string(),
  sender: z.object({
    id: z.string(),
    encryptedProfile: Base64StringSchema.nullable().optional(),
    name: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().nullable().optional(),
  }).optional(),
  ciphertext: PayloadStringSchema,
  content: PayloadStringSchema.optional().nullable(),
  fileKey: Base64StringSchema.nullable().optional(),
  sessionId: z.string().nullable().optional(),
  encryptedSessionKey: PayloadStringSchema.optional().nullable(),
  createdAt: z.string(),
  repliedToId: z.string().optional(),
  linkPreview: z.unknown().optional(),
  expiresAt: z.string().nullable().optional(),
  isViewOnce: z.boolean().optional(),
});

// 2. Ekstrak tipe TypeScript-nya dan tambahkan properti rekursif (repliedTo)
export type RawServerMessage = z.infer<typeof RawServerMessageBaseSchema> & {
  repliedTo?: RawServerMessage; // Rekursi aman di level TypeScript
};

// 3. Gabungkan schema dasar dengan properti rekursif menggunakan .extend()
// Perhatikan penggunaan tipe <RawServerMessage> tanpa 'any'!
export const RawServerMessageSchema: z.ZodType<RawServerMessage> = RawServerMessageBaseSchema.extend({
  repliedTo: z.lazy(() => RawServerMessageSchema.optional()),
});

// --- Local Database Schemas ---
export const ShadowVaultMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: PayloadStringSchema.optional().nullable(),
  createdAt: z.preprocess((val) => {
      if (val === null || val === undefined) return undefined;

      // ✅ FIX: Lindungi toISOString() dari Date yang invalid (Invalid Date / NaN)
      if (val instanceof Date) {
        return Number.isNaN(val.getTime()) ? String(val) : val.toISOString();
      }

      if (typeof val === 'number') {
        const d = new Date(val);
        return Number.isNaN(d.getTime()) ? String(val) : d.toISOString();
      }

      if (typeof val === 'string') return val;
      return String(val); // Fallback ke string agar bisa dicek oleh refine
    }, z.string().default(() => new Date().toISOString()).refine((val) => !isNaN(Date.parse(val)), {
      message: "Invalid date format",
  })),
  status: z.enum(['sending', 'sent', 'delivered', 'read', 'failed']).optional().default('sent'),
  repliedToId: z.string().optional(),
  repliedTo: z.string().optional(),
  senderName: z.string().optional(),
  senderUsername: z.string().optional(),
  senderAvatarUrl: z.string().optional(),
  isViewOnce: z.boolean().optional(),
  isDeletedLocal: z.boolean().optional(),
  fileMeta: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
}).passthrough();
