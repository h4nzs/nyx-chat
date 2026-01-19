import { prisma } from "../lib/prisma.js";
import { supabase } from "./supabase.js";
import { env } from "../config.js";

const BUCKET_NAME = "chat-uploads"; // Sesuaikan dengan nama bucket lu

export async function cleanupOrphanedFiles() {
  console.log("🧹 Starting Storage Cleanup...");
  
  // 1. Ambil semua file dari Supabase Storage (Max 1000 file per batch)
  const { data: storageFiles, error } = await supabase.storage
    .from(BUCKET_NAME)
    .list(undefined, { limit: 1000, offset: 0 });

  if (error || !storageFiles) {
    console.error("❌ Failed to list files:", error);
    return;
  }

  // 2. Ambil semua URL file yang VALID dari database (Message & User)
  // Kita cari yang mengandung nama file di storage
  const validMessages = await prisma.message.findMany({
    where: { content: { contains: BUCKET_NAME } }, // Asumsi URL mengandung nama bucket
    select: { content: true }
  });
  
  const validAvatars = await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { avatarUrl: true }
  });

  // Gabungkan semua URL valid ke dalam satu Set untuk pencarian cepat
  const validUrls = new Set([
    ...validMessages.map(m => m.content),
    ...validAvatars.map(u => u.avatarUrl)
  ]);

  // 3. Cari file yang YATIM (Ada di Storage, tapi URL-nya gak ada di DB)
  const orphanedFiles: string[] = [];
  
  for (const file of storageFiles) {
    // Skip folder
    if (!file.id) continue; 
    
    // Cek apakah nama file ini ada di dalam salah satu URL valid di DB
    // Logic ini mungkin perlu disesuaikan dengan format URL lu
    const isUsed = Array.from(validUrls).some(url => url && url.includes(file.name));
    
    if (!isUsed) {
      orphanedFiles.push(file.name);
    }
  }

  console.log(`🔍 Found ${orphanedFiles.length} orphaned files.`);

  if (orphanedFiles.length > 0) {
    // 4. Hapus file yatim
    const { error: deleteError } = await supabase.storage
      .from(BUCKET_NAME)
      .remove(orphanedFiles);
      
    if (deleteError) {
      console.error("❌ Failed to delete files:", deleteError);
    } else {
      console.log(`✅ Successfully deleted ${orphanedFiles.length} orphaned files.`);
    }
  } else {
    console.log("✨ Storage is clean.");
  }
}