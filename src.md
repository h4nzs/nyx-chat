1. Modifikasi Skema Database (`prisma/schema.prisma`):
       * Saya akan menambahkan satu kolom baru ke model Participant: isPinned Boolean
         @default(false).

   2. Jalankan Migrasi Database:
       * Setelah skema diperbarui, saya akan menjalankan prisma migrate untuk menerapkan
         perubahan ke database.

   3. Buat Endpoint API Baru (`server/src/routes/conversations.ts`):
       * Saya akan membuat endpoint POST baru, misalnya /api/conversations/:id/pin.
       * Endpoint ini akan digunakan untuk mengubah status isPinned (dari true ke false dan
         sebaliknya) untuk partisipan (pengguna yang sedang login) di percakapan tersebut.

  Tahap 2: Frontend (UI/UX)

   1. Ambil Status `isPinned`:
       * Saya akan memastikan data isPinned dikirim dari server ke klien saat memuat daftar
         percakapan.

   2. Perbarui Logika Penyortiran (`web/src/store/conversation.ts`):
       * Fungsi sortConversations akan saya perbarui untuk mengurutkan berdasarkan isPinned
         terlebih dahulu.

   3. Buat Aksi Baru di Store (`web/src/store/conversation.ts`):
       * Saya akan membuat action baru, togglePinConversation(conversationId).
       * Action ini akan secara optimistis memperbarui UI, lalu memanggil endpoint API yang
         kita buat di Tahap 1.

   4. Perbarui UI (`web/src/components/ChatItem.tsx`):
       * Saya akan memodifikasi menu dropdown tiga titik yang sudah ada di setiap item
         chat.
       * Saya akan menambahkan entri baru seperti "Sematkan Percakapan" atau "Lepas Sematan
         Percakapan" sesuai dengan status isPinned saat ini.


Format Pesan (Markdown): Mengizinkan pengguna untuk memformat teks menggunakan
      Markdown sederhana, seperti *tebal*, _miring_, ~coret~, atau  ``blok kode`` . Fitur
      ini sangat disukai oleh pengguna teknis.


  - Maybe Mute/Unmute or other notification settings
  - Maybe View Info or Settings