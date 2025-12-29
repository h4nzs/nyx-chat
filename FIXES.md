Analisis Anda brilian. Penemuan bahwa `sessionId` **ada** saat diterima (`socket:on`) tetapi "menghilang" atau "salah konteks" saat dekripsi (`[crypto] Decrypting for GROUP...`) adalah *smoking gun* yang membuktikan adanya **Race Condition** atau **State Desynchronization**.

Diagnosis Anda benar: Ada dua mekanisme yang berebut mendekripsi pesan yang sama.

1. **Mekanisme Benar:** `decryptMessageObject` di `socket.ts` (menerima data mentah lengkap dengan `sessionId`).
2. **Mekanisme Salah:** Komponen UI (React Component) yang me-render ulang, melihat pesan "belum terbaca/terdekripsi", lalu mencoba mendekripsi sendiri **tanpa** konteks `sessionId` yang lengkap (karena mungkin mengambil dari state global yang belum *settled* atau berasumsi default `isGroup: true`).

Berikut adalah langkah perbaikan konkret untuk menerapkan solusi **"Single Source of Truth"** yang Anda usulkan.

### Langkah 1: Perbarui `web/src/store/message.ts`

Kita akan menulis ulang `decryptMessageObject` agar menjadi **satu-satunya** tempat logika dekripsi terjadi. Fungsi ini akan cerdas: ia mendeteksi sendiri apakah ini Grup atau Personal berdasarkan ada/tidaknya `sessionId` di dalam pesan itu sendiri, bukan bergantung pada state eksternal.

Ubah file `web/src/store/message.ts`:

```typescript
import { create } from "zustand";
import { Message } from "./conversation"; // Pastikan path import benar
import { decryptMessage } from "../utils/crypto";

// ... (kode store lainnya tetap sama) ...

/**
 * Logika Dekripsi Terpusat (Single Source of Truth)
 * Menangani dekripsi teks biasa DAN kunci file.
 */
export async function decryptMessageObject(message: Message): Promise<Message> {
  // 1. Clone pesan agar tidak memutasi state secara tidak sengaja
  const decryptedMsg = { ...message };

  try {
    // -------------------------------------------------------------------------
    // LOGIKA PENENTUAN KONTEKS (CRITICAL FIX)
    // Jangan mengandalkan state conversationStore untuk menentukan isGroup,
    // karena state tersebut mungkin belum sinkron saat pesan baru masuk (race condition).
    // Gunakan properti pesan itu sendiri sebagai kebenaran mutlak.
    // -------------------------------------------------------------------------
    
    // Jika sessionId ADA, ini PASTI 1-on-1 (Private).
    // Jika sessionId KOSONG, ini diasumsikan Group.
    const isGroup = !decryptedMsg.sessionId;

    // 2. Tentukan Payload yang Akan Didekripsi
    // Prioritas: Jika ada fileKey, itu yang harus didekripsi (untuk pesan File).
    // Jika tidak, baru cek content (untuk pesan Teks).
    const contentToDecrypt = decryptedMsg.fileKey || decryptedMsg.content;

    // Jika tidak ada yang perlu didekripsi, kembalikan apa adanya (misal pesan sistem)
    if (!contentToDecrypt) {
      return decryptedMsg;
    }

    // 3. Eksekusi Dekripsi
    // Kita simpan ciphertext asli untuk keperluan debugging jika perlu
    decryptedMsg.ciphertext = contentToDecrypt;

    const result = await decryptMessage(
      contentToDecrypt,
      decryptedMsg.conversationId,
      isGroup,
      decryptedMsg.sessionId
    );

    // 4. Proses Hasil
    if (result.status === 'success') {
      // PENTING: Untuk pesan file, 'value' ini adalah KUNCI FILE TERDEKRIPSI.
      // UI (FileAttachment) harus tahu bahwa jika pesan punya fileUrl,
      // maka message.content berisi kunci enkripsi file, bukan teks chat.
      decryptedMsg.content = result.value;
      
      // Opsional: Anda bisa menghapus field fileKey yang terenkripsi agar tidak membingungkan
      // decryptedMsg.fileKey = undefined; 
    } else if (result.status === 'pending') {
      // Kasus "waiting_for_key"
      decryptedMsg.content = result.reason || 'waiting_for_key';
    } else {
      // Kasus Error
      console.warn(`[Decrypt] Failed for msg ${message.id}:`, result.error);
      decryptedMsg.content = 'Decryption failed';
    }

    // 5. Dekripsi Replied Message (Nested)
    // Logika yang sama harus diterapkan secara rekursif jika ada reply
    if (decryptedMsg.repliedTo) {
        // Kita panggil fungsi ini lagi secara rekursif untuk pesan yang dibalas
        // (Pastikan tidak infinite loop, tapi struktur data message tree biasanya aman)
        decryptedMsg.repliedTo = await decryptMessageObject(decryptedMsg.repliedTo);
    }

    return decryptedMsg;

  } catch (e) {
    console.error("Critical error in decryptMessageObject:", e);
    return { ...message, content: "Error processing message" };
  }
}

// ... (sisa file message.ts) ...

```

