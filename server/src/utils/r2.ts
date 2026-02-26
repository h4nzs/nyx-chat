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
  // 1. INI MEMBUNUH BUG CRC32 (AAAAAA==)
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED"
})

export const getPresignedUploadUrl = async (key: string, contentType: string) => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType
  })

  const url = await getSignedUrl(s3Client, command, { 
    expiresIn: 300,
    // 2. KITA KEMBALIKAN INI BIAR CONTENT-TYPE IKUT DITANDATANGANI!
    signableHeaders: new Set(['host', 'content-type']) 
  })

  return url
}

export const deleteR2File = async (key: string) => {
  const command = new DeleteObjectCommand({
    Bucket: env.r2BucketName,
    Key: key
  })

  return await s3Client.send(command)
}
