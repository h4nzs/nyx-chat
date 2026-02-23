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
