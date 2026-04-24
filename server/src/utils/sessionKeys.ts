// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { prisma } from '../lib/prisma.js'
import { PrismaClient } from '@prisma/client'

export type PrismaTransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">

/**
 * Payload interface for client-encrypted session keys.
 */
export interface ClientSessionKeyPayload {
  deviceId: string;
  encryptedKey: string; // Base64url encoded
  initiatorCiphertexts?: string; // Optional, Base64url encoded
  isInitiator?: boolean;
}

/**
 * Relays client-encrypted session keys to the database for distribution.
 * Pure Blind Relay implementation: Server does not generate or see any plaintext keys.
 */
export async function relaySessionKeys(
  conversationId: string,
  sessionId: string,
  keys: ClientSessionKeyPayload[],
  tx?: PrismaTransactionClient
) {
  const db = tx || prisma

  if (!keys || keys.length === 0) {
    throw new Error(`No session keys provided for conversation ${conversationId}`)
  }

  // Map client payloads to database records
  const keyRecords = keys.map(k => ({
    conversationId,
    sessionId,
    deviceId: k.deviceId,
    encryptedKey: Buffer.from(k.encryptedKey, 'base64url'),
    initiatorCiphertexts: k.initiatorCiphertexts ? Buffer.from(k.initiatorCiphertexts, 'base64url') : null,
    isInitiator: k.isInitiator || false
  }))

  // Save keys to database for retrieval by participant devices
  await db.sessionKey.createMany({
    data: keyRecords
  });

  return { sessionId };
}
