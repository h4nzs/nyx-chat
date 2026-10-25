import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommandInput } from '@aws-sdk/client-s3'
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
// contentLength: Ukuran body yang diizinkan. WAJIB untuk upload dari klien:
//   nilainya ikut ditandatangani (`X-Amz-SignedHeaders` berisi
//   `content-length`), jadi R2 menolak PUT yang body-nya lebih besar/kecil dari
//   yang disetujui server — bukan sekadar percaya `fileSize` dari body request.
// deleteAt: Kapan FILE harus dianggap kadaluarsa (untuk Lifecycle Rules / Metadata)
export const getPresignedUploadUrl = async (key: string, contentType: string, urlTtl: number = 600, contentLength?: number, deleteAt?: Date) => {
  const commandInput: PutObjectCommandInput = {
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType,
    // [FIX] Ensure we don't include checksums in the signature as the frontend won't send them
    ChecksumAlgorithm: undefined 
  };

  // [AUDIT 2026-10-24] Ukuran ditetapkan server (lihat utils/uploadLimits.ts).
  if (typeof contentLength === 'number' && contentLength > 0) {
    commandInput.ContentLength = contentLength;
  }

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

// [docs/31 §31.6 fase 3] URL unduh presigned untuk objek privat (mis. backup).
// Tidak menandatangani header Content-Type/Checksum apa pun, sehingga klien
// boleh mengirim `Range` untuk membaca arsip per frame tanpa mematahkan signature.
export const getPresignedDownloadUrl = async (key: string, urlTtl: number = 300) => {
  const command = new GetObjectCommand({
    Bucket: env.r2BucketName,
    Key: key
  })

  return await getSignedUrl(s3Client, command, { expiresIn: urlTtl })
}

/**
 * [docs/10 §10.13] Tulis objek dari sisi server (bukan presign) — dipakai job
 * snapshot log KT: berkasnya ada di host, bukan di browser, jadi tidak ada
 * gunanya membuat URL bertanda tangan.
 */
export const putR2Object = async (key: string, body: Uint8Array, contentType = 'application/octet-stream') => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    Body: body,
    ContentType: contentType
  })

  return await s3Client.send(command)
}

/**
 * Daftar objek di bawah satu prefix (dipakai retensi snapshot). Dipaginasi
 * penuh: satu halaman hanya memuat 1000 kunci, dan retensi yang diam-diam
 * berhenti di halaman pertama adalah cara paling halus kehilangan riwayat.
 */
export const listR2Objects = async (prefix: string): Promise<Array<{ key: string; lastModified?: Date }>> => {
  const out: Array<{ key: string; lastModified?: Date }> = []
  let continuationToken: string | undefined

  do {
    const page = await s3Client.send(new ListObjectsV2Command({
      Bucket: env.r2BucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }))
    for (const object of page.Contents ?? []) {
      if (object.Key) out.push({ key: object.Key, lastModified: object.LastModified })
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  return out
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
