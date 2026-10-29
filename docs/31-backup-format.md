# 31 — Format Backup Ber-frame (spesifikasi)

> **Status: FASE 1–5 SELESAI, jalur manual + R2 terjangkau UI.** Bentuk byte
> arsip: `web/src/lib/backupFormat.ts`
> (13 test kripto). Pengaitan payload Keychain: `web/src/lib/backupPayload.ts`
> (12 test kripto) — §31.6a. Transport `.nyxbak` manual + R2:
> `web/src/lib/backupTransport.ts` dan `/api/backup/*` (10 + 11 test), plus
> tombol Buat/Ambil di Settings (`BackupExportModal`) dan penghapusan objek awan
> saat wipe — §31.6b.
> Orkestrasi restore perangkat pengganti lewat `migration:*`:
> `web/src/lib/backupRestore.ts` (10 test) — §31.6c. Harness benchmark 10k
> pesan: `web/src/lib/backupBench.ts` — §31.6d (angka terukur, bukan asumsi).
>
> Konteks: `docs/29` §5.3 (celah backup), `docs/30` §30.7 (WS-C) dan §30.6/§30.18
> (multi-device dibatalkan → backup adalah satu-satunya jalur pemulihan selain
> recovery phrase, untuk **perangkat pengganti**).

---

## 31.1 Mengapa ber-frame

Implementasi lama (`exportDatabaseToJson`/`importDatabaseFromJson` di
`web/src/lib/keychainDb.ts`) mengekspor **satu JSON besar** berisi semua tabel
vault. Tiga masalah yang ditutup format baru:

| Masalah | Akibat | Perlakuan di format baru |
|---|---|---|
| Ukuran total bocor | Jumlah pesan/kontak/grup terbaca dari panjang berkas | Setiap payload di-pad ke blok tetap (§31.3) |
| Tanpa integritas | Berkas terpotong/teracak masih "valid sebagian" | AEAD per frame + AAD yang mengikat `(type, index, count)` (§31.4) |
| Tanpa validasi bentuk | Versi/tata letak beda tidak terdeteksi sebelum data dipakai | Magic + `formatVersion` diverifikasi sebelum dekripsi (§31.2) |
| Puncak memori | `JSON.parse` seluruh vault | Parser berjalan per frame (§31.5) |

Referensi desain: `libsignal/rust/message-backup` (frame, padding, key.rs,
scramble) — yang diadopsi adalah **propertinya**, bukan tata letak byte-nya:
Signal memvalidasi `serialize(backup) == serialize(export(restoreFrom(backup)))`;
di NYX properti itu diuji sebagai *roundtrip byte-identik untuk payload*, dengan
nonce yang bisa disuntik pada test.

---

## 31.2 Tata letak arsip

Header (32 byte, offset absolut):

| Offset | Ukuran | Field | Nilai |
|---|---|---|---|
| 0 | 4 | `magic` | ASCII `NYXB` |
| 4 | 1 | `formatVersion` | `1` |
| 5 | 1 | `flags` | `0` (reserved) |
| 6 | 2 | `frameCount` | u16 BE, 1..65535 |
| 8 | 16 | `salt` | salt KDF (§31.3) |
| 24 | 8 | reserved | nol |

Frame (berurutan, tanpa padding antar-frame):

| Ukuran | Field | Catatan |
|---|---|---|
| 1 | `type` | `BackupFrameType` (1..7) |
| 4 | `index` | u32 BE, **wajib** 0,1,2,… (diperiksa parser) |
| 24 | `nonce` | XChaCha20-Poly1305, acak per frame |
| 4 | `ciphertextLength` | u32 BE, ≥ 16 (tag) |
| n | `ciphertext` | `payload ter-pad` + tag Poly1305 16 byte |

Arsip valid berakhir **tepat** di akhir frame terakhir; byte berlebih ditolak.

---

## 31.3 Kunci & padding

**KDF.** `deriveBackupKey(recoveryPhrase, salt)` = Argon2id atas
`recoveryPhrase.normalize('NFKD')`, output 32 byte, parameter identik
`ARGON_VAULT_CONFIG` (`workers/crypto.worker.ts`):

