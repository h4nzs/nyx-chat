# 43 — Rencana Versi Tunggal (greenfield, tanpa data user)

Status: **aktif** (2026-11-16). Menggantikan `docs/27`, `docs/30`, `docs/35`
sebagai sumber rencana, dan menggantikan `docs/38` sebagai kebijakan
penghapusan.

Alasan dokumen ini ada: layanan sudah dimatikan sementara dan **tidak ada data
user yang perlu dilindungi**. Semua jalur kompatibilitas data/protokol lama
kehilangan alasannya. Setiap kompatibilitas yang tersisa harus dibuktikan masih
dibutuhkan; defaultnya **hapus**.

---

## 43.1 Postulat

1. **Satu versi.** Satu versi data lokal, satu versi format protokol, satu
   format at-rest. Tidak ada pembaca format lama, tidak ada penulis ganda,
   tidak ada migrasi.
2. **Infra tidak dibatasi.** Jumlah host, spesifikasi, dan pemisahan layanan
   ditentukan kebutuhan keamanan, bukan sisa era 1 core/8 GB. Dokumen ops
   berhenti membahas tuning spesifikasi dan mulai membahas batas kepercayaan
   antar-host.
3. **Klasik-saja tidak dipertahankan.** Kriptografi harus hybrid atau PQ murni
   yang sudah teruji. Sisa klasik-saja ditutup dengan penggantian, bukan dengan
   catatan risiko permanen.
4. **"Beku" bukan alasan.** Label `format beku`, `jangan diubah`, dan
   sejenisnya dicabut. Yang dipertahankan adalah **properti**, bukan byte:
   tidak ada plaintext di server, tidak ada identitas di transport, padding
   seragam, fail-closed pada kegagalan verifikasi.
5. **Data lokal lama boleh hilang.** Termasuk vault IndexedDB, token mailbox,
   state SPQR, pin KT, dan outbox yang belum terkirim.
6. **Tes mengunci invariant, bukan kebetulan.** Saat perilaku lama dihapus,
   tesnya **ditulis ulang** ke invariant baru — tidak dilemahkan, tidak
   dihapus tanpa pengganti.

---

## 43.2 Peta dokumen

### 43.2.1 Dokumen yang dihapus (rencananya sudah selesai)

| Dok | Isi | Alasan | Sisa yang diadopsi |
|---|---|---|---|
| `27-total-upgrade-plan.md` | rencana era post-VPS-closure, tuning ≥8 GB / ≥4 core, fase 0–6 | seluruh isinya soal keterbatasan hardware yang tidak berlaku lagi | tidak ada (angka spesifikasi dihapus dari `docs/10`) |
| `30-post-parity-implementation-plan.md` | WS-A…WS-K, milestone M1–M8, inventaris `docs/29` | setiap workstream tuntas, dibatalkan, atau digated | §43.7 |
| `35-post-quantum-migration-plan.md` | rencana migrasi PQ, fase 0–N, format v2 | semua fase `implemented`; sisa penanda OPRF/PIR sudah usang (PIR kini dua server, `docs/42`) | tidak ada |

Catatan biaya: ketiga dokumen ini dirujuk **517 kali** dari dokumen lain,
`CHANGELOG.md`, dan komentar kode (`docs/27` 10, `docs/30` 351, `docs/35` 156).
Penghapusan berkas karena itu menuntut penulisan ulang rujukan, bukan sekadar
`git rm`.

### 43.2.2 Dokumen yang dipindahkan ke arsip

| Dok | Tujuan | Alasan |
|---|---|---|
| `29-signal-parity-analysis.md` | `docs/history/` | studi banding; berguna sebagai jejak, bukan sebagai rencana |
| `40-link-history-archive.md` | `docs/history/` | catatan riwayat |

### 43.2.3 Dokumen yang dipertahankan dan dirapikan

| Dok | Tindakan |
|---|---|
| `26-group-privacy-blueprint.md` | tetap; argumen privasi grup masih valid, kalimat "jangan diubah" dicabut |
| `28-db-dump-threat-model.md` | tetap; model ancaman dump DB masih berlaku |
| `37-privacy-closure-plan.md` | tetap; rencana penutupan privasi masih aktif |
| `38-legacy-retirement.md` | **ditulis ulang** menjadi kebijakan versi tunggal (§43.5) |
| `10-deployment-ops.md` | hapus semua tuning spesifikasi host; tambah topologi multi-host (§43.6) |
| `11`, `39`, `41` | drill restore & gate CI disesuaikan dengan realita "tanpa data user" |
| `01,03,04,05,07,09,14,15,16,18,32,33,34,42` | cabut kalimat pembekuan format; rujuk §43.1 |

---

## 43.3 Peta kode — yang dihapus

### 43.3.1 Data lokal (Fase B) — **digantikan §43.11**

> Daftar di bawah mengandaikan Dexie tetap dipakai dan hanya jalur kompatibilitas
> yang dipangkas. Setelah §43.11 (SQLite-WASM/OPFS) dipilih, seluruh tabel
> `web/src/lib/db.ts` dan `dexieMigration.test.ts` dihapus sekaligus, jadi bacalah
> tabel ini sebagai inventaris warisan Dexie yang harus hilang, bukan urutan kerja.

| Berkas | Isi | Tindakan |
|---|---|---|
| `web/src/lib/db.ts:305-442` | rantai Dexie v1–v15 (16 blok `this.version`) | satu `this.version(1)` dengan skema final |
| `web/src/lib/__tests__/dexieMigration.test.ts` | tes rantai migrasi | diganti tes bentuk skema (semua tabel/indeks ada) |
| `web/src/lib/biometricUnlock.ts:154,198,250` | migrasi `localStorage['nyx_bio_vault']` | hapus; vault biometrik hanya format sekarang |
| `web/src/store/verification.ts:39,118-125` | prefiks `verified_conversation_` | hapus; satu prefiks |
| `web/src/lib/keychainDb.ts:299,449,465,639` | fallback id senderId-keyed, format tanpa keyId, pesan tanpa `senderDeviceKey` | hapus |
| `web/src/lib/keyStorage.ts:338` | legacy global fallback | hapus |
| `web/src/lib/contactStore.ts:65,188` | record lama tanpa `firstSeenAt`/`lastSeenAt` | hapus |
| `web/src/store/message.ts:1136,2229,2232` | schema legacy, `devices` kosong | hapus |
| `web/src/utils/safetyNumber.ts:54` | jalur legacy | hapus |

### 43.3.2 Protokol (Fase C)

| Berkas | Isi | Tindakan |
|---|---|---|
| `web/src/lib/ktConfigPin.ts` | inferensi pin ABI-1 | hanya ABI 2 |
| `packages/shared/src/ktValue.ts` | jalur baca `ktValue-1` | hanya `nyx-kt-value-v2` |
| `packages/shared/src/groupEnvelope.ts` | v2/v3 + `GROUP_ENVELOPE_V4` | hanya v4 |
| `web/src/utils/crypto.ts:1304` | jalur tulis v2 saat `signingKeyV2` absen | wajib PQ; tidak ada penulis non-PQ |
| `web/src/lib/spqrWire.ts`, `spqrSession.ts` | header v1, gate `ackV`, kill switch | hanya header v2 |
| `web/src/utils/crypto.ts:2499,2512,2954` | prefix CK pra-v2, grup v2/v3 | hapus |
| `server/src` `KT_SERVER_URL` | jalur v1 yang diabaikan dengan warning | hapus env + warning |

### 43.3.3 At-rest (Fase D)

`server/src/utils/atRestSecrets.ts` sekarang menerima **dua** format: bare
base64url (kunci id `0` dari `NYX_AT_REST_PEPPER`) dan `ENC2:<keyId>:<payload>`.
Fase D menyisakan **satu** format ber-key-id dengan AAD, menghapus
`sealedLookupCandidates()` beserta seluruh pemanggilnya (11 tempat di 5 berkas),
dan menghapus `scripts/reseal-at-rest.ts`.

---

## 43.4 Audit kripto

Sudah PQ atau hybrid: X-Wing (X25519 + ML-KEM-768) untuk KEM, ML-DSA-65 untuk
tanda tangan dan log KT, SPQR braid untuk ratchet, XChaCha20-Poly1305,
AES-GCM, BLAKE2b, HMAC-SHA256.

Sisa klasik-saja:

| Titik | Primitive | Keputusan |
|---|---|---|
| `web/src/lib/privacyPass.ts` | Blind RSA (RFC 9474) | **diganti** — lihat §43.4.1 |
| OHTTP/HPKE `VITE_OHTTP_*` | KEM X25519 | hybrid X25519 + ML-KEM-768 |

### 43.4.1 Pengganti Blind RSA

Tujuan aslinya: satu token anonim yang tidak bisa dikaitkan ke user, tapi hanya
bisa dipakai sekali per sinkronisasi. Blind signature PQ yang matang belum ada,
jadi mekanismenya diganti — bukan primitifnya:

1. **Token buta tanpa tanda tangan buta**: server menerbitkan N token acak
   256-bit per akun per 24 jam, disimpan sebagai HMAC(pepper) saja (tanpa
   plaintext), dan klien menyimpannya ter-seal (`ENC1:`) seperti sekarang.
2. **Anonimitas dari transport**, bukan dari buta kriptografis: token dikirim
   di dalam badan OHTTP (sudah ada), sehingga server tidak melihat IP/identitas
   saat memakai token.
