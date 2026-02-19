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