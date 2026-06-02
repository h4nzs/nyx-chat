# plan

✦ Berikut adalah Laporan Analisis Mendalam dan Perencanaan Migrasi dari Dexie/IndexedDB ke PGlite + Drizzle ORM dengan tetap
  mempertahankan standar keamanan Zero-Knowledge (XChaCha20-Poly1305).

  ---

  🛡️ Nyx Unified Storage Migration Plan
  (Dexie IndexedDB ➔ PGlite PostgreSQL + Drizzle ORM)

  1. Pemetaan Skema (Schema Mapping)
  Kita akan memetakan 16 tabel Dexie ke dalam relasi PostgreSQL menggunakan Drizzle. Tantangan utama di sini adalah penanganan data
  biner (Uint8Array) yang sangat dominan pada keychain Signal Protocol.

  Strategi Tipe Data:
   - Primary Keys: Menggunakan text untuk ID berbasis string (ULID/UUID) dan serial atau integer untuk OTPK.
   - Binary Data (Keys/States): Kita akan menggunakan tipe bytea (Byte Array) di PostgreSQL. PGlite mendukung bytea secara native yang
     akan dipetakan ke Uint8Array di TypeScript melalui driver Drizzle.
   - JSON Objects: Kolom yang menyimpan objek kompleks (seperti repliedTo atau fileMeta) akan menggunakan tipe jsonb untuk pencarian
     yang lebih efisien di masa depan, atau text jika data tersebut terenkripsi (sebagai Base64).

  Contoh Pemetaan Tabel Utama:
  ┌─────────────┬───────────────────┬───────────────────────────────────────────────────────────┬────────────────────────────┐
  │ Tabel Dexie │ Tabel Drizzle     │ Kolom Kunci & Tipe Data                                   │ Indeks Tambahan            │
  │             │ (Postgres)        │                                                           │                            │
  ├─────────────┼───────────────────┼───────────────────────────────────────────────────────────┼────────────────────────────┤
  │ messages    │ messages          │ id (text PK), conversation_id (text), content (bytea/text │ Index di (conversation_id, │
  │             │                   │ - terenkripsi), created_at (timestamp)                    │ created_at)                │
  │ sessionKeys │ session_keys      │ storage_key (text PK), key (bytea)                        │ Index di conversation_id   │
  │ preKeys     │ one_time_pre_keys │ key_id (integer PK), private_key (bytea)                  │ -                          │
  │ kvStore     │ key_value_store   │ key (text PK), value (jsonb)                              │ -                          │
  └─────────────┴───────────────────┴───────────────────────────────────────────────────────────┴────────────────────────────┘
  ---

  2. Strategi AEAD Interceptor (Repository Layer)
  Saat ini, enkripsi dilakukan secara manual di dalam shadowVaultDb.ts. Untuk menjaga kode tetap bersih (clean code) dan type-safe,
  kita akan memperkenalkan lapisan Repositories.

  Struktur Folder:

   1 web/src/lib/db/
   2 ├── schema.ts          # Definisi Drizzle Schema (Postgres tables)
   3 ├── index.ts           # Inisialisasi PGlite & Drizzle Instance
   4 └── repositories/      # Lapisan Abstraksi dengan Auto-Encryption
   5     ├── message.repo.ts
   6     ├── keychain.repo.ts
   7     └── kv.repo.ts

  Konsep Interceptor:
  Setiap Repository akan membungkus pemanggilan Drizzle.
   - Insert/Update: Fungsi akan menerima objek plain, melakukan libsodium.crypto_aead_xchacha20poly1305_ietf_encrypt pada kolom
     sensitif, lalu mengirimkan ciphertext ke Drizzle.
   - Select: Fungsi akan mengambil ciphertext dari DB, melakukan dekripsi otomatis, lalu mengembalikan objek plain ke Store.
   - Strict Typing: Kita akan menggunakan z.infer dari Zod untuk memastikan kontrak data antara Database (Encrypted) dan Application
     (Decrypted) tetap sinkron.

  ---

  3. Strategi Inisialisasi LSK (Local Storage Key)
  Konsep Zero-Knowledge mengharuskan LSK tidak pernah menyentuh disk dalam bentuk plain-text.

  Alur Injeksi Kunci:
   1. Unlock: Pengguna memasukkan password di Modal.
   2. Derivasi: Argon2id dijalankan di RAM untuk menghasilkan MasterSeed. Dari sini, kita turunkan Local Storage Key (LSK) menggunakan
      libsodium.crypto_generichash.
   3. Injeksi: LSK disimpan dalam closure privat di dalam DatabaseProvider atau RepositoryManager.
   4. Akses: Store tidak boleh memanggil db langsung, melainkan harus melalui useRepositories() yang sudah terinjeksi LSK. Jika LSK
      kosong (aplikasi terkunci), repository akan melempar error VaultLockedException.

  ---

  4. Dampak Refactoring (Blast Radius)

  Store yang Terpengaruh:
   1. auth.ts: Perubahan besar pada logika bootstrap dan login karena inisialisasi PGlite (khususnya OPFS) bersifat asinkron dan butuh
      penanganan state "Database Ready".
   2. message.ts & conversation.ts: Semua pemanggilan .where().toArray() atau .put() milik Dexie harus diganti ke sintaks Drizzle
      (misal: db.select().from(messages).where(eq(...))).
   3. shadowVaultDb.ts & keychainDb.ts: File-file ini kemungkinan akan dihapus sepenuhnya dan logikanya dipindahkan ke dalam
      Repositories baru.

  Pertimbangan Web Worker vs Main Thread:
   - PGlite di Main Thread: Lebih mudah diimplementasikan dan di-debug. Drizzle bisa langsung berjalan tanpa proxy pesan.
   - PGlite di Web Worker: Direkomendasikan untuk Nyx. 
       - Pro: Operasi SQL berat dan proses dekripsi ribuan pesan tidak akan membuat animasi UI stuttering (jank).
       - Contra: Membutuhkan lapisan Proxy/Bridge untuk komunikasi postMessage.
   - Keputusan: Saya menyarankan penggunaan Web Worker karena beban kriptografi libsodium digabung dengan PostgreSQL akan cukup berat
     untuk Main Thread perangkat mobile.

  ---

  🚀 Tantangan Khusus & Mitigasi
   - Serialisasi Uint8Array: PostgreSQL bytea akan dikembalikan sebagai Uint8Array oleh PGlite, namun saat dikirim melalui postMessage
     (jika pakai Worker), ia akan di-structured clone. Kita harus memastikan tidak ada konversi ke Array biasa yang merusak performa.
   - Migration Script: Karena ini migrasi destruktif, kita perlu memastikan fungsi nuclearWipe() benar-benar menghapus file
     SQLite/PGlite di OPFS agar tidak terjadi korupsi skema saat update aplikasi.

