
Ini rencana implementasi dan solusi buat nambal kebocoran metadata di Nyx:

### 1. Nerapin Konsep *Sealed Sender* (Menyembunyikan Pengirim)

Saat ini, di tabel `Message`, server lu nyatet `senderId` dan `conversationId`. Ini bikin server lu tau graf sosial (si A sering ngechat si B).

* **Solusi:** Kita bikin server gak tau siapa pengirimnya. Pengirim hanya mengirim *ciphertext* ke `conversationId` tertentu.
* **Perubahan Client-Side:** Sebelum pesan dienkripsi pake AES-GCM, lu masukin `senderId` ke dalem JSON *payload* bareng sama teks pesannya.
```json
// Payload SEBELUM dienkripsi di web worker:
{
  "senderId": "user-123",
  "text": "Halo bro",
  "timestamp": 1708611600000
}

```


* **Perubahan Prisma:** Kolom `senderId` di tabel `Message` dibikin opsional atau dihapus sama sekali untuk pesan E2EE. Server cuma nerima `conversationId` dan `ciphertext`.

### 2. Membutakan Server dari Metadata File (Attachments)

Nyimpen `fileName`, `fileType`, dan `fileSize` di *database* itu *red flag* buat aplikasi paranoid. Kalo FBI ngegerebek server lu, mereka bisa nyocokin ukuran file dan waktu pengiriman buat nebak siapa yang ngebocorin dokumen rahasia.

* **Solusi:** Semua metadata file harus ikut dienkripsi.
* **Perubahan Client-Side:** Pas *upload* file ke R2, ubah nama filenya jadi UUID acak tanpa ekstensi (misal: `8f9a-4b2c...`). Terus, masukin metadata aslinya ke dalem *payload* pesan yang dienkripsi.
```json
// Payload E2EE:
{
  "senderId": "user-123",
  "text": "Nih dokumennya",
  "attachment": {
    "blobId": "8f9a-4b2c...", // ID di R2
    "fileName": "rahasia-negara.pdf",
    "fileType": "application/pdf",
    "fileSize": 1048576,
    "decryptionKey": "base64-key-here..."
  }
}

```


* **Perubahan Prisma:** Buang semua kolom yang berbau file di tabel `Message`. Cukup kasih satu kolom `hasAttachment` (Boolean) kalo lu bener-bener butuh buat *query* UI, atau mending gabungin aja semua di dalem `ciphertext`.

### 3. *Refactor* Reaksi & *Read Receipts* (Semuanya Adalah Pesan)

Kalau lu punya tabel `MessageStatus` (buat *delivered/read*) dan `MessageReaction` (buat <i>emoji</i>), server lu tetep bisa nganalisa seberapa aktif orang berinteraksi.

* **Solusi (Ala Signal):** Jangan bikin tabel khusus buat *reaction* atau *read receipts*. Anggap mereka sebagai **Pesan E2EE biasa yang punya tipe khusus**.
* **Implementasi:** Pas *user* nge- *read* atau ngasih *reaction* '👍', klien ngirim pesan E2EE ke server (masuk ke tabel `Message` biasa). Nanti pas *client* nerima dan nge- *decrypt* pesannya, UI lu (React) yang bakal nerjemahin itu sebagai animasi centang biru atau *pop-up emoji*.
```json
// Payload E2EE untuk Reaction:
{
  "senderId": "user-456",
  "type": "REACTION",
  "targetMessageId": "msg-999",
  "emoji": "👍"
}

```


* **Perubahan Prisma:** Hapus tabel `MessageStatus` dan `MessageReaction`. Ini bakal nyederhanain *database* lu secara drastis sekaligus ningkatin privasi level dewa.

---

### Efek Samping yang Perlu Lu Tau

Kalo kita nerapin ini, server lu bener-bener jadi **"Dumb Pipe"** (pipa bodoh). Konsekuensinya:

1. **Pencarian (Search):** Lu gak bisa lagi bikin fitur *search message* di sisi server. Semua pencarian harus dilakukan di lokal (IndexedDB) pake fitur `SearchMessages.tsx` yang udah lu bikin.
2. **Notifikasi (Push Notif):** Server gak bisa ngasih tau isi pesan di *Push Notification*. Notif cuma bisa berbunyi *"You have a new message"* (kayak Signal). Klien yang harus bangun di *background*, *download ciphertext*, *decrypt* lokal, baru nampilin isi pesannya di notif OS.