```
memorySize = 131072 KiB (128 MB), iterations = 4, parallelism = 1, hashLength = 32
```

Angka-angka itu dipin oleh test (`BACKUP_KDF_PARAMS`), karena menurunkannya
menambah beban perangkat kelas bawah, dan menaikkannya membuat backup lama tidak
bisa dibuka dengan asumsi lama (salt tetap disimpan di header, jadi perubahan
parameter **tetap** harus disertai kenaikan `formatVersion`).

**Padding.** Sebelum dienkripsi, payload menjadi:

```
[panjang asli u32 BE][payload][nol sampai kelipatan 1024 byte]
```

Panjang asli disimpan **di dalam** plaintext, jadi tanpa kunci tidak ada yang
bisa membedakan payload 10 byte dari 1000 byte — keduanya menghasilkan frame
berukuran sama (diuji). Padding yang tidak nol setelah dekripsi = pelanggaran
integritas (`Padding frame tidak nol`).

---

## 31.4 AAD (anti-tamper/reorder/truncate)

Setiap frame di-AEAD dengan AAD ASCII:

```
nyxb:v<formatVersion>:<type>:<index>:<frameCount>
```

Konsekuensinya, tanpa checksum terpisah:

- **tamper** 1 byte → tag gagal,
- **reorder** dua frame berukuran sama → `index` di frame tidak lagi cocok
  dengan urutan pembacaan **dan** AAD-nya berbeda → gagal,
- **truncate** (buang frame terakhir / potong byte) → `frameCount` tidak
  terpenuhi / panjang tidak konsisten → gagal,
- **kunci salah** → tag gagal (bukan menghasilkan data sampah).

---

## 31.5 API

```ts
// turunkan kunci dari recovery phrase + salt di header
const key = await deriveBackupKey(phrase, salt);

// bangun arsip (frames dalam urutan final)
const { bytes, salt } = buildBackupArchive({ frames, key, crypto });
// → header 32 byte + frame; salt acak 16 byte bila tidak diberikan

// baca header tanpa kunci (validasi tipe berkas + ambil salt)
const { frameCount, salt, formatVersion } = readBackupHeader(bytes);

// parse + verifikasi penuh (melempar BackupFormatError untuk semua kasus di §31.4)
const { frames } = parseBackupArchive(bytes, key, crypto);
```

`crypto` adalah `BackupCryptoBackend` (`randomBytes`, `aeadSeal`, `aeadOpen`).
Produksi menyuntikkan adapter dari instance sodium worker
(`libsodiumBackupCrypto(sodium)`), test menyuntikkan adapter yang sama dengan
libsodium-wrappers langsung — **satu implementasi**, jadi perilaku produksi dan
perilaku yang diuji tidak bisa menyimpang.

Catatan lingkungan: AAD dan magic dibangun dengan encoder ASCII internal, bukan
`TextEncoder`, karena di lingkungan jsdom/vitest `TextEncoder().encode()`
mengembalikan `Uint8Array` dari realm lain dan libsodium menolaknya
(`unsupported input type for additional_data`).

---

## 31.6a Fase 2 — pengaitan payload (selesai)

`web/src/lib/backupPayload.ts` memetakan tabel `NyxUnifiedDB` (versi 8) menjadi
frame `backupFormat`, dan kembali. Test di `backupPayload.test.ts` memakai kripto
sungguhan (libsodium + Argon2id + arsip ber-frame).

**Tabel → tipe frame** (`BACKUP_TABLE_FRAME_TYPE`, 20 tabel). Tipe yang dipakai:
`Account` (identitas + sesi kripto: `identityKeys`, `preKeys`, `sessionKeys`,
`ratchetSessions`, `pqDrSessionsV2`), `Contacts` (`contacts`), `Conversation`
(`conversations`, `groupKeys`, `groupSenderStates`, `groupReceiverStates`,
`groupSkippedKeys`, `groupCachedParticipants`), `Message` (`messages`,
`messageKeys`, `skippedKeys`, `pendingHeaders`, `offlineQueue`), `Story`
(`storyKeys`), `Settings` (`kvStore`, `profileCache`). `Tombstone` dicadangkan
(placeholder), belum diproduksi.

