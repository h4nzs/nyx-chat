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
  // --- INI 2 BARIS PENYELAMAT NYAWA BUAT CLOUDFLARE R2 ---
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED" // Mematikan auto-checksum AAAAAA==
})

// Generate URL upload yang valid selama 5 menit
export const getPresignedUploadUrl = async (key: string, contentType: string) => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType
  })

  // Biarkan signableHeaders default, yang penting checksum mati
  const url = await getSignedUrl(s3Client, command, { expiresIn: 300 })

  return url
}

// Hapus file
export const deleteR2File = async (key: string) => {
  const command = new DeleteObjectCommand({
    Bucket: env.r2BucketName,
    Key: key
  })

  const result = await s3Client.send(command)

  return result
}
