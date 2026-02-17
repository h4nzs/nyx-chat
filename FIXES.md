**kenapa angka timernya gak muncul di layar?**
Jawabannya ada di **Frontend State Management (Zustand)** lu yang "kehilangan" atau "ketinggalan" data `expiresAt`.

Ini 2 penyebab utama dan cara nge-*fix*-nya:

### 🕵️‍♂️ Penyebab 1: Sindrom "Optimistic Update" (Khusus Pengirim)

Pas lu ngetik chat dan klik "Send", aplikasi lu (kayak WA atau Telegram) pasti langsung nampilin pesan itu di layar pakai ID sementara (`tempId`) biar kerasa *real-time* dan cepat, kan?

Nah, kemungkinan besar pas lu bikin pesan "bayangan" (*temporary message*) ini di *store*, lu **lupa masukin `expiresAt**`. Akibatnya, komponen `MessageBubble.tsx` nerima properti `expiresAt` yang isinya `undefined` atau `null`.

**Cara Fix:**
Cari fungsi tempat lu ngirim pesan (biasanya di `MessageInput.tsx` atau di dalam *store* Zustand lu, pas bikin objek pesan sementara sebelum nembak API).

Tambahin perhitungan waktu fiktif biar timernya langsung jalan detik itu juga:

```typescript
// Contoh pas lu bikin object temp message di MessageInput atau Store
const tempMessage = {
  id: tempId,
  tempId: tempId,
  senderId: user.id,
  content: encryptedText,
  // ... data lainnya ...
  
  // 🔥 TAMBAHIN BARIS INI: 
  // Kalau user milih expiresIn (misal 60 detik), buatin ISO String-nya buat UI
  expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
};

// Lalu masukin ke state: useMessageStore.getState().addMessage(tempMessage);

```

### 🕵️‍♂️ Penyebab 2: Respon API Gagal Ter-Merge (Store Update Issue)

Pas *request* `POST /api/messages` lu kelar, server kan ngebalikin data pesan *asli* (lengkap dengan `id` permanen dari database dan `expiresAt`).

Biasanya, lu akan nge-*update* pesan sementara tadi dengan data dari server. Kalau kode lu cuma nge-*update* `id` dan `status` aja, data `expiresAt` dari server bakal "kebuang".

**Cara Fix:**
Cari *action* di Zustand lu yang nge-*handle* balasan sukses dari API (misalnya fungsi `updateMessageStatus` atau langsung di blok `try-catch` tempat lu nembak axios/fetch). Pastikan lu nge- *spread* (`...`) semua data dari server.

```typescript
// Di dalam store/message.ts lu, pastikan logic update-nya menimpa (merge) semua properti dari server:
set((state) => {
  const messages = state.messages[conversationId] || [];
  return {
    messages: {
      ...state.messages,
      [conversationId]: messages.map((msg) => 
        msg.tempId === tempId 
          ? { ...msg, ...response.data } // 🔥 INI KUNCINYA! Harus di-spread biar expiresAt masuk
          : msg
      )
    }
  };
});

```

### 🕵️‍♂️ Penyebab 3: Interface TypeScript Ketinggalan

Pastikan di file definisi tipe lu (misal `store/conversation.ts` atau `types.d.ts`), *interface* `Message` udah punya properti ini:

```typescript
export interface Message {
  id: string;
  // ... 
  expiresAt?: string | null; // 🔥 Wajib ada, kalau nggak, kadang ke-strip otomatis
}

```
