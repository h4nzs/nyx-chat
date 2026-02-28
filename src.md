3. 🛠️ Opsi C: Tambah "Killer Feature" Baru
Kalau lu masih gatel pengen ngoding fitur berat.

    Fokus: Gimana kalau kita tambahin Voice Call / Video Call E2EE pakai WebRTC?

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

     What gets encrypted:
   * Profile Data: Name, Bio, Avatar URL.
   * Metadata: (Harder) Who is talking to whom.

  ⚠️ The Challenges (Why most don't do it)


   1. User Discovery (The Biggest Problem):
       * If names are encrypted, how do I search for you?
       * If I type "Kenz", the server can't search the database because
         all names are stored as aes_encrypt("Kenz") (which looks like
         x82ma9...).
       * Solution: You need exact Username matching (using a hashed
         index) or QR code sharing only. "Discovery" features basically
         die.


   2. Avatar Performance:
       * Avatars can't be served directly by a CDN (like R2/S3 public
         URLs) because the URL itself might be encrypted, or the file
         content is encrypted.
       * Impact: Every time you scroll a chat list, the client must
         download the encrypted avatar blob, decrypt it in the Worker,
         and create a blob: URL. This is heavy on CPU and RAM.


   3. Push Notifications:
       * The server sends a notification: "New message from..." ->
         Server doesn't know who sent it!
       * Notifications will just say: "You have a new message."
         (Generic).

  🚀 Implementing It (If you're crazy enough)

  If you want to proceed with this "Paranoia Max" approach:


   1. Profile Encryption:
       * User generates a Profile Key.
       * Encrypted Name/Bio are uploaded to users table.
       * Sharing: When you chat with someone, you silently send them
         your Profile Key inside the E2EE channel. Without that key,
         they see "Unknown User".


   2. Hashed Search:
       * Store argon2(username) for login/search.
       * Store aes(username) for display.


  My Verdict
  For a "Soft Launch" app that wants to be usable: Don't do it yet.
  It massively complicates the "Social" aspect (finding friends). The
  current setup (E2EE messages + Server-visible profiles) is the
  industry standard (Signal, WhatsApp) because it balances privacy with
  usability.


  Better Alternative:
  "Private Profiles" (Feature toggle).
   * Allow users to toggle "Encrypt my Profile".
   * If ON: Their name/photo is hidden from strangers. Only contacts
     with shared keys see it.
   * Default: Visible.

   Sealed Sender (Menyembunyikan senderId)
   * Analisis: Saat ini Message tabel punya senderId yang berelasi ke
     User. Ini membocorkan siapa bicara dengan siapa.
   * Implementasi:
       * Mengubah senderId jadi nullable di Prisma? Bisa.
       * Masalah Validasi: Server perlu tahu apakah pengirim boleh
         mengirim pesan ke conversationId tersebut. Jika senderId
         disembunyikan total dari header HTTP/Socket, server tidak bisa
         memvalidasi membership.
       * Solusi Signal: Signal menggunakan "Delivery Token" yang
         membuktikan membership tanpa mengungkapkan identitas eksplisit
         per pesan, tapi itu sangat kompleks.
       * Solusi NYX (Pragmatis): Server tetap perlu tahu senderId (dari
         token JWT/Auth) untuk validasi permission "write" ke grup.
         Tapi kita bisa TIDAK MENYIMPANNYA di kolom database.
       * Database: Message table -> hapus senderId.
       * Payload E2EE: senderId masuk ke dalam ciphertext.
   * Dampak UI: Client harus decrypt dulu baru tahu ini pesan dari
     siapa (kiri/kanan).

Double Ratchet Algorithm (Rotasi Kunci Dinamis): Saat ini aplikasi menggunakan Static Session Key dari hasil awal X3DH. Untuk ke depannya, setiap kali User A mengirim pesan ke B, kuncinya harus berputar (ratchet). Ini memberikan Forward Secrecy sempurna per-pesan.

Key Compromise Indicator: Tambahkan fitur peringatan UI (warna merah) jika Safety Number / Identity Key lawan bicara tiba-tiba berubah secara drastis (pertanda akun mereka di-restore ulang atau ada potensi intervensi pihak ketiga).

📑 Laporan Rencana Implementasi: Double Ratchet Algorithm

  1. Analisis Kesiapan Arsitektur Saat Ini


  ✅ Apa yang Sudah Kita Punya (Kuat):
   1. X3DH Handshake: Kita sudah memiliki inisialisasi X3DH yang matang. Output dari X3DH (Shared Secret 32-byte) adalah titik awal (Root Key) yang
      sempurna untuk memulai Double Ratchet.
   2. Worker Isolation (`crypto.worker.ts`): Arsitektur kita sudah memisahkan operasi kriptografi ke Web Worker. Ini sangat ideal untuk Double
      Ratchet karena kalkulasi matematika (DH step & KDF) akan semakin berat.
   3. IndexedDB Storage (`keychainDb.ts`): Kita sudah memiliki mekanisme penyimpanan data lokal yang terenkripsi menggunakan Master Seed
      (Argon2id).
   4. JSON Payload Structure: sendMessage sudah bisa membungkus ciphertext ke dalam payload JSON (seperti yang kita lakukan untuk header X3DH).


  ❌ Apa yang Kurang (Harus Dibangun):
   1. KDF (Key Derivation Function): Double Ratchet sangat bergantung pada HKDF (HMAC-based Extract-and-Expand KDF). Saat ini kita hanya pakai
      sodium.crypto_generichash (BLAKE2b). Kita perlu implementasi HKDF standar (bisa pakai Web Crypto API di dalam worker).
   2. State Management (Ratchet State): Saat ini kita hanya menyimpan satu sessionKey per percakapan. Nanti, kita harus menyimpan State Object yang
      kompleks.
   3. Skipped Message Keys Store: Jika pesan datang tidak berurutan (misal pesan 3 datang sebelum pesan 2 karena delay jaringan), kita harus
      memutar ratchet dua kali dan menyimpan kunci pesan ke-2 di penyimpanan sementara (Skipped Keys) sampai pesan ke-2 itu benar-benar tiba.


  ---

  2. Desain Arsitektur Double Ratchet untuk NYX


  A. Struktur State (Ratchet State)
  Kita harus mengubah skema penyimpanan di IndexedDB. Alih-alih menyimpan sessionKey: Uint8Array, kita akan menyimpan state terenkripsi yang
  berisi:
   * RootKey (32 bytes): Kunci utama untuk menurunkan Chain Keys baru.
   * SenderChainKey (32 bytes): Untuk mengirim pesan.
   * ReceiverChainKey (32 bytes): Untuk menerima pesan.
   * MessageNumber (Int): Nomor pesan terkirim di chain saat ini.
   * PreviousChainLength (Int): Jumlah pesan di chain penerima sebelum rotasi DH terakhir.
   * MyRatchetKeyPair (Private/Public): Kunci Curve25519 (ECDH) milik kita yang akan terus diganti.
   * TheirRatchetPublicKey (Public): Kunci ECDH terakhir milik lawan bicara.


  B. Struktur Header Pesan (Double Ratchet Header)
  Setiap ciphertext yang dikirim harus dilengkapi header yang tidak dienkripsi (tapi bisa di-autentikasi / AAD). Di NYX, kita akan memodifikasi
  payload JSON dari:
   1 { "ciphertext": "..." }
  Menjadi:


   1 {
   2   "dr": {
   3     "epk": "Base64(My_Current_Ratchet_Public_Key)",
   4     "n": 5, // Message Number
   5     "pn": 2 // Previous Chain Length
   6   },
   7   "ciphertext": "..."
   8 }

  ---

  3. Rencana Alur Kerja (Implementation Workflow)


  Implementasi ini cukup masif dan harus dilakukan dalam 4 fase (PR) yang terpisah agar tidak merusak sistem yang ada.


  Fase 1: Fondasi Kriptografi (Worker Update)
   1. Implementasi HKDF: Menambahkan fungsi HKDF-SHA256 ke dalam crypto.worker.ts menggunakan crypto.subtle.
   2. Fungsi Ratchet Step:
       * KdfRoot(RootKey, DH_Output) -> [NewRootKey, ChainKey]
       * KdfChain(ChainKey) -> [NewChainKey, MessageKey]
   3. Double Ratchet Init: Memodifikasi worker_x3dh_initiator dan worker_x3dh_recipient agar alih-alih mengembalikan satu sessionKey, mereka
      mengembalikan struktur RatchetState awal.


  Fase 2: Penyimpanan Lokal (State & Skipped Keys)
   1. Refactor `keychainDb.ts`:
       * Ubah SESSION_KEYS_STORE_NAME agar bisa menyimpan objek RatchetState yang dienkripsi dengan Master Seed.
       * Tambahkan Object Store baru: skipped-message-keys (menyimpan kunci pesan yang datang out-of-order agar bisa didekripsi nanti).


  Fase 3: Modifikasi Alur Pengiriman (sendMessage)
   1. Setiap memanggil sendMessage, panggil worker untuk:
       * Lakukan Symmetric-key Ratchet (putar SenderChainKey menjadi kunci pesan baru).
       * Gunakan MessageKey tersebut untuk enkripsi pesan.
       * Naikkan MessageNumber (+1).
       * Simpan RatchetState terbaru ke IndexedDB.
   2. Sisipkan properti dr: { epk, n, pn } ke dalam payload JSON.


  Fase 4: Modifikasi Alur Penerimaan (addIncomingMessage)
   1. Saat menerima pesan, baca header dr.
   2. Cek apakah pesan ini sudah ada di skipped-message-keys. Jika ada, langsung dekripsi.
   3. DH Ratchet (Jika Ephemeral Key Berubah): Jika dr.epk berbeda dari TheirRatchetPublicKey di state kita, artinya lawan bicara sudah mengganti
      kuncinya.
       * Kita hitung DH baru (Kunci Privat kita * Kunci Publik dia yang baru).
       * Jalankan KdfRoot untuk mendapatkan ReceiverChainKey baru.
       * Ganti Kunci Privat kita dengan yang baru (generate keypair baru), hitung DH lagi untuk mendapatkan SenderChainKey baru.
   4. Symmetric Ratchet: Lakukan iterasi KdfChain pada ReceiverChainKey sampai nomor pesannya cocok dengan dr.n. (Jika ada pesan yang terlewat,
      simpan kunci-kuncinya di skipped-message-keys).
   5. Gunakan kunci pesan terakhir untuk mendekripsi ciphertext.
   6. Simpan RatchetState terbaru ke IndexedDB.

  ---


  4. Tantangan & Mitigasi Keamanan


   1. Sinkronisasi Backup Server (`/sync`):
       * Tantangan: Saat ini kita me-backup sessionKey statis ke server. Dengan Double Ratchet, State terus berubah setiap ada pesan. Mem-backup
         state terus-menerus akan membebani server dan rentan race condition jika user login di dua device bersamaan.
       * Mitigasi: Standar Signal Protocol tidak menyarankan sinkronisasi state antar device. Device baru (Linked Device) biasanya memulai sesi
         (Session/Ratchet) yang benar-benar baru dengan lawan bicara (Multi-device architecture).
       * Keputusan Arsitektur: Kita harus mengubah strategi. Untuk saat ini, kita bisa memilih untuk mem-backup state hanya secara berkala (misal
         tiap 10 pesan) ATAU tidak mem-backupnya sama sekali (device baru = chat history kosong, mulai baru, layaknya Signal asli). Ini butuh
         keputusan bisnismu.


   2. Out-of-Order Delivery (Pesan Tersendat):
       * Jika jaringan buruk, algoritma ini menuntut penyimpanan sementara (Max Skip Limits, misal 1000 pesan). Jika lebih dari 1000 pesan
         terlewat, sesi dianggap rusak dan butuh X3DH ulang.

  ---

  Kesimpulan


  Sistem NYX saat ini sudah sangat kokoh sebagai pijakan. Menuju Double Ratchet adalah evolusi alami. Namun, perubahan ini akan merombak total
  bagaimana state sesi disimpan dan dikelola.


  Apakah kamu ingin kita mulai mengeksekusi Fase 1 (Membangun Fondasi Kriptografi HKDF & KdfChain di Worker)? Atau kamu ingin mendiskusikan bagian
  arsitektur (seperti nasib Backup Server) terlebih dahulu?

  🔄 Arsitektur "Periodic Epoch Ratcheting" (Rotasi Sesi Berkala)


  Daripada memutar kunci di setiap pesan (Double Ratchet), kita memutar keseluruhan sesi X3DH secara transparan setelah jangka waktu atau jumlah
  pesan tertentu.

  Bagaimana Cara Kerjanya?


   1. Epoch 1 (Pesan 1 - 100):
      User A dan User B melakukan X3DH Handshake. Tercipta session_123. Kunci ini di-backup ke server. Mereka bertukar 100 pesan menggunakan kunci
  ini.
   2. Trigger Rotasi:
      Saat User A ingin mengirim pesan ke-101, sistem (secara background) mendeteksi batas rotasi tercapai.
   3. Epoch 2 (Pesan 101 - 200):
      Sistem User A diam-diam mengambil OTPK baru milik User B dari server, melakukan X3DH Handshake BARU, dan menciptakan session_456.
   4. Transisi Halus:
      Pesan ke-101 dikirim menggunakan session_456. Kunci baru ini di-backup ke server.
   5. Penerima (User B):
      Saat menerima pesan ke-101, User B mendeteksi header X3DH baru, memprosesnya, dan menyimpan session_456 ke lokal & server backup.

  Mengapa Ini Sangat Cocok untuk NYX?


   * 100% Menggunakan Kode yang Ada: Kita tidak perlu menulis algoritma KDF yang rumit. Kita hanya memicu ulang logika "Lazy Init X3DH" yang sudah
     kita buat dengan susah payah kemarin! Database kita (SessionKey) juga sudah mendukung penyimpanan banyak sessionId untuk satu percakapan.
   * Forward Secrecy yang Praktis: Jika kunci session_456 bocor, hacker HANYA bisa membaca pesan 101-200. Pesan 1-100 tetap aman karena kuncinya
     (session_123) berbeda dan terenkripsi kuat di server.
   * UX Tidak Dikorbankan: Saat user login di browser baru, fitur /api/session-keys/sync (Restore) yang baru saja kita perbaiki akan men-download
     SEMUA kunci epoch (session_123, session_456, dll) dan user tetap bisa membaca seluruh riwayat chat-nya secara instan.
   * Performa Ringan: Melakukan asimetris X3DH setiap 100 pesan (atau setiap 3 hari) sangat ringan di CPU dan baterai dibandingkan melakukannya di
     setiap ketikan pesan.

  Rencana Implementasi (Jika kamu setuju)

  Kita hanya perlu menambahkan sedikit logika di web/src/store/message.ts (di dalam sendMessage):


    1 // Konsep Kasar
    2 const LATEST_KEY = await retrieveLatestSessionKeySecurely(conversationId);
    3 const MESSAGE_COUNT = countMessagesInSession(conversationId, LATEST_KEY.sessionId);
    4
    5 if (MESSAGE_COUNT >= 50) { 
    6    // Waktunya Rotasi!
    7    // Buang LATEST_KEY, paksa sistem melakukan X3DH baru seperti saat pesan pertama kali dikirim.
    8 } else {
    9    // Pakai LATEST_KEY
   10 }


  Ini adalah jalan tengah emas (Golden Compromise) antara kemudahan sinkronisasi cloud ala WhatsApp/Telegram dan keamanan kriptografi tingkat
  tinggi ala Signal.