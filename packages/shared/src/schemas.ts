import { z } from 'zod';
import { asUserId, asConversationId, asMessageId, asStoryId } from './brands';

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
  encryptedProfile: z.string().nullable().optional(),
  role: z.string().optional(),
  isVerified: z.boolean().optional(),
}).passthrough();

export const MinimalConversationSchema = z.object({
  id: ConversationIdSchema,
  isGroup: z.boolean().default(false),
  encryptedMetadata: z.string().nullable().optional(),
  creatorId: UserIdSchema.nullable().optional(),
  updatedAt: z.preprocess((val) => { if (val == null) return undefined; try { const d = new Date(val as string | number | Date); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } }, z.string().optional()),
  unreadCount: z.number().default(0),
  keyRotationPending: z.boolean().optional(),
  requiresKeyRotation: z.boolean().optional(),
}).passthrough();

export const IncomingMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: z.string().nullable().optional(),
  timestamp: z.preprocess((val) => { if (val == null) return undefined; try { const d = new Date(val as string | number | Date); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } }, z.string().optional()),
  createdAt: z.preprocess((val) => { 
    if (val === null || val === undefined) return undefined; 
    try { 
      const d = new Date(val as string | number | Date); 
      if (isNaN(d.getTime())) throw new Error("Invalid date");
      return d.toISOString(); 
    } catch { 
      throw new Error("Invalid date"); 
    } 
  }, z.string().default(() => new Date().toISOString())),
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

// --- Local Database Schemas ---
export const ShadowVaultMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: z.string().nullable().optional(),
  createdAt: z.preprocess((val) => { if (val == null) return undefined; try { const d = new Date(val as string | number | Date); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } }, z.string().optional()), 
  status: z.enum(['sending', 'sent', 'delivered', 'read', 'failed']).optional().default('sent'),
  repliedToId: z.string().optional(),
  repliedTo: z.string().optional(),
  senderName: z.string().optional(),
  senderUsername: z.string().optional(),
  senderAvatarUrl: z.string().optional(),
  isViewOnce: z.boolean().optional(),
  isDeletedLocal: z.boolean().optional(),
}).passthrough();