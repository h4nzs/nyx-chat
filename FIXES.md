# Rencana Pengembangan dan Perbaikan "Chat Lite"

Dokumen ini menguraikan rencana pengembangan jangka panjang untuk meningkatkan fungsionalitas dan keamanan aplikasi "Chat Lite" agar lebih sesuai dengan draf arsitektur E2EE (`src.md`).

---

## 1. Implementasi *Forward Secrecy* dengan Sesi Ratchet

**🎯 Tujuan:**
Meningkatkan keamanan sesi percakapan dengan mengimplementasikan mekanisme *ratcheting*. Ini akan memastikan bahwa jika sebuah kunci sesi bocor, hanya sebagian kecil pesan yang dapat terdekripsi, bukan seluruh riwayat percakapan. Ini adalah langkah untuk menyamai Poin 3.3 di draf.

**📝 Rencana Implementasi:**
1.  **Modifikasi Kriptografi:** Ubah logika enkripsi/dekripsi dari yang menggunakan satu kunci sesi statis per percakapan menjadi sistem yang menghasilkan kunci baru untuk setiap pesan (atau setiap beberapa pesan).
2.  **Sisi Klien (Frontend):**
    *   Saat mengirim pesan, klien akan melakukan langkah "ratchet" untuk menghasilkan kunci pesan baru, lalu mengenkripsi pesan dengan kunci tersebut.
    *   Saat menerima pesan, klien akan melakukan langkah "ratchet" yang sesuai untuk mendapatkan kunci yang benar untuk dekripsi.
    *   *State* ratchet untuk setiap percakapan harus disimpan secara persisten di IndexedDB.
3.  **Sisi Server (Backend):** Tidak ada perubahan besar yang diperlukan, karena server tetap hanya meneruskan pesan terenkripsi. Namun, format pesan mungkin perlu diperbarui untuk menyertakan informasi tentang posisi ratchet (misalnya, nomor urut pesan, kunci publik ephemeral).

**⚖️ Kelayakan & Pertimbangan:**
*   **Kelayakan:** **Sangat Kompleks.** Mengimplementasikan Double Ratchet Algorithm secara penuh sangatlah sulit dan rawan kesalahan, terutama dengan sinkronisasi multi-perangkat.
*   **Perbedaan dengan Draf:** Draf menyebutkan "Double Ratchet" sebagai standar emas.
*   **Saran:** Sebagai langkah awal yang lebih realistis, kita bisa mengimplementasikan **rotasi kunci sesi berbasis waktu atau jumlah pesan**, bukan *per-message ratchet*. Misalnya, secara otomatis membuat kunci sesi baru setiap 100 pesan atau setiap 24 jam. Ini memberikan "Forward Secrecy" yang lebih baik daripada sekarang, dengan kompleksitas yang lebih rendah.

---

## 2. Notifikasi Perubahan Kunci Keamanan yang Lebih Baik

**🎯 Tujuan:**
Memberikan jaminan keamanan yang lebih eksplisit kepada pengguna saat kunci enkripsi kontak mereka berubah, sesuai dengan praktik terbaik aplikasi seperti Signal/WhatsApp.

**📝 Rencana Implementasi:**
1.  **Sisi Klien (Frontend):**
    *   Saat ini, notifikasi *toast* sudah muncul saat *event* `user:identity_changed` diterima. Ini adalah langkah pertama yang bagus.
    *   **Peningkatan:** Selain *toast*, sisipkan sebuah pesan sistem permanen di dalam jendela obrolan yang relevan, misalnya: *"Kunci keamanan untuk [Nama Kontak] telah berubah. Verifikasi identitas mereka untuk melanjutkan."*
    *   **Fitur Verifikasi:** Buat sebuah modal atau halaman di mana pengguna bisa memverifikasi identitas kontak baru, misalnya dengan memindai QR code (jika bertemu langsung) atau membandingkan serangkaian angka ("Safety Numbers"). Setelah diverifikasi, pesan peringatan di obrolan akan hilang.
