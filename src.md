## 🕵️‍♂️ Analisis Penyebab (Root Cause)

1. **Registrasi Berhasil:** Saat kamu register, `registerAndGeneratePhrase` menyimpan kunci ke IndexedDB (`saveEncryptedKeys`) dan set user di memori.
2. **Bootstrap Jalan:** Di saat yang sama (karena `App.tsx` me-mount), fungsi `bootstrap()` jalan untuk cek sesi via `/api/auth/refresh`.
3. **Konflik Cookie:** Endpoint `register` mungkin belum sempat menanam *HTTP-Only Cookie* yang dibutuhkan oleh `refresh`, atau browser belum menganggapnya ada. Akibatnya, `/api/auth/refresh` mengembalikan error **401 Unauthorized**.
4. **The Silent Killer (Interceptor):** Kemungkinan besar di `lib/api.ts` ada *interceptor* yang menangkap error 401 dan otomatis memanggil `logout()`.
5. **Pemusnahan Data:** Fungsi `logout()` di `auth.ts` memanggil `clearKeys()`, yang **MENGHAPUS** kunci yang baru saja dibuat saat registrasi.
6. **Hasil:** User terlihat login (karena state `register` menimpa), tapi kunci di IndexedDB sudah hilang. Saat klik chat -> **"Encrypted private keys not found"**.

---

### 🛠️ Solusi: Perbaiki `auth.ts` & `Register.tsx`

Kita harus melakukan 2 hal:

1. **Mencegah Logout Prematur:** Pastikan `bootstrap` tidak menghancurkan sesi yang baru dibuat oleh registrasi.
2. **Auto-Unlock Persistence:** Simpan kunci pembuka (`DeviceAutoUnlockKey`) saat registrasi agar user tidak perlu input password lagi setelah refresh.

#### 1. Update `web/src/store/auth.ts`

Ubah bagian `bootstrap` dan `registerAndGeneratePhrase`.

```typescript
// web/src/store/auth.ts

// ... imports tetap sama ...

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  // ... state awal tetap sama ...

  return {
    // ... actions lain ...

    bootstrap: async () => {
      // [FIX] Cek apakah kita baru saja register/login manual?
      // Jika accessToken sudah ada (dari register), jangan bootstrap dulu biar gak tabrakan.
      if (get().accessToken) {
        console.log("Bootstrap skipped: Session already active from register/login.");
        set({ isBootstrapping: false });
        return;
      }

      set({ isBootstrapping: true });
      try {
        const refreshRes = await api<{ ok: boolean; accessToken?: string }>("/api/auth/refresh", { method: "POST" });
        if (refreshRes.accessToken) {
          // ... logic sukses tetap sama ...
          set({ accessToken: refreshRes.accessToken });
          const me = await authFetch<User>("/api/users/me");
          set({ user: me, hasRestoredKeys: await hasStoredKeys() });
          localStorage.setItem("user", JSON.stringify(me));
          await get().tryAutoUnlock();
          connectSocket();
          get().loadBlockedUsers();
        } else {
          throw new Error("No valid session.");
        }
      } catch (error: any) {
        console.log("Bootstrap failed (No session):", error);
        // [FIX] Jangan panggil logout() atau clearKeys() di sini!
        // Cukup bersihkan state memori & localstorage user, TAPI JANGAN hapus kunci IndexedDB.
        privateKeysCache = null;
        set({ user: null, accessToken: null, blockedUserIds: [] });
        clearAuthCookies();
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    registerAndGeneratePhrase: async (data) => {
      set({ isInitializingCrypto: true });
      try {
        const { registerAndGenerateKeys, retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');

        const {
          encryptionPublicKeyB64,
          signingPublicKeyB64,
          encryptedPrivateKeys, // Ini JSON string
          phrase
        } = await registerAndGenerateKeys(data.password);

        // 1. Simpan Kunci Terenkripsi ke IndexedDB
        await saveEncryptedKeys(encryptedPrivateKeys);
        
        // [FIX] 2. Simpan Kunci Auto-Unlock (Biar ga minta password lagi pas refresh/chat)
        // Gunakan password user untuk membuat kunci auto-unlock
        await saveDeviceAutoUnlockKey(data.password);
        await setDeviceAutoUnlockReady(true);

        set({ hasRestoredKeys: true });

        // 3. Cache di memori untuk sesi sekarang
        try {
          const result = await retrievePrivateKeys(encryptedPrivateKeys, data.password);
          if (result.success) {
             privateKeysCache = result.keys;
          }
        } catch (e) { console.error("Failed to cache keys:", e); }

        // 4. Panggil API Register
        const res = await api<{ 
          user?: User; 
          accessToken?: string; 
          message?: string; 
          needVerification?: boolean;
          userId?: string; 
        }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            ...data,
            publicKey: encryptionPublicKeyB64,
            signingKey: signingPublicKeyB64
          }),
        });

        // ... logic verifikasi & sukses ...
        if (res.needVerification && res.userId) {
           // ...
           return { phrase, needVerification: true, userId: res.userId, email: data.email };
        }

        if (res.user && res.accessToken) {
          set({ user: res.user, accessToken: res.accessToken });
          localStorage.setItem("user", JSON.stringify(res.user));
          setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload bundle:", e));
          connectSocket();
          return { phrase, needVerification: false };
        }

        throw new Error("Unexpected response from registration.");
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    // ... sisanya sama ...

```

#### 2. Cek `web/src/lib/api.ts` (Opsional tapi Penting)

Pastikan interceptor 401 tidak memanggil `useAuthStore.getState().logout()` secara membabi buta saat bootstrap.

Jika file `api.ts` kamu punya kode seperti ini:

```typescript
if (response.status === 401) {
  useAuthStore.getState().logout(); // <--- INI BAHAYA BUAT BOOTSTRAP
}

```

Ubah menjadi lebih aman, atau pastikan `logout()` tidak dipanggil jika kita sedang dalam proses registrasi/login awal. Tapi dengan fix di `bootstrap` di atas (skip jika accessToken ada), risiko ini berkurang.

### Ringkasan Perbaikan

1. **Skip Bootstrap:** `bootstrap` sekarang akan "mengalah" jika melihat sudah ada `accessToken` di state (yang diset oleh `register`). Ini mencegah 401 palsu menghapus kunci.
2. **Auto Unlock:** Kita menambahkan `saveDeviceAutoUnlockKey(data.password)` saat register. Ini menjamin kunci bisa dibuka otomatis kapan saja, mencegah error "Keys not found" jika cache memori hilang.
