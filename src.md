Tugas kamu sekarang adalah mengimplementasikan fitur **"Sender Keys" (Group Keys)** untuk optimasi obrolan grup, agar klien tidak perlu mengenkripsi pesan sebanyak N-kali (pairwise) untuk setiap anggota grup.

Berikut adalah file-file yang relevan:
1. `chat-lite/web/src/lib/keychainDb.ts` (Penyimpanan kunci di IndexedDB)
2. `chat-lite/web/src/utils/crypto.ts` (Logika utama kripto di main thread)
3. `chat-lite/web/src/workers/crypto.worker.ts` (Worker untuk operasi berat)
4. `chat-lite/web/src/lib/crypto-worker-proxy.ts` (Penghubung main thread ke worker)

Tolong lakukan implementasi dengan langkah-langkah berikut:

### Langkah 1: Storage (keychainDb.ts)
Pastikan ada fungsi untuk menyimpan dan mengambil Group Key.
- `storeGroupKey(conversationId, keyBuffer)`
- `getGroupKey(conversationId)`

### Langkah 2: Distribusi Kunci (crypto.ts)
Buat fungsi `ensureGroupSession` di `crypto.ts`. Logikanya:
- Cek apakah kita sudah punya Group Key untuk conversationID ini di `keychainDb`.
- Jika BELUM:
  1. Minta worker generate random key (32 bytes).
  2. Simpan key tersebut ke `keychainDb`.
  3. Enkripsi key tersebut secara *pairwise* (menggunakan `worker_crypto_box_seal`) untuk setiap *participant* lain di grup.
  4. Kembalikan array objek distribusi kunci untuk dikirim ke socket (`messages:distribute_keys`).

### Langkah 3: Enkripsi Pesan (crypto.ts) - **CRITICAL**
Modifikasi fungsi `encryptMessage` atau buat `encryptGroupMessage`.
- Ambil Group Key dari `keychainDb`.
- **PENTING (Fix Bug Bubble Kosong):** Lakukan konversi string pesan ke `Uint8Array` di sini (Main Thread) menggunakan `sodium.from_string(text)`. JANGAN kirim string mentah ke worker.
- Kirim `Uint8Array` pesan dan `Uint8Array` key ke worker untuk dienkripsi (`crypto_secretbox_easy`).
- Hasilnya (ciphertext) dikembalikan ke UI untuk dikirim via socket.

### Langkah 4: Dekripsi Pesan (crypto.ts)
Modifikasi `decryptMessage` untuk menangani tipe pesan `GROUP`.
- Ambil Group Key dari `keychainDb`.
- Panggil worker untuk dekripsi (`crypto_secretbox_open_easy`).
- Convert hasil dekripsi (Uint8Array) kembali ke string di Main Thread menggunakan `sodium.to_string()`.
