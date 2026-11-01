# Pass 4 — Laporan delta

Basis: `7395c91e`. Laporan pass 1: `docs/audit/AUDIT_REPORT.md`.
Pass 2: `docs/audit/pass-2/`. Pass 3: `docs/audit/pass-3/`.
Temuan baru: `20-findings.md`. Verifikasi fokus transport: `30-sidecar.md`.

## Ringkasan satu paragraf

Keempat temuan pass 3 **tertutup di kode**, dan saya memverifikasinya dengan
membaca jalur yang menulis data, bukan hanya tes: guard ratchet kini fail-closed
dengan urutan bentuk → pembaca → perangkat, OTPK dikonsumsi di kedua jalur,
derivasi `keyId` tidak lagi bergantung endianness, dan pembentukan sesi berhenti
saat kunci peer berubah. Namun perbaikan itu memindahkan celahnya satu langkah:
`issuedByServer` (anchor bukti peserta yang baru) ditulis oleh
`POST /api/conversations` **tanpa validasi apa pun** atas `deviceId` — sementara
endpoint ratchet yang dijaga ketat justru tidak bisa menulis anchor itu. Akibatnya
siapa pun yang punya akun dapat "mendaftarkan" perangkat nyata milik orang lain
ke percakapan yang ia buat, tanpa notifikasi, dan orang itu menjadi *peserta
terbukti* di sana (N4-01, Medium). Di sisi transport, sidecar Rust ternyata
menerapkan batas 32 KB hanya pada jalur bidi; jalur uni membaca **seluruh**
stream ke memori tanpa cap (N4-03, Low, hanya klien terautentikasi). Tidak ada
temuan Critical/High.

## A. Diperbaiki dan terverifikasi (dengan bukti kode)

| ID | Klaim perbaikan | Bukti | Verdict |
|---|---|---|---|
| N3-01 | Ratchet fail-closed: bentuk payload (cap 500, base64url, ≤8 KB, `sessionId` ≤128, `deviceId` ≤128, duplikat digabung) → pemanggil peserta terbukti **tanpa** memakai `SessionKey` (sirkular) → perangkat nyata & sudah terdaftar | `sessionKeyRelayGuard.ts:70-105` (`normalizeKeys`), `:107-143` (`provenParticipants`), `:145-232` (`authorizeSessionKeyRelay`); route memanggilnya sebelum menulis (`routes/sessionKeys.ts:63-69`) | **Tertutup di endpoint itu.** Bukti memakai keanggotaan bertoken + receipt bertag + baris `issuedByServer`, persis seperti yang diklaim. Sisa celah ada di jalur lain (N4-01). |
| N3-01 lanjutan | View-once: pembuka wajib ada di daftar penerima bila pesan punya daftar | `realtimeHandlers.ts:970-985`, `viewOnceRecipients.ts:99-121` | **Tertutup.** `isRecipient` dicek dulu, lalu `isAddressedViewOnceRecipient`; `false` → `return` tanpa `delete`, tanpa `message:viewed`, tanpa pencatatan pembukaan. Pesan lama (`null`) kembali ke perilaku lama. |
| N3-02 | Regenerate OTPK menghapus prekey lokal setelah derivasi berhasil | diff `crypto.ts:3315-3336` — `deleteOneTimePreKey(otpkId)` **sebelum** `return regenerated` | **Tertutup.** Jalur normal dan regenerate kini setara; regenerate gagal tidak menghapus (dan fallback di bawahnya menolak blob ber-OTPK). |
| N3-03 | `keyId` OTPK little-endian eksplisit di kedua tempat | `crypto.worker.ts:985-990` (regenerate) dan `:1546-1551` (pembuatan), keduanya `DataView.setUint32(0, keyId, true)` | **Tertutup.** Di host little-endian byte-nya identik → tidak ada migrasi; hanya platform big-endian berubah. |
| N3-04 | Kunci peer yang berubah/bertentangan dengan log menhentikan pembentukan sesi | `crypto.ts:3225-3235` — `throw new Error('IDENTITY_CHANGED: …')` sebelum `from_base64` bundle/derivasi | **Tertutup untuk `changed`.** `unavailable` sengaja tidak memblokir (F-09, banner). Klaim "fetchPreKeyBundle tidak memanggil KT" cocok dengan kode yang saya baca. |
| Bug laten create | `initiatorCiphertext` (tidak ada di schema) dan kewajiban ciphertext X3DH | `routes/conversations.ts:210-222` — menulis `initiatorCiphertexts`, boleh `null`, `issuedByServer: true` | **Tertutup** untuk kedua bug itu. |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| F-13 | **Tidak diverifikasi** (sejak pass 1) | `pnpm audit --prod` butuh jaringan; tidak satu pun pass menjalankannya ulang. |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip; jangan sebut "CSP penuh". |
| Cakupan | Terbuka | `routes/auth.ts`, `packages/spqr-wasm`, WASM KT, dan seluruh eksekusi Rust tetap belum diaudit. |

