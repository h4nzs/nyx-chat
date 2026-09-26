/**
 * Shared type guard functions for validating parsed JSON payloads.
 * Use these instead of inline `as` assertions on JSON.parse results.
 */

import type { SystemMessagePayload } from '@nyx/shared';

// ─── Reaction Payload ────────────────────────────────────────────
export interface ReactionPayload {
  type: 'reaction';
  targetMessageId: string;
  emoji: string;
}

export function isReactionPayload(data: unknown): data is ReactionPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return (
    d.type === 'reaction' &&
    typeof d.targetMessageId === 'string' &&
    typeof d.emoji === 'string'
  );
}

// ─── Edit Payload ────────────────────────────────────────────────
export interface EditPayload {
  type: 'edit';
  targetMessageId: string;
  text: string;
}

export function isEditPayload(data: unknown): data is EditPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return (
    d.type === 'edit' &&
    typeof d.targetMessageId === 'string' &&
    typeof d.text === 'string'
  );
}

// ─── Silent / System Payload Types ───────────────────────────────
export type SilentType =
  | 'silent'
  | 'CALL_INIT'
  | 'GHOST_SYNC'
  | 'STORY_KEY'
  | 'UNSEND'
  | 'reaction_remove'
  | 'SYSTEM_KEY_REQUEST'
  // [T2] Sender-key distribution via pairwise session (doc 26.2): kunci grup
  // dikirim sebagai pesan kontrol 1:1, tak lagi lewat messages:distribute_keys.
  | 'GROUP_KEY';

export interface SilentPayload {
  type: SilentType;
  text?: string;
  key?: string;
  storyId?: string;
  targetMessageId?: string;
  emoji?: string;
  url?: string;
  /** [T2] GROUP_KEY distribution payload — sealed sender key + routing metadata. */
  groupKey?: {
    /** Sealed sender-key envelope (inner pq_box_seal, dipertahankan dari jalur lama). */
    key: string;
    /** Pseudonym pengirim distribusi (metadata v2) — di-resolve penerima via peta. */
    senderId?: string;
    senderDeviceKey?: string;
    /** Device filtering: envelope ditolak bila identity key device penerima tidak cocok. */
    targetDeviceId?: string;
    targetDeviceKey?: string;
  };
}

const SILENT_TYPES: ReadonlySet<string> = new Set<SilentType>([
  'silent', 'CALL_INIT', 'GHOST_SYNC', 'STORY_KEY',
  'UNSEND', 'reaction_remove', 'SYSTEM_KEY_REQUEST', 'GROUP_KEY',
]);

export function isSilentPayload(data: unknown): data is SilentPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  if (typeof d.type !== 'string' || !SILENT_TYPES.has(d.type)) return false;
  return true;
}

// ─── File Metadata ────────────────────────────────────────────────
export interface FileMetadata {
  type: 'file';
  url?: string;
  key?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  isBlindAttachment?: boolean;
}

export function isFileMetadata(data: unknown): data is FileMetadata {
  if (!isPlainObject(data)) return false;
  const d = data;
  if (d.type !== 'file') return false;
  // Validate optional field types if present
  if (d.url !== undefined && typeof d.url !== 'string') return false;
  if (d.key !== undefined && typeof d.key !== 'string') return false;
  if (d.name !== undefined && typeof d.name !== 'string') return false;
  if (d.size !== undefined && typeof d.size !== 'number') return false;
  if (d.mimeType !== undefined && typeof d.mimeType !== 'string') return false;
  if (d.isBlindAttachment !== undefined && typeof d.isBlindAttachment !== 'boolean') return false;
  return true;
}

// ─── Story Reply ─────────────────────────────────────────────────
export interface StoryReplyPayload {
  type: 'story_reply';
  text?: string;
  storyAuthorId?: string;
  isReply?: boolean;
  storyText?: string;
  hasMedia?: boolean;
}

export function isStoryReplyPayload(data: unknown): data is StoryReplyPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  if (d.type !== 'story_reply') return false;
  // Validate optional field types if present
  if (d.text !== undefined && typeof d.text !== 'string') return false;
  if (d.storyAuthorId !== undefined && typeof d.storyAuthorId !== 'string') return false;
  if (d.isReply !== undefined && typeof d.isReply !== 'boolean') return false;
  if (d.storyText !== undefined && typeof d.storyText !== 'string') return false;
  if (d.hasMedia !== undefined && typeof d.hasMedia !== 'boolean') return false;
  return true;
}

