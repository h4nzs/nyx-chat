import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config.js";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
  },
});

// Generate URL upload yang valid selama 5 menit
export const getPresignedUploadUrl = async (key: string, contentType: string) => {
  const command = new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(r2, command, { expiresIn: 300 });
  console.log(`[R2] Generated presigned upload URL for key: ${key}`);

  return url;
};

// Hapus file
export const deleteR2File = async (key: string) => {
  const command = new DeleteObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
  });

  console.log(`[R2] Attempting to delete file with key: ${key}`);
  const result = await r2.send(command);
  console.log(`[R2] Successfully deleted file with key: ${key}`);

  return result;
};