3. **Anti-replay + anti-linkability**: satu token = satu `POST /api/groups/sync`,
   diikat ke `conversationId` lewat HMAC lokal (sudah ada di
   `privacyPass.ts`); server menandai token terpakai di Redis dengan TTL 24 jam.
4. **Batas**: server tetap bisa menghitung "berapa token dipakai per akun per
   hari" (itu memang fitur rate-limit), tetapi tidak bisa mengaitkan token ke
   percobaan sinkronisasi tertentu karena pemakaian terjadi di dalam OHTTP.

Risiko yang harus ditutup: tanpa blind signature, issuer bisa mengeluarkan token
yang dapat dikenali. Mitigasi: token adalah byte acak yang dihasilkan **klien**
lalu dikirim ke issuer yang hanya menyimpan HMAC-nya; issuer tidak pernah
melihat nilai token, sehingga tidak bisa menandainya.

---

## 43.5 Kebijakan versi tunggal (pengganti `docs/38`)

`docs/38` selama ini berisi daftar "apa yang boleh dihapus" dengan tiga syarat
konservasi. Di era tanpa data user, urutannya dibalik:

1. Setiap jalur pembaca format lama **dihapus** kecuali ada alasan tertulis yang
   bisa diverifikasi hari ini (bukan "mungkin nanti ada perangkat lama").
2. Setiap jalur penulis ganda **dihapus**; hanya satu format yang ditulis.
3. Setiap label `format beku` dicabut dan diganti pernyataan properti.
4. Setiap dokumen rencana yang sudah tuntas **dihapus**, bukan disimpan sebagai
   "referensi".
5. Tes yang mengunci perilaku lama ditulis ulang, tidak dilemahkan.

---

## 43.6 Infra multi-host

Satu peran per host, batas kepercayaan eksplisit:

| Host | Peran | Data sensitif yang terlihat |
|---|---|---|
| A | API + Postgres | metadata percakapan terenkripsi, blind index |
| B | relay WSS (socket.io gateway) | routing, tanpa isi pesan |
| C | sidecar WebTransport | frame terenkripsi, tanpa identitas |
| D | OHTTP relay | envelope buta, tanpa identitas |
| E, F | PIR server A dan B | shard, saling jujur-sedikit |
| G | KT log | komitmen kunci, tanpa isi |
| H | KT auditor | salinan log, kunci auditor sendiri |
| I | Prometheus/Alertmanager | metrik event-only |

`docs/10` berhenti membahas `vm.swappiness`, `shared_buffers`, atau jumlah core;
yang dibahas adalah batas kepercayaan antar-host, port loopback per exporter, dan
prosedur fail-closed saat satu host mati.

---

## 43.7 Item terbuka yang diadopsi dari `docs/27`/`30`/`35`

| Item | Status | Sumber hidup |
|---|---|---|
| MLS (WS-J) | gate 2027+, belum dimulai | §43.7 (dokumen ini) |
| Klien native push/background (WS-K) | proyek terpisah | — |
| Observability (alert, dashboard, exporter) | selesai sebagian | `docs/10` §10.12, `docs/41` |
| WS-H sisa: false-positive ASN/NAT, kunci TPM/SE, root vendor | butuh data lapangan | `docs/41` |
| KT `cmd/kt-client` interop + dua auditor berdampingan | belum | `docs/34` §34.6 |
| Snapshot KT di VPS + bukti restore | tercakup drill | `docs/39` §39.5 |
| PIR dua server + sharding | selesai | `docs/42`, `docs/41` §6.7 |

---

## 43.8 Urutan fase dan gate

| Fase | Isi | Gate |
|---|---|---|
| **A** | dokumen: `docs/43` (ini), `docs/38` ditulis ulang, `27/30/35` dihapus, `29/40` diarsipkan, `AGENTS.md` jadi invariant | `pnpm run check:status`, oxlint, CI hijau |
| **B** | data lokal: **SQLite-WASM/OPFS menggantikan Dexie** (§43.11), satu skema tanpa rantai versi, kunci DB ter-seal | unit storage + kontrak, E2E auth + chat + group + backup + multi-tab |
| **C** | protokol: pin ABI-1, `ktValue-1`, envelope v2/v3, `signingKeyV2` opsional, SPQR v1 + kill switch, `KT_SERVER_URL` | unit + E2E KT live + SPQR + group era |
| **D** | at-rest satu format ber-AAD, hapus `sealedLookupCandidates` + `scripts/reseal-at-rest.ts` | unit server, drill backup/restore |
| **E** | kripto: HPKE hybrid, pengganti Blind RSA (§43.4.1) | unit + E2E sync anonim |
| **F** | infra: `docs/10` multi-host, unit systemd per peran, contoh topologi | drill, `scripts/drill-alerts.sh` |

Setiap fase berakhir dengan `pnpm -r run build`, unit test, oxlint, dan CI 12/12.
Fase B dan C menyentuh jalur kripto yang dipakai E2E kritis, jadi masing-masing
butuh dua putaran E2E penuh sebelum dinyatakan selesai.

Fase lanjutan (G–I) ditambahkan 16 November 2026 sebagai hasil analisis §43.10–§43.12;
A–F tetap seperti di atas.

| Fase | Isi | Gate |
|---|---|---|
| **G** | E2E: tutup celah gate (`mustPass` per spec), storage/multi-tab, offline/PWA, panic wipe, i18n 4 bahasa, versi-klien (§43.10) | suite inti ≤ 12 mnt di PR, penuh di nightly |
| **H** | transport & OHTTP: WebTransport jadi jalur utama (Safari 26.4 Baseline), HPKE hybrid X-Wing di gateway (§43.12.2, §43.12.4) | unit + E2E `chrome` + gateway dua suite |
| **I** | MLS (OpenMLS WASM) dievaluasi hanya setelah ciphersuite PQ-nya distandarkan; sampai itu SPQR tetap (§43.12.3) | keputusan tertulis, bukan kode |

---

## 43.9 Yang tetap dipertahankan

- Sealing at-rest (`ENC1:`) sebagai **properti** (kunci tidak pernah di disk
  dalam bentuk terang), bukan sebagai format beku.
- Padding trafik 8 KB.
- Backup `.nyxbak` terenkripsi (format boleh berubah, properti tidak).
- `SERVER_CAPABILITIES` sebagai satu sumber negosiasi dua relay.
- KT monitor fail-closed dan verdict per peer.
- LevelDB single-writer untuk log KT.
- Metrics exporter loopback-only, event-only.

---

## 43.10 Analisis E2E — kondisi sekarang, celah, dan rencana

Diukur 16 November 2026 dari repo (bukan dari ingatan): **21 berkas spec, 30 `test()`,
26 tes di suite utama** (a11y dan PIR punya config sendiri), 4 config Playwright,
dan gate `required-tests.json` dengan `minTotal: 26`.

| Proyek / config | Berkas | Tes | Dijalankan |
|---|---|---|---|
| `chromium` (PR) | 19 | 26 | `pnpm exec playwright test --project=chromium` |
| `chrome` (PR, WebTransport) | 19 | 26 | job `e2e-chrome`, sidecar Rust + coturn |
| `firefox` / `webkit` | 1 tiap engine | 4 | nightly job `browsers` (auth + settings + a11y) |
| `a11y` | 1 | 3 | `playwright.a11y.config.ts` (tanpa reset DB) |
| `ohttp` | 1 | 1 | `playwright.ohttp.config.ts` |
| `pir` | 1 | 1 | `playwright.pir.config.ts`, job `pir-e2e` di `drills.yml` |

Durasi terukur (run `43692225973`): chromium **19,5 mnt**, chrome **17,2 mnt**;
anggaran job 40/45 mnt. Artinya suite ini sudah memakai ~50% anggaran tanpa satu
pun tes baru.

### 43.10.1 Celah gate yang paling berbahaya

`mustPass` hanya memuat **12 tes (chromium)** dan **15 tes (chrome)** dari 26.
`minTotal` menjaga *jumlah* dan `mustPass` menjaga identitas, tetapi hanya untuk
tes yang terdaftar. Konsekuensi yang perlu disadari: tes di luar `mustPass` boleh
berubah menjadi skip dengan alasan yang sudah diizinkan — atau diganti tes lain
yang judulnya tidak diperiksa — tanpa gate gagal. Di chromium itu mencakup
`chat`/`transport`/`regression` (memang butuh WebTransport; chromium headless
tidak punya), `spqr`/`pqV2`/`ohttp`/`call`/`ktLive` (infra opsional), dan
`pqBenchThrottle` (opt-in `NYX_PQ_THROTTLE=1`). Semuanya punya alasan skip sah,
jadi bukan pelanggaran — tetapi artinya **lapisan yang dijamin gate hanya 12 dari
26 tes**.

Dua akibat konkret dari membaca spec-nya:

- `regression.spec.ts` **kedua** tesnya skip tanpa WebTransport, dan tes foto
  juga butuh R2. Di job `e2e-chrome` sidecar hidup tetapi R2 tidak, jadi tes
  "burner destroyed … setelah reload" **tidak pernah dijalankan di CI mana pun**
  padahal hanya butuh sidecar. Ini regresi burner yang dulu muncul kembali setelah
  reload — tepat jenis bug yang tidak tertangkap.
- `pqBenchThrottle` sengaja opt-in; jangan pernah memasukkannya ke `mustPass`,
  cukup pastikan ia tetap terdaftar sebagai tes opt-in di dokumentasi.

Perbaikan (Fase G, kecil dan langsung):

