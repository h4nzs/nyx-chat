
### ⏳ 1. Pembersihan Tabel `SessionKey` dan `RefreshToken`

Tumpukan data di dua tabel ini memang masalah klasik di aplikasi yang pakai JWT dan E2EE. Data lama yang menumpuk ini gak ada gunanya dan cuma bikin indeks *database* jadi berat.

Saran lu untuk membersihkan tabel ini sangat brilian, dan kita bisa mengeksekusinya pakai *Cron Job* (sama kayak konsep *Disappearing Messages* yang lu tanyain sebelumnya).

**Analisis Struktur Tabel:**

* **`RefreshToken`:** Tabel ini punya kolom `expiresAt`. Token yang waktu `expiresAt`-nya sudah lewat dari waktu sekarang berarti udah kadaluarsa dan bisa dihapus.
* **`SessionKey`:** Tabel ini (yang menyimpan kunci enkripsi *session* E2EE antar perangkat) juga punya kolom `expiresAt` yang sifatnya opsional (boleh *null*). Lu bisa menghapus *row* di mana `expiresAt`-nya sudah lewat.

**Cara Eksekusi (The Cron Sweeper):**

Lu bisa buat *file* baru khusus buat nampung skrip *Cron Job*, misalnya di `server/src/jobs/sweeper.ts`.

```typescript
import cron from 'node-cron';
import { prisma } from '../lib/prisma'; // Sesuaikan path

// Jadwalkan untuk jalan setiap jam 3 pagi (server time) tiap hari
// Format Cron: "Menit Jam Tanggal Bulan Hari"
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Memulai pembersihan database harian...');
  const now = new Date();

  try {
    // 1. Bersihkan RefreshToken kadaluarsa
    const deletedTokens = await prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lte: now } // lte = Less Than or Equal (lebih kecil atau sama dengan sekarang)
      }
    });
    console.log(`[Cron] Berhasil menghapus ${deletedTokens.count} token kadaluarsa.`);

    // 2. Bersihkan SessionKey kadaluarsa (jika fitur expiresAt digunakan)
    const deletedSessionKeys = await prisma.sessionKey.deleteMany({
      where: {
        expiresAt: { not: null, lte: now }
      }
    });
    console.log(`[Cron] Berhasil menghapus ${deletedSessionKeys.count} kunci sesi kadaluarsa.`);

  } catch (error) {
    console.error('[Cron] Gagal melakukan pembersihan database:', error);
  }
});

```

**Langkah Terakhir:**
Biar *cron job* ini jalan, lu harus *import file* tersebut di *file* utama server lu, yaitu `server/src/index.ts` atau `server/src/app.ts`.

```typescript
// Di bagian atas index.ts atau app.ts
import './jobs/sweeper'; // Gak perlu panggil fungsi, cukup import biar node-cron inisialisasi

```
