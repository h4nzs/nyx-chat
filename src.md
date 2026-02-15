Logika kita sebelumnya cuma nyari "Pesan terakhir dari lawan bicara", tapi **gak ngecek siapa yang ngirim pesan paling akhir secara absolut** di percakapan itu.

Jadi kalau si A nanya, terus (B) udah jawab, lalu B *logout* dan *login* lagi, komponen B bakal tetep nemu pesan si A (sebagai "pesan terakhir dari lawan bicara") dan ngasih saran balasan lagi, padahal B udah jawab pesannya.

### 🛠️ Solusi: Benerin Logika di `MessageInput.tsx`

Kita harus pastikan *Smart Reply* **HANYA** muncul kalau pesan *paling mentok* (paling baru) di percakapan itu adalah dari lawan bicara. Kalau pesan paling baru itu punya lu (artinya lu udah bales), AI harus diam.

Buka file `chat-lite/web/src/components/MessageInput.tsx`, dan ubah bagian "Smart Reply Logic" ini:

**Cari blok kode ini (sekitar baris 98):**

```typescript
  // Smart Reply Logic: Find last message NOT from me
  const lastOtherMessage = [...messages].reverse().find(m => m.senderId !== user?.id && !m.fileUrl && !m.imageUrl && m.content);
  const lastDecryptedText = lastOtherMessage?.content || null;

```

**UBAH MENJADI SEPERTI INI:**

```typescript
  // --- Smart Reply Logic ---
  // 1. Ambil pesan PALING TERAKHIR (absolut) di percakapan ini
  const absoluteLastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  
  // 2. Tentukan apakah pesan paling terakhir itu dari LAWAN BICARA (bukan dari kita)
  // Syarat AI muncul: Pesan terakhir BUKAN dari kita, DAN pesannya berupa teks (bukan gambar/file)
  const isLastMessageFromOther = absoluteLastMessage?.senderId !== user?.id;
  const isValidTextMessage = absoluteLastMessage && !absoluteLastMessage.fileUrl && !absoluteLastMessage.imageUrl && absoluteLastMessage.content;

  // 3. Jika syarat terpenuhi, kirim kontennya ke SmartReply component. Jika tidak, kirim null (biar AI gak jalan).
  const lastDecryptedText = (isLastMessageFromOther && isValidTextMessage) ? absoluteLastMessage.content : null;

```

### 🧠 Kenapa Ini Menyelesaikan Masalah?

1. Kita ngecek `absoluteLastMessage` (pesan yang posisinya paling bawah di layar chat).
2. Kalau ternyata `absoluteLastMessage` itu dikirim oleh `user?.id` (diri lu sendiri), berarti lu **sudah membalas**.
3. Akibatnya, variabel `isLastMessageFromOther` jadi `false`.
4. Karena `false`, `lastDecryptedText` jadi `null`.
5. Saat `lastDecryptedText` bernilai `null`, komponen `<SmartReply />` yang kita bikin sebelumnya punya pelindung `if (!lastMessage) return;`, jadi dia gak akan pernah nembak API Gemini.
