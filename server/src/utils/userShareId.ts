// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 §R5] `User.shareId` — ID publik acak untuk tautan berbagi.
 *
 * Sebelumnya tautan `/u/<hashId>` membawa `usernameHash` (blind index
 * ter-pepper). Itu membuat pemegang dump dapat memakai nilai tersimpan sebagai
 * kunci lookup hidup, dan membuat tautan yang beredar selamanya terkait dengan
 * blind index akun. `shareId` memutus kaitan itu: 256-bit acak, tanpa
 * hubungan matematis dengan username.
 *
 * Baris legacy belum punya kolom ini; diisi sekali saat register atau lazily
 * saat login / `GET /me` (bukan job backfill terpisah). Collision 256-bit
 * praktis mustahil, jadi tidak ada retry khusus — P2002 di sini berarti bug
 * RNG, bukan kejadian normal.
 */
import { prisma } from '../lib/prisma.js'
import { generateShareId } from './atRestSecrets.js'

export async function ensureUserShareId(user: { id: string; shareId?: string | null }): Promise<string> {
  if (user.shareId) return user.shareId
  const shareId = generateShareId()
  await prisma.user.update({ where: { id: user.id }, data: { shareId } })
  user.shareId = shareId
  return shareId
}
