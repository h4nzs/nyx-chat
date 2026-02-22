Tolong eksekusi perbaikan arsitektur kriptografi dan perbaiki bug kritis pada antrean offline. Berdasarkan analisis terbaru, kegagalan dekripsi pesan offline disebabkan oleh dua hal: 1) Pesan offline dimasukkan ke queue sebagai plaintext, bukan ciphertext. 2) Masih ada sisa race condition karena kalkulasi X3DH dilakukan di startConversation dan diteruskan via IndexedDB (PendingHeader). Kita harus merombaknya menjadi "Pure Lazy Initialization" (Stateless).

Lakukan dua tugas berikut secara berurutan:

Tugas 1: Rombak web/src/store/conversation.ts (Jadikan Stateless)

Modifikasi fungsi startConversation:

Hapus semua logika dan import kriptografi dari fungsi ini (hapus establishSessionFromPreKeyBundle, penghitungan sodium, addSessionKey, dan storePendingHeader).

Fungsi ini HANYA bertugas membuat room obrolan. Ubah payload POST /api/conversations agar mengirimkan initialSession berupa data "dummy" saja untuk memuaskan validasi backend (karena distribusi kunci asli akan dilakukan di pesan pertama).

Gunakan payload ini di initialSession:{ sessionId: "dummy_" + Date.now(), ephemeralPublicKey: "dummy", initialKeys: [{ userId: user.id, key: "dummy" }, { userId: peerId, key: "dummy" }] }

Tugas 2: Rombak web/src/store/message.ts (Sempurnakan Lazy Init & Fix Bug Offline Queue)

Modifikasi fungsi sendMessage:

Hapus blok kode yang mencoba mengambil header dari IndexedDB (getPendingHeader / deletePendingHeader).

Jadikan blok "LAZY SESSION INITIALIZATION (X3DH)" yang sudah ada sebagai satu-satunya jalur utama untuk membuat sesi baru jika retrieveLatestSessionKeySecurely(conversationId) mengembalikan null. Pastikan di dalam blok ini aplikasi mengambil bundle lawan, mengeksekusi X3DH dengan OTPK, menyimpan sesi lokal, dan membungkus x3dhHeader.

[CRITICAL BUG FIX] Cari blok if (!isConnected && !isReactionPayload) { ... }. Perbaiki objek yang dimasukkan ke addToQueue. Saat ini kode menggunakan const queueMsg = { ...data, ... } yang menyebabkan pesan terkirim sebagai plaintext. Ubah menjadi const queueMsg = { ...payload, ... } agar ciphertext dan amplop JSON X3DH tersimpan di dalam antrean offline.

Pastikan tidak ada deklarasi fungsi yang hilang atau struktur state Zustand yang rusak. Tolong eksekusi.