**Bentuk payload.** Satu frame = satu *chunk*: `{ table, records: [...] }` dalam
JSON. Catatan di-`encodeBackupValue` rekursif lebih dulu, sehingga `Uint8Array`,
`ArrayBuffer`, semua `ArrayBufferView`, dan `Date` bertahan lewat penanda
`__type` (kompatibel dengan ekspor JSON lama). Tipe tak terdukung
(function/symbol/bigint) **ditolak**, bukan dibuang diam-diam — backup yang
"berhasil" tapi kehilangan field adalah bug yang baru terlihat saat restore.

**Yang sengaja TIDAK dilakukan:** nilai at-rest (`ENC1:`) **tidak** didekripsi.
Backup memuat ciphertext apa adanya; `masterSeed` berasal dari recovery phrase
yang sama, jadi nilainya tetap terbaca di perangkat pengganti tanpa membuat
backup bergantung pada state hidup.

**Determinisme & chunking.**

- Tabel diproses dalam `BACKUP_TABLE_ORDER` yang tetap; catatan diurutkan
  berdasarkan kunci primer (`BACKUP_TABLE_KEY_PATH`). Urutan masukan tidak
  memengaruhi hasil (diuji).
- Bila JSON satu tabel melewati `chunkBytes` (default 256 KB), frame baru
  dimulai — puncak memori per frame terbatas dan `frameCount` tetap di bawah
  batas u16 selama kapasitas ≈ 16 GB. Melebihi `BACKUP_MAX_FRAMES` = error
  eksplisit, bukan pemotongan senyap.
- `scramble` (opsional, butuh kunci): permutasi Fisher–Yates deterministik
  ber-seed kunci+jumlah frame, sehingga frame bertipe sama tidak tersusun
  menurut struktur sosial, sementara ekspor ulang dari state hasil restore tetap
  byte-identik (diuji).

**Batasan yang jujur:** `frameCount` ada di header **plaintext**, jadi jumlah
total frame tetap terlihat dari berkas; yang disembunyikan scramble hanyalah
pengelompokan (frame bertipe sama yang berdampingan). Menyembunyikan jumlah frame
mengubah tata letak format → wajib naikkan `formatVersion`.

**Validasi keras yang diuji:** tabel tak dikenal (saat membangun & saat membaca),
tipe frame yang tidak cocok dengan tabel, payload bukan JSON, penanda nilai tak
dikenal, tipe nilai tak didukung, dan arsip tanpa catatan.

> Catatan realm: `encodeBackupValue` memakai `ArrayBuffer.isView`, **bukan**
> `value instanceof Uint8Array`. Di lingkungan jsdom/vitest typed array bisa
> berasal dari realm lain, dan `instanceof` gagal di sana sehingga nilai biner
> salah dikodekan menjadi objek berkunci angka `{0:..,1:..}` — bug nyata yang
> tertangkap oleh test ini, sejalan dengan alasan encoder UTF-8 di §31.5.

---

## 31.6b Fase 3 — transport `.nyxbak` (selesai)

**Jalur manual (selalu tersedia, tanpa server).** `web/src/lib/backupTransport.ts`:
`startBackupFileDownload` mengunduh byte arsip sebagai `nyx-backup-<UTC>.nyxbak`,
`readBackupFile` membaca berkas pilihan pengguna dan **memvalidasi header**
(magic/versi/panjang) sebelum data menyentuh kunci. Berkas asing/terpotong
ditolak lebih awal.

**Pintu masuk UI (2026-10-16).** Sebelum ini fungsi-fungsi tersebut punya **nol
pemanggil**: arsip hanya lahir dari alur QR (`MigrationSendPage`, kunci acak yang
di-seal ke penerima), sehingga jalur berkas ber-kunci-phrase tidak punya sumber
berkas sama sekali. Sekarang dua tombol di modul Data → Settings menutupnya:

| Komponen | Peran |
|---|---|
| `web/src/components/BackupExportModal.tsx` (tombol “Encrypted Backup (.nyxbak)”) | Ambil recovery phrase (auto-unlock key, atau prompt password) → salt acak 16 byte → `deriveBackupKey(normalizeBackupPhrase(phrase), salt)` → `createFramedBackup({ …, salt })` (salt yang sama ditulis di header) → `startBackupFileDownload`. Opsional: unggah byte yang **sama** via `uploadBackupToCloud` |
| `BackupRestoreModal` (tombol “Restore from .nyxbak File”) | Dua sumber: berkas pilihan pengguna **atau** `downloadCloudBackup()` (404 dibedakan sebagai “tidak ada backup awan”). Keduanya masuk jalur `openFramedBackupWithPhrase` yang sama |

`normalizeBackupPhrase` (`trim` + `lowercase`, satu implementasi di
`backupRestore.ts`) dipakai jalur export **dan** restore, jadi arsip yang dibuat
di satu tempat tidak bisa gagal dibuka karena beda aturan normalisasi.

**Hapus saat akun dihapus.** `DELETE /api/users/me` (langkah 1b di
`server/src/routes/users.ts`) menurunkan kunci objek lewat
`deriveBackupObjectKey(env.backupKeySecret, userId)` lalu menghapusnya. Ini tidak
opsional: kunci objek sengaja **tidak** memuat userId, jadi filter lampiran
berbasis prefix `${userId}-` tidak pernah bisa menyapunya.

**Hapus saat wipe.** `executeLocalWipe` memanggil `deleteCloudBackup()` **sebelum**
`/api/auth/logout-all` (endpoint `DELETE` butuh sesi hidup; setelah logout objek di
R2 tidak bisa dihapus lagi). Kegagalannya best-effort dan tidak menghentikan wipe
lokal. Dikunci oleh `web/src/lib/__tests__/nukeCloudBackup.test.ts` (urutan +
“gagal hapus tetap lanjut”).

**Jalur R2 (opsional).** Endpoint di `server/src/routes/backup.ts`:

| Metode | Path | Peran |
|---|---|---|
| `POST` | `/api/backup/presign` | URL PUT presigned; body `{ size, urlTtl? }`; `uploadLimiter` (20/jam) |
| `POST` | `/api/backup/download-url` | URL GET presigned untuk restore; `generalLimiter` |
| `DELETE` | `/api/backup` | Hapus objek backup akun — dipanggil `executeLocalWipe` sebelum `logout-all` (bagian alur nuke) |

**Kunci objek tanpa userId.** `deriveBackupObjectKey(secret, userId)` =
`backups/<HMAC-SHA256(secret, "nyx:backup:<userId>")>.nyxbak` (64 hex).
Propertinya: deterministik tanpa state, tidak memuat userId, dan tanpa rahasia
server kunci tidak bisa diturunkan dari userId yang bocor. Karena deterministik,
satu akun = satu objek (unggah berikutnya menimpa) — **tidak ada tabel DB baru**
dan tidak ada riwayat backup menumpuk.

**Rahasia.** `BACKUP_KEY_SECRET` (fallback `JWT_SECRET` dengan peringatan
startup). Konsekuensi rotasi dicatat di `docs/10` dan `.env.example`: mengganti
rahasia membuat backup awan lama tak bisa ditemukan lagi (objek lama tetap ada).
Produksi sebaiknya menyetel nilai independen yang stabil.

**Kuota per akun.** `BACKUP_FREE_MAX_BYTES` = 100 MB, `BACKUP_SUBSCRIBER_MAX_BYTES`
= 500 MB (`server/src/utils/backupObject.ts`). TTL presigned dijepit ke 30–900 detik
(default 300). Gate verifikasi akun sama dengan `/api/uploads/presigned`
(sandbox tidak boleh menyimpan blob).

**Metrik.** `nyx_backup_ops_total{op,result}` (presign/download/delete) — hanya
hitungan event, tanpa identitas (aturan WS-G).

