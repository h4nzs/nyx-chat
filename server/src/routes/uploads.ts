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

    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'video/mp4', 'video/quicktime', 'video/x-msvideo',
      'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp3',
      'application/zip', 'application/x-rar-compressed',
      'application/octet-stream'
    ]

    if (!allowedTypes.includes(fileType)) {
      return res.status(400).json({ error: `File type not allowed: ${fileType}` })
    }

    const fileSize = req.body.fileSize ? parseInt(req.body.fileSize, 10) : 0
    if (fileSize > 0) {
      const avatarMaxSize = 5 * 1024 * 1024
      const imageMaxSize = 15 * 1024 * 1024
      const videoMaxSize = 100 * 1024 * 1024
      const documentMaxSize = 50 * 1024 * 1024

      let maxSize: number
      if (targetFolder === 'avatars') {
        maxSize = avatarMaxSize
      } else if (fileType.startsWith('image/')) {
        maxSize = imageMaxSize
      } else if (fileType.startsWith('video/')) {
        maxSize = videoMaxSize
      } else if (fileType.startsWith('audio/')) {
        maxSize = videoMaxSize
      } else if (fileType.startsWith('application/') || fileType === 'text/plain') {
        maxSize = documentMaxSize
      } else {
        maxSize = documentMaxSize
      }

      // Encryption Overhead Buffer (IV + Auth Tag + Margin)
      // AES-GCM adds ~28 bytes. We add 1KB to be safe.
      const ENCRYPTION_OVERHEAD = 1024; 
      const allowedMax = maxSize + ENCRYPTION_OVERHEAD;

      if (fileSize > allowedMax) {
        const allowedMaxMB = (allowedMax / (1024 * 1024)).toFixed(2)
        return res.status(400).json({
          error: `File too large. Maximum size for this file type is ${allowedMaxMB}MB (including encryption overhead).`
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

    res.json({
      uploadUrl,
      key,
      publicUrl: `${env.r2PublicDomain}/${key}`
    })
  } catch (error) {
    console.error('[PRESIGNED-URL-ERROR]', error)
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
        where: { userId: req.user.id, conversationId: groupId }
      })
      if (!participant || participant.role !== 'ADMIN') throw new ApiError(403, 'Forbidden: Only admin can change group avatar')

      const oldGroup = await prisma.conversation.findUnique({
        where: { id: groupId },
        select: { avatarUrl: true }
      })

      if (oldGroup?.avatarUrl) {
        deleteOldFile(oldGroup.avatarUrl).catch(console.error)
      }

      const updatedConversation = await prisma.conversation.update({
        where: { id: groupId },
        data: { avatarUrl: fileUrl },
        include: {
          participants: {
            select: {
              user: { select: { id: true, encryptedProfile: true, publicKey: true } },
              role: true
            }
          },
          creator: { select: { id: true } }
        }
      })

      const transformedConversation = {
        ...updatedConversation,
        participants: updatedConversation.participants.map(p => ({ ...p.user, role: p.role }))
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