1. **`mustPass` = semua tes yang tidak punya alasan skip sah di proyek itu.**
   Di chromium itu tetap mengecualikan `chat`/`transport`/`regression` (WT tidak
   ada) dan `pqBenchThrottle` (opt-in); di chrome hanya tes yang butuh R2/flag
   yang dikecualikan, sehingga tes burner "destroyed after reload" masuk.
2. **Snapshot judul tes**: commit `web/e2e/required-tests.snapshot.json` berisi
   `file::title` untuk **semua** tes per proyek; gate gagal bila himpunan hasil
   berbeda dari snapshot (tes hilang, tes baru belum didaftarkan, atau satu tes
   diganti tes lain). Inilah yang menutup lubang "jumlah tetap 26 tapi isinya
   berbeda".
3. **Tambahkan ke `mustPass` chrome** tes yang hanya butuh sidecar dan sudah
   berjalan di job itu: `regression.spec.ts` → "burner conversation destroyed on
   host stays deleted after reload". Jangan tambahkan tes foto burner (butuh R2)
   atau `pqBenchThrottle` (opt-in).
4. **Generator `minTotal`**: hitung dari report, jangan diketik; angka manual
   sudah basi sekali (§6.5 `docs/41` menulis 10/13 padahal manifest 12/15).

### 43.10.2 Fitur yang tidak punya E2E sama sekali

| Area | Bukti di kode | Risiko | Prioritas |
|---|---|---|---|
| Panic password / wipe | `web/src/store/auth.ts`, `nukeProtocol` | keamanan: klaim "wipe" tidak diuji end-to-end | **P0** |
| Multi-tab | tidak ada spec | dua tab menulis DB yang sama; dengan SQLite §43.11 ini justru titik gagal baru | **P0** |
| Offline / PWA / antrean kirim | `offlineQueue`, service worker | pesan hilang saat jaringan putus, SW basi menolak envelope grup | **P0** |
| Quota / storage penuh | belum ada | DB gagal tulis tanpa pesan yang benar | P1 |
| i18n 4 bahasa | `web/public/locales/{en,es,id,pt-BR}` | `missingKey` hanya terlihat di konsol; tidak ada gate | P1 |
| Story, link history | `stories`, `linkHistory` (0 spec) | regresi senyap | P1 |
| Burner regression | `regression.spec.ts` | **selalu skip** tanpa WT+R2; tes "destroyed after reload" tidak pernah jalan meski hanya butuh sidecar | **P0** |
| Push notification | `usePushNotifications`, `pushSupport` | sudah ada unit test gerbang; jalur nyata butuh HTTPS + izin | P2 |
| Client version gate | `ClientVersionRequiredPage` | klien tua tidak tertahan | P1 |
| Error boundary / chunk gagal | pesan `Error caught by boundary` muncul di E2E | halaman putih tanpa tes | P1 |

### 43.10.3 Rencana suite (Fase G)

- **Pecah dua label**: `test:e2e:core` (spec mustPass + storage/panic/offline) untuk
  PR, `test:e2e:full` untuk nightly. Suite inti ditargetkan **≤ 12 menit** dengan
  `--shard=2` (dua worker tetap `workers: 1` per shard, DB terpisah per shard
  lewat `NYX_E2E_DATABASE_URL`).
- **Fixture lewat API**, bukan UI: registrasi UI memakan 20–40 dtk per spec dan
  modal chain-nya sumber flake. Spec yang tidak menguji onboarding memakai helper
  yang membuat akun via `POST /api/auth/register` lalu menyuntikkan kunci hasil
  `registerUser` yang sudah ada.
- **Spec baru wajib**: `storage.spec.ts` (reload, dua tab, tulis bersamaan,
  `SQLITE_BUSY` ditangani, quota), `offline.spec.ts` (SW prod, offline, antrean
  terkirim saat online), `panic.spec.ts` (panic → IndexedDB/OPFS kosong, cookie
  mati, redirect), `i18n.spec.ts` (4 locale × 1 halaman, asersi tidak ada
  `missingKey` di konsol), `clientVersion.spec.ts` (header versi lama → halaman
  gate), `a11y` diperluas ke chat/grup/settings-tab.
- **Metrik flake**: report JSON sudah memuat `status: flaky/expected`; simpan
  ringkasannya sebagai artifact dan tampilkan tren di `docs/41`. `quarantine.json`
  tetap kosong sampai ada data, bukan sebagai tempat menyembunyikan tes.
- **Naikkan Firefox/WebKit ke PR** setelah 7 hari hijau (sudah dijadwalkan 20
  November 2026); WebKit kini punya `WebTransport` (Safari 26.4), jadi
  `transport.spec` bisa ikut di WebKit **setelah** Playwright WebKit Linux
  benar-benar mendukungnya — di mesin ini masih belum, jadi tetap skip beralasan.

---

## 43.11 Penyimpanan klien: Dexie → SQLite-WASM di OPFS

### 43.11.1 Kenapa Dexie menjadi batas pertumbuhan

Keadaan sekarang: `web/src/lib/db.ts` 455 baris berisi **16 versi skema**
(v1–v16) untuk **25 tabel**, ditambah `keychainDb.ts` 1.002 baris dan
`store/message.ts` 3.450 baris. Semua kolom yang diurutkan/difilter sudah di-seal
`ENC1:`, sehingga indeks IndexedDB hanya berguna untuk `conversationId` dan
`orderBucketMs`; sisanya `.filter()` = pemindaian linier di memori. Tidak ada
agregasi, join, atau full-text search — pencarian pesan dan hitungan percakapan
dikerjakan JavaScript di atas array.

