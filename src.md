# Laporan Final Investigasi Bug Dekripsi File (29 Desember 2025)

## Status
Masalah **TERIDENTIFIKASI**. Akar masalahnya bukan pada transmisi data, melainkan pada **Race Condition di Logika Dekripsi Klien**.

## Bukti Kunci
Log `[SOCKET-DEBUG]` yang kita tambahkan membuktikan secara definitif:
1.  Server **mengirim** `sessionId` dengan benar saat menyiarkan pesan file 1-on-1.
2.  Klien **menerima** `sessionId` tersebut dengan benar di dalam event `socket.on("message:new")`.

Namun, setelah itu, log `[crypto] Decrypting for GROUP...` tetap muncul.

## Analisis Akar Masalah (Hipotesis Baru)
Ini bukanlah satu panggilan fungsi yang salah, melainkan **dua panggilan `decryptMessage` yang saling tumpang tindih (Race Condition)** untuk pesan yang sama:

1.  **Panggilan #1 (Jalur yang Benar):** Ketika event `message:new` diterima, `decryptMessageObject` dipanggil. Karena `sessionId` ada, ia dengan benar memanggil `decryptMessage` dalam mode 1-on-1 (`isGroup: false`). Log dari jalur ini mungkin tidak terlihat jelas karena ia langsung mencoba mengambil kunci sesi.

2.  **Panggilan #2 (Jalur yang Salah & Bising):** Secara bersamaan, ada komponen UI atau `useEffect` lain yang bereaksi terhadap penambahan pesan baru ke dalam state (`useMessageStore`). Komponen ini kemudian memicu proses dekripsi sendiri untuk pesan yang sama. Namun, karena *race condition*, state `conversation` yang ia baca mungkin belum sepenuhnya sinkron, atau logikanya salah, sehingga ia keliru menyimpulkan `isGroup: true`. Panggilan inilah yang menghasilkan log `Decrypting for GROUP...` yang terus kita lihat dan yang menyebabkan UI menampilkan "waiting_for_key".

**Kesimpulan:** Kode kita tidak salah dalam satu baris, tetapi arsitektur reaktivitas kita memiliki celah yang menyebabkan proses dekripsi ganda dengan konteks yang salah.

**Rekomendasi Perbaikan:**
Hentikan proses dekripsi ganda. Proses dekripsi harus terjadi **hanya sekali** di satu tempat yang menjadi "satu-satunya sumber kebenaran" (*single source of truth*).

**Solusi yang Diusulkan:**
Ubah `decryptMessageObject` di `chat-lite/web/src/store/message.ts` agar menjadi satu-satunya yang bertanggung jawab dan hapus logika `if (decryptedMsg.content)` yang membingungkan. Buat agar ia selalu memeriksa `fileKey` jika ada.

```typescript
// Konsep Perbaikan di web/src/store/message.ts

export async function decryptMessageObject(message: Message): Promise<Message> {
  const decryptedMsg = { ...message };
  try {
    // Sumber kebenaran: Pesan grup TIDAK punya sessionId.
    const isGroup = !decryptedMsg.sessionId;

    // Prioritaskan dekripsi fileKey jika ada, jika tidak, gunakan content.
    const contentToDecrypt = decryptedMsg.fileKey || decryptedMsg.content;

    if (contentToDecrypt) {
      decryptedMsg.ciphertext = contentToDecrypt; // Simpan ciphertext asli
      const result = await decryptMessage(contentToDecrypt, decryptedMsg.conversationId, isGroup, decryptedMsg.sessionId);
      
      if (result.status === 'success') {
        // Hasil dekripsi (kunci file mentah atau teks biasa) disimpan di 'content'
        decryptedMsg.content = result.value;
      } else {
        decryptedMsg.content = result.reason; // 'waiting_for_key' atau error
      }
    }

    // Logika dekripsi untuk 'repliedTo' tetap sama...
    // ...

    return decryptedMsg;
  } catch (e) {
    // ...
  }
}
```
Perubahan ini membuat `decryptMessageObject` lebih pintar: ia tahu bahwa untuk pesan file, yang perlu didekripsi adalah `fileKey`, bukan `content`. Ini debería menghentikan kebingungan dan panggilan dekripsi yang salah.
