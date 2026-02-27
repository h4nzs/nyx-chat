import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config.js'

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  },
  // 1. WAJIB BUAT R2: Biar URL-nya gak jadi subdomain aneh (chat-uploads.671c...)
  forcePathStyle: true,
  // 2. OBAT ANTI-AAAAAA==: Larang AWS SDK ngitung checksum file kosong!
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
})

// Generate URL upload yang valid selama 5 menit
export const getPresignedUploadUrl = async (key: string, contentType: string) => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType
  })

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: 300,
    signableHeaders: new Set(['content-type'])
  })

  return url
}

// Hapus file
export const deleteR2File = async (key: string) => {
  const command = new DeleteObjectCommand({
    Bucket: env.r2BucketName,
    Key: key
  })

  return await s3Client.send(command)
}
