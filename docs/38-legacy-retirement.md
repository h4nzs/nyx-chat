# 38 — Pensiun jalur versi lama

> **Status (2026-10-28):** keputusan maintainer — semua klien sudah di versi
> aplikasi terbaru, tidak ada klien yang masih memakai KT v1 atau format
> protokol terdahulu. Data lokal bersisa dari versi lama **boleh hilang**.
> Dokumen ini mencatat apa yang dihapus, apa yang sengaja **tidak** dihapus,
> dan alasannya. Tanpa tabel ini, penghapusan "legacy" berikutnya akan
> mengulang perdebatan yang sama.

## 38.1 Aturan yang dipakai

Satu jalur dihapus hanya bila ketiga syarat ini benar:

1. **Tidak ada penulis baru** yang menghasilkan bentuk lama itu (bukan sekadar
   "jarang dipakai").
2. **Tidak ada data yang masih dibutuhkan untuk membuka isi yang tersimpan** —
   atau datanya memang boleh hilang menurut keputusan di atas.
3. Menghapusnya **tidak menghilangkan jalur pemulihan darurat** yang masih
   dipakai operator (rollback KT, kill switch SPQR).

Yang sering tertukar: **kode untuk klien lama** vs **kode untuk data lokal lama
milik klien sekarang**. Yang pertama boleh dibuang bersama kliennya; yang kedua
hanya boleh dibuang kalau isi data itu memang sudah tidak dibutuhkan.

## 38.2 Inventaris

| # | Jalur lama | Lokasi | Kenapa masih ada | Putusan |
|---|---|---|---|---|
| 1 | Verifier KT **ABI 1** (Ed25519 + EC-VRF) | `web/src/lib/keyTransparency.ts`, `ktBundleProof.ts` (impor + `loadKtVerifier`), `packages/keytrans-wasm/` — **semuanya dihapus** | log v1 masih bisa disajikan `KT_QUERY_URL` | **Selesai** — klien hanya mengenal ABI 2; config ABI 1/`abiVersion` kosong ditolak terlihat (`unavailable`, atau `unverifiable` bila pin ABI 2 sudah ada). Paket WASM v1 (dan artefak `keytrans.wasm`) dihapus 2026-10-28: tidak ada lagi kode yang membacanya |
| 2 | Inferensi pin ABI 1 dari bentuk kunci | `web/src/lib/ktConfigPin.ts` (`parseKtConfigPin`) | pin tersimpan pengguna lama berbentuk dua kunci 32 B tanpa `abiVersion` | **Pertahankan** hanya sebagai jalur **upgrade satu arah** ke pin ABI 2; arah v2 → v1 tetap ditolak |
| 3 | Penulisan log KT **v1** (`KT_SERVER_URL`) | `server/src/utils/keyTransparency.ts`, `ktIdentityLog.ts` — jalur v1 dihapus | dual-write transisi `docs/35` §35.7 | **Selesai (2026-10-28)** — penulis hanya punya satu log (v2). Metrik digabung: `nyx_kt_writes_total`/`nyx_kt_last_success_timestamp_seconds` kini milik log v2, `nyx_kt_v2_*` dihapus; alert, dashboard, dan drill case memakai nama lama sehingga tidak ada jendela buta. `KT_SERVER_URL` sisa hanya memicu satu peringatan boot lalu diabaikan |
| 4 | Format nilai log v1 (1282 B) saat menulis | `server/src/utils/keyTransparency.ts` (`encodeKtValue`/`decodeKtValue`, `KT_VALUE_V1_BYTES`) — dihapus | akun pra-PQ | **Selesai** — entri tanpa `signingKeyV2` (ML-DSA-65) dilewati terlihat (`KT_V2_SIGNING_KEY_INVALID` → `result="invalid"`), bukan ditulis sebagai v1. Pembacaan nilai v1 di klien tetap (data lama di `packages/shared/src/ktValue.ts`) |
| 5 | Layanan v1 `nyx-kt-query` + auditor v1 `nyx-kt-auditor` | `server/kt-query/*.go` v1, `cmd/nyx-kt-auditor`, `cmd/nyx-kt-check`, `ops/systemd/nyx-kt-{query,auditor}.*`, blok v1 `deploy.yml`, job scrape `:9466`/`:9467` — **dihapus** | pemilik LevelDB v1 | **Selesai** — `deploy.yml` mematikan + menghapus unit v1 yang masih `enabled` di VPS lalu men-deploy log v2. LevelDB v1 dibiarkan di disk (arsip/rollback operator, `docs/39`) |
| 6 | Envelope grup **v3** | `packages/shared/src/groupEnvelope.ts` | dekode pesan grup lama | **Pertahankan dekode** (data), hapus hanya bila isi grup lama boleh hilang |
| 7 | Envelope grup **v2** | `web/src/utils/crypto.ts:1304` | ditulis bila `signingKeyV2` tidak ada | **Pertahankan** selama `signingKeyV2` masih opsional |
| 8 | Migrasi `localStorage['nyx_bio_vault']` | `web/src/lib/biometricUnlock.ts:154,198,250` | vault biometrik format lama | **Hapus** (data lama boleh hilang) |
| 9 | Migrasi prefix `verified_conversation_` | `web/src/store/verification.ts:39,118-125` | kunci verifikasi format lama | **Hapus** |
| 10 | Hash 64-hex legacy di pencarian | `web/src/lib/userSearch.ts`, `server/src/routes/users.ts` | identifier dari link berbagi lama | **Pertahankan** — ini bukan versi klien, melainkan bentuk identifier yang masih dipakai jalur berbagi |
| 11 | Riwayat skema Dexie v1–v15 | `web/src/lib/db.ts:305-442` | membuka DB yang sama (berisi keychain) | **Pertahankan mutlak** — menghapus rantai upgrade bukan "membuang data lama", tapi berisiko mengunci kunci identitas pengguna sekarang |
| 12 | Header pesan SPQR **v1**, gate `ackV`, kill switch | `docs/33`, `web/src/lib/spqrWire.ts` | protokol baca + rollback | **Pertahankan** — kill switch berhenti mengirim, tidak pernah berhenti membaca |
| 13 | `x-delivery-tokens` di CORS | `server/src/app.ts:221` | sisa header yang sudah dihapus | **Selesai** — sudah tidak ada di whitelist; komentarnya menjelaskan kenapa |
| 14 | Drill pemulihan KT v1 (`scripts/kt-restore-drill.sh` + `nyx-kt-check`) | skrip, `server/scripts/kt-{drill-entries,fixtures,query-fixtures}.ts`, job CI `kt-recovery` — **dihapus** | menguji penulis/pohon v1 | **Segresi yang disengaja, belum ditutup** — drill setara untuk v2 belum ada (lihat §38.3). Jangan dianggap setara dengan drill yang dulu lulus |
| 15 | Vendor `libsignal-keytrans` (crate v1) | `vendor/signal/libsignal-keytrans/`, bagian `scripts/vendor-signal.sh`, guard `check-vendor.sh` — **dihapus** | sumber `packages/keytrans-wasm` | **Selesai** — verifier v2 adalah fork lokal `packages/keytrans-v2`, tidak dikompilasi dari vendor Signal. `NOTICE` §2 kini hanya menyebut libsignal sebagai referensi desain |

