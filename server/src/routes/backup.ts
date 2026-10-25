// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'

import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { generalLimiter, uploadLimiter } from '../middleware/rateLimiter.js'
import { env } from '../config.js'
import { deleteR2File, getPresignedDownloadUrl, getPresignedUploadUrl } from '../utils/r2.js'
import { clampBackupUrlTtl, deriveBackupObjectKey, validateBackupUpload } from '../utils/backupObject.js'
import { BACKUP_OPS, incCounter } from '../utils/metrics.js'

// [docs/30 WS-C fase 3 / docs/31 §31.6] Transport backup ber-frame ke R2.
//
// Kontrak privasi:
//   - Server TIDAK PERNAH melihat kunci/konten: arsip sudah terenkripsi di
//     klien dengan kunci turunan recovery phrase (Argon2id). Body yang di-PUT
//     adalah `application/octet-stream` opaque.
//   - Kunci objek diturunkan HMAC (tanpa userId) — lihat `utils/backupObject.ts`.
//   - Tidak ada tabel DB baru: satu objek per akun (kunci deterministik →
//     unggah berikutnya menimpa, jadi tidak ada riwayat yang menumpuk).
//
// Rate limit: `uploadLimiter` untuk presign (20/jam), `generalLimiter` untuk
// unduh/hapus (operasi murah, tidak mengunggah byte).

const router: Router = Router()

// === 1. PRESIGNED UPLOAD ===
router.post('/presign', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    // Gate yang sama dengan `/api/uploads/presigned`: akun sandbox tak boleh
    // menyimpan blob di R2. Dicatat sebagai kebijakan, bukan penegakan kripto.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isVerified: true, subscriptionTier: true }
    })
    if (!user?.isVerified) {
      incCounter(BACKUP_OPS, { op: 'presign', result: 'unverified' })
      return res.status(403).json({ error: 'SANDBOX_UPLOAD_RESTRICTION: Unverified users cannot store backups.' })
    }

    const decision = validateBackupUpload(req.body?.size, req.body?.urlTtl, user.subscriptionTier)
    if (!decision.ok) {
      incCounter(BACKUP_OPS, { op: 'presign', result: 'rejected' })
      return res.status(decision.status).json({ error: decision.error })
    }

    const key = deriveBackupObjectKey(env.backupKeySecret, userId)
    // Content-Type dikunci `application/octet-stream` (arsip terenkripsi).
    // [AUDIT 2026-10-24] Ukuran arsip yang sudah divalidasi ikut dikunci di
    // tanda tangan, jadi R2 menolak body yang berbeda dari yang disetujui.
    const uploadUrl = await getPresignedUploadUrl(key, 'application/octet-stream', decision.urlTtl, decision.size)

    incCounter(BACKUP_OPS, { op: 'presign', result: 'ok' })
    res.json({
      uploadUrl,
      key,
      size: decision.size,
      urlTtl: decision.urlTtl,
      contentType: 'application/octet-stream'
    })
  } catch (error) {
    incCounter(BACKUP_OPS, { op: 'presign', result: 'error' })
    next(error)
  }
})

// === 2. PRESIGNED DOWNLOAD (restore di perangkat pengganti) ===
router.post('/download-url', requireAuth, generalLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const urlTtl = clampBackupUrlTtl(req.body?.urlTtl)
    const key = deriveBackupObjectKey(env.backupKeySecret, userId)
    const downloadUrl = await getPresignedDownloadUrl(key, urlTtl)

    incCounter(BACKUP_OPS, { op: 'download', result: 'ok' })
    res.json({ downloadUrl, key, urlTtl })
  } catch (error) {
    incCounter(BACKUP_OPS, { op: 'download', result: 'error' })
    next(error)
  }
})

// === 3. DELETE (hapus backup awan milik sendiri; bagian alur nuke) ===
router.delete('/', requireAuth, generalLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const key = deriveBackupObjectKey(env.backupKeySecret, userId)
    await deleteR2File(key)

    incCounter(BACKUP_OPS, { op: 'delete', result: 'ok' })
    res.json({ deleted: true })
  } catch (error) {
    incCounter(BACKUP_OPS, { op: 'delete', result: 'error' })
    next(error)
  }
})

export default router
