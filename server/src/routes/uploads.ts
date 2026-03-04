import { Router, Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { ApiError } from '../utils/errors.js'
import { getIo } from '../socket.js'
import { env } from '../config.js'
import { nanoid } from 'nanoid'
import { getPresignedUploadUrl, deleteR2File } from '../utils/r2.js' 
import { uploadLimiter } from '../middleware/rateLimiter.js'
import { deleteFromSupabase } from '../utils/supabase.js' 

const router: Router = Router()

// Helper: Hapus file lama (Support R2 & Legacy Supabase)
async function deleteOldFile (url: string) {
  try {
    if (!url) {
      return
    }
    // [FIX] Ensure r2PublicDomain is valid before checking includes.
    // If r2PublicDomain is empty string, url.includes('') is always true!
    if (env.r2PublicDomain && env.r2PublicDomain.length > 0 && url.includes(env.r2PublicDomain)) {
      const key = url.replace(`${env.r2PublicDomain}/`, '')
      await deleteR2File(key)
    }
    else {
      await deleteFromSupabase(url)
    }
  } catch (error) {
    console.error('[Delete File Error]', error)
  }
}

// === 0. GENERATE PRESIGNED URL ===
router.post('/presigned', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const { fileName, fileType, folder } = req.body

    if (!fileName || !fileType || !folder) {
      return res.status(400).json({ error: 'Missing required fields: fileName, fileType, or folder' })
    }

    const allowedFolders = ['avatars', 'attachments', 'groups']
    const targetFolder = allowedFolders.includes(folder) ? folder : 'misc'

    // ZERO-KNOWLEDGE PROTOCOL ENFORCEMENT
    // The server must only accept encrypted binary blobs. 
    // Allowing specific mime-types leaks metadata about the communication patterns.
    if (fileType !== 'application/octet-stream') {
      return res.status(400).json({ error: "Protocol violation: Only encrypted 'application/octet-stream' payloads are permitted." })
    }

    const fileSize = req.body.fileSize ? parseInt(req.body.fileSize, 10) : 0
    if (fileSize > 0) {
      // Unified Zero-Knowledge Limits (in Bytes) based purely on destination folder
      const AVATAR_LIMIT = 5 * 1024 * 1024;      // 5 MB for avatars
      const ATTACHMENT_LIMIT = 100 * 1024 * 1024; // 100 MB max for chat attachments (HD Images, Videos, Files)
      
      const maxSize = (targetFolder === 'avatars' || targetFolder === 'groups') ? AVATAR_LIMIT : ATTACHMENT_LIMIT;

      // Encryption Overhead Buffer (IV + Auth Tag + Margin)
      // AES-GCM adds ~28 bytes. We add 1KB to be safe.
      const ENCRYPTION_OVERHEAD = 1024; 
      const allowedMax = maxSize + ENCRYPTION_OVERHEAD;

      if (fileSize > allowedMax) {
        const allowedMaxMB = (maxSize / (1024 * 1024)).toFixed(0)
        return res.status(400).json({
          error: `Payload too large. Maximum size for ${targetFolder} is ${allowedMaxMB}MB.`
        })
      }
    }

    const ext = fileName.split('.').pop()?.toLowerCase()
    if (!ext) {
      return res.status(400).json({ error: 'File extension not found in filename' })
    }

    const key = `${targetFolder}/${req.user!.id}-${nanoid()}.${ext}`

    // [FIX] Force Content-Type to octet-stream because file is ENCRYPTED
    const uploadUrl = await getPresignedUploadUrl(key, 'application/octet-stream')

    // Safe logging - do not log filename
    // console.log(`[Upload] Presigned URL generated for user ${req.user!.id}`);

    res.json({
      uploadUrl,
      key,
      publicUrl: `${env.r2PublicDomain}/${key}`
    })
  } catch (error) {
    console.error('[PRESIGNED-URL-ERROR] Failed to generate URL')
    next(error)
  }
})

// User avatars are now E2E Encrypted and updated via PUT /api/users/me along with the profile.
// The server cannot decrypt the profile to extract the old avatar URL, so client must handle garbage collection or rely on orphaned file cleanup.

// === 1. SIMPAN AVATAR GROUP ===
router.post(
  '/groups/:id/avatar',
  uploadLimiter,
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fileUrl } = req.body
      const groupId = req.params.id

      if (!req.user) throw new ApiError(401, 'Unauthorized')
      if (!fileUrl) throw new ApiError(400, 'Missing fileUrl.')

      const participant = await prisma.participant.findFirst({
        where: { userId: req.user.id, conversationId: groupId as string }
      })
      if (!participant || participant.role !== 'ADMIN') throw new ApiError(403, 'Forbidden: Only admin can change group avatar')

      const oldGroup = await prisma.conversation.findUnique({
        where: { id: groupId as string },
        select: { avatarUrl: true }
      })

      if (oldGroup?.avatarUrl) {
        deleteOldFile(oldGroup.avatarUrl).catch(console.error)
      }

      const updatedConversation = await prisma.conversation.update({
        where: { id: groupId as string },
        data: { avatarUrl: fileUrl },
        include: {
          participants: {
            include: {
              user: { select: { id: true, encryptedProfile: true, publicKey: true } }
            }
          }
        }
      })

      const transformedConversation = {
        ...updatedConversation,
        participants: updatedConversation.participants.map((p: any) => ({ ...p.user, role: p.role }))
      }

      getIo().to(groupId).emit('conversation:updated', {
        id: groupId,
        avatarUrl: fileUrl,
        lastUpdated: updatedConversation.updatedAt
      })

      res.json(transformedConversation)
    } catch (e) {
      next(e)
    }
  })

export default router
