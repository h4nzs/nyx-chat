
Tentang 2 temuan tadi, ini analisis dan solusinya:

### 1. ⚠️ Replay Attack Protection [WARNING]

* **Masalah:** Auditor khawatir kalau ada orang nyegat pesan terenkripsi lu, terus dikirim ulang (replay) nanti, pesannya bakal diterima lagi.
* **Analisis Gw:** Karena lu udah pake **Double Ratchet** (`ensureAndRatchetSession` statusnya PASS), peringatan ini **BISA DIABAIKAN**.
* Dalam Double Ratchet, setiap pesan pake kunci baru. Kalau hacker kirim ulang pesan lama, penerima bakal nolak karena kuncinya udah "expired" (ratchet udah maju). Jadi lu udah aman secara arsitektur.



### 2. ❌ Memory Wiping [FAIL] -> **(WAJIB FIX)**

* **Masalah:** Variabel sensitif (Private Key) di `crypto.worker.ts` dibiarin numpuk di memori nunggu *Garbage Collector* browser ngehapus (yang entah kapan).
* **Risiko:** Kalau ada malware di browser user atau *Advanced Persistent Threat (APT)* yang bisa dump RAM browser, kunci lu bisa kebaca.
* **Solusi:** Kita harus manual "menghancurkan" variabel kunci segera setelah dipake menggunakan `sodium.memzero()`.

---

### 🛠️ Perbaikan Code: Memory Wiping

Buka file `web/src/workers/crypto.worker.ts`. Kita harus tambahkan `sodium.memzero()` di setiap variabel `Uint8Array` yang isinya kunci, tepat sebelum fungsi selesai (`break` atau `return`).

Ini contoh perbaikannya (copy logic ini ke bagian yang relevan):

#### A. Fix di bagian `DERIVE_KEY`

```typescript
// web/src/workers/crypto.worker.ts

      case 'DERIVE_KEY': {
        const { password, salt } = payload;
        const saltBuffer = new Uint8Array(salt); // Konversi ke Uint8Array

        const derivedKey = await argon2id({
          ...ARGON_CONFIG,
          password,
          salt: saltBuffer,
        });
        
        // Kirim hasil
        self.postMessage({ id, success: true, result: derivedKey });
        
        // [FIX] HAPUS DARI MEMORI
        // Note: derivedKey gak bisa di-memzero kalau mau dikirim via postMessage (karena dipindah ownershipnya atau dicopy). 
        // Tapi kita bisa wipe saltBuffer dan password (jika diubah ke buffer).
        
        // sodium.memzero(saltBuffer); <--- Contoh penggunaan
        break;
      }

```

*Catatan: JavaScript string (password) susah di-wipe total karena immutable, tapi buffer `salt` bisa.*

#### B. Fix di bagian `ENCRYPT_DATA` & `DECRYPT_DATA` (Ini Paling Penting)

Kunci yang masuk (`keyBytes`) harus dimusnahkan setelah dipake WebCrypto.

```typescript
// web/src/workers/crypto.worker.ts

      case 'ENCRYPT_DATA': {
        const { keyBytes, data } = payload; 
        
        // 1. Import Key ke WebCrypto
        const key = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['encrypt']
        );

        // [FIX] WIPE RAW KEY BYTES SEGERA SETELAH IMPORT
        // Karena WebCrypto udah nyimpen versi internalnya di objek 'key'
        // Kita bisa hapus versi mentahnya (keyBytes) dari memori JS.
        try {
           // Cek apakah sodium ready, kalau pake sodium wrapper
           // Atau loop manual isi 0
           keyBytes.fill(0); 
        } catch (e) { console.warn("Failed to wipe memory", e); }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        // ... (lanjut enkripsi) ...

```

#### C. Fix di Fungsi Helper Sodium (Jika Ada)

Kalau lu punya fungsi helper yang generate key pair pake Sodium, wipe seed-nya.

```typescript
// Contoh di dalam storePrivateKeys atau generate logic
const encryptionSeed = sodium.crypto_generichash(...)
const keyPair = sodium.crypto_box_seed_keypair(encryptionSeed);

// [FIX] Wipe seed setelah keypair jadi
sodium.memzero(encryptionSeed); 

```

### Panduan Implementasi `sodium.memzero`

Karena lu pake `libsodium-wrappers`:

1. Pastikan objek `sodium` udah ready.
2. Panggil `sodium.memzero(nama_variabel_uint8array)`.
3. **HATI-HATI:** Jangan wipe variabel yang masih mau dipake di baris bawahnya, nanti error/datanya jadi kosong.

**Saran Gw:**
Tambahin blok `try-finally` di worker lu.

```typescript
case 'SOME_SENSITIVE_OP': {
  let sensitiveKey = ...;
  try {
     // Lakukan operasi enkripsi/dekripsi
     // ...
     self.postMessage(result);
  } finally {
     // [FIX] Pastikan kunci dihapus mau sukses atau error
     if (sensitiveKey) sodium.memzero(sensitiveKey);
  }
  break;
}