-----

## fase 1 dan 2 done

Tugas: Rencana arsitektur disetujui. Eksekusi Fase 1 (Drizzle Schema) dan Fase 2 (PGlite Web Worker & AEAD Repositories) untuk migrasi Nyx Chat.

Langkah Eksekusi:

1. Setup Dependensi & Pembersihan
- Install `@electric-sql/pglite`, `drizzle-orm`, dan `drizzle-kit`.
- Hapus Dexie dari dependencies (`pnpm remove dexie`).
- Pastikan `vite.config.ts` bersih dari header COOP/COEP dan SSL lokal eksperimental yang sebelumnya merusak environment.

2. Buat Drizzle Schema (`web/src/lib/db/schema.ts`)
- Petakan 16 tabel dari arsitektur lama.
- Gunakan tipe `text` untuk Primary Keys (id), `timestamp` untuk tanggal.
- Gunakan tipe `bytea` untuk properti kriptografi murni (seperti `key`, `encryptedPrivateKey`, `state` dari Double Ratchet).
- Gunakan tipe `bytea` (atau `text`) untuk kolom yang akan dienkripsi oleh AEAD (seperti `messages.content`, `messages.repliedTo`).
- Definisikan indeks (indexes) pada skema Drizzle (misalnya index pada `conversation_id` dan `created_at` di tabel messages).

3. Setup PGlite Web Worker (`web/src/workers/pglite.worker.ts`)
- Buat Web Worker yang menginisialisasi `new PGlite('opfs://nyx-chat-pg')` dan `drizzle(pg, { schema })`.
- Buat mekanisme routing RPC (postMessage) untuk menerima instruksi query dari UI.
- Saat inisialisasi, sisipkan perintah destruktif: `indexedDB.deleteDatabase('NyxUnifiedDB')` untuk menghapus sisa Dexie.

