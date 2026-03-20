import { z } from 'zod';
import { asUserId, asConversationId, asMessageId, asStoryId } from '../types/brands';

// --- Base ID Schemas (Transforming to Branded Types) ---
export const UserIdSchema = z.string().min(1).transform((val) => asUserId(val));
export const ConversationIdSchema = z.string().min(1).transform((val) => asConversationId(val));
export const MessageIdSchema = z.string().min(1).transform((val) => asMessageId(val));
export const StoryIdSchema = z.string().min(1).transform((val) => asStoryId(val));

// --- Minimal Shared Schemas ---
// Digunakan sebagai pondasi awal sebelum kita memvalidasi seluruh entitas
export const MinimalUserSchema = z.object({
  id: UserIdSchema,
  username: z.string(),
  avatarUrl: z.string().nullable().optional(),
});

export const IncomingMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: z.string().nullable().optional(), // Nullable optional to be safe
  timestamp: z.union([z.number(), z.string(), z.date()]).transform(val => new Date(val).toISOString()), // Transform to ISO string to match core types usually
  // Using passthrough to allow other fields like 'ciphertext', 'nonce' etc without validation for now
}).passthrough();

// --- WebRTC Signaling Schemas ---
export const WebRTCSignalTypeSchema = z.enum(['request', 'accept', 'offer', 'answer', 'ice-candidate', 'end', 'reject']);

export const WebRTCSignalingSchema = z.object({
  type: WebRTCSignalTypeSchema,
  from: UserIdSchema,
  // Using passthrough because payload is often an encrypted string during 'webrtc:secure_signal' 
  // but could be object if not fully encrypted at the transport layer
  payload: z.any().optional(), 
}).passthrough();

// --- Local Database Schemas ---
export const ShadowVaultMessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderId: UserIdSchema,
  content: z.string().nullable().optional(),
  createdAt: z.union([z.number(), z.string(), z.date()]).transform(val => new Date(val).toISOString()), 
  status: z.enum(['sending', 'sent', 'delivered', 'read', 'failed']).optional().default('sent'),
  repliedToId: z.string().optional(),
  repliedTo: z.string().optional(),
  senderName: z.string().optional(),
  senderUsername: z.string().optional(),
  senderAvatarUrl: z.string().optional(),
  isViewOnce: z.boolean().optional(),
  isDeletedLocal: z.boolean().optional(),
}).passthrough();