Batasan yang terdokumentasi di Dexie sendiri: `filter()` berjalan di atas baris
hasil indeks, `bulkDelete` 100 ribu baris ≈ 10 detik, dan query di luar indeks
menjadi scan ([#1170](https://github.com/dexie/Dexie.js/issues/1170),
[#1984](https://github.com/dexie/Dexie.js/issues/1984)). Itu bukan bug Dexie;
IndexedDB memang bukan mesin query.

### 43.11.2 Opsi yang dibandingkan

| Opsi | Multi-tab | Header khusus | Enkripsi halaman | Catatan |
|---|---|---|---|---|
| Dexie (sekarang) | ya | tidak | tidak (per-field `ENC1:`) | 16 versi, tanpa SQL/FTS/agregasi |
| `@sqlite.org/sqlite-wasm` + VFS `opfs` | ya (dengan `SQLITE_BUSY`) | **COOP+COEP** (`SharedArrayBuffer`) | SQLite3MC / VFS kustom | resmi dari proyek SQLite, worker-only |
| `sqlite-wasm` + `opfs-sahpool` | **tidak** (satu koneksi) | tidak | sama | tercepat untuk batch, tab kedua gagal membuka |
| SQLocal (wrapper) | ya lewat VFS `opfs`, event lintas-tab | COOP+COEP | sama | worker + reaktif + driver Drizzle/Kysely |
| PGlite | ya (IndexedDB) | tidak | tidak | Postgres-WASM, ukuran dan latensi berlebih untuk 25 tabel |

Sumber: [dokumentasi persistensi SQLite-WASM](https://sqlite.org/wasm/doc/trunk/persistence.md)
(OPFS worker-only, Safari 16.4+, perbedaan `opfs` vs `opfs-sahpool`),
[PowerSync, Mei 2026](https://powersync.com/blog/sqlite-persistence-on-the-web)
(wa-sqlite/SQLocal, SQLCipher tidak punya build WASM resmi),
[Notion](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
(pola satu penulis), dan [benchmark OPFS](https://opfs.dev/benchmarks)
(Safari punya masalah file-handle pada beberapa wrapper, bukan pada sqlite-wasm).

### 43.11.3 Keputusan

**Pakai `@sqlite.org/sqlite-wasm` di dedicated worker, VFS `opfs`, enkripsi
SQLite3 Multiple Ciphers (sqleet: ChaCha20-Poly1305 + HMAC), kunci 32 byte acak
dibungkus `masterSeed` dan hanya hidup di memori worker.** Alasan per pilihan:

1. **`opfs`, bukan `opfs-sahpool`**: NYX nyata dipakai di beberapa tab, dan
   `opfs-sahpool` menolak koneksi kedua. `opfs` butuh COOP/COEP; itu bisa
   ditambahkan di nginx/Vite dan tidak bentrok dengan CSP ketat yang sudah ada.
   Konsekuensinya harus diuji: `Cross-Origin-Embedder-Policy: require-corp`
   mewajibkan `Cross-Origin-Resource-Policy` pada aset lintas-origin (avatar R2,
   media) — kalau tidak, gambar mati. Ini pekerjaan Fase B, bukan kejutan.
2. **SQLite3MC, bukan VFS kripto sendiri**: primitif kustom berarti menulis
   ulang nonce, integritas per halaman, dan rollback — area yang tidak boleh
   bereksperimen. SQLite3MC MIT, format SQLCipher-4 kompatibel, punya build WASM,
   dan menambah ±25–35% waktu pada WebKit menurut
   [benchmark Evolu](https://www.evolu.dev/blog/evolu-builds-its-own-sqlite).
   Kunci tetap satu: `PRAGMA key = "x'…'"` sebelum query pertama.
3. **SQLocal sebagai pembungkus?** Tidak untuk sekarang. Yang dibutuhkan hanya
   worker + API query; menambah wrapper + driver ORM menambah dependensi dan
   lapisan yang harus diaudit. Pakai `@sqlite.org/sqlite-wasm` langsung dengan
   lapisan `web/src/lib/storage/` bertipe; Drizzle/Kysely bisa ditambahkan nanti
   tanpa mengubah skema ([SQLocal](https://sqlocal.dev/guide/introduction)).

**Jangan pernah fallback diam-diam ke `:memory:`** saat OPFS tidak tersedia
(Safari < 16.4, mode privat, storage diblokir). DB in-memory yang tampak bekerja
lalu hilang saat reload adalah kehilangan data yang menyamar sebagai fitur.
Jika `getDirectory()` gagal: tampilkan status "penyimpanan lokal tidak tersedia",
jangan izinkan sesi baru, dan arahkan ke `.nyxbak`.

### 43.11.4 Skema dan perilaku

- **Satu `this.version`** diganti satu `schema.sql` idempoten (`CREATE TABLE IF
  NOT EXISTS` + `PRAGMA user_version`). Tidak ada migrasi data: sesi dev boleh
  menghapus DB (postulat §43.1.5).
- **`messages`**: PK `(conversationId, orderKey)`; `orderKey` = `orderBucketMs`
  yang sudah ada; kolom ter-seal tetap `ENC1:` (properti, bukan format — §43.9).
  FTS5 (`unicode61`, `content=''`) untuk pencarian lokal; isi FTS ada di dalam
  halaman terenkripsi, jadi tidak menambah kebocoran at-rest.
- **Kunci & ratchet** tetap di tabel terpisah dengan `ENC1:` per nilai; jangan
  pindahkan ke kolom plaintext hanya karena SQLite punya tipe.
- **Transaksi**: satu penulis, `BEGIN IMMEDIATE` untuk tulis yang membaca dulu,
  `busy_timeout=5000`, `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=FULL`
  untuk pesan (durabilitas lebih penting daripada 1 ms).
- **Lintas tab**: SQLocal/SQLite tidak mengirim event; kirim `BroadcastChannel
  'nyx-db'` setelah commit, dan tab lain memakai `liveQuery`-nya sendiri. Uji dua
  tab di `storage.spec.ts`.
- **Backup `.nyxbak`**: `VACUUM INTO '/tmp/backup.db'` → baca file → seal dengan
  envelope yang sudah ada. Restore = buka file hasil dekripsi sebagai DB baru.
  Ini menghapus seluruh kode enumerasi tabel di `BACKUP_TABLE_ORDER`.
- **Lampiran** tetap di OPFS (`opfsStorage.ts`, 500 MB, sudah terenkripsi); SQLite
  hanya menyimpan metadata. Jangan pindahkan blob besar ke BLOB SQLite.

### 43.11.5 Ukuran dan risiko

- `sqlite3.wasm` ±1,3 MB (≈400 KB gzip). Worker memuatnya lazy saat unlock; PWA
  precache **wajib** memuatnya (`**/*.wasm`) supaya offline tetap jalan — biaya
  ini dibayar sekali, bukan per pesan. Dexie + `dexie-react-hooks` (±50 KB)
  hilang.
- **Safari ITP**: semua storage script-writable dihapus setelah 7 hari tanpa
  interaksi, dan quota browser ±60–80% disk (WebKit
  [kebijakan storage](https://webkit.org/blog/14403/updates-to-storage-policy)).
  Karena itu `navigator.storage.persist()` dipanggil saat onboarding (bukan
  diam-diam), dan `.nyxbak` tetap satu-satunya jaminan lintas perangkat.
- **Enkripsi ≠ anti-XSS**: kunci ada di memori tab saat unlocked; SQLite3MC hanya
  melindungi file di disk (profil browser dicuri, backup profil). Itu tetap
  sepadan: saat ini ciphertext per-field juga bisa dibaca kode halaman.

### 43.11.6 Urutan kerja (menggantikan §43.3.1)

| Langkah | Isi | Bukti |
|---|---|---|
| B1 | `web/src/lib/storage/` (interface `MessageStore`, `KeyStore`, `KvStore`) + worker SQLite + `schema.sql` + SQLite3MC | unit kontrak dijalankan terhadap Dexie **dan** SQLite |
| B2 | Pindahkan pembaca (`store/message.ts`, `keychainDb.ts`, `contactStore.ts`, KT) ke interface; dual-write di belakang flag DEV | E2E core + `storage.spec.ts` |
| B3 | Hapus Dexie, 16 versi, `dexieMigration.test.ts`, `db.ts`; `BACKUP_TABLE_ORDER` diganti `VACUUM INTO` | `pnpm -r run build`, unit, E2E penuh 2× |

---

## 43.12 Rekomendasi teknologi lain (dengan keputusan)

### 43.12.1 Ringkasan keputusan

| Area | Sekarang | Rekomendasi | Alasan |
|---|---|---|---|
| Transport | WebTransport + WSS | **WT jalur utama**, WSS fallback dipertahankan | Safari 26.4 (Mar 2026) membawa WT → Baseline; WSS tetap perlu untuk jaringan yang memblokir UDP/HTTP3 |
| OHTTP HPKE | X25519 (klasik) | **hybrid X-Wing** di gateway, dual-suite | RFC 9458 klasik; draft PQ HPKE sudah berjalan di `hpke-rs`/Divvi Up. Jangan kirim PQ-only sebelum gateway mengiklankannya |
| Grup | SPQR braid kustom | **tetap SPQR**, MLS ditunda | OpenMLS WASM ada (`js` feature), tapi ciphersuite-nya X25519/P-256 — melanggar §43.1.3 |
| PIR | XOR-PIR 2 server | **tetap**, benchmark SimplePIR bila direktori membesar | XOR-PIR tanpa hint; SimplePIR butuh hint 121 MB/1 GB DB; ZipPIR 2026 tanpa client storage |
| Blind signature | Blind RSA (dihapus) | **jangan adopsi PQ blind signature dulu** | BRaccoon 2026: 28 KB sig, 847 KB transcript, 2 ronde; MSIS 4,7 KB masih preprint |
| Pencarian lokal | filter JS | **FTS5** di DB terenkripsi | agregasi & FTS di dalam SQLite, bukan array |
| State UI | Zustand + array penuh | query SQLite + jendela halaman | `store/message.ts` 3.450 baris adalah gejala menyimpan seluruh riwayat di memori |

### 43.12.2 WebTransport sudah Baseline

Safari 26.4 (24 Maret 2026) mengaktifkan `WebTransport` secara default, dan MDN
menandainya **Baseline 2026** ([WebKit](https://webkit.org/blog/17862/webkit-features-for-safari-26-4),
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)). Konsekuensi
untuk NYX: sidecar Rust bukan lagi jalur "Chromium saja"; spec `transport`
boleh menjadi `mustPass` di WebKit **ketika** Playwright WebKit Linux mendukung
(di mesin ini belum — sudah tercatat di §43.10.3). Yang perlu diperbaiki:
`WEBTRANSPORT` gagal harus jatuh ke WSS **tanpa kehilangan pesan** (outbox tetap
`offlineQueue`), dan capability negotiation tetap satu sumber
(`SERVER_CAPABILITIES`).

Catatan implementasi: Safari memakai wire format WebTransport yang lebih tua di
beberapa versi dan pernah gagal sebelum `ready` terhadap server non-standar
([laporan interop](https://github.com/WilliamSmithEdward/embedio-neo/issues/525));
uji `chrome` dan `webkit` terhadap sidecar yang sama sebelum menganggap WT
universal.

### 43.12.3 MLS: tunda, jangan campur

OpenMLS 0.9.x bisa dikompilasi ke WASM (`js` feature) dan ada facade `mls-ts`
([OpenMLS](https://book.openmls.tech/user_manual/wasm.html), [mls-ts](https://mls4rn.dev/)).
Tetapi semua ciphersuite yang didukung adalah X25519/P-256 + AES-GCM/ChaCha20 —
klasik, tanpa ML-KEM. Mengadopsinya sekarang berarti menambah protokol klasik-saja,
kebalikan dari §43.1.3. Keputusan: **tunggu ciphersuite PQ MLS** (draft IETF),
lalu evaluasi OpenMLS; sampai itu SPQR tetap dan header v1 dibuang (§43.3.2).

### 43.12.4 OHTTP: hybrid HPKE, dual-suite

OHTTP (RFC 9458) memakai HPKE; implementasi PQ sudah tersedia sebagai draft:
`hpke-rs` di libcrux dan gateway Divvi Up sudah mengiklankan suite hybrid
([CE Labs](https://celabs.eu/blog/pq-hpke), [Divvi Up](https://divviup.org/blog/pq-secure)).
Rencana: gateway mengiklankan **dua** suite (X25519 dan X-Wing), klien memilih
hybrid bila ada, dan request tetap satu amplop per request. `hpke-js` punya modul
X-Wing eksperimental ([hpke-js](https://github.com/dajiaji/hpke-js)) — jangan
jadikan satu-satunya implementasi; verifikasi silang dengan vektor uji, pola yang
sama dengan `tools/dr-oracle`.

### 43.12.5 Blind RSA: penggantian di §43.4.1 sudah benar

Status riset 2026: BRaccoon adalah blind signature lattice pertama yang
concurrently secure dengan signature identik (28 KB, transcript 847 KB, 2 ronde)
([ePrint 2026/1084](https://eprint.iacr.org/2026/1084)); versi MSIS 4,7 KB masih
preprint ([2026/1690](https://eprint.iacr.org/2026/1690)). Keduanya belum cukup
matang untuk produksi. Keputusan §43.4.1 (token acak dari klien, issuer hanya
menyimpan HMAC, anonimitas dari OHTTP) tetap: **mekanisme diganti, bukan
primitifnya**. Tambahkan satu syarat: token 256-bit dari `crypto.getRandomValues`,
bukan hasil KDF dari identitas.

### 43.12.6 PIR: pertahankan XOR-PIR, siapkan benchmark pengganti

SimplePIR mencapai 10 GB/s/core tetapi membutuhkan hint 121 MB untuk DB 1 GB
([USENIX 2023](https://www.usenix.org/system/files/usenixsecurity23-henzinger.pdf));
ZipPIR 2026 mencapai >2 GB/s tanpa hint klien
([USENIX 2026](https://www.usenix.org/system/files/usenixsecurity26-mahdavi.pdf)).
Direktori NYX jauh lebih kecil dari 1 GB (100 ribu pengguna × ~200 B ≈ 20 MB),
sehingga hint SimplePIR akan kecil — tetapi tetap ada unduhan awal dan
preprocessing. XOR-PIR dua server tetap pilihan benar karena tidak menyimpan hint
apa pun di klien dan sudah terbukti 2,5 ms p50 (§6.7). Aksi: tambahkan
`scripts/bench/pir-variants.mjs` yang mengukur SimplePIR/ZipPIR pada ukuran
direktori NYX **sebelum** mempertimbangkan penggantian, dan jangan mengganti
selama `PIR_ENABLED` default mati.

### 43.12.7 Domain produksi

Per 16 November 2026 13:59 UTC, `nyx-app.my.id`, `app.nyx-app.my.id`, dan
`api.nyx-app.my.id` menjawab **HTTP 502 dari Cloudflare** (DNS ke `2606:4700:*`,
`server: cloudflare`, `retry-after: 60`). Artinya edge hidup tetapi origin/tunnel
mati — konsisten dengan layanan yang sengaja dimatikan. Sebelum layanan
dinyalakan lagi: `deploy.yml` (manual) → cek `/health` API → `/api/system/status`
→ sidecar → KT → PIR. Jangan menganggap 502 sebagai masalah DNS.

---

## 43.13 Yang tidak diubah oleh dokumen ini

- Primitive dan properti di §43.9 (padding 8 KB, `ENC1:` sebagai properti,
  `SERVER_CAPABILITIES`, KT fail-closed, LevelDB single-writer).
- Format wire SPQR v2, header grup v4, dan envelope `base64url(nonce||ct)` sampai
  fase penggantinya benar-benar selesai dan diuji lintas implementasi.
- Gate CI 12/12 dan branch protection 14 context; fase baru menambah job, bukan
  mengganti nama job yang sudah required.

## 43.14 Ukuran keberhasilan

| Fase | Metrik yang harus terukur |
|---|---|
| B | DB tunggal ≤ 2 MB wasm; reload 1.000 pesan < 50 ms; tanpa rantai versi; `storage.spec` hijau |
| G | suite inti PR ≤ 12 mnt; 0 tes non-opsional di luar `mustPass`; 4 spec baru hijau |
| H | OHTTP dual-suite diterima gateway; WT gagal → WSS tanpa pesan hilang |
| I | keputusan MLS tertulis dengan tanggal dan alasan, bukan "nanti" |
| J | 0 fitur "setengah terpasang" di §43.15; 0 flag default-mati tanpa dokumentasi + tes; template env tunggal |
| K | 0 kolom waktu non-ordering berpresisi penuh (tes skema); 0 URL/filename yang memuat userId; payload push tanpa id percakapan |
| L | 0 referensi tenant/B2B/embed tersisa di kode, skema, locale, dan marketing; `/api/engine` menjawab 404 |

---

## 43.15 Audit implementasi setengah jadi dan fitur yang masih mati

Diperiksa 16 November 2026 dengan cara yang bisa diulang: `rg` untuk
`TODO|FIXME|HACK|XXX` (tanpa `vendor/`, `dist/`, `docs/`), seluruh
`process.env.*` di `server/src` dan `import.meta.env.*` di `web/src`, daftar
rute yang benar-benar di-mount di `server/src/app.ts`, importer setiap berkas
`web/src/lib/*` (termasuk `React.lazy`/dynamic import), dan pemetaan spec E2E.
Hasilnya dua kelas masalah yang **berbeda**: (a) fitur yang kodenya utuh tetapi
sengaja mati karena butuh infra/kunci, dan (b) fitur yang benar-benar setengah.
Keduanya harus terlihat, karena "default mati" yang tidak tercatat berubah
menjadi "tidak pernah diuji" dalam beberapa minggu.

### 43.15.1 Fitur utuh tetapi default MATI

Semua baris di bawah **tersambung end-to-end** (server, klien, metrik). Yang
kurang hanya konfigurasi operator — jadi jangan menulis kode baru sebelum
bagian ini dinyalakan dan diuji.

| Fitur | Flag default | Yang harus ada untuk menyalakan | Risiko bila dinyalakan tanpa urutan |
|---|---|---|---|
| PIR dua server | `PIR_ENABLED` kosong; klien `VITE_PIR_ENABLED` kosong | 2 sidecar role a/b, `PIR_SERVERS`, `PIR_MANIFEST_KEYS`, `PIR_SIGNING_KEYS`, `PIR_SHARD_DIR`, `PIR_ADMIN_TOKEN`; klien butuh OHTTP + OPRF | **Indeks kosong**: `oprfIndex` hanya ditulis bila `PIR_OPRF_ENABLED=1` (`utils/searchOprf.ts:67`), jadi PIR menyala tanpa OPRF = semua query "tidak ditemukan" |
| OPRF pencarian | `PIR_OPRF_ENABLED` kosong; klien `VITE_PIR_OPRF_ENABLED` kosong | seed (`NYX_OPRF_SEED` atau pepper), flag server **dan** klien bersamaan | Akun lama belum punya `oprfIndex`; baru terisi saat login (`routes/auth.ts:598`) — belum ada skrip backfill |
| OHTTP | `OHTTP_ENABLED` kosong; klien `VITE_OHTTP_ENABLED` kosong | pasangan kunci (`ohttp-key:generate`), relay proses terpisah, `OHTTP_INTERNAL_TOKEN` sama di API+relay | Klien tidak punya fallback HTTP biasa; relay mati = pencarian mati, bukan "lambat" |
| KT baca | `KT_QUERY_URL` kosong | `nyx-kt-query-v2` + config ABI 2 | `/api/keys/kt/*` 503; semua verdict `unavailable`, banner muncul (fail-closed, bukan diam) |
| KT tulis | `KT_V2_SERVER_URL` kosong | penulis gRPC v2 + `KT_V2_SERVER_URL` | Rotasi kunci tidak ter-audit; monitor tidak bisa "active" |
| KT backfill | `KT_V2_BACKFILL_ON_LOGIN` kosong | flag `=1` setelah penulis hidup | Akun pra-v2 tidak pernah masuk log sampai login berikutnya |
| Push notification | `VAPID_SUBJECT/PUBLIC/PRIVATE` kosong | ketiganya di `server/.env` (deploy hanya meneruskan `VITE_VAPID_PUBLIC_KEY` dari secret, `deploy.yml:70`) | Server mencatat "push disabled"; UI tetap ada dan gagal diam-diam saat subscribe |
| Gerbang versi klien | `MIN_CLIENT_VERSION` kosong; `CLIENT_VERSION_REQUIRE_MUTATIONS` kosong | angka versi setelah populasi klien stabil | Mengunci klien lama dari mengirim pesan; jangan dinyalakan sebelum metrik 426 terlihat |
| Anti-abuse registrasi | `ABUSE_REGISTRATION_GUARD=off`, `ABUSE_REQUIRE_ATTESTATION=off` | guard `on`/`shadow`, bundle root attestation, keputusan `ALLOW_*` | `shadow` dulu; `on` bisa menolak perangkat tanpa authenticator |
| Privacy Pass wajib | `PP_SYNC_REQUIRED` kosong | kunci issuer stabil (`PP_ISSUER_PRIVATE_JWK`) + semua klien terbaru | Sync anonim lama tetap lolos tanpa bukti (by design, tapi jangan disebut "wajib") |
| Jitter rilis grup | `GROUP_RELEASE_JITTER_MS` kosong | angka ≤ 2000 ms | Menambah latensi; metrik `nyx_group_release_delay_ms` harus dipantau |
| Arsip riwayat link | **`LINK_HISTORY_ENABLED=on`** (default hidup) | kredensial R2 + lifecycle rule `link-history/` | Tanpa R2, `/limits.available=false` dan presign 503 — sudah terlihat, bukan diam |
| Pembayaran kripto | `NOWPAYMENTS_*` kosong | API key + IPN secret | **Tidak konsisten**: webhook fail-closed 503, tetapi `create-crypto-transaction` tanpa guard memanggil NOWPayments dengan `x-api-key` kosong lalu jatuh ke 500 generik (lihat §43.15.2) |

Catatan urutan yang tidak boleh dibalik: **OPRF → backfill `oprfIndex` → PIR →
OHTTP untuk klien**. PIR tanpa OPRF bukan "mode degraded", melainkan direktori
kosong; snapshot PIR hanya berisi user `where oprfIndex != null`
(`jobs/pirSnapshot.ts:57`).

`jobs/pirSnapshot.ts` juga sudah menyegarkan shard **tiap 3 menit bila ada
penulisan baru** (`PIR_DIRTY_REFRESH_CRON = '*/3 * * * *'`), bukan hanya 04:15.
Kalimat di `AGENTS.md` dan `docs/10` §10.19 yang menyatakan akun baru tidak bisa
dicari sampai 04:15 sudah basi dan harus dikoreksi saat menyentuh dokumen itu.

### 43.15.2 Implementasi setengah / tidak konsisten (harus diperbaiki)

| # | Temuan | Bukti | Yang kurang (definition of done) | Prioritas |
|---|---|---|---|---|
| 1 | `server/.env.example` **basi** | tidak memuat `PIR_ENABLED`, `OHTTP_ENABLED`, `PIR_OPRF_ENABLED`, `PP_*`, `NYX_AT_REST_KEYRING`; masih memuat `GROUP_ISSUER_KEY_PKCS8/VERSION` untuk blind-RSA grup yang **dihapus 2026-10-23** | satu template saja (root) atau sinkronkan; hapus kunci fitur yang sudah tidak dibaca | **P0** |
| 2 | Typo template root | `.env.example:321` berbunyi `VITE_PIR_RELAYS==` | `VITE_PIR_RELAYS=`; tambah pemeriksaan template di `check:status` atau skrip kecil | **P0** |
| 3 | Pembayaran tanpa guard | `routes/subscriptions.ts:21,47` tidak memeriksa `nowPaymentsApiKey`; webhook sudah 503 | jawab 503 `PAYMENTS_NOT_CONFIGURED` sebelum fetch, dan sembunyikan tombol upgrade bila `available:false` | **P0** |
| 4 | Endpoint kredensial grup zombie | `POST /api/groups/:id/credential/present` masih ada (`routes/groups.ts:474`) dan membaca `CREDENTIAL_SUITE_ALLOWLIST`, tetapi tidak ada verifier yang dikirim → selalu 403 `no_verifier` | hapus rute + flag + metrik `CREDENTIAL_PRESENT`, atau nyatakan sebagai API mati di `STATUS.md`; jangan biarkan route fail-closed tanpa pemilik | P1 |
| 5 | `/api/engine` + `/embed/chat/:id` tanpa pemilik | `server/src/routes/engine.ts` membuat room iframe dan mengembalikan URL; halaman embed ada; **tidak ada pemanggil `/api/engine` dari web, tidak ada E2E, tidak disebut di docs/STATUS**; prefix `/api/engine` dikecualikan dari CSRF (`app.ts:435`) | **Diputuskan: hapus seluruh tenant/B2B/embed.** Rencana lengkap + inventaris file di §43.17; jangan menambah tes untuk fitur ini | **P0** |
| 6 | Story tidak punya E2E | UI aktif (`ChatList.tsx:555` → `StoryTray` → `CreateStoryModal`/`StoryViewer`), server punya blocklist + rate limit + expiry 24 jam; **tidak ada spec E2E** dan tidak ada tes distribusi kunci story | satu spec: posting, terlihat oleh penerima kunci, tidak terlihat tanpa kunci, hilang setelah expiry, blokir 403 | P1 |
| 7 | Antrean offline tanpa E2E | `offlineQueueDb` dipakai `store/message.ts` (tulis saat putus, retry ≤5, drop + `FAILED`); tidak ada spec yang memuat ulang halaman saat offline | spec: kirim saat offline → reload → online → pesan terkirim tepat sekali | P1 |
| 8 | TODO di fork KT | `packages/keytrans-v2/src/proto/wire.proto:115` (`signature = 5; TODO`) dan `src/log.rs:432` (`PathMismatch maybe?`) | bukan bug NYX (kode upstream), tetapi catat sebagai batasan fork di `NOTICE` §2; jangan "memperbaiki" tanpa pindah pin | P2 |
| 9 | TODO deploy | `.github/workflows/deploy.yml:159` masih password SSH | pindah ke `secrets.VPS_SSH_KEY`; satu perubahan terkontrol, bukan saat deploy tergesa | P2 |
| 10 | Klaim PIR 04:15 basi | lihat §43.15.1 | koreksi `AGENTS.md` + `docs/10` §10.19 saat menyentuhnya | P1 |
| 11 | a11y baru 3 halaman | `web/e2e/a11y.spec.ts` (login, register, settings) | tambah `chat`, `privacy`, modal story; jalankan di config a11y | P2 |

### 43.15.3 Yang diperiksa dan **tidak** bermasalah

Agar audit ini tidak diulang dari nol: `offlineQueueDb` (dipakai, bukan mati),
`opfsStorage` (lampiran), `shadowVaultDb` (kunci story/riwayat, 33 referensi),
`searchIndex`/`messageSearch`, `coverTraffic` (default **hidup**,
`store/settings.ts:35`), `deliveryReceipts`, `groupMailbox`, `groupSync`,
`groupEpochRotation`, `groupPseudonyms`, `ktSubject`, `ktConfigPin`,
`pqBoxSeal`, `chaff`, `presenceSubscribe`, `refreshLock`/`refreshRetry`,
`linkHistoryExport/Import/Retry`, dan seluruh berkas `*Bench` (hanya dipanggil
skrip, memang bukan gate). Rute yang di-mount `app.ts` sudah lengkap; tidak ada
router yatim selain temuan #5.

### 43.15.4 Urutan kerja yang aman

1. **P0 dokumen/ops** (#1, #2, #3): satu template env, typo, guard pembayaran.
   Tidak menyentuh kripto dan bisa masuk satu PR.
2. **OPRF + backfill** (#43.15.1): skrip `oprf:backfill` yang menghitung
   `oprfIndex` untuk akun lama (idempoten, batch, log agregat) **sebelum** PIR
   dinyalakan.
3. **PIR**: sidecar a/b → rebuild manual → `/admin/rebuild` → query E2E dua
   relay → baru `PIR_ENABLED=1`.
4. **OHTTP**: kunci → relay proses terpisah → `OHTTP_INTERNAL_TOKEN` sama →
   klien `VITE_OHTTP_ENABLED=1` → buktikan tidak ada fallback.
5. **KT**: baca → tulis → backfill → monitor `active` di Privacy Self-Check.
6. **Push**: tiga VAPID + tes pengiriman nyata (bukan hanya tombol subscribe).
7. **Gerbang versi + anti-abuse** paling akhir; keduanya bisa mengunci pengguna.
8. **Keputusan hapus/pertahankan**: #4 masih perlu keputusan; #5 sudah
   diputuskan hapus (§43.17). E2E #6–#7 masuk Fase G.

Aturan tetap: setiap flag yang dinyalakan harus punya satu bukti round-trip
(metrik, baris DB, atau E2E) yang bisa ditunjukkan — bukan hanya "env sudah
diset". Ini aturan yang sama yang dipakai `privacyStatus.ts` (`active` vs
`configured`), dan alasan panel itu tidak menaikkan status hanya karena flag.

---

## 43.16 Audit metadata: transit dan server (linkability)

Audit statis 16 November 2026 atas 20 model di `server/prisma/schema.prisma`,
seluruh penulisan timestamp, jalur preview/upload/push, logging request, dan
header respons. Ini **bukan** dump-audit runtime (alat itu sudah ada di
`utils/dumpAudit.ts`); tujuannya menemukan sisa metadata yang masih bisa
mengaitkan akun, perangkat, percakapan, atau waktu — bukan mengulang klaim
"sudah sealed" yang sudah ada. `AGENTS.md` mode pre-launch menetapkan
anti-linkability sebagai north star, jadi temuan **P0** di §43.16.2 bersifat
wajib, bukan opsional.

### 43.16.1 Yang sudah benar (jangan diubah)

- **IP/UA tidak dipersist.** `RefreshToken` tidak punya `ipAddress`/`userAgent`;
  daftar sesi memakai `Device.nameSealed` + `jti` + `isCurrent`
  (`routes/sessions.ts:54`). Rate limit memakai tag HMAC `clientIpTag`, bukan IP.
- **Identitas ter-seal/tag:** `UserHiddenConversation.userId`, `MessageStatus.userId`
  (tag per-percakapan), `Message.senderId` (NULL di 1:1 / pseudonym grup),
  `Story.authorTag`, `BlockedUser.blockerTag/blockedTag`, `Device.nameSealed`,
  `Device.installationTag`, `PushSubscription.endpointSealed`.
- **Blind index ber-pepper:** `usernameHash`, `oprfIndex`, `shareId` acak; PK
  `uuid()` (bukan `cuid()` time-ordered).
- **Waktu sudah dikasar di jalur panas:** `Message.createdAt` + `expiresAt`
  (15 menit, `routes/messages.ts:235-240`), `MessageStatus.updatedAt`,
  `MessageViewOnceOpen.openedAt`, `Conversation.lastMessageAt`,
  `Device.lastActiveAt` (15 menit), `User.lastActiveDay` (harian).
- **Grup tanpa graf:** keanggotaan hanya `tokenHash`, mailbox tanpa kolom
  pengirim/penerima asli, `kind` + `tag` HMAC, `COVER` tersedia.
- **Upload hanya `application/octet-stream`** (blob terenkripsi), ukuran dikunci
  di presign, retensi di-clamp.
- **Transit dasar:** API `Cache-Control: no-store`, CSRF per-instalasi,
  `trust proxy` tepat 2 hop, CORS allowlist, HSTS/Referrer-Policy dari helmet,
  `X-Forwarded-For` mentah tidak dipercaya.
- **Push body generik** ("New Secure Message"), bukan isi pesan/nama pengirim.

### 43.16.2 Transit — temuan

| # | Temuan | Bukti | Dampak | Perbaikan (DoD) | P |
|---|---|---|---|---|---|
| T1 | **Preview link dikirim ke server saat mengetik** | `store/messageInput.ts:134-150` (`fetchTypingLinkPreview`) memanggil `POST /api/previews`; server fetch URL (`routes/previews.ts:14`), log kegagalan memuat URL penuh (`:22`, `sanitizeForLog` hanya membuang karakter kontrol), image lewat query (`components/LinkPreviewCard.tsx:40`) dengan `Cache-Control: public, max-age=86400` (`previews.ts:84`) | Server melihat **URL yang belum tentu dikirim**; URL masuk access log nginx/Cloudflare dan riwayat browser; cache bersama menyimpan gambar per URL; target melihat `NYX-Preview-Bot/1.0` + IP VPS | Jangan fetch saat mengetik: hanya setelah kirim atau opt-in. Image lewat body/opaque id, bukan query. `Cache-Control: private, no-store`. Log hanya hostname/hash. Uji: URL di log tidak memuat query | **P0** |
| T2 | **URL upload memuat userId + ekstensi asli** | `routes/uploads.ts:93` membentuk `key = `${folder}/${req.user.id}-${nanoid()}.${ext}`` dan mengembalikan `publicUrl`; `/uploads` memakai `Cross-Origin-Resource-Policy: cross-origin` + cache 1 tahun (`app.ts`) | Satu lampiran yang bocor mengaitkan semua file ke akun; ekstensi membocorkan jenis media walau body `octet-stream`; hotlink lintas situs | Key acak tanpa userId/ekstensi (`${folder}/${uuidv4()}`), metadata jenis hanya di klien; uji regex key tidak memuat userId dan tidak berakhiran ekstensi | **P0** |
| T3 | **Push membawa `conversationId`/`messageId` ke FCM/APNs** | `utils/sendPushNotification.ts:29-45` menaruh kedua id di `data` setiap notifikasi | Provider push dapat mengorelasikan perangkat, percakapan, dan irama pesan lintas waktu | Hilangkan id dari payload; kirim hanya sinyal "ada pesan" + token opaque per-subscription. Uji payload tidak memuat `conversationId`/`messageId` | **P0** |
| T4 | **Header sidik jari stack** | `app.ts:180-185` menetapkan `X-Edge-Relay`, `X-Sec-Protocol`, dan `X-Powered-By: NYX-Engine` **setelah** `app.disable('x-powered-by')` | Menambah fingerprint non-standar; `NYX-Engine` juga menempelkan nama fitur yang akan dihapus | Hapus ketiganya (atau satu header netral tanpa nama internal) | P1 |
| T5 | **UserId mentah di log** | `realtime/gateway.ts:289` (`Handler ${event} gagal untuk user ${userId}`), `network/redisBridge.ts:86` (error object dari payload upstream) | Log agregator/operator mendapat timeline akun; log bocor = identitas bocor | Ganti dengan tag HMAC (`userIdTag`), jangan log payload/identifier; uji tidak ada userId mentah | P1 |
| T6 | **Kompresi global termasuk `/api`** | `app.ts:79` `app.use(compression())` | Kelas BREACH: token CSRF di JSON + input yang bisa dipantulkan; ciphertext sendiri untungnya high-entropy | Filter: jangan kompres `/api`, atau `no-transform` untuk respons ber-token | P1 |
| T7 | **TURN plaintext didahulukan** | `.env.example:76` menaruh `turn:...?transport=udp` sebelum `turns:...:5349` | Metadata panggilan (IP peer, waktu) terlihat di jaringan bila klien memilih UDP | `turns:` lebih dulu/ satu-satunya di contoh produksi; dokumentasikan bahwa coturn tetap melihat IP peer (residual) | P1 |
| T8 | **OHTTP/PIR default mati** | lihat §43.15.1 | Pencarian belum anonim di deployment default | Sama dengan §43.15.4; jangan duplikasi pekerjaan | P1 |

### 43.16.3 Timestamp presisi yang belum dikasar

Prinsip yang sudah dipakai (`temporalBucket.ts`): waktu yang tidak dibutuhkan
untuk urutan tidak boleh presisi; bila dipakai untuk urutan, pakai bucket +
tie-break `id`. Sayangnya prinsip itu baru diterapkan di jalur pesan.

| Area | Kolom | Bukti | Kenapa bocor |
|---|---|---|---|
| Akun | `User.createdAt`, `User.updatedAt`, `User.bannedAt` | `schema.prisma` model `User` | Waktu daftar, waktu perubahan profil, waktu ban — presisi detik |
| Langganan | `User.subscriptionExpiresAt` | model `User` | Siklus pembayaran; cukup presisi hari |
| Perangkat/sesi | `Device.createdAt`, `RefreshToken.createdAt`, `RefreshToken.lastUsedAt`, `SessionKey.createdAt`, `PushSubscription.createdAt` | model terkait | `lastUsedAt` = jam online per perangkat (dipakai urut di `sessions.ts:50`); bucket 15 menit tetap menjaga urutan |
| Percakapan/grup | `Conversation.updatedAt`, `Conversation.epochRotatedAt`, `UserHiddenConversation.createdAt/expiresAt`, `GroupMailboxItem.createdAt`, `BlockedUser.createdAt` | model terkait | Waktu join/leave, rotasi kunci, distribusi envelope, dan blokir |
| Konten | `Story.createdAt` **dan** `Story.expiresAt`; `MessageViewOnceRecipient.createdAt` | model `Story`, `MessageViewOnceRecipient` | `expiresAt = createdAt + 24 jam` **mematikan** bucket: presisi tetap terbaca dari selisih; `MessageViewOnceOpen.openedAt` sudah bucket, tabel penerima belum |

DoD: satu putaran perubahan yang mengasar semua kolom di atas (15 menit untuk
aktivitas, harian untuk langganan), `expiresAt` diturunkan dari waktu yang sama,
dan tes skema yang **mengenumerasi field** (bukan hanya `MessageStatus`) supaya
model baru tidak lolos. `lastUsedAt` tetap boleh diurutkan; resolusinya cukup
15 menit.

### 43.16.4 Residual linkability dan tabel

| # | Temuan | Bukti | Status / DoD |
|---|---|---|---|
| R1 | **Edge graph tetap plaintext** | `Device.userId` (FK), `SessionKey.deviceId` + `conversationId`, `Message.conversationId`, `UserHiddenConversation.conversationId`; hanya `userId` keanggotaan yang sealed | Tak terhindarkan untuk routing, tetapi dump tetap bisa menggambar akun→perangkat→percakapan. Dokumentasikan sebagai residual; pertahankan purge `SessionKey` 30 hari; **jangan menambah edge plaintext baru** |
| R2 | **Volume pesan** | `Conversation.messageSeq` + `Message.seq` | Jumlah/urutan per percakapan terlihat walau isi dan ukuran di-pad. Residual; jangan tambah counter yang tidak perlu |
| R3 | **`banReason` teks bebas** | `schema.prisma` model `User` | Bisa memuat kutipan laporan/PII. Seal, atau batasi enum + catatan terpisah |
| R4 | **Fingerprint authenticator** | `Authenticator.credentialID`, `transports`, `credentialDeviceType`, `credentialBackedUp` | Kombinasi ini mencirikan model security key. Risiko rendah; pertimbangkan membuang `transports` bila tidak dipakai |
| R5 | **Kunci push + deviceId** | `PushSubscription.p256dh`/`auth` plaintext, `deviceId` FK | Bukan identifier sendiri, tetapi terikat perangkat. Endpoint sudah sealed; biarkan |
| R6 | **Tabel tak terpakai** | `MessageViewOnceRecipient`, `PreKeyBundle`, `GroupMailboxItem` **dipakai** lewat `utils/viewOnceRecipients.ts`, `utils/keyBundle.ts`, `utils/groupMailbox.ts`; satu-satunya tabel mati adalah `Tenant` | Tidak ada tabel yatim selain `Tenant`; hapus lewat §43.17 |
| R7 | **Identifier deterministik** | `usernameHash`, `oprfIndex` unik | Ber-pepper, jadi dump tanpa env tidak bisa membalik; enumerasi online dibatasi rate limit. Pertahankan |
| R8 | **Hash rahasia otoritas** | `Conversation.authSecret`, `adminSecretHash`, `Message.deleteSecret` | SHA-256 dari token 256-bit acak — benar, jangan diganti |
| R9 | **Dump audit belum memeriksa waktu/graph** | `utils/dumpAudit.ts:65` hanya daftar identitas | Tambah pemeriksaan timestamp presisi dan edge yang memang residual, supaya klaim §43.16 tidak bergantung pada bacaan manual |

### 43.16.5 Urutan perbaikan

> **Status 2026-11-17 — P0 implemented.** T1: preview tidak lagi diambil saat
> mengetik, image lewat body + `Cache-Control: private, no-store`, log hanya
> hostname. T2: key `<folder>/<uuid>` tanpa userId/ekstensi, kepemilikan hapus
> dibuktikan token HMAC dari presign. T3: payload push tanpa
> `conversationId`/`messageId`; deep link memakai `pushToken` opaque per
> pengiriman per subscription (Redis `push:link:<token>`, TTL 24 jam, ditukar
> lewat `POST /api/push/link`; token ditaruh di hash `/chat#push=…` agar tidak
> masuk access log). Bucket
> `Story`/`MessageViewOnceRecipient` memakai `messageTimeBucket()`, `@default(now())`
> dihapus. Tes: `pushPayload.test.ts`, `uploadLimits.test.ts`,
> `temporalBucket.test.ts`, `viewOnceRecipients.test.ts`.

1. **P0 (satu PR kecil):** T1 preview, T2 key upload, T3 payload push, plus
   bucket `Story.createdAt/expiresAt` + `MessageViewOnceRecipient.createdAt`.
2. **P1:** T4 header, T5 log, T6 kompresi, T7 TURN, sisa timestamp di §43.16.3,
   `banReason`.
3. **P2:** R9 perluasan `dumpAudit`, R1/R2 dokumentasi residual, R4.

Tes yang harus menyertai: (a) `temporalBucket.test.ts` mengenumerasi semua field
waktu non-ordering; (b) key upload tidak memuat userId/ekstensi; (c) payload
push tidak memuat id percakapan; (d) log preview tidak memuat query string;
(e) tidak ada `userId` mentah di logger gateway. Tanpa tes, aturan ini akan
kembali bocor pada model berikutnya.

### 43.16.6 Yang tidak diubah

Padding 8 KB, sealed sender, pseudonym grup, mailbox tanpa graf, `uuid` PK,
pelarangan IP/UA, cover traffic, dan pemisahan `ENC1:`/`ENC2:` tetap seperti
§43.13. Audit ini menambah disiplin waktu dan transit, bukan mengganti primitif.

---

## 43.17 Rencana penghapusan tenant / B2B / embed

> **Status (2026-11-17):** dieksekusi. Kode, skema, rute, UI, i18n, tes, dan
> halaman marketing B2B dihapus; `Tenant`/`externalIdSealed`/`metadata` tidak
> lagi ada di skema. Drop kolom fisik mengikuti `prisma db push` saat deploy.

Keputusan: fitur **tenant, B2B Engine, dan halaman embed dihapus seluruhnya**.
Alasannya bukan hanya "tanpa pemilik" (§43.15.2 #5), tetapi juga privasi:
`Tenant` mengelompokkan akun di bawah satu organisasi, `tenantId` menjadi edge
linkability lintas akun, dan `/api/engine` adalah satu-satunya prefix yang
dikecualikan dari CSRF. Ini dicatat **sebelum** kode disentuh; belum ada
penghapusan pada commit ini.

### 43.17.1 Prasyarat

- Konfirmasi greenfield: `SELECT count(*) FROM "Tenant";` = 0 dan tidak ada
  `User.tenantId`/`Conversation.tenantId` yang terisi. Bila ada baris,
  **berhenti dan selidiki** — mode pre-launch tidak menyediakan jalur ekspor,
  adapter kompatibilitas, atau handler legacy.
- Backup penuh + `pg_dump` sebelum `prisma db push` (untuk audit; bukan alasan
  menahan drop).
- Tidak ada konsumen eksternal `/api/engine/rooms` (marketing masih
  mengiklankannya — harus diperbarui di PR yang sama).
- Urutan deploy: tidak ada user aktif, jadi downtime singkat dapat diterima,
  tetapi proses lama tidak boleh melayani request setelah kolom hilang.

### 43.17.2 Inventaris kode

| Area | Lokasi | Tindakan |
|---|---|---|
| Skema | `Tenant` (`schema.prisma:84-99`); `User.tenantId`, `User.tenant`, `User.externalIdSealed`, `@@unique([tenantId, externalIdSealed])` (`:72-76`); `Conversation.tenantId`, `Conversation.tenant` (`:264-265`) | Hapus model, kolom, relasi, unique; lalu `prisma db push` |
| Server | `routes/engine.ts` (seluruh berkas); `middleware/tenantAuth.ts` (seluruh berkas) | Hapus |
| Server wiring | `app.ts:53` (import), `:435` (CSRF exemption `/api/engine`), `:526` (mount), `:183` (`X-Powered-By: NYX-Engine`) | Hapus import/mount/exemption; ganti header atau hapus (lihat T4) |
| Admin API | `routes/admin.ts:138-208` (`GET/POST /tenants`, `PATCH /tenants/:id/toggle`); import `sealAtRest`/`openAtRest` bila hanya dipakai di situ | Hapus tiga endpoint + import yang menjadi mati |
| Audit/at-rest | `utils/dumpAudit.ts:40-41,65` (target `externalIdSealed`); komentar tenant di `utils/atRestSecrets.ts:26` | Hapus target/konteks; perbarui komentar |
| Tes server | `tests/schemaPrivacy.test.ts:103-105,118,138-142,160-177` (D3/D4/D5/D11); `tests/temporalBucket.test.ts:117` (daftar model memuat `Tenant`); `tests/usernameBlindIndex.test.ts:101,131` (engine) | Hapus/ubah asersi tenant; keluarkan `Tenant` dari daftar; hapus import engine |
| Web | `pages/EmbedChatPage.tsx`; `App.tsx:25` (lazy) + `:732` (route) | Hapus halaman, import, route |
| Cookie embed | `lib/tokenStorage.ts:25,43-58` (`EMBED_ACCESS_COOKIE`, `setEmbedAccessCookie`, `eraseCookie` di clear); `middleware/auth.ts:14-18` (fallback `embed_at`); `app.ts:427` (`SESSION_COOKIES`) | Hapus cookie/token fallback; `SESSION_COOKIES` kembali `['at','rt']` |
| Admin UI | `pages/AdminDashboard.tsx:24-41` (interface), `48-160` (state/fungsi), `195-390` (tab/UI tenant) | Hapus; pertahankan dashboard, banned users, metrik |
| i18n | `web/public/locales/{en,es,id,pt-BR}/admin.json:23-40` (11 kunci tenant); `chat.json:208-211` (`embed`) | Hapus di keempat bahasa (aturan "semua locale" tetap) |
| Marketing | `marketing/src/pages/api-docs.astro:72-75`; `marketing/src/locales/*/api-docs.json` (deskripsi B2B + contoh `POST /api/engine/rooms`); `commercial.json` (enterprise/B2B) | Hapus/halaman diganti; build marketing |
| Docs | `docs/20-subscriptions.md` §20.3 + judul/ringkasan; `docs/07`, `09`, `10`, `11`, `12`, `13`, `14` §14.5, `21`, `22`, `28` (D4/D11), `30`; `docs/README` indeks | Perbarui; arsip `docs/audit/*` cukup diberi catatan "fitur dihapus" — jangan tulis ulang sejarah audit |
| Dokumen ini | §43.15.2 #5 | Tandai selesai setelah eksekusi (bukan dihapus) |

### 43.17.3 Urutan eksekusi

1. **Dokumen + marketing** (PR ini/berikutnya): hapus klaim B2B, tandai
   `docs/20` §20.3 superseded, perbarui §43.15.2 #5.
2. **Server:** hapus route/middleware/admin/wiring; perbarui tes; `tsc` +
   unit test server hijau tanpa `Tenant`.
3. **Web:** hapus halaman/route/cookie/admin UI/i18n; `tsc -b && vite build`
   hijau. Tidak ada spec E2E yang harus dihapus (memang tidak pernah ada).
4. **Skema:** hentikan API, `prisma db push` (setuju
   `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`), verifikasi kolom hilang,
   nyalakan API — satu kali, tanpa dual-run atau dua versi skema. Karena tidak
   ada user aktif, downtime singkat lebih murah daripada kompatibilitas.
5. **Verifikasi residual:** `rg` seluruh repo; cek dump/backup lama (masih
   memuat baris tenant sealed) sesuai kebijakan retensi; baru tutup tiket.

### 43.17.4 Definition of Done

- `rg -n -i "tenant|externalIdSealed|/api/engine|embed_at|EmbedChat"` di
  `server/src`, `server/prisma`, `web/src`, `web/public`, `marketing/src`
  **kosong** (kecuali arsip audit dan rencana ini).
- `/api/engine/rooms` → 404; `/embed/chat/:id` → 404/NotFound; tidak ada cookie
  `embed_at` yang ditulis klien.
- `pnpm -r build`; `npx tsc --noEmit` di `server/` dan `web/`; unit test
  `pnpm -r --if-present run test`; `npx oxlint src`; `node scripts/check-status.mjs`.
- Skema lokal: `\d "User"` tanpa `tenantId`/`externalIdSealed`, `\dt` tanpa
  `Tenant`; `dumpAudit`/skrip privacy-dump tidak lagi mengharapkan kolom itu.
- Satu tes regresi: route engine 404 dan halaman embed tidak lagi merender chat.

### 43.17.5 Risiko

- Drop kolom/tabel **ireversibel**; meski tidak ada data user, backup tetap
  dibuat untuk audit dan drop tidak dijalankan sebelum `Tenant` dipastikan kosong.
- `prisma db push` di `deploy.yml` berjalan sebelum restart pm2; bila kode lama
  masih hidup saat kolom hilang, request tenant akan error. Lakukan di jendela
  maintenance atau pisahkan langkahnya.
- Menghapus exemption CSRF `/api/engine` menutup permukaan, bukan membukanya —
  pastikan tidak ada klien lama yang masih memanggilnya.
- Menghapus `embed_at` menghilangkan token akses non-HttpOnly yang bisa dibaca
  JS — peningkatan keamanan, tetapi sesi embed yang sedang berjalan akan putus.
- Klaim privasi di `docs/28` D4/D11 menjadi usang; tandai superseded, jangan
  hapus riwayat audit.