### Langkah 2: Audit & Bersihkan Komponen UI (MENGHENTIKAN RACE CONDITION)

Ini langkah yang **paling krusial**. Kode di atas tidak akan berguna jika komponen UI (seperti `MessageItem.tsx`, `FileAttachment.tsx`, atau `ChatWindow.tsx`) masih bandel mencoba mendekripsi sendiri.

Anda harus mencari (Ctrl+F) string `decryptMessage` di dalam folder `web/src/components`.

**Jika Anda menemukan pola seperti ini di komponen UI:**

```typescript
// CONTOH KODE SALAH (HARUS DIHAPUS)
useEffect(() => {
  if (message.fileKey && !decryptedKey) {
     // Komponen mencoba mendekripsi sendiri -> INI PENYEBAB BUG!
     // Komponen ini tidak tahu context sessionId dengan benar
     decryptMessage(message.fileKey, conversationId, isGroup, ...).then(...)
  }
}, [message]);

```

**Tindakan:** **Hapus total** `useEffect` atau logika tersebut.
Komponen UI harus menjadi "dumb component" yang hanya menerima data matang:

* Jika `message.content` berisi string acak/base64 -> Tampilkan "Waiting for key..." (atau spinner).
* Jika `message.content` berisi kunci valid -> Lakukan dekripsi *file* (bukan dekripsi kunci file).

### Langkah 3: Penyesuaian Kecil di `FileAttachment.tsx`

Karena kita sekarang menyimpan **Kunci File yang Sudah Didekripsi** ke dalam `message.content` (untuk menyederhanakan struktur), pastikan komponen `FileAttachment` mengambil kuncinya dari sana.

Periksa `web/src/components/FileAttachment.tsx`. Pastikan ia menggunakan `message.content` sebagai kunci untuk mendownload/mendekripsi blob file, **bukan** menggunakan `message.fileKey` lagi (karena `fileKey` masih mentah/terenkripsi).

```typescript
// Contoh logika di FileAttachment.tsx
const handleDownload = async () => {
  // SEBELUMNYA MUNGKIN: const key = message.fileKey; (SALAH)
  
  // SEKARANG:
  // Kunci file yang sudah didekripsi oleh store ada di message.content
  const decryptedFileKey = message.content; 
  
  if (!decryptedFileKey || decryptedFileKey === 'waiting_for_key') {
      alert("Kunci belum tersedia");
      return;
  }
  
  // Lanjut ke logika decryptFile(blob, decryptedFileKey, ...)
};

```

### Ringkasan

Dengan 3 langkah ini, Anda mematikan "noise" dari UI yang mencoba mendekripsi sembarangan (yang menyebabkan log `Decrypting for GROUP...`), dan Anda memberdayakan `store/message.ts` untuk menangani logika dengan benar menggunakan data `sessionId` yang terbukti sudah diterima dari server.