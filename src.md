3. 🛠️ Opsi C: Tambah "Killer Feature" Baru
Kalau lu masih gatel pengen ngoding fitur berat.

    Fokus: Gimana kalau kita tambahin Voice Call / Video Call E2EE pakai WebRTC? Atau bikin fitur hapus pesan otomatis (disappearing messages) dalam waktu 24 jam?
    
Rekomendasi (Masa Depan):
  Mengenkripsi Kunci Sesi dengan Master Key (atau kunci turunan dari
  Master Key) adalah langkah keamanan "Encryption at Rest" yang sangat
  baik. Ini memastikan bahwa meskipun database dicuri, isinya tidak
  berguna tanpa password pengguna (yang membuka Master Key).

  Ini adalah refaktor yang cukup besar. Kita perlu:
   1. Mengubah addSessionKey untuk menerima Master Key dan mengenkripsi
      sessionKey sebelum disimpan.
   2. Mengubah getSessionKey untuk menerima Master Key dan mendekripsi
      sessionKey sebelum dikembalikan.
   3. Mengubah semua panggilan ke fungsi-fungsi ini di seluruh aplikasi
      untuk menyertakan Master Key.

   1. Refactoring Struktur Socket.IO (Backend)
  Saat ini, file server/src/socket.ts menangani hampir semua logika
  real-time: autentikasi, kehadiran (presence), pengiriman pesan, key
  exchange, dan notifikasi. Ini membuatnya menjadi "God Object" yang
  sulit dipelihara.

   * Saran: Pecah logika socket menjadi modul-modul handler terpisah.
   * Contoh Struktur:



   1     server/src/socket/
   2     ├── index.ts          # Inisialisasi io dan middleware
   3     ├── handlers/
   4     │   ├── auth.ts       # Linking device, initial handshake
   5     │   ├── message.ts    # Send, receive, read status
   6     │   ├── presence.ts   # Online/offline, typing indicators
   7     │   └── crypto.ts     # Key distribution, session requests
   * Manfaat: Kode lebih bersih, lebih mudah di-debug, dan risiko
     konflik saat merge berkurang.


  5. Optimasi Virtualisasi Chat (react-virtuoso)
  Anda baru saja beralih ke react-virtuoso. Pastikan fitur
  stick-to-bottom (auto-scroll ke pesan terbaru) berjalan mulus,
  terutama saat ada gambar yang dimuat.


   * Saran: Pastikan komponen gambar (LazyImage atau FileAttachment)
     memiliki prop height atau aspek rasio yang tetap sebelum gambar
     dimuat. Ini mencegah layout shift yang membuat scroll "melompat"
     saat gambar muncul di dalam list virtual.