## C. Regresi baru

Tidak ada regresi fungsional dari `7395c91e` yang bisa saya buktikan: klien
view-once tidak berubah, jalur pembuatan 1:1 tetap `best-effort` (kegagalan
sealing tidak menggagalkan chat), dan seluruh tes server lulus.

Yang ada bukan regresi tetapi **pelemahan anchor**: bukti peserta yang baru
(`issuedByServer`) dapat dicetak lewat jalur yang tidak divalidasi (N4-01), dan
klaim "ratchet hidup lagi" tidak benar karena fungsinya tidak punya pemanggil
(N4-02).

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N4-01 | **Medium** (High confidence) | `POST /api/conversations` menulis `SessionKey.issuedByServer` untuk `deviceId` apa pun: tanpa cek kepemilikan/peserta, tanpa cap jumlah, tanpa validasi base64/ukuran (skema hanya `z.string()`). Perangkat nyata milik orang lain bisa "didaftarkan" tanpa notifikasi; korban lalu muncul di presence penyerang, bisa dikirimi `typing`, dan menjadi **peserta terbukti** di percakapan itu (sehingga baris ratchet untuk perangkatnya boleh ditulis). |
| N4-02 | Low | `ensureAndRatchetSession` **tidak punya pemanggil** di `web/src` (grep: hanya definisi). CHANGELOG menyebut "hidup lagi". Selain itu anchor bootstrap hanya membuktikan **penerima** (perangkat pembuat sengaja dilewati saat sealing), jadi pembuat 1:1 tidak punya bukti dan akan menerima 403 bila fungsinya dipakai. |
| N4-03 | Low | Sidecar: batas 32 KB ditegakkan **sebelum alokasi hanya di jalur bidi**. Jalur uni membaca seluruh stream ke `Vec` tanpa cap (`buffer.extend_from_slice`), lalu mem-parse dengan `usize::MAX`; `ServerConfig::builder()` tidak menyetel batas transport. Klien terautentikasi dapat menahan memori sidecar, dan payload >32 KB tetap diteruskan ke `nyx:upstream:*`. |
| N4-04 | Info | Tiket URL hanya dipakai bila **keduanya** `id` dan `deviceId` ada; tiket tanpa `deviceId` jatuh ke jalur auth bidi. Bukan bug (fail-closed), tetapi berarti tiket "setengah" berperilaku seperti tanpa tiket. |

## E. Tes & checks pass ini

- `npx tsc --noEmit` (server): **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning (tidak berubah dari pass 3).
- `pnpm --filter nyx-server run test`: **775 tes, 773 lulus, 0 gagal, 2 skip**
  (70,7 s). Naik 11 tes dari pass 3 — cocok dengan `sessionKeyRelayGuard.test.ts`
  (9 kasus) dan tambahan `realtimeAuthorization`.
- `vitest run` (pqHandshake, x3dhOracleVectors, x3dhOracleInterop): **3 berkas,
  17 tes, 17 lulus** (10,4 s) setelah perubahan `crypto.ts`/`crypto.worker.ts`.
- `cargo test` **tidak** dijalankan; tidak ada klaim kompilasi/uji untuk Rust.

## F. Rekomendasi urutan tindak lanjut

1. **N4-01** — validasi `initialSession` di `POST /api/conversations` dengan
   aturan yang sama dengan guard ratchet: cap 500, base64url ≤8 KB, dan
   `deviceId` harus milik `userIds` (atau pemanggil). Ini menutup jalur pencetakan
   anchor tanpa menyentuh format wire.
2. **N4-03** — terapkan cap pada jalur uni (baca maksimum `5 + MAX_BIDI_PAYLOAD_BYTES`
   lalu tolak sisanya) atau setel batas transport QUIC; sekarang aturan 32 KB
   hanya berlaku di satu dari tiga jalur.
3. **N4-02** — putuskan: hapus `ensureAndRatchetSession` (dan klaim CHANGELOG),
   atau panggil ia dan sertakan perangkat pembuat dalam sealing agar pembuat 1:1
   punya bukti.
4. F-13: jalankan `pnpm audit --prod` sebelum rilis.
