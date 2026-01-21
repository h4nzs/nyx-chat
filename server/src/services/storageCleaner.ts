// server/src/services/storageCleaner.ts
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js'; // Pastikan env terimport dengan benar

// Inisialisasi Supabase dengan SERVICE KEY (Biar bypass permission RLS)
const supabase = createClient(
  process.env.SUPABASE_URL!, 
  process.env.SUPABASE_SERVICE_KEY!
);

const BUCKET_NAME = 'chat-uploads'; // Ganti sesuai nama bucket kamu
const FOLDER_NAME = 'attachments'; // Ganti sesuai nama folder target

async function emptyAttachmentsFolder() {
  console.log(`🧹 [Cron] Starting cleanup for folder: ${FOLDER_NAME}...`);
  
  let deletedCount = 0;
  let hasMore = true;

    try {
    // Pindahkan kalkulasi tanggal ke luar loop (optimasi kecil)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    while (hasMore) {
      // 1. List file: AMBIL DARI YANG TERLAMA (ASCENDING)
      const { data: files, error: listError } = await supabase
        .storage
        .from(BUCKET_NAME)
        .list(FOLDER_NAME, { 
          limit: 100,
          sortBy: { column: 'created_at', order: 'asc' } // <--- TAMBAHAN PENTING
        });

      if (listError) throw listError;

      // Jika kosong, berarti folder habis
      if (!files || files.length === 0) {
        hasMore = false;
        break;
      }

      // Filter: Hanya file yang lebih tua dari 7 hari
      const filesToDelete = files
        .filter(f => {
           // Pastikan f.created_at valid
           return f.created_at && new Date(f.created_at) < sevenDaysAgo;
        })
        .map(f => `${FOLDER_NAME}/${f.name}`);

      // LOGIKA KUNCI:
      // Karena kita sudah urutkan dari yang TERLAMA ('asc'),
      // Jika batch pertama ini tidak ada yang perlu dihapus (semua file < 7 hari),
      // maka kita yakin 100% file sisanya pasti juga < 7 hari.
      // Jadi aman untuk break.
      if (filesToDelete.length === 0) {
        hasMore = false;
        console.log("   ✅ Sisa file masih baru (kurang dari 7 hari). Stopping.");
        break;
      }

      // 2. Hapus file
      const { error: deleteError } = await supabase
        .storage
        .from(BUCKET_NAME)
        .remove(filesToDelete);

      if (deleteError) throw deleteError;

      deletedCount += filesToDelete.length;
      console.log(`   🗑️ Deleted batch of ${filesToDelete.length} old files...`);
      
      // Jeda 1 detik biar CPU aman
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("❌ [Cron] Cleanup failed:", error);
  }
}

// Setup Cron Job
export const initStorageCron = () => {
  // Jadwal: Setiap Hari Minggu jam 00:00 (Minggu malam)
  // Format: Minute Hour DayMx Month DayWk
  cron.schedule('0 0 * * 0', () => {
    emptyAttachmentsFolder();
  });

  console.log("⏰ Storage cleanup cron scheduled (Every Sunday at 00:00)");
};