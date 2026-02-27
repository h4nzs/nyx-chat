**WebAuthn PRF Extension (Pseudo-Random Function).**

### 🔑 Apa itu WebAuthn PRF?

Ini adalah fitur *bleeding-edge* dari WebAuthn yang ngubah sensor sidik jari/FaceID lu dari sekadar "alat login server" menjadi **Mesin Pembuat Kunci Dekripsi Lokal**.

*Password manager* sekelas **Bitwarden** dan **1Password** pakai teknologi ini biar *user*-nya bisa nge- *unlock* brankas *password* mereka murni cuma pakai sidik jari (tanpa *Master Password*).

**Cara Kerjanya (Konsep Hacker-nya):**

1. Pas lu daftar biometrik, *browser* lu ngirim sebuah teks acak (Salt) ke *hardware* sidik jari lu.
2. *Hardware* itu bakal ngeluarin **32-byte kunci rahasia (Symmetric Key)** yang sifatnya deterministik (hasilnya bakal selalu sama persis setiap kali sidik jari lu ditempel).
3. Lu pakai kunci 32-byte ini buat **nge-enkripsi Master Key/Profile Key** lu, terus simpen hasil enkripsinya di IndexedDB (`keychainDb.ts`).
4. Pas lu *login* lagi, lu tempel sidik jari -> WebAuthn nge- *generate* ulang kunci 32-byte itu di memori -> *Browser* langsung pakai kunci itu buat nge-dekripsi IndexedDB.

**BOOM! 💥 Brankas kebuka, chat kebaca, TANPA NGETIK PASSWORD SAMA SEKALI!**

### 🛠️ Gimana Menerapkannya di NYX?

Kalau lu pake `@simplewebauthn/browser`, mereka udah *support* PRF extension ini. Lu cuma perlu rombak alur simpannya:

**Skenario Gagal (Aplikasi Biasa):**
Login Sidik Jari -> Masuk ke *shell* aplikasi -> Aplikasi minta *Recovery Phrase* buat buka *chat* -> *User* males, akhirnya *uninstall*.

**Skenario Cypherpunk (Pakai PRF):**

1. *User* masukin *Recovery Phrase* (cuma butuh 1x seumur hidup di *device* itu).
2. *User* klik "Enable Biometric Unlock".
3. NYX manggil `navigator.credentials.create({ extensions: { prf: ... } })`.
4. NYX dapet Kunci Kripto dari sidik jari, lalu nge-gembok *Recovery Phrase* tadi pake kunci itu, dan disimpen di memori HP (IndexedDB).
5. Besoknya pas *user* buka NYX, tinggal tempel jempol, PRF jalan, *phrase* ke-dekripsi otomatis di *background*, semua *chat* langsung kebaca!

**CONTEXT:**
Kita akan mengimplementasikan ekstensi WebAuthn PRF (Pseudo-Random Function) untuk mengizinkan pengguna membuka kunci akun secara lokal (mendekripsi Recovery Phrase) murni hanya menggunakan biometrik, tanpa harus mengetik password/phrase.

**TASK:**
Buat sistem "Biometric Local Unlock" menggunakan Web Crypto API dan WebAuthn PRF Extension.

**Langkah 1: Buat file `web/src/lib/biometricUnlock.ts**`
Buat modul baru ini untuk menangani enkripsi/dekripsi lokal menggunakan PRF.

