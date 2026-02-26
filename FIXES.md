*"Kita akan mengeksekusi Phase 2: 'Profile Encryption'. Tujuan kita adalah mengenkripsi data profil pengguna (Name, Bio, Avatar) di sisi klien sebelum dikirim ke server. Server hanya akan menyimpan teks acak (ciphertext).*

*Tolong lakukan perubahan presisi pada file-file berikut:*

### STEP 1: Modifikasi Skema Database (`server/prisma/schema.prisma`)

* Pada model `User`:
* **HAPUS** kolom `name`, `avatarUrl`, dan `description`.
* **TAMBAHKAN** kolom `encryptedProfile String? @db.Text`.



### STEP 2: Rombak Backend Routes (`server/src/routes/auth.ts` & `server/src/routes/users.ts`)

* **Di `auth.ts`:**
* `POST /register`: Hapus validasi dan payload `name`. Ganti dengan menerima `encryptedProfile: z.string().optional()`. Simpan `encryptedProfile` saat `prisma.user.create`.
* `POST /login` & `POST /webauthn/login/verify` & `POST /refresh`: Pada `select`, hapus `name`, `avatarUrl`, `description`. Ganti menjadi mengambil `encryptedProfile`.


* **Di `users.ts`:**
* `GET /me`, `GET /search`, `GET /:userId`, dan `POST /by-username`: Hapus semua pengambilan (select) dan kembalian (return) untuk `name`, `avatarUrl`, `description`. Ganti dengan `encryptedProfile`.
* `PUT /me`: Ubah Zod validation untuk hanya menerima `encryptedProfile: z.string()`. Ubah logika update agar hanya meng-update field `encryptedProfile` di database.
* Pada event emit socket `user:updated`, kirimkan object yang berisi `id` dan `encryptedProfile`.



### STEP 3: Tambahkan Mesin Enkripsi di Worker (`web/src/workers/crypto.worker.ts`)

* Tambahkan *case* baru di dalam `self.onmessage` switch untuk enkripsi profil menggunakan libsodium (XChaCha20-Poly1305):

```typescript
      case 'encryptProfile': {
        const { profileJsonString, profileKeyB64 } = payload;
        const key = sodium.from_base64(profileKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
        const message = new TextEncoder().encode(profileJsonString);
        // Generate random nonce (24 bytes for XChaCha20)
        const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
        
        const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            message,
            null, // no additional data
            null, // secret nonce
            nonce,
            key
        );
        
        // Combine nonce + ciphertext
        const combined = new Uint8Array(nonce.length + ciphertext.length);
        combined.set(nonce);
        combined.set(ciphertext, nonce.length);
        
        result = sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);
        break;
      }
      case 'decryptProfile': {
        const { encryptedProfileB64, profileKeyB64 } = payload;
        const key = sodium.from_base64(profileKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
        const combined = sodium.from_base64(encryptedProfileB64, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
        const nonce = combined.slice(0, nonceBytes);
        const ciphertext = combined.slice(nonceBytes);
        
        const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, // secret nonce
            ciphertext,
            null, // additional data
            nonce,
            key
        );
        
        result = new TextDecoder().decode(decrypted);
        break;
      }
      case 'generateProfileKey': {
        // Generate a random 32-byte key for profile encryption
        const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
        result = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
        break;
      }

```

### STEP 4: Proxy Worker (`web/src/lib/crypto-worker-proxy.ts`)

* Tambahkan *wrapper functions* untuk memanggil worker di atas:

```typescript
export async function encryptProfile(profileJsonString: string, profileKeyB64: string): Promise<string> {
  return sendToWorker('encryptProfile', { profileJsonString, profileKeyB64 });
}
export async function decryptProfile(encryptedProfileB64: string, profileKeyB64: string): Promise<string> {
  return sendToWorker('decryptProfile', { encryptedProfileB64, profileKeyB64 });
}
export async function generateProfileKey(): Promise<string> {
  return sendToWorker('generateProfileKey', {});
}

```

### STEP 5: Penyesuaian Tipe User di Frontend (`web/src/store/auth.ts` & `conversation.ts`)

* Pada tipe `User` (di `auth.ts` dan file tipe lainnya):
* **Hapus** `name`, `avatarUrl`, dan `description`.
* **Tambahkan** `encryptedProfile?: string | null;`


* **PERHATIAN:** Ini akan menyebabkan banyak error TypeScript di komponen UI (seperti `ChatList.tsx`, `UserInfoModal.tsx`, dll) karena `user.name` tidak lagi ada. Untuk sementara, biarkan error UI tersebut, atau ubah pemanggilan `user.name` menjadi string fallback sementara seperti `"Encrypted User"` agar TypeScript lolos kompilasi. Kita akan merombak UI-nya di iterasi selanjutnya setelah kunci terdistribusi.
* Di `Register.tsx`: Saat pendaftaran, fungsi `handleRegister` tidak lagi mengirimkan `name` ke store secara langsung, tetapi kita akan membuat `profileKey` dan melakukan enkripsi (ini akan kita sempurnakan setelah schema DB di-push). Sementara, cukup hapus input `name` dari UI atau sesuaikan agar lolos TS.

*Fokus eksekusi ini murni pada Perubahan Skema, Route Backend, dan Mesin Enkripsi di Worker. Biarkan UI sedikit error untuk sementara waktu.*"
