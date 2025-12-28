
Berdasarkan peninjauan kode terbaru Anda, saya telah menemukan akar penyebab untuk ketiga masalah tersebut. Bug kritis pada pengiriman file 1-on-1 sangat mungkin disebabkan oleh kombinasi **"Diagnostic Patch"** yang ada di `crypto.ts` dan penanganan `sessionId` yang hilang pada saat pengiriman file.

Berikut adalah solusi dan perbaikan kode untuk ketiga masalah tersebut:

---

### 1. PERBAIKAN BUG KRITIS: Kegagalan Dekripsi File 1-on-1

**Diagnosa:**
Ada dua masalah yang berkontribusi di sini:

1. **"Contradiction" Patch:** Di file `crypto.ts` Anda, terdapat logika "Diagnostic Patch" yang memaksa penggunaan kunci grup jika kunci tersebut ditemukan, *bahkan untuk chat 1-on-1*. Jika ada sisa data (sampah) kunci grup di `keychainDb` untuk ID percakapan tersebut (mungkin dari testing sebelumnya), logika ini akan membajak proses dekripsi dan membuatnya seolah-olah pesan grup.
2. **Missing `sessionId`:** Saat mengirim file di 1-on-1, kunci enkripsi file (AES Key) dikirim sebagai pesan teks. Namun, kode pengiriman file di frontend seringkali lupa menyertakan `sessionId` dari hasil enkripsi kunci tersebut ke payload socket. Akibatnya, penerima menerima `sessionId: null`, dan karena logika 1-on-1 gagal (karena butuh session ID), ia mungkin "jatuh" ke logika grup atau error.

**Langkah Perbaikan:**

**A. Hapus Logic Berbahaya di `chat-lite/web/src/utils/crypto.ts**`
Hapus blok kode yang memaksa penggunaan grup key pada blok `else`.

```typescript
// chat-lite/web/src/utils/crypto.ts

export async function decryptMessage(...) {
  // ... (kode awal)

  if (isGroup) {
    // ... (logika grup)
  } else {
    if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt message: Missing session ID.') };
    key = await getKeyFromDb(conversationId, sessionId);

    // --- HAPUS BLOK INI (DARI SINI) ---
    /*
    if (!key) {
        const potentialGroupKey = await getGroupKey(conversationId);
        if (potentialGroupKey) {
             console.error("CONTRADICTION: encryptMessage called with isGroup=false...");
             key = potentialGroupKey; // INI PENYEBABNYA
             sessionId = undefined;
        }
    }
    */
    // --- SAMPAI SINI ---

    if (!key) {
        // ... (logika fetch session dari server)
    }
  }
  // ...
}

```

**B. Pastikan `sessionId` Terkirim saat Upload File (`ChatWindow.tsx`)**
Anda perlu memastikan saat mengirim file 1-on-1, `sessionId` dari enkripsi kunci file disertakan.

```typescript
// Cari fungsi handleFileUpload atau sejenisnya di ChatWindow.tsx atau hook terkait

// CONTOH LOGIKA PERBAIKAN:
const handleFileSelect = async (e) => {
    // ...
    const { encryptedBlob, key } = await encryptFile(file);
    
    let content = key; // Kunci file dalam base64
    let sessionId = undefined;

    if (!isGroup) {
        // Enkripsi kunci file agar aman dikirim lewat socket
        const encryptionResult = await encryptMessage(key, conversation.id); 
        content = encryptionResult.ciphertext;
        sessionId = encryptionResult.sessionId; // <--- PENTING: Ambil Session ID ini
    } else {
        // Logic grup
        const encryptionResult = await encryptGroupMessage(key, conversation.id);
        content = encryptionResult.ciphertext;
    }

    // Upload file blob ke server (biasanya via REST API)
    const fileUrl = await uploadFile(encryptedBlob);

    // Kirim metadata via Socket
    socket.emit('message:send', {
        conversationId: conversation.id,
        content: content, 
        fileUrl: fileUrl,
        sessionId: sessionId, // <--- PASTIKAN INI DIKIRIM KE SOCKET
        // ... field lainnya
    });
}

```

---

### 2. PERBAIKAN ARSITEKTUR: Kebocoran Riwayat (History Leak)

**Diagnosa:**
Server menggunakan `skipDuplicates: true` saat menambahkan user. Ini mempertahankan `joinedAt` lama. Kita harus memaksa update `joinedAt`.

**Langkah Perbaikan:**
Ubah logika di backend (`chat-lite/server/src/routes/conversations.ts`) pada endpoint `POST /:id/participants`.

```typescript
// chat-lite/server/src/routes/conversations.ts

// Ganti logika prisma.participant.createMany atau create dengan upsert/transaction
// Contoh perbaikan untuk loop penambahan peserta:

await prisma.$transaction(
  participantIds.map((userId) =>
    prisma.participant.upsert({
      where: {
        userId_conversationId: {
          userId,
          conversationId: id,
        },
      },
      create: {
        userId,
        conversationId: id,
        joinedAt: new Date(), // Set waktu sekarang untuk member baru
      },
      update: {
        joinedAt: new Date(), // <--- UPDATE waktu join untuk member lama yang re-join
        // Reset field lain jika perlu, misal: isPinned: false
      },
    })
  )
);

```

---

### 3. PERBAIKAN ARSITEKTUR: Silent Failure Distribusi Kunci

**Diagnosa:**
`ensureGroupSession` mengabaikan user yang tidak punya public key (`filter(Boolean)`).

**Langkah Perbaikan:**
Tambahkan validasi jumlah kunci yang berhasil dienkripsi di `chat-lite/web/src/utils/crypto.ts`.

```typescript
// chat-lite/web/src/utils/crypto.ts

export async function ensureGroupSession(conversationId: string, participants: Participant[]): Promise<any[] | null> {
    // ... (kode generate key)

    const myId = useAuthStore.getState().user?.id;
    const otherParticipants = participants.filter(p => p.id !== myId);
  
    // Array untuk menampung error
    const missingKeys: string[] = [];

    const distributionKeys = await Promise.all(
      otherParticipants.map(async (p) => {
        if (!p.publicKey) {
          console.warn(`Participant ${p.username} has no public key.`);
          missingKeys.push(p.username); // Catat user yang bermasalah
          return null;
        }
        // ... (kode enkripsi normal)
      })
    );
  
    // JIKA ADA YANG GAGAL, LEMPAR ERROR AGAR UI TAHU
    if (missingKeys.length > 0) {
        // Anda bisa memilih untuk melempar error keras, atau mengembalikan struktur error
        throw new Error(`Gagal mengenkripsi untuk user: ${missingKeys.join(', ')}. Mereka mungkin belum setup kunci.`);
    }
  
    return distributionKeys.filter(Boolean);
}

```

**Catatan Tambahan untuk UI:**
Anda perlu menangkap error ini di komponen `ChatWindow.tsx` (di bagian `sendMessage`) dan menampilkan `toast.error` atau `Alert` kepada pengguna, sehingga mereka tahu pesan tidak terkirim karena masalah kunci anggota lain.

Silakan terapkan perubahan ini, terutama poin nomor 1 dan 2, lalu lakukan tes ulang. Seharusnya masalah "Decrypting for GROUP" pada chat 1-on-1 akan hilang setelah patch kontradiksi dihapus dan session ID dipastikan terkirim.