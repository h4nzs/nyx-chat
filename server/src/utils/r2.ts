import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config.js'

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  },
  forcePathStyle: true
})

// Generate URL upload yang valid selama 5 menit (default)
// urlTtl: Berapa lama LINK upload valid (detik)
// deleteAt: Kapan FILE harus dianggap kadaluarsa (untuk Lifecycle Rules / Metadata)
export const getPresignedUploadUrl = async (key: string, contentType: string, urlTtl: number = 300, deleteAt?: Date) => {
  const commandInput: any = {
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType,
    // [FIX] Ensure we don't include checksums in the signature as the frontend won't send them
    ChecksumAlgorithm: undefined 
  };

  // Jika ada jadwal penghapusan (Disappearing Messages / Cleanup)
  // Kita pasang Custom Metadata 'delete-at'. 
  // NOTE: Kita tidak pakai 'Expires' header di sini karena AWS SDK akan memaksa header tersebut masuk ke signature,
  // yang menyebabkan error 403 (CORS/Signature Mismatch) jika browser tidak mengirim header 'Expires'.
  if (deleteAt) {
    commandInput.Metadata = {
      'delete-at': deleteAt.toISOString()
    };
  }

  const command = new PutObjectCommand(commandInput)

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: urlTtl, 
    // Kita hanya mengunci content-type. Header lain seperti 'host' akan diurus SDK.
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

// Hapus BANYAK file sekaligus (Batch Delete)
export const deleteR2Files = async (keys: string[]) => {
  if (keys.length === 0) return

  const command = new DeleteObjectsCommand({
    Bucket: env.r2BucketName,
    Delete: {
      Objects: keys.map(Key => ({ Key })),
      Quiet: true
    }
  })

  return await s3Client.send(command)
}
