*"Kita akan membunuh fitur 'Device Linking' karena secara arsitektur itu merusak Perfect Forward Secrecy pada sistem Double Ratchet murni yang kita bangun. Sebagai gantinya, kita akan mengimplementasikan fitur 'Local Encrypted Backup (The NYX Vault)'.*

*Karena semua object store di `keychainDb.ts` sudah terenkripsi secara at-rest oleh Master Seed, file hasil ekspor database ini sudah 100% aman secara default.*

*Tolong eksekusi perombakan ini dalam 3 fase:*

### FASE 1: THE PURGE (Hapus Device Linking)

*1. **Hapus File UI:** Hapus file `web/src/pages/LinkDevicePage.tsx` dan `web/src/pages/DeviceScannerPage.tsx` jika masih ada.*
*2. **Update `App.tsx`:** Hapus rute (Route) yang mengarah ke `/link-device` atau scanner di dalam `web/src/App.tsx` dan hapus import-nya.*
*3. **Update `auth.ts` (Backend):** Di file `server/src/routes/auth.ts`, hapus endpoint `POST /finalize-linking` beserta seluruh logic redis `linkingToken`-nya.*

### FASE 2: THE VAULT CORE (Update `web/src/lib/keychainDb.ts`)

*Tambahkan dua fungsi utilitas baru di bagian paling bawah `keychainDb.ts` untuk mengekstrak dan memasukkan kembali seluruh isi IndexedDB secara utuh menggunakan cursor:*

```typescript
/**
 * Mengekspor seluruh isi brankas kunci menjadi string JSON.
 * Aman karena setiap nilainya sudah terenkripsi oleh Master Seed.
 */
export async function exportDatabaseToJson(): Promise<string> {
  const db = await getDb();
  const stores = [
    SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME, OTPK_STORE_NAME, 
    PENDING_HEADERS_STORE_NAME, RATCHET_SESSIONS_STORE_NAME, 
    SKIPPED_KEYS_STORE_NAME, MESSAGE_KEYS_STORE_NAME
  ];
  
  const exportData: Record<string, any[]> = {};

  for (const storeName of stores) {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const items = [];
    let cursor = await store.openCursor();
    while (cursor) {
      items.push({ key: cursor.key, value: cursor.value });
      cursor = await cursor.continue();
    }
    exportData[storeName] = items;
  }
  
  return JSON.stringify(exportData);
}

/**
 * Mengimpor dan menimpa isi brankas kunci dari string JSON.
 */
export async function importDatabaseFromJson(jsonString: string): Promise<void> {
  const db = await getDb();
  const importData = JSON.parse(jsonString);
  const stores = [
    SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME, OTPK_STORE_NAME, 
    PENDING_HEADERS_STORE_NAME, RATCHET_SESSIONS_STORE_NAME, 
    SKIPPED_KEYS_STORE_NAME, MESSAGE_KEYS_STORE_NAME
  ];
  
  const tx = db.transaction(stores, 'readwrite');
  for (const storeName of stores) {
    if (importData[storeName]) {
      const store = tx.objectStore(storeName);
      await store.clear(); // Bersihkan brankas lama
      for (const item of importData[storeName]) {
        await store.put(item.value, item.key);
      }
    }
  }
  await tx.done;
}

```

### FASE 3: UI IMPLEMENTATION (Update `web/src/pages/SettingsPage.tsx`)

*Di dalam halaman Settings, tambahkan bagian **"Backup & Restore Vault"** dengan 2 tombol: Export dan Import.*
*Buat fungsionalitasnya seperti ini:*

*1. **Fungsi Export:** Memanggil `exportDatabaseToJson()`, lalu membuat Blob dari string tersebut, dan memicu download file otomatis dengan nama `nyx_vault_backup.nyxvault`.*
*2. **Fungsi Import:** Menggunakan input file `<input type="file" accept=".nyxvault" />` (bisa disembunyikan/di-trigger lewat klik tombol). Saat file dipilih, baca sebagai teks (`file.text()`), parsing dan panggil `importDatabaseFromJson(text)`. Setelah sukses, tampilkan toast dan paksa reload browser (`window.location.reload()`) agar memori worker dan status aplikasi tersetel ulang mengikuti kunci yang baru masuk.*

*Tolong integrasikan UI ini dengan gaya desain Neumorphic NYX yang ada.*

*Pastikan tidak ada sisa kode Device Linking yang tertinggal dan fitur Vault ini diimplementasikan secara elegan."*