```typescript
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

// Salt statis untuk PRF (harus sama persis setiap kali diminta). 
// Dalam skenario nyata, salt ini bisa di-generate unik per user dan disimpan di localStorage (tidak rahasia).
const PRF_SALT = new TextEncoder().encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_12345678"); // Harus 32 bytes

// Helper: WebCrypto AES-GCM
async function encryptData(text: string, keyBuffer: ArrayBuffer): Promise<{ ciphertext: string, iv: string }> {
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { 
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))), 
    iv: btoa(String.fromCharCode(...iv)) 
  };
}

async function decryptData(ciphertextB64: string, ivB64: string, keyBuffer: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const encrypted = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

// 1. SETUP (Dipanggil saat user mengaktifkan Biometric di Settings)
// Meminta otentikator untuk membuat kredensial baru dengan dukungan PRF, 
// lalu mengenkripsi Recovery Phrase dengan kunci dari PRF tersebut.
export async function setupBiometricUnlock(options: any, recoveryPhrase: string): Promise<boolean> {
  try {
    // Inject PRF extension ke options dari server
    const authOptions = {
      ...options,
      extensions: { prf: { eval: { first: PRF_SALT } } }
    };

    const attResp = await startRegistration(authOptions);
    
    // Ambil kunci rahasia yang dihasilkan oleh hardware sidik jari (PRF)
    const prfResults = (attResp.clientExtensionResults as any)?.prf;
    if (!prfResults || !prfResults.results || !prfResults.results.first) {
        throw new Error("Device does not support WebAuthn PRF extension for local unlock.");
    }
    
    const symmetricKey = new Uint8Array(prfResults.results.first).buffer;
    
    // Enkripsi recovery phrase menggunakan kunci dari sidik jari
    const { ciphertext, iv } = await encryptData(recoveryPhrase, symmetricKey);
    
    // Simpan hasil enkripsi ke localStorage (Aman karena hanya bisa dibuka dengan sidik jari user)
    localStorage.setItem('nyx_bio_vault', JSON.stringify({ ciphertext, iv }));
    return true;
  } catch (err) {
    console.error("PRF Setup Error:", err);
    throw err;
  }
}

// 2. UNLOCK (Dipanggil di halaman Login)
export async function unlockWithBiometric(options: any): Promise<string> {
  const vaultStr = localStorage.getItem('nyx_bio_vault');
  if (!vaultStr) throw new Error("No biometric vault found on this device.");
  const vault = JSON.parse(vaultStr);

  const authOptions = {
    ...options,
    extensions: { prf: { eval: { first: PRF_SALT } } }
  };

  const asseResp = await startAuthentication(authOptions);
  
  const prfResults = (asseResp.clientExtensionResults as any)?.prf;
  if (!prfResults || !prfResults.results || !prfResults.results.first) {
      throw new Error("Failed to extract PRF key from authenticator.");
  }

  const symmetricKey = new Uint8Array(prfResults.results.first).buffer;
  
  // Dekripsi phrase menggunakan kunci yang baru saja dibuat ulang oleh sidik jari
  const recoveryPhrase = await decryptData(vault.ciphertext, vault.iv, symmetricKey);
  return recoveryPhrase;
}

```

**Langkah 2: Integrasikan ke `web/src/pages/SettingsPage.tsx` (Proses Setup)**
Di fungsi `handleRegisterPasskey`, setelah `startRegistration` sukses dan diverifikasi oleh server (atau sebagai langkah paralel/modifikasi dari `startRegistration` bawaan):

1. Import `setupBiometricUnlock`.
2. Ubah alur agar menggunakan `setupBiometricUnlock(options, userRecoveryPhrase)` alih-alih `startRegistration` biasa. *(Catatan untuk AI: Asumsikan Anda bisa mengambil recovery phrase user dari state/keychain saat setup ini, atau buat prompt konfirmasi yang meminta user memasukkan phrase mereka sekali saja untuk digembok).*

**Langkah 3: Integrasikan ke `web/src/pages/Login.tsx` (Proses Unlock)**

1. Cek apakah `localStorage.getItem('nyx_bio_vault')` ada.
2. Jika ada, tampilkan tombol besar: **"Unlock with Fingerprint / FaceID"**.
3. Saat diklik, panggil API `/api/auth/webauthn/login/options` untuk mendapatkan options, lalu panggil `unlockWithBiometric(options)`.
4. Jika berhasil mendeskripsi, nilai yang dikembalikan adalah `Recovery Phrase`.
5. Langsung gunakan `Recovery Phrase` tersebut untuk melakukan login/restore session secara otomatis tanpa user perlu mengetik apapun!

**Aturan Tambahan:**

* Tangani error dengan elegan (misal jika user membatalkan scan sidik jari, atau jika device tidak mendukung PRF, fallback ke input teks manual).
* Pastikan TypeScript `any` di-handle secukupnya agar build tidak gagal, karena tipe PRF di `@simplewebauthn` versi lama mungkin belum terdefinisi penuh di interface-nya.
