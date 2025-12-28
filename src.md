# Laporan Investigasi Lanjutan: Bug Kritis Dekripsi File 1-on-1 (28 Desember 2025)

Dokumen ini adalah analisis terbaru mengenai bug persisten yang menyebabkan pesan file dalam percakapan 1-on-1 gagal didekripsi. Laporan sebelumnya di `FIXES.md` telah diimplementasikan, namun tidak menyelesaikan masalah inti.

## Ringkasan Masalah

- **Gejala:** Saat mengirim file di chat 1-on-1, pesan gagal didekripsi oleh pengirim dan penerima setelah dikonfirmasi oleh server. Bubble pesan menampilkan "waiting_for_key".
- **Bukti Kunci (dari Log):** Log konsol secara konsisten menunjukkan `[crypto] Decrypting for GROUP...`. Ini membuktikan bahwa fungsi `decryptMessage` dipanggil dengan `isGroup: true`.
- **Akar Masalah yang Terbukti:** Logika ini hanya bisa berjalan jika `!message.sessionId` bernilai `true` saat `decryptMessageObject` dieksekusi. Ini berarti, pada saat dekripsi, objek pesan yang diterima dari server melalui event `message:new` **tidak memiliki `sessionId`** (nilainya `null` atau `undefined`), meskipun ini adalah pesan 1-on-1.

## Investigasi & Kontradiksi

Terjadi kontradiksi fundamental antara bagaimana sistem seharusnya bekerja dan apa yang ditunjukkan oleh log:

1.  **Sisi Pengirim (Client - `messageInput.ts`)**: Saat `uploadFile`, klien **sudah benar** mengenkripsi kunci file menggunakan sesi 1-on-1, menghasilkan `sessionId` yang valid, dan mengirimkan `sessionId` ini ke server sebagai bagian dari `FormData`.

2.  **Sisi Server (`uploads.ts`)**: Endpoint unggahan file di server **sudah benar** menerima `sessionId` dan menyimpannya ke database saat membuat record `Message`. `prisma.message.create({ data: { ..., sessionId, ... } })`.

3.  **Sisi Server (Broadcast)**: Server kemudian menyiarkan (`emit`) objek pesan yang baru saja dibuat—yang seharusnya mengandung `sessionId`—kembali ke semua klien di percakapan melalui event `message:new`.

4.  **Sisi Penerima (Client - `socket.ts`)**: Klien menerima event `message:new`. Di sinilah letak misterinya. Objek `newMessage` yang diterima di sini, yang kemudian diteruskan ke `decryptMessageObject`, tampaknya **kehilangan `sessionId`-nya**.

## Hipotesis Kegagalan

Penyebab mengapa `sessionId` hilang dalam perjalanan dari server-emit ke client-handler masih belum jelas, tetapi kemungkinannya adalah:

-   **Masalah Serialisasi/Deserialisasi:** Ada kemungkinan proses serialisasi di server saat `emit` atau deserialisasi di `socket.io-client` menghilangkan properti `sessionId`.
-   **Inkonsistensi Tipe Data:** Meskipun tipe `Message` di sisi klien memiliki `sessionId?: string | null`, bisa jadi ada proses lain (casting, spread operator, dll.) di antara penerimaan socket dan pemanggilan `decryptMessageObject` yang menghilangkannya.
-   **Bug di Library:** Ada kemungkinan, meskipun kecil, bug di salah satu library (`prisma` atau `socket.io`) yang menangani pembuatan atau transmisi objek.

## Langkah Selanjutnya yang Direkomendasikan

Karena semua perbaikan logis telah gagal, langkah berikutnya adalah **instrumentasi ekstrem** untuk membuktikan keberadaan `sessionId` di setiap langkah:

1.  **Server (`uploads.ts`):** Tambahkan `console.log` tepat sebelum `io.emit()` untuk mencetak `messageToBroadcast` dan memastikan `sessionId` ada di sana.
2.  **Klien (`socket.ts`):** Tambahkan `console.log` di baris pertama listener `socket.on("message:new", ...)` untuk mencetak objek `newMessage` mentah yang diterima, sebelum diteruskan ke fungsi lain.

Dengan membandingkan kedua log ini, kita dapat secara definitif menentukan apakah `sessionId` hilang saat transit di jaringan, atau hilang di dalam logika internal klien. Ini adalah satu-satunya cara untuk menyelesaikan misteri ini.
