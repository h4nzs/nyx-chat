import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { env } from '../config.js'
import { nanoid } from 'nanoid'
import { getPresignedUploadUrl } from '../utils/r2.js' 
import { uploadLimiter } from '../middleware/rateLimiter.js'
// [AUDIT 2026-10-24] Batas ukuran ditetapkan server (dan dikunci di presign).
import { resolveUploadPolicy, validateUploadSize } from '../utils/uploadLimits.js'

const router: Router = Router()

// Presigning tanpa kredensial R2 hanya menghasilkan 500 yang membingungkan
// (dan di CI/e2e membuat kegagalan upload tampak seperti bug klien). Jawab
// eksplisit agar klien/ops tahu fitur file memang belum dikonfigurasi.
const storageConfigured = (): boolean =>
  Boolean(env.r2AccountId && env.r2AccessKeyId && env.r2SecretAccessKey && env.r2BucketName)

// === 0. GENERATE PRESIGNED URL ===
router.post('/presigned', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    if (!storageConfigured()) {
      return res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' })
    }

    const { fileName, fileType, folder } = req.body

    if (!fileName || !fileType || !folder) {
      return res.status(400).json({ error: 'Missing required fields: fileName, fileType, or folder' })
    }

    // [FIX] Cek status verifikasi pengguna
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isVerified: true, subscriptionTier: true } });
    if (!user?.isVerified) {
        return res.status(403).json({ error: 'SANDBOX_UPLOAD_RESTRICTION: Unverified users cannot upload files.' });
    }

    const allowedFolders = ['avatars', 'attachments', 'groups']
    const targetFolder = allowedFolders.includes(folder) ? folder : 'misc'

    // ZERO-KNOWLEDGE PROTOCOL ENFORCEMENT
    // The server must only accept encrypted binary blobs. 
    // Allowing specific mime-types leaks metadata about the communication patterns.
    if (fileType !== 'application/octet-stream') {
      return res.status(400).json({ error: "Protocol violation: Only encrypted 'application/octet-stream' payloads are permitted." })
    }

    // [AUDIT 2026-10-24] Ukuran ditetapkan server dan ikut ditandatangani
    // (`ContentLength` → `X-Amz-SignedHeaders`), sehingga R2 menolak body yang
    // lebih besar/kecil dari yang disetujui. `fileSize` kini WAJIB: tanpa angka
    // dari klien tidak ada yang bisa dikunci — dan presign tanpa batas adalah
    // lubang yang sedang ditutup ini.
    const policy = resolveUploadPolicy(
      targetFolder === 'avatars' || targetFolder === 'groups' ? targetFolder : 'attachments',
      user.subscriptionTier
    );
    const sizeCheck = validateUploadSize(req.body.fileSize, policy);
    if (!sizeCheck.ok) {
      return res.status(400).json({
        error: sizeCheck.error === 'FILE_SIZE_REQUIRED'
          ? 'FILE_SIZE_REQUIRED: fileSize (byte) wajib dikirim agar server bisa mengunci ukuran upload.'
          : `Payload too large. Maximum size for ${targetFolder} is ${sizeCheck.maxMB}MB.`,
        code: sizeCheck.error,
        maxMB: sizeCheck.maxMB
      });
    }

    const ext = fileName.split('.').pop()?.toLowerCase()
    if (!ext) {
      return res.status(400).json({ error: 'File extension not found in filename' })
    }

    // urlTtl: How long the UPLOAD LINK works (default 5 mins)
    const urlTtl = req.body.urlTtl ? parseInt(req.body.urlTtl, 10) : 300;

    // fileRetention: How long the FILE lives before expiration (optional, seconds)
    // Used for Disappearing Messages or temporary transfers
    let deleteAt: Date | undefined;
    const fileRetention = req.body.fileRetention ? parseInt(req.body.fileRetention, 10) : 0;
    
    if (fileRetention > 0) {
      deleteAt = new Date();
      deleteAt.setSeconds(deleteAt.getSeconds() + fileRetention);
    }

    const key = `${targetFolder}/${req.user!.id}-${nanoid()}.${ext}`

    // [FIX] Force Content-Type to octet-stream because file is ENCRYPTED
    // We pass both urlTtl (link expiry) and deleteAt (file metadata expiry)
    const uploadUrl = await getPresignedUploadUrl(key, 'application/octet-stream', urlTtl, sizeCheck.size, deleteAt)

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

// === 0.1 BURNER CHAT PRESIGNED URL (ANONYMOUS) ===
router.post('/burner-presigned', uploadLimiter, async (req, res, next) => {
  try {
    if (!storageConfigured()) {
      return res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' })
    }

    const { fileName, fileType, folder } = req.body

    if (!fileName || !fileType || folder !== 'attachments') {
      return res.status(400).json({ error: 'Missing required fields or invalid folder for burner' })
    }

    if (fileType !== 'application/octet-stream') {
      return res.status(400).json({ error: "Protocol violation: Only encrypted 'application/octet-stream' payloads are permitted." })
    }

    // [AUDIT 2026-10-24] Sama seperti jalur ber-login: angka dari klien dipakai
    // sebagai `ContentLength` yang ditandatangani, jadi batas 50 MB ditegakkan
    // R2, bukan hanya dipercaya dari body.
    const sizeCheck = validateUploadSize(req.body.fileSize, resolveUploadPolicy('burner', null));
    if (!sizeCheck.ok) {
      return res.status(400).json({
        error: sizeCheck.error === 'FILE_SIZE_REQUIRED'
          ? 'FILE_SIZE_REQUIRED: fileSize (byte) wajib dikirim agar server bisa mengunci ukuran upload.'
          : 'Payload too large. Maximum size is 50MB.',
        code: sizeCheck.error,
        maxMB: sizeCheck.maxMB
      });
    }

    const ext = fileName.split('.').pop()?.toLowerCase()
    if (!ext) {
      return res.status(400).json({ error: 'File extension not found in filename' })
    }

    let deleteAt: Date | undefined;
    const fileRetention = req.body.fileRetention ? parseInt(req.body.fileRetention, 10) : 0;
    if (fileRetention > 0) {
      deleteAt = new Date();
      deleteAt.setSeconds(deleteAt.getSeconds() + fileRetention);
    }

    const key = `burner/${nanoid()}.${ext}`
    const uploadUrl = await getPresignedUploadUrl(key, 'application/octet-stream', 300, sizeCheck.size, deleteAt)

    res.json({
      uploadUrl,
      key,
      publicUrl: `${env.r2PublicDomain}/${key}`
    })
  } catch (error) {
    console.error('[PRESIGNED-URL-ERROR] Failed to generate Burner URL')
    next(error)
  }
})

// User avatars are now E2E Encrypted and updated via PUT /api/users/me along with the profile.
// The server cannot decrypt the profile to extract the old avatar URL, so client must handle garbage collection or rely on orphaned file cleanup.

// [AUDIT 2026-10-24] Route `POST /groups/:id/avatar` DIHAPUS: router ini tidak
// memasang multer sehingga `req.file` selalu undefined, handler hanya
// mengembalikan `fileUrl` yang dikirim klien tanpa menulis apa pun, dan avatar
// grup kini lewat `PUT /api/conversations/:id/details`. Ia hanya memotong
// kuota `uploadLimiter` (20/jam) milik pengguna.

export default router