## 38.3 Konsekuensi yang diterima

- **Rollback KT v1 hilang dari klien maupun server.** Arahkan `KT_QUERY_URL`
  ke v1 + `resetKtPin` bukan lagi pilihan: klien menolak ABI 1 dan penulis v1
  tidak ada. Rollback = deploy ulang commit sebelumnya (lalu tulis v1 kembali
  berjalan hanya dari kode lama). Ini disengaja: log v1 frozen, jadi
  menyajikannya hanya menghasilkan anchor basi.
- **Dual-write berhenti.** Selama transisi, setiap entri masuk dua pohon; sejak
  2026-10-28 hanya v2. Klien yang memegang anchor v1 tidak bisa melanjutkannya —
  itu sudah tidak mungkin sejak klien menolak ABI 1.
- **Akun tanpa `signingKeyV2`** tidak lagi punya entri log yang ter-update.
  Entri baru dilewati `KT_V2_SIGNING_KEY_INVALID` (terlihat di
  `nyx_kt_writes_total{result="invalid"}`), jadi rotasi ke perangkat PQ adalah
  prasyaratnya — bukan kegagalan senyap.
- **Drill pemulihan KT v1 hilang dan belum ada penggantinya.** Job CI
  `kt-recovery` dihapus karena bergantung pada penulis v1 + `nyx-kt-check`.
  Snapshot v2 tetap dibuat **terverifikasi** oleh proses log (penulisan dijeda,
  salinan dibuka ulang, head+root dibandingkan) dan diunggah `ktSnapshot.ts`,
  tetapi rantai penuh *tulis → snapshot → bencana → pulih → bukti lolos verifier*
  tidak lagi diuji otomatis. Itu regresi yang terbuka, dicatat juga di `docs/39`
  §39.5.
- **Data lokal format lama** (vault biometrik lama, kunci verifikasi lama)
  diabaikan; pengguna yang membukanya kembali akan diminta mengatur ulang
  biometrik/verifikasi, bukan kehilangan identitas.

## 38.4 Yang tidak termasuk di sini

Format beku yang **bukan** warisan: prefix at-rest `ENC1:`, envelope
XChaCha `base64url(nonce‖ct)`, padding 8 KB, `NYXB` v1, format nilai log v1
*sebagai data baca* (`packages/shared/src/ktValue.ts` — masih dipakai untuk
membaca entri lama dan fixture), dan `SERVER_CAPABILITIES`. Itu kontrak aktif,
bukan versi lama. Nama env `KT_V2_SERVER_URL` juga dipertahankan meski tinggal
satu log: mengganti nama env produksi tidak memberi keamanan apa pun dan
memaksa semua deployment menyunting `.env` sebelum boot.
