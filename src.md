3. 🛠️ Opsi C: Tambah "Killer Feature" Baru
Kalau lu masih gatel pengen ngoding fitur berat.

    Fokus: Gimana kalau kita tambahin Voice Call / Video Call E2EE pakai WebRTC?

   1. Refactoring Struktur Socket.IO (Backend)
  Saat ini, file server/src/socket.ts menangani hampir semua logika
  real-time: autentikasi, kehadiran (presence), pengiriman pesan, key
  exchange, dan notifikasi. Ini membuatnya menjadi "God Object" yang
  sulit dipelihara.

   * Saran: Pecah logika socket menjadi modul-modul handler terpisah.
   * Contoh Struktur:



   1     server/src/socket/
   2     ├── index.ts          # Inisialisasi io dan middleware
   3     ├── handlers/
   4     │   ├── auth.ts       # Linking device, initial handshake
   5     │   ├── message.ts    # Send, receive, read status
   6     │   ├── presence.ts   # Online/offline, typing indicators
   7     │   └── crypto.ts     # Key distribution, session requests
   * Manfaat: Kode lebih bersih, lebih mudah di-debug, dan risiko
     konflik saat merge berkurang.


  5. Optimasi Virtualisasi Chat (react-virtuoso)
  Anda baru saja beralih ke react-virtuoso. Pastikan fitur
  stick-to-bottom (auto-scroll ke pesan terbaru) berjalan mulus,
  terutama saat ada gambar yang dimuat.


   * Saran: Pastikan komponen gambar (LazyImage atau FileAttachment)
     memiliki prop height atau aspek rasio yang tetap sebelum gambar
     dimuat. Ini mencegah layout shift yang membuat scroll "melompat"
     saat gambar muncul di dalam list virtual.

     What gets encrypted:
   * Profile Data: Name, Bio, Avatar URL.
   * Metadata: (Harder) Who is talking to whom.

  ⚠️ The Challenges (Why most don't do it)


   1. User Discovery (The Biggest Problem):
       * If names are encrypted, how do I search for you?
       * If I type "Kenz", the server can't search the database because
         all names are stored as aes_encrypt("Kenz") (which looks like
         x82ma9...).
       * Solution: You need exact Username matching (using a hashed
         index) or QR code sharing only. "Discovery" features basically
         die.


   2. Avatar Performance:
       * Avatars can't be served directly by a CDN (like R2/S3 public
         URLs) because the URL itself might be encrypted, or the file
         content is encrypted.
       * Impact: Every time you scroll a chat list, the client must
         download the encrypted avatar blob, decrypt it in the Worker,
         and create a blob: URL. This is heavy on CPU and RAM.


   3. Push Notifications:
       * The server sends a notification: "New message from..." ->
         Server doesn't know who sent it!
       * Notifications will just say: "You have a new message."
         (Generic).

  🚀 Implementing It (If you're crazy enough)

  If you want to proceed with this "Paranoia Max" approach:


   1. Profile Encryption:
       * User generates a Profile Key.
       * Encrypted Name/Bio are uploaded to users table.
       * Sharing: When you chat with someone, you silently send them
         your Profile Key inside the E2EE channel. Without that key,
         they see "Unknown User".


   2. Hashed Search:
       * Store argon2(username) for login/search.
       * Store aes(username) for display.


  My Verdict
  For a "Soft Launch" app that wants to be usable: Don't do it yet.
  It massively complicates the "Social" aspect (finding friends). The
  current setup (E2EE messages + Server-visible profiles) is the
  industry standard (Signal, WhatsApp) because it balances privacy with
  usability.


  Better Alternative:
  "Private Profiles" (Feature toggle).
   * Allow users to toggle "Encrypt my Profile".
   * If ON: Their name/photo is hidden from strangers. Only contacts
     with shared keys see it.
   * Default: Visible.

   Sealed Sender (Menyembunyikan senderId)
   * Analisis: Saat ini Message tabel punya senderId yang berelasi ke
     User. Ini membocorkan siapa bicara dengan siapa.
   * Implementasi:
       * Mengubah senderId jadi nullable di Prisma? Bisa.
       * Masalah Validasi: Server perlu tahu apakah pengirim boleh
         mengirim pesan ke conversationId tersebut. Jika senderId
         disembunyikan total dari header HTTP/Socket, server tidak bisa
         memvalidasi membership.
       * Solusi Signal: Signal menggunakan "Delivery Token" yang
         membuktikan membership tanpa mengungkapkan identitas eksplisit
         per pesan, tapi itu sangat kompleks.
       * Solusi NYX (Pragmatis): Server tetap perlu tahu senderId (dari
         token JWT/Auth) untuk validasi permission "write" ke grup.
         Tapi kita bisa TIDAK MENYIMPANNYA di kolom database.
       * Database: Message table -> hapus senderId.
       * Payload E2EE: senderId masuk ke dalam ciphertext.
   * Dampak UI: Client harus decrypt dulu baru tahu ini pesan dari
     siapa (kiri/kanan).

Ini detail implementasi buat *upgrade* X3DH nyx ke standar Signal:

### 1. Update Database Server (`schema.prisma`)

Server butuh "lemari" buat nyimpen ratusan kunci publik sekali pakai dari setiap *user*.

```prisma
// Tambahin model ini di schema.prisma
model OneTimePreKey {
  id        String   @id // Pakai ID unik yang di-generate dari client (misal: integer ID 1, 2, 3...)
  userId    String
  publicKey String   // Public key (Base64/Hex) dari Curve25519
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

```

*Catatan:* Di model `User`, lu juga harus nambahin relasi `oneTimePreKeys OneTimePreKey[]`.

### 2. Client-Side: Generate & Upload Batch

Pas *user* register atau pas *stock* kunci di server udah mau abis, *client* (Web Worker) harus nge- *generate* banyak kunci sekaligus (Signal biasanya bikin 100 kunci).

* **Generate:** Bikin 100 pasang *keypair* Curve25519 (`crypto_box_keypair`).
* **Store Local:** Simpen 100 *Private Key*-nya di `keychainDb.ts` (IndexedDB) pake enkripsi *master seed* lu. Jangan lupa catat `keyId`-nya.
* **Upload:** Kirim 100 *Public Key*-nya beserta `keyId` ke server lewat API.

### 3. Server-Side: Sistem "Pop" (Dispense Key)

Ini bagian penting dari konsep *One-Time*. Saat Alice mau ngechat Bob, Alice bakal minta *Pre-Key Bundle* Bob ke server.

Server harus mengembalikan:

1. Identity Key Bob ()
2. Signed Pre-Key Bob () beserta *signature*-nya.
3. **Satu** One-Time Pre-Key Bob ().

**Krusial:** Begitu server ngirim  ke Alice, server **HARUS LANGSUNG MENGHAPUS**  tersebut dari *database*. Jadi kalau orang lain mau ngechat Bob sedetik kemudian, dia bakal dapet  yang berbeda.

### 4. Upgrade Kalkulasi X3DH (Di Web Worker Alice)

Nah, di sinilah *math* kriptografinya berubah. Sekarang kita punya 4 tahap kalkulasi *Diffie-Hellman* (`crypto_scalarmult`), bukan 3 lagi.

Di `crypto.worker.ts`, lu harus ngitung 4 *shared secrets* ini:

*
*
*
* *(Ini yang baru!)*

Setelah dapet keempatnya, gabungin semua (di- *concatenate*) dan masukin ke *Key Derivation Function* (KDF), biasanya pake HKDF (HMAC-based Extract-and-Expand KDF) buat dapet *Shared Secret* ():

*Note:*  = Identity Key,  = Ephemeral Key (kunci sementara yang Alice bikin pas mau ngechat),  = Signed Pre-Key.

### 5. Inisialisasi Pesan & Eksekusi di Sisi Bob

Pas Alice ngirim pesan pertama ke Bob, pesan itu harus nyertain:

*  (Identity Key Alice)
*  (Ephemeral Key Alice)
* **ID dari  yang dipakai Alice.**

**Apa yang Bob lakuin pas nerima pesan ini?**

1. Bob ngeliat *payload* pesannya: *"Oh, Alice pake OTPK ID nomor 42"*.
2. Bob nyari *Private Key* nomor 42 di `keychainDb.ts` (IndexedDB).
3. Bob ngelakuin kalkulasi X3DH yang sama buat dapetin .
4. **Paranoia Step:** Bob **MENGHAPUS SECARA PERMANEN** *Private Key* nomor 42 dari IndexedDB-nya. Ini menjamin *Forward Secrecy*. Kalau HP/Browser Bob dibajak besok, *hacker* gak bisa baca pesan Alice yang ini karena kuncinya bener-bener udah musnah.

---

Dengan *flow* ini, bahkan seandainya *server* lu di- *hack* dan *Signed Pre-Key* Bob dipalsuin, *hacker* tetep gak bisa ngedekripsi pesan, karena dia gak punya *Private Key* dari  yang disimpen di *browser* Bob.
