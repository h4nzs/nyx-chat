import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js';

// Pastikan bucket ini sudah dibuat di Supabase Dashboard dan diset PUBLIC
export const BUCKET_NAME = 'chat-uploads';

if (!env.supabaseUrl || !env.supabaseServiceKey) {
  console.warn("⚠️ Supabase credentials missing in .env! Uploads will fail.");
}

// Gunakan Service Key untuk bypass RLS (Row Level Security) agar backend bebas upload
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey);

export async function uploadToSupabase(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  // 1. Upload file ke Bucket
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, fileBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  // 2. Dapatkan URL Publik
  const { data } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return data.publicUrl;
}
