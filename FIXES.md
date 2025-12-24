Saat ini, berdasarkan analisa kode `crypto.ts` dan `socket.ts`, sepertinya aplikasi Chat Lite menggunakan pendekatan **Pairwise Encryption** (atau *Client-Side Fan-out*). Artinya, jika ada grup dengan 50 anggota, ketika User A mengirim pesan, User A harus mengenkripsi pesan itu 49 kali (satu untuk setiap kunci sesi teman). Ini memakan CPU dan baterai.

Berikut adalah saran dan solusi konkrit untuk mengatasi masalah skalabilitas ini, diurutkan dari yang paling mudah diterapkan hingga yang paling *advanced*:

### 1. Implementasi "Sender Keys" (Solusi Paling Efektif)

Ini adalah standar industri yang digunakan oleh Signal (untuk grup) dan WhatsApp.

* **Masalah Sekarang (Pairwise):**
User A ingin kirim "Halo" ke Grup (B, C, D).
1. Encrypt "Halo" pakai Kunci A-B.
2. Encrypt "Halo" pakai Kunci A-C.
3. Encrypt "Halo" pakai Kunci A-D.
*Beban: 3x enkripsi.*


* **Solusi (Sender Keys):**
User A membuat satu **"Chain Key"** (kunci simetris acak) khusus untuk dirinya di grup ini.
1. User A mengenkripsi Chain Key ini *sekali saja* ke B, C, dan D menggunakan *pairwise channel* yang sudah ada. (Ini disebut tahap distribusi kunci).
2. Untuk pesan "Halo", User A mengenkripsinya **HANYA SEKALI** menggunakan Chain Key tersebut.
3. Kirim *ciphertext* tunggal itu ke server. Server menyebarkannya ke B, C, D.
4. B, C, dan D sudah punya Chain Key milik A, jadi mereka bisa mendekripsinya.


* **Dampak:** Kompleksitas enkripsi pesan turun dari  menjadi . Beban CPU klien berkurang drastis. Ratcheting hanya terjadi pada *Chain Key* itu sendiri (Hash Ratchet), yang sangat ringan.

### 2. Offloading ke Web Workers (Optimasi Frontend)

Saya melihat di `chat-lite/web/src/utils/crypto.ts`, fungsi enkripsi/dekripsi berjalan di *main thread* JavaScript.
Pada grup yang ramai, ini akan membuat UI "nge-freeze" atau patah-patah saat mendekripsi banyak pesan masuk sekaligus.

* **Solusi:** Pindahkan seluruh logika `libsodium` dan manajemen kunci ke **Web Worker**.
* **Cara Kerja:**
1. UI mengirim pesan mentah ke Worker.
2. Worker melakukan kerja berat (enkripsi matematika).
3. Worker mengembalikan *ciphertext* ke UI untuk dikirim via Socket.


* **Keuntungan:** UI tetap 60fps mulus meskipun di latar belakang sedang mendekripsi 100 pesan gambar.

### 3. "Lazy" Ratcheting (Optimasi Protokol)

Di file `crypto.ts`, terdapat fungsi `ensureAndRatchetSession`. Jika ini dipanggil terlalu sering (misal setiap pesan), overhead jabat tangan (handshake) akan tinggi.

* **Solusi:** Jangan lakukan *Diffie-Hellman Ratchet* (pembaruan kunci asimetris) setiap kali kirim pesan.
* **Strategi:** Gunakan **Hash Ratchet** (sangat cepat) untuk setiap pesan, dan simpan *Diffie-Hellman Ratchet* hanya untuk momen-momen tertentu, misalnya:
* Setiap 50 pesan.
* Atau hanya ketika ada anggota baru masuk/keluar grup (untuk menjaga *Post-Compromise Security*).



### 4. Enkripsi Media yang Efisien (Hybrid Encryption)

Untuk file (gambar/video), pastikan kamu tidak mengenkripsi *blob* file itu berkali-kali.
Saya melihat di `crypto.ts` fungsi `encryptFile` sudah menghasilkan `encryptedBlob` dan `key`.

* **Pastikan Alurnya:**
1. Enkripsi file besar (misal 5MB) **satu kali** dengan kunci acak sementara (`AES-Key`).
2. Simpan file terenkripsi itu ke server/storage.
3. Lalu, enkripsi `AES-Key` (yang ukurannya cuma 32 bytes) menggunakan metode *Sender Keys* (Poin 1) atau *Pairwise* ke semua anggota grup.


* **Hasil:** Klien hanya perlu mengenkripsi ulang 32 bytes data untuk setiap anggota, bukan 5MB data.

### 5. MLS (Messaging Layer Security) - Masa Depan

Jika kamu ingin solusi yang benar-benar *scalable* untuk grup dengan ribuan anggota (seperti "Supergroup"), kamu bisa melirik standar IETF baru bernama **MLS**.

* **Konsep:** Menggunakan struktur pohon (*TreeKEM*). Jika ada anggota keluar dari grup berisi 1000 orang, operasi *re-keying* hanya butuh logaritma langkah (), bukan linear.
* **Catatan:** Ini sangat kompleks untuk diimplementasikan dari nol. Mengingat kamu sudah punya basis *Signal Protocol* (X3DH), pindah ke "Sender Keys" (Poin 1) adalah langkah transisi yang paling masuk akal dan *feasible*.

### Rekomendasi Prioritas

Saya sarankan kamu mulai dengan **Poin 2 (Web Workers)** karena itu murni perubahan arsitektur kode frontend tanpa mengubah protokol database/server. Itu akan memberikan dampak performa "terasa" yang instan bagi pengguna.

Setelah itu, baru implementasikan **Poin 1 (Sender Keys)** untuk menyelesaikan masalah skalabilitas kriptografinya secara fundamental.