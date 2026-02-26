import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config.js'

// 1. KITA HAPUS forcePathStyle
// 2. KITA HAPUS requestChecksumCalculation (kadang bikin S3 v3 rewel di R2)
export const s3Client = new S3Client({
  region: 'auto',
  // PERHATIKAN INI: Jangan pake path endpoint. 
  // Gunakan virtual hosted style secara eksplisit jika perlu, atau cukup biarin SDK mikir sendiri.
  // Tapi untuk R2, endpoint ini yang paling aman:
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  }
})

// Generate URL upload yang valid selama 5 menit
export const getPresignedUploadUrl = async (key: string, contentType: string) => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType
  })

  // PERHATIKAN INI: Hapus `signableHeaders: new Set(['host', 'content-type'])`
  // Kenapa? Karena browser (Fetch/XHR) sering kali nge-rewrite atau ngirim header Host 
  // dengan cara yang beda dari apa yang di-sign sama AWS SDK.
  // Biarin AWS SDK nge-sign minimalis aja.
  const url = await getSignedUrl(s3Client, command, { 
    expiresIn: 300 
  })

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
