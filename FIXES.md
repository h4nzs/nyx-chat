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
