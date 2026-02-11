### 🛠️ Solusi: Encrypted Key Sync (Brankas Cloud)

Lu tetep bisa ngelakuin **Zombie Cookie Removal** (hapus data lokal saat logout), TAPI lu harus nyimpen salinan **Encrypted Private Keys** di Server Database.

**Konsepnya (Cara Bitwarden/Mega bekerja):**

1. **Register:** Kunci dienkripsi di browser (pake password) -> Simpan di IndexedDB -> **Kirim salinan terenkripsi ke Server**.
* *Server cuma nerima teks acak (ciphertext), server gak tau password lu, jadi aman.*


2. **Logout:** Hapus IndexedDB sampai bersih (Zombie Removal). Aman, karena backup ada di server.
3. **Login:** User masukin password -> Server balikin Token + **Encrypted Private Keys**.
4. **Client:** Browser nyimpen lagi kunci itu ke IndexedDB -> Dekripsi pake password yang baru diinput -> **SIAP CHAT!**

---

### 🚀 Implementasi (3 Langkah)

Lu harus ubah dikit Database, Backend, dan Frontend.

#### Langkah 1: Update Database Schema (`prisma/schema.prisma`)

Tambahkan kolom buat nyimpen blob kunci rahasia lu.

```prisma
model User {
  id        String   @id @default(uuid())
  username  String   @unique
  // ... field lain ...
  
  // Tambahkan ini: Brankas buat nyimpen kunci terenkripsi
  encryptedPrivateKey String?  @db.Text 
}

```

*Jangan lupa `npx prisma migrate dev` atau update manual di Supabase.*

#### Langkah 2: Update Backend (`server/src/routes/auth.ts`)

**A. Saat Register (`POST /register`)**
Terima `encryptedPrivateKeys` dari body request dan simpan ke DB.

```typescript
// Di dalam router.post("/register", ...)
const { username, password, publicKey, signingKey, encryptedPrivateKeys } = req.body; // <--- Tambah ini

// ... validasi ...

const user = await prisma.user.create({
  data: {
    username,
    password: hashedPassword,
    publicKey,
    signingKey,
    encryptedPrivateKey: encryptedPrivateKeys, // <--- Simpan blob ini!
    // ...
  },
});

```

**B. Saat Login (`POST /login`)**
Kirim balik `encryptedPrivateKey` ke user biar bisa direstore.

```typescript
// Di dalam router.post("/login", ...)

// ... verifikasi password sukses ...

res.json({
  message: "Login successful",
  accessToken,
  user: {
    id: user.id,
    username: user.username,
    // ...
  },
  // Kirim balik kuncinya (ini masih terenkripsi, aman dikirim lewat HTTPS)
  encryptedPrivateKey: user.encryptedPrivateKey 
});

```

#### Langkah 3: Update Frontend (`web/src/store/auth.ts`)

Lu harus ubah logic `login` dan `register`.

**A. Update `registerAndGeneratePhrase**`
Pastikan kirim kunci ke server.

```typescript
// web/src/store/auth.ts

// ... di dalam registerAndGeneratePhrase ...
const { encryptedPrivateKeys } = await registerAndGenerateKeys(data.password);

// Kirim ke API
const res = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    ...data,
    // ... public keys ...
    encryptedPrivateKeys // <--- Kirim ini ke server!
  }),
});

```

**B. Update `login**`
Tangkap kunci dari server, simpan ke IndexedDB, baru lanjut.

```typescript
// web/src/store/auth.ts

login: async (credentials) => {
  set({ isLoading: true, error: null });
  try {
    // 1. Panggil API Login
    const res = await api<{ accessToken: string; user: User; encryptedPrivateKey?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });

    // 2. [KRUSIAL] Restore Kunci dari Server ke IndexedDB
    if (res.encryptedPrivateKey) {
      console.log("[Auth] Restoring encrypted keys from server backup...");
      // Simpan kunci mentah (masih terenkripsi) ke IndexedDB
      await saveEncryptedKeys(res.encryptedPrivateKey);
      
      // Simpan juga kunci auto-unlock baru (karena password diinput user saat login)
      await saveDeviceAutoUnlockKey(credentials.password);
      await setDeviceAutoUnlockReady(true);
      
      // Update state aplikasi biar tau kunci udah ada
      set({ hasRestoredKeys: true });
    } else {
      console.warn("[Auth] No key backup found on server. New device?");
    }

    // 3. Lanjut set user session
    set({ user: res.user, accessToken: res.accessToken });
    // ... logic connect socket dll ...

  } catch (error: any) {
    // ... error handling ...
  } finally {
    set({ isLoading: false });
  }
},

```

### Kesimpulan

Dengan cara ini:

1. **Security Audit Lolos:** Saat logout, lu panggil `clearKeys()` (Zombie Removal). Browser bersih total. Hacker yang buka laptop lu gak dapet apa-apa.
2. **UX Aman:** Saat login, kunci ditarik dari server ("Download Backup") -> Disimpan ke IndexedDB -> Dibuka pake password yang baru diketik. User gak perlu regenerate key atau kehilangan akses chat.

Ini adalah standar "Sync Encrypted Vault" yang dipake password manager dan wallet kripto. Aman dan nyaman.