4. Setup AEAD Repository Layer (`web/src/lib/db/repositories/*.ts`)
- Buat layer abstraksi (misal `MessageRepository`, `KeyRepository`) yang berjalan di Main Thread.
- Repository ini harus menampung LSK (Local Storage Key) di memori.
- Interceptor Mutlak: Saat fungsi `repo.insertMessage(data)` dipanggil, fungsi ini WAJIB mengenkripsi kolom sensitif (`content`, `repliedTo`, dll) dengan `libsodium` menggunakan LSK SEBELUM mengirim payload-nya via postMessage ke Worker.
- Saat fungsi `repo.getMessages(...)` dipanggil, ia menerima deretan `bytea`/`Uint8Array` dari Worker, lalu mendekripsinya secara otomatis sebelum mengembalikan `Promise<DecryptedMessageRecord[]>` ke caller (Zustand store).

Kewajiban Mutlak:
- Gunakan tipe data native `Uint8Array` untuk komunikasi `bytea` antar Worker dan Main Thread. JANGAN konversi menjadi array of numbers (`number[]`) agar terhindar dari OOM memory leak.
- Strict Typing TypeScript (NO `any`).
- Setelah pembuatan struktur selesai, jalankan `tsc --noEmit` di `/web` untuk memastikan Drizzle schema dan tipe repository sinkron.

---

## fase 3 done

Tugas: Eksekusi Fase 3 - Migrasi Lapisan Otentikasi (Auth) dan Manajemen Kunci (Keychain) ke arsitektur PGlite Repositories.

Konteks: Fase 1 dan 2 sukses. Namun aplikasi saat ini error karena store masih mengimpor Dexie lama (keyStorage.ts, auth.ts, keychain.ts, keychainDb.ts). Kita harus memutus rantai Dexie ini dan menyambungkannya ke Lapisan Repository baru.

Lakukan modifikasi presisi pada file-file berikut:

1. Injeksi LSK & Pembersihan (web/src/lib/keyStorage.ts)
- Hapus semua import terkait `db` Dexie lama atau `keychainDb.ts`.
- Impor `DatabaseManager` dan fungsi utilitas LSK (seperti `deriveLSK`) dari struktur repositori baru.
- Pada fungsi `saveDeviceAutoUnlockKey` (atau fungsi unlock), setelah LSK berhasil diturunkan (derived) dari password/PIN, panggil `DatabaseManager.setLSK(lsk)`. LSK ini HARUS berwujud Uint8Array.
- Pada fungsi `clearKeys`, panggil `DatabaseManager.clearLSK()` untuk memastikan memori RAM dibersihkan saat pengguna logout.

2. Refactor Keychain & KeyStorage (web/src/lib/keychainDb.ts)
- File ini kemungkinan besar menjadi pusat error karena berisi logika Dexie lama.
- Rombak isi file ini. Hapus semua pemanggilan Dexie.
- Ganti fungsi-fungsinya agar memanggil metode yang bersesuaian dari `KeychainRepository` (atau repository terkait) yang baru saja kamu buat di Fase 2. Jaga agar interface kembalian fungsi-fungsinya tetap sama dengan versi aslinya, sehingga store lain yang belum dimigrasi tidak hancur total.

3. Penanganan "Ghost Device" & Race Condition (web/src/store/auth.ts)
- Buka `web/src/store/auth.ts`. Sesuaikan pemanggilan pengambilan kunci agar menggunakan `KeychainRepository` baru.
- Penanganan Ghost Device: Di dalam `retrieveAndCacheKeys`, setelah mendapatkan userId, coba ambil Identity Key dari lokal. JIKA kunci tidak ditemukan (`!identityKey`), ini berarti storage OPFS baru saja di-reset sementara session token masih hidup.
  Lakukan tindakan ini: panggil fungsi `useAuthStore.getState().logout(true)`, hapus auth tokens dari localStorage/sessionStorage, lalu lemparkan error eksplisit: `throw new Error('LOCAL_KEYS_WIPED: Local encryption keys are permanently lost due to storage reset. You have been logged out.');`
