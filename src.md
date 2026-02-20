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


  2. Implementasi "Offline Message Queue" yang Kuat (Frontend)
  Aplikasi chat modern diharapkan tetap responsif saat sinyal hilang.
  Saat ini Anda menggunakan idb (IndexedDB), yang bagus. Namun,
  pastikan alur pengiriman pesan saat offline benar-benar solid.


   * Saran: Buat mekanisme queue (antrean) di zustand atau idb untuk
     pesan keluar (status: 'PENDING').
       1. Saat user kirim pesan dan socket mati -> Simpan ke IDB,
          tampilkan di UI dengan ikon "jam" (pending).
       2. Listen event socket.on('connect') -> Loop antrean pesan
          pending -> Emit ulang ke server.
   * Manfaat: UX yang jauh lebih baik; pengguna tidak kehilangan pesan
     karena koneksi tidak stabil.

  3. Fitur "Disappearing Messages" (TTL)
  Mengingat fokus aplikasi ini adalah keamanan (E2EE), fitur pesan yang
  menghilang otomatis (Time-To-Live) sangat relevan.


   * Saran:
       * DB: Tambahkan kolom expiresAt pada tabel Message.
       * Backend: Gunakan Cron Job (misal: node-cron) atau fitur Redis
         Keyspace Notifications untuk menghapus pesan fisik (dan
         filenya di R2) setelah waktu habis.
       * Frontend: Timer lokal untuk menyembunyikan pesan dari UI
         sebelum penghapusan server terjadi.


  4. Error Tracking & Monitoring (Production)
  Karena Anda men-deploy ke Render dan Vercel, menelusuri bug hanya
  lewat log console akan sangat sulit saat pengguna bertambah.


   * Saran: Integrasikan Sentry (atau GlitchTip/LogRocket).
       * Tangkap unhandled promise rejections di frontend.
       * Tangkap error API 500 di backend.
   * Manfaat: Anda akan tahu persis baris mana yang error dan konteks
     user-nya (OS, Browser) tanpa harus menebak-nebak.


  5. Optimasi Virtualisasi Chat (react-virtuoso)
  Anda baru saja beralih ke react-virtuoso. Pastikan fitur
  stick-to-bottom (auto-scroll ke pesan terbaru) berjalan mulus,
  terutama saat ada gambar yang dimuat.


   * Saran: Pastikan komponen gambar (LazyImage atau FileAttachment)
     memiliki prop height atau aspek rasio yang tetap sebelum gambar
     dimuat. Ini mencegah layout shift yang membuat scroll "melompat"
     saat gambar muncul di dalam list virtual.