// ─── X3DH Header ─────────────────────────────────────────────────
export interface X3dhHeader {
  ciphertext?: string;
  x3dh?: {
    initiatorSigningKey: string;
    initiatorCiphertexts: string;
    otpkId: number;
  };
}

export function isX3dhHeader(data: unknown): data is X3dhHeader {
  if (!isPlainObject(data)) return false;
  const d = data;
  if (d.x3dh !== undefined) {
    if (!d.x3dh || typeof d.x3dh !== 'object') return false;
    const x = d.x3dh as Record<string, unknown>;
    if (typeof x.initiatorSigningKey !== 'string') return false;
    if (typeof x.initiatorCiphertexts !== 'string') return false;
    if (typeof x.otpkId !== 'number') return false;
  }
  return true;
}

// ─── System Message Payload ──────────────────────────────────────
export function isSystemMessagePayload(data: unknown): data is SystemMessagePayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return typeof d.type === 'string';
}

// ─── Generic Object with participants ────────────────────────────
export function hasParticipantsArray(data: unknown): data is { participants: string[] } {
  if (!isPlainObject(data)) return false;
  const d = data;
  return Array.isArray(d.participants) && d.participants.every(p => typeof p === 'string');
}

// ─── Ciphertext Wrapper ──────────────────────────────────────────
export interface CiphertextWrapper {
  ciphertext?: string;
}

export function isCiphertextWrapper(data: unknown): data is CiphertextWrapper {
  if (!isPlainObject(data)) return false;
  const d = data;
  return d.ciphertext === undefined || typeof d.ciphertext === 'string';
}

// ─── Conversation Metadata (decrypted) ────────────────────────────
export interface DecryptedGroupMetadata {
  title?: string;
  description?: string;
  avatarUrl?: string;
  participants?: string[];
  authSecret?: string;
}

export function isDecryptedGroupMetadata(data: unknown): data is DecryptedGroupMetadata {
  if (!isPlainObject(data)) return false;
  // All fields are optional, but validate types if present
  const d = data;
  if (d.title !== undefined && typeof d.title !== 'string') return false;
  if (d.description !== undefined && typeof d.description !== 'string') return false;
  if (d.avatarUrl !== undefined && typeof d.avatarUrl !== 'string') return false;
  if (d.authSecret !== undefined && typeof d.authSecret !== 'string') return false;
  if (d.participants !== undefined) {
    if (!Array.isArray(d.participants)) return false;
    if (!d.participants.every(p => typeof p === 'string')) return false;
  }
  return true;
}

// ─── Story Key Payload ────────────────────────────────────────────
export interface StoryKeyPayload {
  type: 'STORY_KEY';
  storyId?: string;
  key?: string;
}

export function isStoryKeyPayload(data: unknown): data is StoryKeyPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return d.type === 'STORY_KEY';
}

// ─── GHOST_SYNC Payload ────────────────────────────────────────────
export interface GhostSyncPayload {
  type: 'GHOST_SYNC';
}

export function isGhostSyncPayload(data: unknown): data is GhostSyncPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return d.type === 'GHOST_SYNC';
}

// ─── Upgraded Account Payload ──────────────────────────────────────
export interface ProtocolResetPayload {
  type: 'PROTOCOL_RESET';
  conversationId?: string;
  senderId?: string;
}

export function isProtocolResetPayload(data: unknown): data is ProtocolResetPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return d.type === 'PROTOCOL_RESET';
}

// ─── Plain Object (for Record<string, unknown> patterns) ───────────
/** Checks if value is a non-null object (not array). Use for JSON.parse results. */
export function isPlainObject(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data);
}

// ─── Link Preview ─────────────────────────────────────────────────
export interface LinkPreviewPayload {
  url?: string;
  title?: string;
  description?: string;
  image?: string;
}

export function isLinkPreviewPayload(data: unknown): data is LinkPreviewPayload {
  if (!isPlainObject(data)) return false;
  const d = data;
  return typeof d.url === 'string' || typeof d.title === 'string';
}
