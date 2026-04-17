// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { prisma } from '../lib/prisma.js'
import { PrismaClient } from '@prisma/client'
import { getSodium } from '../lib/sodium.js'
import { sanitizeForLog } from './logger.js'

export type PrismaTransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">

const B64_VARIANT = 'URLSAFE_NO_PADDING'

/**
 * Creates a new session key from scratch on the server and encrypts it for all participant devices.
 * This is used for ratcheting sessions or as a fallback.
 */
export async function rotateAndDistributeSessionKeys (conversationId: string, initiatorId: string, tx?: PrismaTransactionClient) {
  const db = tx || prisma
  const sodium = await getSodium()
  const sessionKey = sodium.crypto_secretbox_keygen()
  const sessionId = `session_${sodium.to_hex(sodium.randombytes_buf(16))}`

  // ✅ FIX: Tarik partisipan sekaligus dengan SEMUA perangkat aktif mereka
  const participants = await db.participant.findMany({
    where: { conversationId },
    include: { 
      user: { 
        include: { 
          devices: {
            select: { id: true, publicKey: true }
          }
        } 
      } 
    }
  })

  if (participants.length === 0) {
    throw new Error(`No participants found for conversation ${conversationId}`)
  }

  // Tipe data yang valid untuk di-insert ke tabel SessionKey skema baru
  type SessionKeyRecord = {
    sessionId: string;
    encryptedKey: string;
    deviceId: string;
    conversationId: string;
    initiatorCiphertexts: Buffer | null;
    isInitiator: boolean;
  }

  const keyRecords: SessionKeyRecord[] = []
  let initiatorHasKey = false;
  let initiatorEncryptedKey = '';

  // ✅ FIX: Looping Ganda (1 User -> Banyak Device)
  for (const p of participants) {
    const devices = p.user.devices

    if (!devices || devices.length === 0) {
      console.warn(`User ${sanitizeForLog(p.user.id)} in conversation ${sanitizeForLog(conversationId)} has no active devices.`)
      continue
    }

    for (const device of devices) {
      if (!device.publicKey) {
        console.warn(`Device ${sanitizeForLog(device.id)} for user ${sanitizeForLog(p.user.id)} has no public key.`)
        continue
      }

      try {
        const recipientPublicKey = new Uint8Array(device.publicKey);
        const encryptedKey = sodium.crypto_box_seal(sessionKey, recipientPublicKey)
        const encryptedKeyB64 = sodium.to_base64(encryptedKey, sodium.base64_variants[B64_VARIANT])

        const isInitiator = p.user.id === initiatorId

        keyRecords.push({
          sessionId,
          encryptedKey: encryptedKeyB64,
          deviceId: device.id,
          conversationId,
          initiatorCiphertexts: null, // Add placeholder ephemeral key
          isInitiator
        })

        if (isInitiator && !initiatorHasKey) {
          initiatorHasKey = true
          initiatorEncryptedKey = encryptedKeyB64
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error'
        console.error(`Failed to process public key for device ${sanitizeForLog(device.id)}. Error: ${sanitizeForLog(errorMessage)}`)
        throw new Error(`Corrupted public key found for device ${sanitizeForLog(device.id)}. Cannot establish secure session.`)
      }
    }
  }

  if (keyRecords.length === 0) {
    throw new Error(`Failed to create session keys: No valid devices found in conversation ${sanitizeForLog(conversationId)}.`)
  }

  if (!initiatorHasKey) {
    throw new Error('Could not find a valid session key for the initiator\'s device.')
  }

  // Simpan kunci ke database untuk didistribusikan ke masing-masing device
  await prisma.sessionKey.createMany({
      data: keyRecords.map(k => ({
        ...k,
        // Konversi eksplisit Buffer ke Uint8Array murni agar kompatibel dengan Prisma Bytes
        encryptedKey: new Uint8Array(Buffer.from(k.encryptedKey, 'base64')),
        initiatorCiphertexts: k.initiatorCiphertexts ? new Uint8Array(k.initiatorCiphertexts) : null
      }))
    });

    return { sessionId, encryptedKey: initiatorEncryptedKey };
}