**Verifikasi.** `server/tests/backupObject.test.ts` (10 test: determinisme kunci,
tanpa kebocoran userId, kuota per tier, penjepitan TTL, matriks validasi) +
`web/src/lib/__tests__/backupTransport.test.ts` (11 test dengan `api` di-stub tapi
validasi header sungguhan: tolak magic salah/berkas pendek, endpoint & body benar,
PUT byte identik, presign gagal → PUT tidak jalan, 404 → `ApiError(404)`).

**Batasan yang jujur (jangan diklaim lebih):**

- Kuota ditegakkan terhadap `size` yang **diklaim klien**, sama seperti jalur
  upload lampiran; penegakan keras harus lewat kebijakan bucket/lifecycle R2.
- Bucket R2 dipakai bersama. Agar objek backup benar-benar privat, operator harus
  memastikan prefix `backups/` tidak disajikan domain publik R2 (atau memakai
  bucket terpisah) — lihat `docs/10`.
- Belum ada endpoint cek-kebenaran (`HEAD`); UI restore memakai `download-url`
  + 404 sebagai sinyal "tidak ada backup" (sudah dipakai, lihat tombol "Ambil
  dari awan").
- Presigned PUT tidak membatasi ukuran objek; klien yang nakal bisa mengunggah
  lebih besar dari kuota. Isinya tetap opaque, tetapi ini bisa ditegakkan di
  bucket policy.

---

## 31.6c Fase 4 — restore perangkat pengganti via `migration:*` (selesai)

`web/src/lib/backupRestore.ts` menyambungkan tiga lapisan tanpa menduplikasi
logika mana pun:

| Fungsi | Peran |
|---|---|
| `readTablesFromDexie` / `writeTablesToDexie` | Adapter Dexie: baca tabel; tulis dalam **satu transaksi** `rw` `clear()` → `bulkPut()` |
| `liveBackupStore()` | Store produksi; `./db` diimpor **dinamis**, jadi modul ini tidak meng-instansiasi Dexie di lingkungan test |
| `createFramedBackup` | Baca tabel → `buildBackupFrames` → `buildBackupArchive`; laporan `{ size, frameCount, records, tables }` |
| `restoreFramedBackup` | `readBackupHeader` → `parseBackupArchive` → dekode **per frame** (`readBackupChunk`, progres `done/total`) → tulis |
| `openFramedBackupWithPhrase` | Jalur berkas manual: salt dari header → `deriveBackupKey(phrase)` → restore |
| `formatBackupSize` / `averageFrameBytes` | Laporan ukuran untuk UI |

**Dua jalur kunci, bentuk byte identik.** Arsip ber-frame tidak menentukan asal
kunci — itu keputusan pemanggil:

| Jalur | Kunci | Butuh phrase di perangkat lama? |
|---|---|---|
| `migration:*` (transfer langsung) | acak 32 byte, diseal `pq_box_seal_v2` (X-Wing, magic `NYS2`) ke kunci publik penerima (QR); QR v1 tanpa `pqPubKey` ditolak | tidak |
| berkas `.nyxbak` | `deriveBackupKey(recoveryPhrase, salt)` | ya (di perangkat pengganti saat restore) |

**Wiring UI.** `MigrationSendPage` membangun arsip pada tahap prefetch (socket
sudah dibekukan agar state ratchet tidak bergerak), mengirim `migration:start`
dengan `sealedKey`, lalu `migration:chunk` per 500 KB **sebagai base64**.
Perbaikan penting: transport men-serialize payload dengan `JSON.stringify`, jadi
`ArrayBuffer` yang dikirim apa adanya menjadi `{}` — chunk penerima yang
mengharapkan base64 tidak akan pernah cocok. Sekarang chunk dikodekan
`sodium.to_base64` sebelum dikirim. `MigrationReceivePage` merakit ulang chunk,
membuka `sealedKey` dengan private key perangkat, lalu memanggil
`restoreFramedBackup` dengan progres 0–100 % **per frame**.

**Validasi yang diuji** (`web/src/lib/__tests__/backupRestore.test.ts`, 10 test,
kripto sungguhan): roundtrip biner/`Date`/nilai `ENC1:` apa adanya; progres per
frame (jumlah panggilan = `frameCount`, monotonik); kunci salah ditolak
**sebelum** `writeTables`; arsip kosong ditolak; phrase salah ditolak; adapter
Dexie (clear-sebelum-bulkPut, tabel yang tidak ada di arsip tidak disentuh, satu
transaksi); format ukuran.

**Batasan yang jujur:**

- Backup awan bersifat **opt-in**: kotak centang di modal Buat (default mati),
  karena akun sandbox ditolak 403 di `/api/backup/presign`. Berkas lokal selalu
  dibuat lebih dulu — kegagalan unggah tidak pernah membatalkan backup yang sah.
- `restoreFramedBackup` masih memuat semua frame hasil `parseBackupArchive` dan
  catatan hasil dekode di memori sebelum menulis (penulisan harus satu
  transaksi). Manfaat streaming format karena itu belum penuh; pengukuran puncak
  memori adalah fase 5.
- Penulisan hanya menyentuh tabel yang **hadir** di arsip; data lokal yang tidak
  ada di arsip tidak dihapus (lebih aman daripada wipe-sebelum-restore, tapi
  bukan "bersihkan semua").
- **Jalur berkas manual** (pemilih berkas + prompt recovery phrase) sudah
  dipasang: `web/src/components/BackupRestoreModal.tsx`, dibuka dari tombol
  "Restore from .nyxbak File" di modul Data → Settings (sumbernya berkas
  `.nyxbak` dari tombol "Encrypted Backup (.nyxbak)" atau salinan awan).
  Alurnya: `readBackupFile`
  (validasi header **sebelum** phrase disentuh) → `openFramedBackupWithPhrase`
  (KDF 128 MB, sekali) → hapus `deviceId` + bersihkan `identityKeys` (bootstrap
  identitas baru, sama seperti "Import Vault") → reload. Diuji di
  `src/components/__tests__/backupRestoreModal.test.tsx` (4 test: berkas asing
  ditolak tanpa restore, tombol non-aktif sampai lengkap, phrase dinormalkan
  `trim`+`lowercase`, phrase salah → error tanpa klaim sukses).

---

## 31.6 Yang belum dikerjakan (fase lanjutan)

1. ~~**Fase 2 — pengaitan payload:** memetakan tabel Keychain menjadi frame per tipe.~~
   **SELESAI** — lihat §31.6a.
2. ~~**Fase 3 — transport:** unduh/unggah `.nyxbak` manual **dan** endpoint
   `POST /api/backup/presign`.~~ **SELESAI** — lihat §31.6b.
3. ~~**Fase 4 — UX restore:** alur restore di perangkat pengganti
   (bersama `migration:*`), progres per frame, laporan ukuran.~~
   **SELESAI** — lihat §31.6c.
4. ~~**Fase 5 — pengukuran:** harness benchmark export/import 10k pesan (waktu +
   puncak memori) sebagai gate `docs/30` §30.7.~~ **SELESAI** — lihat §31.6d.

Jalur `migration:*` ber-frame sudah aktif untuk perangkat pengganti, dan sejak
**2026-10-29** `.nyxbak` adalah **satu-satunya** jalur backup.

**Yang dihapus (2026-10-29):** export/import JSON lama
(`exportDatabaseToJson`/`importDatabaseFromJson`, berkas `.nyxvault`) dibuang
dari `keychainDb.ts`, dari Settings (`Ekspor/Impor Brankas`), dari modal
recovery di `/login`, dan dari `ChatInfoModal` (teks bantuan). Alasannya bukan
sekadar duplikasi:

- **Ekspornya plaintext.** Tidak ada satu pun kode yang membuat envelope
  `{encrypted, salt, data}` yang dibaca `importDatabaseFromJson` (grep
  `encrypted: true` = 0), jadi tombol "Ekspor Brankas" selalu menulis JSON
  terbaca. Di dalamnya `sessionKeys.key` dan `groupKeys.key` ditulis mentah
  (`keychainDb.ts`), bukan `ENC1:` — artinya kunci sesi/grup ikut keluar apa
  adanya.
- **Cakupan lebih kecil:** 16 tabel (tanpa `conversations`, `contacts`,
  `profileCache`, `groupCachedParticipants`) dan `Date` hilang jadi string,
  sedangkan `.nyxbak` memuat 20 tabel dengan penanda `__type`.
- **Import-nya tidak menjalankan `normalizeOrderIndex()`**, jadi pesan dari
  vault pra-v9 bisa tersimpan tapi tak pernah muncul di query berpaginasi, dan
  ia menghapus `identityKeys` (bukan hanya `deviceId`).

Konsekuensi yang diterima: pengguna yang masih memegang berkas `.nyxvault`
tidak bisa memulihkannya lagi. Penggantinya sudah ada sebelum penghapusan
(QR `migration:*`, berkas `.nyxbak`, dan salinan awan R2), dan file itu sendiri
tidak pernah menjadi satu-satunya cadangan yang aman karena isinya terbuka.

---

## 31.6d Fase 5 — benchmark 10k pesan (selesai)

`web/src/lib/backupBench.ts` mengubah klaim "format ber-frame muat untuk 10k
pesan" menjadi angka. Fixture deterministik (LCG, tanpa `Math.random`) memuat
10 000 pesan + 10 000 kunci pesan + percakapan/kontak/identitas; `restore`
mengembalikan tabel yang berbeda dan integritasnya diverifikasi lewat
`countsEqual` (perbandingan jumlah-per-tabel **tanpa** peduli urutan kunci,
karena `createFramedBackup` men-scramble frame secara default).

**Cara menjalankan.**

```bash
# suite normal tetap cepat: 200 pesan (uji kewarasan + integritas)
pnpm --filter nyx-web run test

# benchmark penuh 10k pesan (mencetak laporan waktu + puncak memori)
pnpm --filter nyx-web run bench:backup
```

**Hasil terukur (Mesin dev Linux, Node 26, satu proses, `chunkBytes` 64 KB,
kripto sungguhan libsodium; jalur ini tidak memakai Argon2 karena kuncinya acak).
Rentang di bawah berasal dari **dua eksekusi berturut-turut** — variasi antar-jalan
≈ ±10 %:**

| Metrik | Export | Restore |
|---|---|---|
| Waktu | **1.34 – 1.51 s** | **0.62 – 0.77 s** |
| Puncak heap | **~146–147 MB** | **~146–147 MB** |
| Puncak RSS | **~296–297 MB** | **~311–312 MB** |

Arsip: **4.62 MB** untuk **20 272 catatan** dalam **79 frame**; integritas `OK`.

**Gate** ada di `BACKUP_BENCH_BUDGET` (`exportMs` ≤ 30 s, `restoreMs` ≤ 30 s,
`archiveBytes` ≤ 256 MB) — ambang longgar agar tidak rapuh terhadap perbedaan
mesin CI/VPS; angka sebenarnya selalu dicetak.

**Batasan yang jujur:**

- **I/O IndexedDB tidak termasuk.** Penyimpanan di-inject sebagai store
  in-memory, jadi angka di atas adalah batas bawah untuk kripto + serialisasi +
  AEAD, bukan profil browser (Dexie/OPFS bisa menambah ratusan ms di perangkat
  kelas bawah).
- Puncak memori diukur lewat sampling `process.memoryUsage()` setiap 10 ms; pada
  fase yang sangat singkat puncak sebenarnya bisa sedikit lebih tinggi dari yang
  terambil sampelnya.
- Fixture memakai ciphertext sintetis ber-panjang tetap; perangkat nyata punya
  variasi ukuran payload (media, replied-to, dsb).
- `restoreFramedBackup` masih menahan seluruh frame + catatan hasil dekode di
  memori sebelum satu transaksi tulis (lihat §31.6c), jadi puncak heap restore
  belum turun meski arsipnya kecil.