2.  **Sisi Server (Backend):** Logika yang ada saat ini sudah cukup untuk mengirim notifikasi awal. Tidak ada perubahan besar yang diperlukan untuk tahap ini.

**⚖️ Kelayakan & Pertimbangan:**
*   **Kelayakan:** **Sangat Mungkin Dilakukan.** Ini sebagian besar adalah pekerjaan di sisi UI/UX dan dapat diimplementasikan secara bertahap.

---

## 3. Dukungan Percakapan Asinkron (Pre-Keys)

**🎯 Tujuan:**
Memungkinkan pengguna untuk memulai percakapan dan mengirim pesan pertama kepada kontak yang sedang *offline*, sesuai dengan Poin 3.2 di draf.

**📝 Rencana Implementasi:**
1.  **Sisi Server (Backend):**
    *   Buat model *database* baru untuk `SignedPreKey` dan `OneTimePreKey`.
    *   Buat *endpoint* API bagi klien untuk mengunggah kunci-kunci publik ini. Server akan menyimpan dan mendistribusikannya sesuai permintaan.
2.  **Sisi Klien (Frontend):**
    *   Saat *login*, klien akan membuat satu `SignedPreKey` dan sekumpulan `OneTimePreKey` (misalnya, 100 kunci), lalu mengunggahnya ke server.
    *   Saat memulai percakapan baru, klien pengirim akan meminta "paket pre-key" dari server untuk penerima.
    *   Klien pengirim menggunakan paket ini untuk membangun sesi terenkripsi awal (menggunakan protokol seperti X3DH) dan mengirim pesan pertama.
    *   Saat penerima *online*, ia akan menggunakan kunci privatnya untuk memproses pesan awal ini, membangun sesi, dan membalas.

**⚖️ Kelayakan & Pertimbangan:**
*   **Kelayakan:** **Kompleks, tapi Mungkin Dilakukan.** Ini adalah fitur standar untuk aplikasi E2EE modern dan akan menjadi peningkatan besar bagi pengalaman pengguna. Ini adalah perubahan arsitektur yang signifikan tetapi sepadan dengan hasilnya.

---

## 4. Sinkronisasi Multi-Perangkat yang Lebih Baik

**🎯 Tujuan:**
Mencapai pengalaman multi-perangkat yang mulus di mana riwayat obrolan dan statusnya (telah dibaca, dll.) tersinkronisasi di semua perangkat milik satu pengguna, sesuai Poin 5 di draf.

**📝 Rencana Implementasi:**
1.  **Fan-out Pesan:**
    *   Saat pengguna mengirim pesan, server harus mengenkripsi dan mengirimkannya tidak hanya ke penerima, tetapi juga ke **semua perangkat lain milik si pengirim**.
    *   Ini sangat rumit karena setiap perangkat memiliki sesi enkripsinya sendiri.
2.  **Sinkronisasi Status:**
    *   Saat pesan dibaca di satu perangkat, *event* harus disiarkan ke perangkat lain milik pengguna yang sama untuk menandainya sebagai telah dibaca di mana-mana.
    *   Hal yang sama berlaku untuk menghapus atau mengedit pesan.

**⚖️ Kelayakan & Pertimbangan:**
*   **Kelayakan:** **Sangat Sulit dan Kompleks.** Ini adalah tantangan terbesar dalam arsitektur E2EE. Sinkronisasi riwayat pesan secara aman tanpa server bisa melihat kontennya adalah masalah yang sangat sulit untuk dipecahkan di lingkungan web.
*   **Perbedaan dengan Draf:** Draf menguraikan arsitektur ini secara ideal. Namun, dalam praktiknya, ini adalah fitur yang paling sering disederhanakan.
*   **Saran:** Untuk saat ini, model "satu sesi aktif pada satu waktu" yang ada di aplikasi adalah kompromi yang wajar. Fokus pada tiga poin perbaikan di atas akan memberikan dampak yang jauh lebih besar dengan tingkat kesulitan yang lebih masuk akal. Fitur ini sebaiknya dianggap sebagai **tujuan jangka panjang (aspirasional)**.
