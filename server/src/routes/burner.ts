// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Status room burner (Burner Chat / halaman `/drop`).
 *
 * Kenapa endpoint ini ada: destroy hanya disiarkan sebagai event realtime
 * (`burner:terminated`) ke anggota room. Kalau guest sedang offline, belum
 * bergabung, atau identitas guest-nya berganti setelah reload, event itu tidak
 * pernah sampai — dan halaman `/drop` sama sekali tidak punya cara bertanya
 * "room ini masih hidup?". Akibatnya guest bisa duduk di room yang sudah
 * dihancurkan host, bahkan setelah refresh. Status ini memberi gerbang yang
 * tidak bergantung pada kehadiran socket saat destroy terjadi.
 *
 * Pengetahuan yang dibocorkan minimal: hanya `terminated: true|false` untuk
 * room id yang diminta. Tidak ada isi pesan, kunci, atau daftar anggota.
 */
import { Router } from 'express';
import { redisClient } from '../lib/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';

const router = Router();

/** Key Redis yang dipakai juga oleh `realtimeHandlers` saat destroy. */
export function burnerTerminatedKey(roomId: string): string {
  return `burner:terminated:${roomId}`;
}

/**
 * Bentuk room id yang dibuat `generateBurnerLink()`: `burner_` + hex 32.
 * Divalidasi supaya endpoint ini tidak bisa dipakai memanggil key Redis
 * sembarang (`burner:room:*`, key internal lain) dan supaya panjang key
 * terbatas — fail-closed, bukan sanitasi longgar.
 */
export function isValidBurnerRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && /^burner_[A-Za-z0-9]{1,64}$/.test(roomId);
}

router.get('/:roomId/status', requireAuth, async (req, res, next) => {
  try {
    const { roomId } = req.params;
    if (!isValidBurnerRoomId(roomId)) throw new ApiError(400, 'Invalid burner room id');

    const terminated = (await redisClient.exists(burnerTerminatedKey(roomId))) === 1;
    res.json({ roomId, terminated });
  } catch (e) {
    next(e);
  }
});

export default router;