- Race Condition Password Prompt: Cegah aplikasi memanggil modal password ganda secara bersamaan.
  Buat variabel let di luar scope store: `let activePasswordPromptPromise: Promise<string> | null = null;`
  Di dalam blok fungsi `promptForPassword`, cek jika `activePasswordPromptPromise` sudah ada, maka langsung `return activePasswordPromptPromise;`. Jika belum, buat Promise baru, simpan ke variabel tersebut, dan setel ulang menjadi `null` di dalam blok `finally`.

4. Migrasi Zustand Keychain (web/src/store/keychain.ts)
- Ubah semua pengambilan/penyimpanan kunci (Session Keys, Group Keys) di store ini agar menggunakan PGlite Repositories.

Kewajiban Mutlak:
- WAJIB Typescript Strict Mode. NO `any`.
- Pastikan kamu mengekstrak nilai kembalian repository dengan tipe yang benar (terutama konversi objek kunci yang dibutuhkan oleh store).
- Eksekusi `tsc --noEmit` di `/web`. Pastikan tidak ada error tipe data yang tersisa di `auth.ts`, `keychain.ts`, maupun `keyStorage.ts` sebelum memberikan laporan selesai.

---

## fase 4 ongoing

Tugas: Eksekusi Fase 4 - Migrasi Core Messaging, Offline Queue, mitigasi Pencarian Pesan Terenkripsi (Zero-Knowledge Search), dan verifikasi Burner Chat.

Konteks: Fase 3 berhasil. Sekarang kita harus memigrasikan penyimpanan pesan dan antrean offline ke PGlite, serta menghapus "dummy getter" pada fitur pencarian yang dapat memicu OOM (Out of Memory).

Lakukan eksekusi presisi pada tugas-tugas berikut:

1. Bangun Pipa Pencarian Terukur (web/src/lib/db/repositories/message.repo.ts)
- Hapus "dummy getter" yang tidak aman untuk memori.
- Karena `content` terenkripsi dan PGlite tidak bisa melakukan `ILIKE`, buat fungsi `searchMessagesDecrypted(query: string, limit: number)`.
- Algoritma: Lakukan query `SELECT` pesan secara chunking/batch (misal: 100 pesan per query diurutkan dari yang terbaru). Dekripsi batch tersebut menggunakan LSK di memori, lalu filter berdasarkan `query` string. Jika hasil filter belum mencapai `limit`, fetch batch 100 berikutnya. Ini mencegah penarikan 10.000 pesan secara simultan ke RAM.

2. Migrasi Offline Queue (web/src/lib/offlineQueueDb.ts -> web/src/lib/db/repositories/queue.repo.ts)
- Migrasikan `offlineQueueDb.ts` agar menggunakan PGlite via `QueueRepository`.
- Pastikan kolom `data` (yang berisi payload pesan yang gagal terkirim) juga **WAJIB dienkripsi** sebelum masuk ke PGlite, karena itu berisi metadata sensitif yang sedang menunggu koneksi internet.

3. Refactor Message & Conversation Store (web/src/store/message.ts & conversation.ts)
- Rombak kedua store ini agar sepenuhnya menggunakan `MessageRepository` dan `QueueRepository` dari arsitektur PGlite baru.
- Hapus semua pemanggilan Dexie, termasuk fungsi-fungsi lama dari `shadowVaultDb.ts`.

4. Verifikasi Integrasi Burner Chat (web/src/store/burner.ts)
- Periksa `burner.ts`. Pada diskusi kita sebelumnya, kita telah memperbaiki alur KEM ciphertext (`ct`) dan masalah wrapper socket.
- Pastikan bahwa penyimpanan sesi ephemeral `pqDrSessions` kini secara eksklusif menggunakan PGlite Repository, bukan IndexedDB. Burner state harus tetap tersinkronisasi tanpa error.

5. Tech Debt Eradication
- Hapus file `web/src/lib/shadowVaultDb.ts`, `web/src/lib/keychainDb.ts`, dan file Dexie lama lainnya yang kini 100% usang untuk menjaga codebase tetap bersih.

Kewajiban Mutlak:
- WAJIB Typescript Strict Mode.
- Pastikan tipe kembalian Promise antara Repository dan Store benar-benar sinkron (terutama untuk objek bersarang seperti `repliedTo` yang mungkin perlu di-JSON.parse setelah didekripsi).
- Eksekusi `tsc --noEmit` di `/web`. Selesaikan semua error typing akibat penghapusan file lama sebelum menyelesaikan tugas ini.