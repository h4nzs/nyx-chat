# Laporan Masalah Saat Ini & Analisis Bug (27 Desember 2025)

Dokumen ini merangkum masalah-masalah kritis yang masih ada di dalam aplikasi, berdasarkan serangkaian pengujian dan analisis mendalam. Meskipun beberapa perbaikan keamanan dan logika telah diterapkan, ada satu bug inti yang persisten dan beberapa kelemahan arsitektur yang perlu ditangani.

---

### 1. Bug Inti (Belum Terselesaikan): Kegagalan Dekripsi untuk Pesan File di Percakapan 1-on-1

Ini adalah bug paling kritis yang saat ini ada.

**Gejala:**
- Saat mengirim sebuah file (gambar, dokumen, dll.) dalam percakapan 1-on-1, pesan tampil dengan benar sesaat (sebagai pesan optimistik).
- Namun, setelah pesan tersebut dikonfirmasi oleh server dan diterima kembali melalui event `message:new`, bubble pesan di sisi pengirim dan penerima berubah menjadi "waiting_for_key".
- Log konsol secara konsisten menunjukkan bahwa aplikasi mencoba mendekripsi pesan ini menggunakan alur **grup** (`[crypto] Decrypting for GROUP...`), yang mana salah untuk konteks 1-on-1.

**Analisis Akar Masalah:**
Penyebab pastinya masih belum dapat dipastikan, yang menandakan adanya masalah fundamental dan sulit dipahami dalam state management aplikasi. Hipotesisnya adalah:
- **Korupsi State:** Di suatu tempat dalam alur pengiriman file, `state` dari `useConversationStore` untuk percakapan 1-on-1 tersebut menjadi tidak sinkron, menyebabkan properti `isGroup` terbaca sebagai `true` saat `decryptMessageObject` dieksekusi.
- **Perbedaan Alur Data:** Ada perbedaan mendasar antara bagaimana pesan teks dan pesan file diproses setelah diterima dari server. Meskipun beberapa upaya telah dilakukan untuk menyamakan logika dekripsi (seperti di `decryptMessageObject`), tampaknya ada jalur kode lain atau transformasi data yang terlewat yang khusus menangani pesan file dan salah mengidentifikasi konteksnya.
- **Upaya Perbaikan & Kegagalan:** Upaya untuk memperbaiki sumber data (`GET /api/conversations`), memperbaiki fungsi pembaruan state (`addOrUpdateConversation`), dan bahkan memaksa logika dekripsi untuk menggunakan `!message.sessionId` sebagai sumber kebenaran, semuanya gagal. Ini menunjukkan masalahnya lebih dalam dari sekadar salah satu fungsi tersebut.

**Status:** Belum teratasi. Memerlukan *instrumentasi* dan *debugging* yang lebih mendalam pada alur `message:new` di `socket.ts` hingga ke pemanggilan `decryptMessageObject` untuk melihat secara pasti mengapa state bisa salah.

---

### 2. Kelemahan Arsitektur: Kebocoran Sebagian Riwayat saat Pengguna Ditambahkan Kembali

**Gejala:**
- User A dikeluarkan dari grup, lalu ditambahkan kembali.
- Setelah User A me-reload halaman, ia dapat melihat kembali riwayat pesan dari periode keanggotaan **pertamanya**. Pesan yang dikirim saat ia di luar grup tetap tidak bisa diakses, namun riwayat lama muncul kembali.

**Analisis Akar Masalah:**
- Saat menambahkan kembali anggota, server menggunakan logika `skipDuplicates: true` yang tidak membuat record `Participant` baru. Ini menyebabkan timestamp `joinedAt` pengguna tersebut tidak diperbarui.
- Endpoint `GET /api/messages/:id` telah diperbaiki untuk hanya mengambil pesan yang dibuat setelah `joinedAt`. Namun, karena `joinedAt` tidak diperbarui, pengguna tersebut secara teknis masih dianggap berhak melihat riwayat lama tersebut.
- **Implikasi Privasi:** Ini melanggar ekspektasi privasi di mana anggota grup yang tersisa berasumsi bahwa pengguna yang dikeluarkan telah kehilangan akses ke semua riwayat.

**Status:** Teridentifikasi. Membutuhkan perubahan arsitektur yang lebih signifikan, seperti mengubah cara server menangani penambahan ulang anggota (misalnya, dengan menghapus dan membuat ulang record `Participant` untuk memperbarui `joinedAt`) atau mengimplementasikan tabel untuk melacak periode keanggotaan.

---

### 3. Kelemahan Arsitektur: Kegagalan Distribusi Kunci yang Tidak Terdengar (Silent Failure)

**Gejala:**
- Saat kita menemukan bug di mana seorang peserta tidak memiliki `publicKey` di database, pengirim tetap dapat mengirim pesan.
- Pesan tersebut dienkripsi dengan kunci grup yang hanya dimiliki oleh pengirim. Pesan ini dijamin gagal didekripsi di sisi penerima, namun pengirim tidak menerima notifikasi error apa pun.

**Analisis Akar Masalah:**
- Fungsi `ensureGroupSession` di `crypto.ts` saat ini, jika gagal membuat kunci terenkripsi untuk satu peserta (karena `publicKey` tidak ada), ia hanya akan mencatat peringatan di konsol dan melanjutkan proses.
- Seharusnya, aplikasi memberikan umpan balik yang jelas kepada pengirim bahwa pesan tidak dapat dienkripsi untuk semua anggota, dan mungkin memberikan pilihan untuk membatalkan pengiriman.

**Status:** Teridentifikasi. Membutuhkan perubahan logika di `ensureGroupSession` dan fungsi pemanggilnya (`sendMessage`, `uploadFile`, dll.) untuk menangani kasus kegagalan ini dengan lebih baik dan memberikan feedback ke UI.
