# 30 — Rencana Implementasi Pasca-Paritas (semua item docs/29 yang belum)

> **Status: RENCANA.** Belum ada kode dalam dokumen ini. Disusun 2026-10-11 dari:
> (a) `docs/26` (blueprint privasi grup), `docs/27` (total upgrade), `docs/28`
> (threat model dump), `docs/29` (analisis paritas Signal);
> (b) pembacaan langsung kode NYX (path/endpoint disitir di bawah);
> (c) pembacaan langsung repo Signal di `~/signal` — semua rujukan **di-pin ke commit**
> (lihat §30.2) supaya bisa direproduksi.
>
> Aturan dokumen ini selaras dengan `docs/04` (format kripto beku) dan `docs/28`
> (hardening at-rest): **tidak ada item yang boleh diimplementasikan "setengah".**
> Setiap workstream punya definisi selesai penuh + acceptance gate (§30.19).
> Yang tidak bisa diselesaikan sekarang (mis. MLS) ditulis eksplisit sebagai
> **gate**, bukan disamarkan sebagai "lite".

---

## 30.1 Prinsip kerja (non-negotiable)

1. **Tidak ada "lite".** Verifikasi kunci tidak dibangun sebagai "KT lite berbasis
   gossip di HP" lalu berhenti — itu tetap dikerjakan sebagai **cacat sementara
   yang diberi label**, dengan jalur ke KT penuh yang sudah dirancang (§30.4).
   Berlaku sama untuk PQ ratchet (FS+PCS, bukan FS saja) dan multi-device
   (N device bertanda tangan, bukan "1.5 device").
2. **Format beku tidak berubah** (`docs/04`): `ENC1:`, XChaCha envelope,
   `Array.from(...)`, padding 8KB, primitif. Fitur baru = **jalur versi paralel**
   yang dipilih lewat **negosiasi kapabilitas** (sudah landed, `docs/29` QW7).
3. **Setiap kolom server baru wajib lulus `docs/28`**: ter-seal/`ENC1:`,
   bucketing waktu, `identityTag` di Redis, tanpa userId di nilai cache; diperiksa
   `server/src/utils/dumpAudit.ts` + `server/scripts/privacy-dump-audit.ts`.
   Fitur yang tidak bisa lulus aturan ini **tidak boleh di-merge**.
4. **Tanpa telemetry beridentitas.** Metrik = hitungan event, tanpa label userId/
   IP/usernameHash.
5. **Test perilaku, bukan regex source** untuk endpoint baru (dokumen §5.8
   `docs/29`). Verifikasi kripto boleh tetap KAT (dan memang harus).
6. **Self-host tetap realistis.** Setiap proses baru (KT, coturn, Prometheus)
   harus muat di **satu VPS** dengan cerita operasional jelas (pm2/systemd +
   backup).
7. **Kode Signal yang diadopsi**: AGPL-3.0-only, kompatibel dengan NYX
   (AGPL-3.0) — wajib `NOTICE` + catat commit pin di `docs/25` +
   `docs/30` §30.2, dan ditulis di `CHANGELOG.md`. **`NOTICE` sudah ada di root
   (2026-10-14)**: tiga komponen Signal (crate `spqr`, `libsignal-keytrans`,
   `key-transparency-server`) beserta lisensi + commit pin + cara konsumsinya
   (awalnya checkout lokal sebagai path dependency; **di-revisi 2026-10-14**: sumber disalin ke `vendor/signal/` + `server/kt-query/vendor/`, artefak WASM tetap di-commit).

---

## 30.2 Pin referensi Signal (dibaca 2026-10-11)

| Repo | Commit | Dipakai untuk |
|---|---|---|
| `key-transparency-server` | `30b7a2a40604` (2026-08-18) | server log KT (Go, gRPC) + vektor uji auditor (`cmd/generate-auditing-test-vectors`) |
| `key-transparency-auditor` | `13a9126a6308` (2026-08-18) | auditor referensi (Java) — dasar **port Go** `cmd/nyx-kt-auditor` + fixture `katie_test_vectors.pb` (lihat `NOTICE` §4) |
| `libsignal` (`rust/keytrans`) | `e8cc2dddd578` (2026-09-22) | klien verifikasi KT (`verify.rs`, `log.rs`, `vrf.rs`, `commitments.rs`) |
| `SparsePostQuantumRatchet` | `06959b4708f9` (2026-09-16), crate `spqr` v1.6.0 | ratchet PQ FS+PCS (ML-KEM Braid) |
| `libsignal` (`rust/message-backup`) | commit sama | referensi desain format backup ber-frame |
| `Signal-Server` | `bdf3e1aea1b8` (2026-09-25) | `DeviceController`/`ProvisioningController`, `KeyTransparencyController`, `CallLinkController` |
| `Signal-Desktop` | `abe80d32445e` (2026-09-23) | `ts/services/keyTransparency.preload.ts` (alur klien + UI dialog) |

Temuan penting yang menyederhanakan NYX (dari pembacaan kode, bukan asumsi):

- KT server **sudah punya** tipe search key `UsernameHashPrefix = 'u'`
  (`cmd/shared/*.go`), dipakai di `cmd/kt-server/kt_query_handler.go:225`
  (`append([]byte{shared.UsernameHashPrefix}, req.UsernameHash...)`). Jadi
  **tidak ada perubahan protokol** di sisi server KT untuk NYX: search key =
  `0x75 || usernameHash(32 byte)`.
- Index prefix tree = **output ECVRF** atas search key
  (`tree/transparency/transparency.go:284` → `ECVRFProve`), panjang 32 byte
  (`tree/prefix/prefix.go:26 IndexLength = 32`). Karena `usernameHash` NYX sudah
  32 byte dari Argon2id 64MB, **log KT tidak menjadi kamus baru** — lebih kuat
  daripada Signal (yang memakai hash nomor telepon).
- Validasi tipe search key hanya melihat byte pertama
  (`cmd/kt-server/util.go:195`), tanpa batas panjang → kompatibel.
- Backend KT: `db/leveldb.go` (lokal, tanpa infra baru) + `memory.go` (test) +
  `dynamodb.go`. **LevelDB lokal** = pilihan default untuk VPS tunggal.
- Alat uji yang bisa langsung dipakai: `cmd/kt-client` (operasi manual),
  `cmd/generate-auditing-test-vectors` (vektor verifikasi auditor),
  `cmd/kt-stress` (beban).

---

## 30.3 Inventaris: apa yang sudah selesai vs yang tersisa

Status `docs/29` §8 (dengan bukti pengunci):

| # | Item `docs/29` | Status | Bukti |
|---|---|---|---|
| 1 | Gate + binding credential (§7.1) | ✅ | `server/tests/credentialIssuance.test.ts` |
| 2 | Verification state → keychain + hard gate (§7.2) | ✅ | `web/src/lib/__tests__/peerIdentityTrust.test.ts` |
| 3 | Buang fallback STUN Google (§7) | ✅ | `server/tests/turnIceServers.test.ts` |
| 4 | Bucket/`ENC1:` metadata lokal (§7.3) | ✅ (subset; penuh di WS-F) | `web/src/lib/__tests__/localAtRest.test.ts` |
| 5 | Lint hidup lagi (§7.4) | ✅ | `pnpm run lint` (oxlint, 0 error) |
| 6 | KAT lintas-implementasi (§5.8) | ✅ (primitif; DR/sender-key penuh di WS-G) | `server/tests/cryptoKnownAnswer.test.ts`, `web/…/argonKnownAnswer.test.ts` |
| 7 | Negosiasi kapabilitas (§5.6) | ✅ | `web/…/transportCapabilities.test.ts`, `cargo test` sidecar |
| 8 | KT lite (§5.1 tahap A) | ⛔ diganti | **tidak dikerjakan sebagai "lite"** — langsung KT penuh (WS-A) |
| 9 | Backup ber-frame (§5.3) + R2 | ✅ | WS-C fase 1–5 — `docs/31` §31.6a–d |
| 10 | Observability + k6 (`docs/27` §27.7) | 🟡 sebagian | WS-G — metrik/exporter/alert landed; sisa di §30.20 |
| 11 | Call privacy: coturn + signaling token (§5.7) | ✅ | WS-E — kredensial coturn HMAC (`utils/turnCredentials.ts`) + signaling lewat **token relay** yang dipetakan ke sesi aktif (`utils/callRelayTokens.ts`), target `to` tidak lagi userId |
| 12 | KT penuh (§5.1 tahap B + C) | ✅ | WS-A — penulis + verifier klien + layanan baca `server/kt-query` + **auditor/mode 3** (`kt-query/audit.go`) + **gossip tree head** (`web/src/lib/ktGossip.ts`, `GET /api/keys/kt/head`); residual di §30.20 M4 |
| 13 | Multi-device (§5.2) | ⛔ **DIBATALKAN** | non-goal permanen (§30.6, §30.18) — single-device = properti keamanan |
| 14 | SPQR PQ ratchet (§5.4) | ✅ | WS-D — integrasi jalur pesan landed (header v2 + `ackV` + state braid ter-seal + rollback + E2E chrome); detail `docs/33` |
| 15 | MLS (`docs/26` §26.8.2) | ⏸ gate 2027+ | WS-J |
| 16 | Klien native (push/background) | ⏸ proyek terpisah | WS-K |

Tambahan dari `docs/29` §5.5/§5.8/§7.5 yang belum tuntas: storage lokal penuh +
pencarian terenkripsi (WS-F), anti-abuse tanpa PII (WS-H), dedup helper E2E
(WS-G), test perilaku endpoint (WS-G), username links (WS-I).

---

## 30.4 Peta workstream

| WS | Deliverable (penuh) | Bergantung pada | Perkiraan | Risiko utama |
|---|---|---|---|---|
| **A** | KT penuh: server log + klien verifikasi + monitor/auditor + gossip | QW7 ✅, QW2 ✅ | 6–9 minggu | WASM compile; operasional log; UX konflik |
| ~~B~~ | ~~Multi-device~~ — **DIBATALKAN 2026-10-11** (§30.6): single active device adalah pilihan keamanan, bukan keterbatasan | — | — | — |
| **C** | Backup ber-frame terenkripsi + restore (perangkat PENGGANTI, bukan perangkat tertaut) + R2 opsional | alur `migration:*` yang sudah ada | 2–3 minggu | format jangka panjang; kompatibilitas |
| **D** | SPQR: PQ FS+PCS sebagai jalur versi paralel | QW7 ✅ (capability) | 6–10 minggu | WASM RNG; ukuran chunk; CPU |
| **E** | Calls: coturn self-host + signaling berbasis delivery token | — | 2–3 minggu | NAT/TLS ops; korelasi signaling |
| **F** | Storage lokal penuh + pencarian terenkripsi | — | 2 minggu | performa; migrasi data lama |
| **G** | Observability (Prometheus/Grafana + alert), k6, test perilaku, fuzzing, vektor DR/sender-key | — | 3–4 minggu | disiplin menulis test perilaku |
| **H** | Anti-abuse bertingkat tanpa PII | G (metrik) | 2 minggu | false positive; tanpa IP |
| **I** | Username links / contact discovery | — | 1 minggu | enumerasi |
| **J** | MLS (gate 2027+) | D + RFC | — | di luar kendali |
| **K** | Klien native (push/background) | B, C | proyek sendiri | butuh akun Apple/Google |

Spike yang harus jalan **lebih dulu** karena mengunci arsitektur:

- **Spike-1 (2–3 hari):** kompilasi `libsignal/rust/keytrans` → WASM (prost-build/
  protoc, `wasm32-unknown-unknown`) dan jalankan vektor dari
  `cmd/generate-auditing-test-vectors`. Kalau gagal → jalur fallback: port TS
  `verify.rs` (1404 baris) + `log.rs`/`prefix.rs`/`implicit.rs`/`commitments.rs`/
  `left_balanced.rs`/`vrf.rs` (total ±3.5k baris) ke `packages/shared/src/keytrans/`,
  **tetap diverifikasi oleh vektor yang sama**.
- **Spike-2 (2–3 hari):** kompilasi crate `spqr` → WASM + jalankan test vektor
  crate; ukur CPU/ukuran output untuk 1 ratchet step. Kalau gagal → tetap WASM
  tapi lewat crate pembungkus minimal yang meng-expose API message-key.

---

## 30.5 WS-A — Key Transparency penuh (tahap B + C)

**Tujuan:** server tidak bisa menyajikan prekey bundle palsu secara terarah tanpa
terdeteksi, dan deteksi tidak bergantung pada kejujuran server.

> **Status verifikasi (2026-10-17).** Penulis log **terpasang & terverifikasi**:
> 11 test di `server/tests/keyTransparency.test.ts` + 8 test
> `server/tests/ktIdentityLog.test.ts`, plus satu penulisan nyata ke binary Go
> `key-transparency-server` (instance terisolasi `127.0.0.1:18081`, ukuran pohon
> bertambah). **Tiga jalur rotasi kunci kini menulis ke log** (poin 2 di bawah);
> sisa yang jujur: `keyVersion` tetap label alur (bukan penghitung) — lihat
> `docs/32` §32.7 poin 2.

**Arsitektur (rekomendasi: pakai kode Signal apa adanya):**

1. **Proses `nyx-kt`** = binary Go dari `key-transparency-server` (pin teratas),
   backend **LevelDB lokal** (`/root/nyx-kt/leveldb`), listen gRPC **hanya di
   loopback** (`127.0.0.1:8443`), dijalankan pm2/systemd berdampingan dengan
   `nyx-api`/`nyx-sidecar`. Snapshot LevelDB → R2 harian (tanpa kunci di box?
   kuncinya ada di box — dicatat sebagai residual).
2. **Penulis log (Node)**: `server/src/utils/keyTransparency.ts` memanggil Update
   (gRPC internal) untuk **semua** perubahan kunci identitas. Nilai yang masuk
   log: `usernameHash → { identityKey, pqIdentityKey, signingKey, keyVersion,
   updatedAtBucket }`. **Tidak** ada userId, IP, nama. Log ditulis *setelah*
   commit DB sukses, fire-and-forget (idempoten lewat
   `(searchKey, keyVersion, digest nilai)`), dengan **label alur**
   (`KT_KEY_VERSION_*`, bukan angka sihir):
   - `register` → `routes/auth.ts`, label registrasi.
   - `recover` → `routes/auth.ts`, label pemulihan.
   - **Rotasi kunci** (`routes/keys.ts` `POST /keys/prekey-bundle`,
     `routes/users.ts` `PUT /users/me/keys`, re-sync kunci `POST /auth/login`)
     → `utils/ktIdentityLog.ts`, label rotasi. Bandingkan material sebelum/sesudah:
     upload ulang bundle yang sama (auto-heal, login biasa) **tidak** menghasilkan
     entri. Karena server hanya menyimpan identifier ter-pepper
     (`pepperedIdentifier`) dan tak bisa menurunkan search key darinya, klien
     melampirkan identifier mentah (Argon2id 32 byte) — `usernameHash` — pada
     upload bundle; **kepemilikannya diverifikasi** sebelum menulis
     (`identifierLookupCandidates(kiriman)` harus memuat `User.usernameHash`),
     atau siapa pun yang login bisa menulis ke search key akun lain.
     Klien menyimpannya ter-seal `ENC1:` scoped per user (`keyStorage`).
   - Jalur yang **tetap tidak menulis log**: device dummy iframe B2B
     (`routes/engine.ts`) — akun tenant dengan kunci dummy, tidak punya
     identifier Argon2id.

   Jalur mana yang menimpa `Device.publicKey` dikunci guard
   `tests/keyTransparency.test.ts` (`wiring: jalur yang menimpa Device.publicKey …`)
   dan `tests/ktIdentityLog.test.ts` (`wiring: tiga jalur rotasi memanggil penulis
   log`) supaya jalur baru tidak lolos tanpa keputusan.
3. **Klien verifikasi (web)**: modul baru `web/src/lib/keyTransparency.ts` +
   WASM (Spike-1) yang dipanggil dari `crypto.worker.ts` (op baru, file tidak
   dipecah — aturan `docs/04` tetap). Alur:
   - **Search proof** diverifikasi sebelum bundle dipakai untuk X3DH
     (`web/src/utils/crypto.ts` jalur `processPreKeyBundle`/`encrypt`).
   - **Monitor**: setiap kontak memonitor key kita (dan kita memonitor kontaknya)
     → perubahan key memicu *notification* dari log, bukan kepercayaan pada
     bundle yang dikirim server.
   - **Distinguished key**: entry per akun (`distinguished` search key) berisi
     komitmen **satu** perangkat + `keyVersion`. Karena NYX tetap single-device
     (§30.6), tidak ada daftar device untuk dilindungi — entry ini yang membuat
     rotasi kunci (re-pair/klaim ulang perangkat) terlihat oleh semua klien,
     bukan hanya oleh kontak yang kebetulan melihat bundle baru.
   - **Konflik = hard gate**: sudah ada mekanisme gate kirim dari QW2
     (`web/src/lib/peerIdentityTrust.ts`); KT hanya mengganti *sumber kebenaran*
     dari TOFU → log.
4. **Tahap C (auditor + gossip) — LANDED**: verifikasi berkala dilakukan loop
   monitor (`ktBundleProof.monitorKeyTransparency` + `ktMonitoring`), **bukan**
   modul `keyTransparencyAudit.ts` terpisah — WASM sudah menyediakan
   `verify_monitor`, jadi tidak ada modul baru yang perlu ditulis. Auditor pihak
   ketiga dilayani `server/kt-query` (`TreeSize`/`Audit`/`SetAuditorHead`,
   `audit.go`) memakai verifikasi upstream; gossip tree head hidup di
   `web/src/lib/ktGossip.ts` (payload ter-seal `ktG`) + `GET /api/keys/kt/head`,
   dan split-view (ukuran pohon sama, root beda) dilaporkan + memicu
   `chat:banners.kt_split_view`.

   **Auditor dioperasikan (2026-10-16).** Proses auditor nyata ada di repo ini:
   `server/kt-query/cmd/nyx-kt-auditor` (Go) — port baris-per-baris verifikasi
   dari `signalapp/key-transparency-auditor` (Java, auditor referensi Signal),
   diuji terhadap **vektor resmi** (`testdata/katie_test_vectors.pb`: 10 update
   `should_succeed` dengan root hash tiap langkah, 5 vektor `should_fail`, dan
   tanda tangan tree head byte-per-byte), dan berjalan sebagai unit systemd
   terpisah (`ops/systemd/nyx-kt-auditor.service`) yang hanya bicara lewat gRPC
   loopback. Diaktifkan dengan menambahkan entri `api.auditors` + kunci publik
   auditor di config log.

   **Sisa jujur tahap C:** (a) ~~auditor belum dioperasikan~~ — **selesai**
   (`docs/32` §32.4 poin 4, `server/kt-query/README.md`), dengan catatan auditor
   ini berjalan di host yang sama dengan log: ia membuktikan konsistensi riwayat,
   bukan independensi organisasi; (b) interop `cmd/kt-client` upstream tetap
   **tidak** dijalankan (ia `package main` dan tidak di-vendor) — perannya
   diambil `nyx-kt-check` (`verify-search`/`tree-size`/`audit`); gate vektor
   `cmd/generate-auditing-test-vectors` kini **ada padanannya** di suite Go
   (`nyx-kt-auditor/vectors_test.go`) yang dijalankan CI lewat `go test ./...`.

**Yang TIDAK dilakukan:** gossip "lite" di HP sebagai pengganti log (dihapus dari
rencana — itu bukan KT, hanya TOFU kolektif).

**Acceptance gate WS-A:**

1. **Sebagian**: jalur auditor diverifikasi `server/kt-query/audit_test.go`
   memakai **verifier upstream** yang sama dengan WASM (`VerifySearch` menolak
   bukti mode 3 tanpa auditor head, menerimanya setelah `SetAuditorHead`,
   menolaknya bila tanda tangan diubah/kunci lain/di luar mode), **dan** port
   auditor (`cmd/nyx-kt-auditor`) diuji terhadap vektor resmi Signal + dijalankan
   nyata di self-host. Yang **belum**: menjalankan binari
   `cmd/generate-auditing-test-vectors` di CI — ia `package
   main` di repo upstream dan tidak di-vendor (butuh vendor khusus + parser
   vektor).
2. **Sebagian**: interop dibuktikan lewat jalur penulis → `kt-query` → WASM
   (`keyTransparency.test.ts` + fixture dari layanan nyata). `cmd/kt-client`
   tidak dijalankan (alasan sama seperti poin 1).
3. **Simulasi MITM**: test integrasi di mana server mengembalikan bundle palsu →
   klien **menolak** dengan bukti ketidakcocokan log (bukan sekadar warning TOFU),
   dan pengiriman terblokir sampai user menyelesaikan konfirmasi.
4. Audit privasi: `privacy-dump-audit.ts` tetap lulus; log LevelDB tidak memuat
   nilai yang memetakan ke akun tanpa `usernameHash` (yang sudah memory-hard).
5. Degradasi terlihat: `nyx-kt` mati → klien jalan dengan TOFU (verdict
   `unavailable` tersimpan + dicatat, backoff 5 menit; metrik
   `nyx_kt_queries_total{result="disabled"|"error"}`). **Tidak ada banner** —
   yang tampil ke user hanya toast saat `keyVersion` naik; banner akan ditambah
   bila audit UI menuntutnya.
6. Rollback: **`KT_QUERY_URL` dikosongkan** → `/api/keys/kt/*` menjawab 503 dan
   klien kembali ke TOFU tanpa perubahan kode. Kapabilitas
   `CLIENT_CAPABILITIES.KT_LITE` (`packages/shared/src/transport.ts`) masih
   **dideklarasikan tetapi tidak pernah diiklankan/dibaca** — dulu disebut
   sebagai gerbang rollback, nyatanya bukan; jangan hapus deklarasinya, dan
   jangan pakai sebagai gerbang sebelum benar-benar diiklankan sidecar.

**Risiko & mitigasi:** WASM gagal → fallback port TS dengan vektor yang sama
(diuji); LevelDB tumbuh → metrik ukuran + snapshot R2 + retensi tree head lama;
CPU VPS → VRF per request sudah di-cache di server KT (`db/cache_control.go`),
diukur dengan `kt-stress` sebelum rilis; UX konflik → dialog seperti
`KeyTransparencyErrorDialog` Signal-Desktop (referensi, bukan copy).

---

## 30.6 WS-B — Multi-device: **DIBATALKAN** (non-goal permanen, keputusan 2026-10-11)

**Keputusan:** NYX tidak akan mendukung multi-device. Satu akun = satu
perangkat aktif, dan itu dipertahankan sebagai properti keamanan.

Alasan (menggantikan seluruh rencana di bawah): NYX sengaja memilih "1 perangkat
aktif" (`server/src/network/redisBridge.ts:142 isActiveDeviceAllowed`) karena
setiap perangkat tambahan menghadirkan kembali kelas masalah yang justru mau
dihindari: daftar device yang bisa disalahgunakan, fan-out kunci per device,
sinkronisasi contact graph/verification/admin token, dan layanan storage
ber-kunci-akun. Menambah perangkat = menambah permukaan serangan tanpa menambah
jaminan kripto.

Yang berubah karena keputusan ini:

1. `CLIENT_CAPABILITIES.MULTI_DEVICE` dihapus dari
   `packages/shared/src/transport.ts` (kapabilitas untuk fitur yang tidak akan
   pernah ada hanya menyesatkan).
2. KT (WS-A) tidak menyimpan/melindungi daftar device; `distinguished` key =
   komitmen satu perangkat + `keyVersion` (§30.5).
3. WS-C (backup) menargetkan **perangkat pengganti** (device hilang/rusak) lewat
   alur `migration:*` yang sudah ada — bukan perangkat tertaut.
4. Jalur pemulihan resmi: recovery phrase (registrasi/restore) + backup
   ber-frame (WS-C). Tidak ada storage service per-akun.
5. Yang TETAP dipertahankan dari catatan lama di bawah: penguatan `migration:*`
   sebagai transfer vault (bukan penambahan device) dan rotasi kunci saat kick —
   keduanya tetap relevan untuk skenario penggantian perangkat.

<details>
<summary>Rencana lama (arsip — tidak dikerjakan)</summary>

### Arsip: rencana WS-B pra-keputusan

**Perubahan konsep:** dari "one user, one active device"
(`server/src/network/redisBridge.ts:142` `isActiveDeviceAllowed`, dipanggil per
opcode) → **device list bertanda tangan dengan N perangkat tertaut**.

1. **Model & skema (Prisma):** tabel `LinkedDevice` (atau perluas `Device`)
   dengan `devicePublicKey`, `deviceNameSealed`, `addedAtBucket`, dan
   `DeviceListVersion` + **tanda tangan identity key** atas
   `(userId, version, [deviceKey…])`. Server menyimpan tanda tangan, **tidak bisa
   memalsukan**; klien memverifikasi (dan entry `distinguished` di KT dari WS-A
   mengikat daftar ini — dua fitur saling mengunci).
2. **Enforcement:** `isActiveDeviceAllowed` → `isDeviceLinked(userId, deviceId)`
   dengan cache & invalidasi Redis yang sudah ada; tambah batas jumlah device
   (mis. 5) + kuota penautan.
3. **Fan-out:** amplop per-device sudah jadi norma (`targetDeviceId`/
   `targetDeviceKey` di sender-key v2, `sendToDevice` di `redisBridge.ts:94`) —
   perluas ke semua jalur user-scoped: `message:send`, ACK, presence, story,
   key dist, dst. Modul baru: `server/src/utils/deviceFanout.ts` yang menerima
   satu payload + daftar device → kirim paralel (bounded concurrency).
4. **Provisioning:** QR "Tambah perangkat" memakai alur linking yang ada
   (`auth:request_linking_qr`, `migration:start|chunk|ack` di
   `server/src/network/realtimeHandlers.ts:804-845`), diubah dari *pindah vault*
   → *tambah perangkat* (state transfer, bukan move).
5. **SYNC/COPY antar perangkat:** keluarga event baru (`device:sync_*`) untuk
   `contactStore`, verification state (QW2), settings, admin token grup, dan
   state sender-key/era. Riwayat pesan **tidak** disinkronkan di jalur ini —
   itu tugas WS-C (backup) supaya volume tidak meledak.
6. **Storage service minimal:** blob terenkripsi per akun di R2 (bucket privat,
   key = opaque id, bukan userId), dibuka oleh kunci turunan `masterSeed` →
   prasyarat WS-C.
7. **Push per device:** `PushSubscription` per device dengan payload ter-seal
   (sudah ada) + dedup notifikasi lintas device.

**Acceptance gate WS-B:** (1) dua profil Chrome nyata, keduanya login akun yang
sama, saling mengirim & menerima pesan terenkripsi; (2) device list diverifikasi
tanda tangannya dan percobaan server memalsukan device → ditolak klien;
(3) "kick device" memicu rotasi (era/pseudonym) dan device yang di-kick tidak
bisa mendekripsi pesan baru; (4) semua test single-device lama tetap hijau;
(5) audit: skema baru lulus `docs/28` (nama device ter-seal, waktu ter-bucket,
tidak ada userId di Redis).

### Arsip: catatan non-negotiable (tetap berlaku untuk skenario penggantian perangkat)

Server tidak boleh tahu *aktivitas* perangkat, hanya identitas sesi aktif
(dipakai untuk kick/rotasi). Ini sudah berlaku di single-device dan **tidak**
berubah oleh pembatalan multi-device.

</details>

---

## 30.7 WS-C — Backup ber-frame terenkripsi + restore (perangkat pengganti)

Baseline sekarang: `exportDatabaseToJson`/`importDatabaseFromJson`
(`web/src/lib/keychainDb.ts:827,876`) = satu JSON besar, tanpa validasi format,
tanpa sinkronisasi.

**Desain format (dokumen baru `docs/31-backup-format.md` — dibuat saat WS-C mulai), mengambil *properti*
dari `libsignal/rust/message-backup`):**

- Envelope frame: `[magic|formatVersion|frameType|frameIndex|len|ciphertext|tag]`
  dengan `frameType` = account | contacts | conversation | message | story |
  settings | tombstone; setiap frame dienkripsi terpisah (XChaCha20-Poly1305,
  nonce dari counter frame) + HMAC di atas header (anti reorder/truncate).
- Kunci backup: BIP39 recovery phrase (sudah ada: `entropyToMnemonic`/
  `mnemonicToEntropy` di `crypto.worker.ts:1199,1211`) → Argon2id
  (`ARGON_VAULT_CONFIG` 128MB) → `backupKey`; salt disimpan di header.
- **Padding & scramble**: setiap frame di-pad ke kelipatan blok (bocor ukuran
  dihilangkan), urutan frame untuk tipe tertentu diacak (referensi:
  `message-backup/src/scramble/`) sehingga bentuk backup tidak membocorkan
  struktur sosial.
- Properti yang diuji: `serialize(backup) == serialize(export(restoreFrom(backup)))`
  (idempotensi roundtrip) + deteksi tamper per frame + deteksi truncate.
- Streaming: export/import berjalan per frame (bukan satu string JSON di memori)
  supaya DB besar tidak mematikan tab.

**Transport & penyimpanan:** endpoint baru `POST /api/backup/presign`
(folder privat `backups/`, kuota per akun, konten `application/octet-stream`,
tanpa metadata isi) memakai `server/src/utils/r2.ts` yang sudah ada; opsional
"backup otomatis" mingguan dari klien + tombol restore di perangkat baru.
Skenario tanpa server tetap ada: file `.nyxbak` bisa diunduh/dipindah manual.

**Acceptance gate WS-C:** (1) property test roundtrip + tamper/reorder/truncate;
(2) backup 10k pesan: ukuran ≤ X MB, waktu export ≤ 30s di perangkat kelas
menengah, restore ke **perangkat pengganti** selesai tanpa akses server (file
dipindah manual atau lewat R2); (3) restore menghasilkan state identik
(contacts, verification, era grup) di perangkat pengganti lewat alur
`migration:*`; (4) key tidak pernah dikirim ke server (audit: server hanya
melihat blob).

---

## 30.8 WS-D — SPQR: PQ forward secrecy **dan** post-compromise security

Sekarang: DR hybrid dengan langkah KEM (`KEMs`/`KEMr`/`savedCt` di
`web/src/workers/crypto.worker.ts:477-540`, header `ct` 1120 byte sampai `ackKem`)
= PQ **FS** saja.

**Desain:** jalur versi paralel (aturan `docs/04`), dipilih lewat kapabilitas
`spqr-ratchet` (sudah dideklarasikan di `packages/shared/src/transport.ts`,
sengaja *belum* diiklankan klien):

1. Crate `spqr` (pin §30.2) dikompilasi ke WASM → `packages/spqr-wasm/`, dipanggil
   dari `crypto.worker.ts` sebagai *message-key generator* (API sama semangatnya
   dengan libsodium sekarang: output key, bukan format pesan).
2. Chain simetris (message key → XChaCha20-Poly1305) **dipertahankan**, sehingga
   format pesan di wire tidak berubah drastis; yang berubah hanya cara menghasilkan
   `KEMs/KEMr` (ML-KEM Braid + erasure coding Reed–Solomon dari
   `spqr/src/encoding/polynomial.rs`) dan penanganan chunk besar.
3. **Anti-downgrade**: jalur v2 hanya aktif bila **kedua** klien mengiklankan
   kapabilitas; server tidak pernah menentukan pilihan primitif. Peer lama tetap
   jalur v1 (dan state v1 tetap dipertahankan di keychain, `ENC1:`).
4. **PCS teruji**: test skenario kompromi state → pesan berikutnya (setelah
   pertukaran braid) tidak terbaca; FS tetap: state lama tidak bisa membaca
   pesan lampau.

**Acceptance gate WS-D:** (1) test vektor milik crate `spqr` lulus di WASM;
(2) property test packet loss 1..N−1 chunk → pesan tetap dapat direkonstruksi
(erasure coding benar-benar bekerja); (3) interop: klien-WASM ↔ klien-v1 saling
kirim tanpa regresi; (4) tidak ada panic/abort WASM pada input acak (fuzz);
(5) benchmark: ukuran pesan & CPU per ratchet step diukur dan dicatat (VPS 4c).

---

## 30.9 WS-E — Calls: coturn sendiri + signaling tidak ter-link ke akun

Sekarang: TURN Cloudflare + `ICE_STUN_URLS` operator (QW3 sudah membuang fallback
Google), signaling `WEBRTC_SIGNAL` dirutekan `to: userId` (`docs/29` §5.7).

1. **coturn self-host** (systemd di VPS): `3478/udp+tcp`, `5349/tls`,
   `use-auth-secret` + `static-auth-secret`; `/api/keys/turn`
   (`server/src/routes/keys.ts:609`) menerbitkan kredensial **time-limited**
   (HMAC username/timestamp) dan menjadikan Cloudflare TURN sebagai cadangan
   opsional, bukan primer.
2. **Signaling berbasis delivery token (T3b)**: pemetaan `token → sesi aktif`
   (Redis, ter-`identityTag`), sehingga percobaan call tidak ter-link ke akun di
   log/DB. Delivery token grup sudah ada sebagai pola — dipakai juga untuk 1:1.
3. **Call links** (opsional, setelah 2): token sekali pakai + expiry, mengikuti
   pola `CallLinkController` Signal sebagai referensi desain.
4. **Non-goal tetap**: multi-party SFU (`docs/26` §26.3, `docs/27` §27.8).

**Acceptance gate WS-E:** (1) E2E call 1:1 di CI chrome (`--project=chrome`)
dengan coturn; (2) tidak ada hostname pihak ketiga di jalur ICE (test source +
runtime); (3) audit log server: tidak ada `userId` di jalur signaling call;
(4) TURN mati → UI error eksplisit (`call_no_turn` sudah ada di 4 bahasa).

**Status gate (2026-10-15):** (1) ✅ `web/e2e/call.spec.ts` dijalankan Chrome
penuh terhadap coturn di CI (`e2e-chrome` memasang + menjalankan coturn sendiri,
`allow-loopback-peers` khusus runner) — bukan hanya di mesin dev; (2) ✅ spesifikasi
uji menyaring entri ICE ke kredensial coturn saja (`username` berpola
`<unixExpiry>:`) dan menolak kredensial Cloudflare sebagai bukti, sehingga test
**tidak bisa lulus** lewat pihak ketiga; (3) ✅ struktur token relay (§30.9 poin 2)
+ guardrail unit test yang menolak `userId` di envelope; (4) ✅ `call_no_turn`.
Yang **masih** tersisa dari WS-E hanya sisi operasi: coturn systemd di VPS (kode
sudah siap; `docs/10` §10.4).

---

## 30.10 WS-F — Storage lokal penuh + pencarian terenkripsi

QW4 baru menutup sebagian: `lastMessageAt` di-bucket + `seq`/angka sensitif
di-seal (`bucketLocalTimestamp`/`sealLocalNumber` di `web/src/lib/localAtRest.ts`).
Sisa yang masih plaintext (`web/src/lib/db.ts`):
`ConversationRecord.isGroup|isPinned|isArchived`,
`DecryptedMessageRecord.createdAt|senderId|status|isViewOnce|expiresAt|repliedToId|seq`,
`ContactRow.updatedAt`.

1. Perluas `web/src/lib/localAtRest.ts` → seal semua kolom struktural dengan
   kunci turunan `masterSeed`; urutan pesan memakai kolom ter-seal-ordering
   (HMAC/bucket) sehingga sorting tidak butuh plaintext.
2. **Migrasi** data lama (plaintext) → seal saat unlock (`saveDeviceAutoUnlockKey`
   jalur yang sudah ada), idempoten, dan aman untuk rollback (baris terbaca dua
   format).
3. **Pencarian**: indeks in-memory saat vault terbuka (kata → messageId, dibangun
   dari plaintext yang sudah didekripsi di memori), plus jalur opsional
   token-HMAC ke disk untuk pencarian setelah reload. Tidak ada FTS plaintext.
4. Ukur: 10k pesan → waktu build indeks & memori.

**Acceptance gate WS-F:** (1) inspeksi IndexedDB (test + manual) tidak
memperlihatkan pola aktivitas (jumlah pesan per hari, jam, grup/1:1); (2) urutan
pesan tetap benar setelah reload & wipe; (3) pencarian < 100ms untuk 10k pesan;
(4) test lama `localAtRest`/`vaultSeqPersistence` tetap hijau.

**Status gate (2026-10-16):** (1) ✅ **kecuali granularitas bucket** — pemindai
baris mentah (`findActivityLeaks` di `web/src/lib/__tests__/dexieMigration.test.ts`,
**IndexedDB nyata + Dexie nyata**) menyapu semua tabel dan melaporkan **nol**
kebocoran, dengan **kontrol negatif** yang membuktikan pemindainya tidak buta
(baris bocor buatan → ≥5 temuan). Yang **tetap** terbaca dan diterima secara
desain, bukan lupa: `orderBucketMs`/`lastMessageAt` di bucket 15 menit + jumlah
baris per bucket. Keduanya sudah bocor di server dengan skema yang sama
(`docs/28` Tier 2 — B3/B4), jadi gate "jumlah pesan per hari/jam" tertutup sampai
**presisi bucket**, bukan nol informasi — pernyataan jujurnya ada di §30.20 M7.
Sisa plaintext yang tidak bisa di-seal tanpa mengubah indeks: `QueueItem.timestamp`
(`offlineQueue`, `orderBy('timestamp')`, antrean kirim yang sementara).
(2) ✅ test reload (tutup→buka DB, urutan identik) + wipe (`Dexie.delete` → restore
baris mentah arsip → `normalizeOrderIndex`), urutan & presisi tampilan utuh.
(3) ✅ terukur 10k pesan: build indeks **192,9 ms**, cari dingin **4,3 ms**,
cari hangat **4,03 ms/query** (gate < 100 ms) — `pnpm --filter nyx-web run bench:search`.
(4) ✅ `localAtRest` 7 + `vaultSeqPersistence` 4 hijau (bagian dari suite web
**654/654**, 76 file).

**Temuan verifikasi ini (dan perbaikannya):** inspeksi mentah menemukan DUA kolom
waktu presisi yang masih plaintext walau daftar "sisa" di atas tidak
menyebutnya — `DecryptedMessageRecord.sentAt` (ms per pesan; inilah yang membuat
"jam" masih terbaca) dan `PqDrSessionRecord.lastActivity` (ms per sesi PQ-DR).
Keduanya kini di-seal `ENC1:` mengikuti pola `seq`: writer menyegel, migrasi unlock
menutup baris lama (`sealLegacyStructFields` + `migrateAtRestSealing`), dan pembaca
membukanya (`openLocalNumber`, baris lama tetap terbaca). Tidak ada perubahan
format wire/kripto — `sentAt` tetap hanya hidup di dalam ciphertext saat dikirim.

---

## 30.11 WS-G — Rekayasa, observability, dan verifikasi

1. **Metrik tanpa telemetry** (`docs/27` §27.7): Prometheus + Grafana self-host
   (systemd/docker) + node/postgres/redis exporter; metrik hanya hitungan event
   (volume pesan, distribusi mode transport, error rate, latency sweeper,
   pertumbuhan DB) — **tanpa userId/IP/usernameHash**. Docs + dashboard
   di-commit.
2. **Alert**: disk, RAM, eviksi key rate-limit Redis, lag sweeper
   (`server/src/jobs/systemSweeper.ts`), expiry sertifikat sidecar
   (`cert_tests` sudah ada), lag log KT (WS-A), gagal verifikasi KT. **14 aturan,
   dan tiap aturan punya kasus drill** (`ops/prometheus/tests.yml` + `scripts/drill-alerts.sh`).
3. **k6 load test**: 500 user konkuren, 20 pesan/s agregat, badai fan-out grup;
   gate p95 < 200ms untuk operasi relay; jalankan nightly + sebelum rilis besar.
   **Sudah dijalankan** (`scripts/load/run-relay-load.sh`, terukur 2026-10-14: send
   p95 74,4 ms / fetch p95 68,8 ms, 0% error).
4. **Test perilaku menggantikan regex source**: untuk endpoint kripto/otorisasi
   (`keys.ts`, `conversations.ts` credential, `sessions.ts`) pakai supertest +
   fake Prisma/Redis (pola `node:test` + fake yang sudah dipakai server).
   Target: setiap endpoint otorisasi punya ≥1 test perilaku.
5. **Fuzzing**: parser framing sidecar (cargo-fuzz), `parseTransportHello`,
   parser backup (WS-C), verifier proof KT (Spike-1 output).
6. **Vektor lintas-implementasi DR/sender-key**: harness Rust kecil yang memakai
   **libsignal** sebagai oracle (pin §30.2) menghasilkan vektor (ratchet step,
   sender-key chain, skipped key) → test TS memverifikasi output NYX identik
   untuk primitif yang sama. **Yang landed menyimpang dari bentuk ini:** oracle
   tidak dibangun dari libsignal (workspace besar, primitif `SessionRecord`
   tidak bisa dipotong tanpa menyentuh jalur beku) melainkan **implementasi
   kedua tanpa libsodium** di `tools/dr-oracle/` (Go: `x/crypto/curve25519`,
   `cloudflare/circl` X-Wing, `x/crypto/blake2b`) yang memverifikasi
   X3DH + `kdfChain` + AEAD dua arah. Ini menutup kelas bug "NYX==NYX setuju
   atas kesalahan yang sama" untuk primitif di bawah ratchet; **sender-key
   chain / skipped key tetap diuji internal** (`spqrRatchet.test.ts` + crate
   SPQR), bukan oleh oracle. Lihat baris M4 §30.20.
7. **Dedup helper E2E** (`docs/29` §7.5): satu `web/e2e/helpers/registration.ts`
   + import di semua spec; target suite chrome lebih cepat & stabil.

**Acceptance gate WS-G:** (1) alert benar-benar menyala dalam game-day drill →
✅ `scripts/drill-alerts.sh` (14 aturan, kasus menyala + tidak-menyala; job CI
`alerts` + scrape nyata di job `e2e`); (2) k6 lolos p95 < 200ms → ✅ terukur
500 VU (send p95 74,4 ms / fetch p95 68,8 ms, 0% error); (3) `pnpm -r lint`
kategori `correctness` → `error` (temuan lama dibersihkan, `docs/29` QW5
residual) → ✅ 0 error; (4) fuzz jalan ≥1 jam tanpa crash → ✅ (web + sidecar,
`docs/30` M2); (5) vektor DR/sender-key lulus → ✅ **parsial**: X3DH/KEM/kdfChain
vs oracle non-libsodium (`tools/dr-oracle`); sender-key chain/skipped key masih
internal.

---

## 30.12 WS-H — Anti-abuse bertingkat tanpa PII

- Kuota bertingkat mengikuti pola `server/src/utils/otpkQuota.ts`: per
  `identityTag`, per-hash-ASN (HMAC pepper — **IP mentah tidak pernah disimpan**),
  per-installation tag (sudah ada di `Device.installationTag`).
- WebAuthn attestation untuk akun baru (perangkat keras), PoW adaptif
  (`server/src/routes/auth.ts` jalur PoW sudah ada), Turnstile tetap.
- Deteksi sybil = heuristik burst (bukan ML, tidak butuh data pribadi).- Acceptance: 100 akun dari satu ASN dalam 1 jam → tertahan; audit: tidak ada IP
di DB/Redis (sudah jadi aturan `docs/28`); test false-positive untuk jaringan
besar (NAT kantor).

**Status gate (2026-10-16):** (1) ✅ akun ke-100 dari satu ASN ditahan —
`evaluateRegistrationBurst` inklusif di `REGISTRATION_MAX_PER_ASN = 100` +
guard melempar `429 REGISTRATION_BURST_LIMIT` (test perilaku, bukan regex:
`server/tests/registrationGuard.test.ts`); (2) ❌→✅ **audit "tidak ada IP di
DB/Redis" awalnya GAGAL**: key limiter `express-rate-limit` menyimpan **alamat
klien mentah** (`rl:general:<ip>`, `rl:auth:<ip>`, `rl:upload:<ip>`, TTL 15 mnt–1
jam) dan counter PoW menyimpan `blake2b` **tanpa kunci** dari identitas
(16 hex — ruang IPv4 2^32 bisa dienumerasi dari snapshot Redis). Keduanya
diperbaiki: `clientIpTag` (HMAC pepper atas alamat yang sudah dinormalkan
`ipKeyGenerator`) untuk semua limiter, `powRateKey` (HMAC pepper,
domain-separated) untuk `/pow/challenge`. Perilaku pembatasan tidak berubah (IP
sama → tag sama); yang berubah hanya bentuk key, dan counter lama di-reset sekali
saat deploy. Guardrail: `tests/ipKey.test.ts` + `tests/powIdentity.test.ts`
(memastikan key tidak memuat alamat dan wiring-nya tidak kembali ke IP mentah);
(3) ✅ false-positive NAT kantor besar: 40 akun satu ASN tersebar (burst 10 menit
= 8, instalasi masing-masing) → tanpa blokir **dan** tanpa attestation, plus
mode `shadow` yang mengukur `would_block`/`would_attest` tanpa mengubah perilaku
siapa pun; (4) ✅ attestation akun baru wajib diverifikasi **sebelum** akun dibuat
(`428 ATTESTATION_REQUIRED` → verifikasi dua lapis → `isVerified` + baris
`Authenticator`), `none`/`self` ditolak default, challenge sekali-pakai, dan
rantai perangkat nyata (root tidak ikut `x5c`) diverifikasi lewat root yang
dipin (`ABUSE_ATTESTATION_ROOTS_FILE`, `ops/attestation/README.md`); (5) ✅
PoW adaptif + Turnstile tetap. Checklist menyalakan & memantau (termasuk mode
shadow sebagai jalur pengukuran lapangan): **`docs/10` §10.16** (alert
`NyxAbuseGuardDisabled` dulu menunjuk §10.13 — salah sasaran, dikoreksi).

---

## 30.13 WS-I — Username links (contact discovery tanpa graph sosial)

Link `https://nyx-app.my.id/u/<hashId>` → halaman yang hanya mengirim
`hashId` (nilai ter-pepper yang sudah ada) ke server untuk memetakan ke
`usernameHash`; tanpa enumerasi (rate limit + exact match; pola
`users.ts` `isExactHash` sudah ada). Ini fitur parity yang murah.

**Status gate (2026-10-16):** route `/u/:hashId` + validasi bentuk **benar**,
tetapi verifikasi menemukan tautannya **tidak bisa didapat maupun dipindai**:
(a) `ShareProfileModal` masih membangun `/connect?u=…&i=<userId>&p=<profil
terenkripsi>` — userId mentah ikut beredar di QR, dan tidak ada satu pun kode
yang menghasilkan `/u/`; (b) `ScanQRModal` hanya menerima bentuk `/connect?u=…`,
jadi QR berisi `/u/<hashId>` diabaikan. Keduanya diperbaiki:

- **Produsen** — `ShareProfileModal` memakai `buildUsernameLink` → QR + tombol
  salin kini `/u/<hashId>` (hanya hashId), dan hashId tak berbentuk sah tidak
  lagi menghasilkan QR (dulu `buildUsernameLink` bisa melempar saat render).
- **Konsumen** — `web/src/utils/usernameLink.ts` `parseProfileShareLink()`
  menjadi satu parser untuk dua bentuk: `/u/<hashId>` (validasi bentuk sama
dengan server) dan `/connect?u=…&i=…&p=…` **apa adanya** (QR yang sudah beredar
tidak boleh mati). Dipakai `ScanQRModal` → query diteruskan ke `/connect`.

Verifikasi: web `npx tsc --noEmit` 0, `vitest` **669/669 (78 file)** dan
`pnpm --filter nyx-web run build` exit 0; test baru `usernameLink.test.ts`
(+8: roundtrip, segmen hash tak sah, QR lama apa adanya, host tidak dipatok,
skema non-http), `shareProfileModal.test.tsx` (3) dan `scanQrModal.test.tsx` (4).
Pembatasan "tanpa enumerasi" di sisi server tidak berubah dan tetap seperti
diuji: `/api/users/search` hanya mencocokkan kandidat **persis**
(`identifierLookupCandidates(q)`, tanpa prefix/`startsWith`), di bawah
`generalLimiter` (300/15 mnt per tag sumber), dan wajib `req.user`.

**Batas yang belum tertutup (bukan di klien):** tautan dibangun dari
`window.location.origin`, jadi host-nya adalah **host aplikasi**
(`app.nyx-app.my.id`, atau domain self-host). Host marketing
(`nyx-app.my.id`, `web/nginx.conf` “RUMAH 1”) melayani `/var/www/nyx-marketing`
dengan `try_files $uri $uri.html $uri/ =404` — **tidak ada** fallback SPA dan
**tidak ada** aturan `/u/` maupun `/connect`, sehingga contoh tautan di atas
(`https://nyx-app.my.id/u/<hashId>`) akan 404 di host itu. Perbaikannya satu
`location ~ ^/(u/|connect$)` → `301` ke `app.nyx-app.my.id` di blok marketing,
tetapi itu perubahan nginx produksi (dan mungkin sudah ditangani aturan
Cloudflare di luar repo) — **belum diubah di sini**; sampai itu diputuskan,
pakai URL subdomain aplikasi.

---

## 30.14 WS-J / WS-K — Gate yang sengaja belum dikerjakan

- **WS-J MLS**: tetap gate `docs/26` §26.8.2 (PQ ciphersuite RFC + OpenMLS
  produksi + audit, perkiraan 2027). Bila trigger menyala: MLS sebagai
  *key-management layer* di bawah pseudonym/era yang sudah ada — bukan
  pengganti T1/T3 (MLS tidak menyembunyikan keanggotaan dari DS).
- **WS-K Klien native**: satu-satunya cara notifikasi andal (iOS background push
  tidak bisa dijamin di web). Butuh dokumen desain sendiri + akun Apple/Google
  (FCM/APNs = layanan pihak ketiga → akan direkomendasikan lewat Gravity Index   saat fase dimulai). Prasyarat: WS-C (backend/restore) — WS-B tidak lagi
   relevan (multi-device dibatalkan, §30.6).

---

## 30.15 Urutan eksekusi & milestone

```
Spike-1 (KT→WASM) ─┐
Spike-2 (SPQR→WASM)┘
        │
M1 WS-G(obs+test perilaku) ─┬─> M2 WS-A (KT penuh B+C)
   WS-F (storage penuh)     │        │
                            │        ▼
                            └─> M3 DIBATALKAN (multi-device) ──> M4 WS-C (backup+restore)
                                     │                              │
                                     ▼                              ▼
                              M5 WS-D (SPQR)               M6 WS-E (calls)
                                     │
                                     ▼
                        M7 WS-H + WS-I + WS-G(fuzz/vektor)
                                     │
                                     ▼
                        M8 (gate): WS-J MLS · WS-K native
```

| Milestone | Isi | Acceptance gate (ringkas) |
|---|---|---|
| **M0** | Spike-1 & Spike-2 | keputusan WASM vs port TS terdokumentasi + bukti jalan (vektor) |
| **M1** | WS-G (obs + test perilaku + k6) + WS-F | alert drill, k6 p95<200ms, IndexedDB bersih |
| **M2** | WS-A | vektor audit, interop `kt-client`, simulasi MITM ditolak, fail-visible |
| **M3** | ~~WS-B~~ dibatalkan (§30.6) | Tidak ada gate — single-device dipertahankan |
| **M4** | WS-C | property roundtrip + restore perangkat baru tanpa server |
| **M5** | WS-D | PCS test + packet-loss test + no-downgrade |
| **M6** | WS-E | E2E call chrome via coturn, tanpa pihak ketiga di ICE |
| **M7** | WS-H + WS-I + sisa WS-G | sybil test, lint correctness = error, fuzz stabil |
| **M8** | WS-J/WS-K (gate) | dokumen desain + keputusan maintainer |

Catatan urutan (revisi setelah pembatalan multi-device): WS-A tidak lagi
menunggu apa pun dari WS-B dan menjadi milestone kepercayaan berikutnya; WS-C
berdiri sendiri di atas alur `migration:*` yang sudah ada (menggantikan
ketergantungan pada WS-B); WS-D hanya bergantung kapabilitas sehingga bisa
diparalelkan dengan WS-C bila ada bandwidth.

---

## 30.16 Keputusan — **sudah diputuskan 2026-10-11**

| # | Keputusan | Pilihan | Alasan |
|---|---|---|---|
| 1 | KT server | **Reuse `key-transparency-server` (Go) apa adanya**, backend LevelDB lokal, proses `nyx-kt` di loopback | Protokolnya sudah punya search key `UsernameHashPrefix` (§30.2) → nol perubahan protokol; membawa serta auditor, alat uji vektor, dan `kt-stress` |
| 2 | Klien KT | **WASM dari `libsignal/rust/keytrans`** | Verifikasi adalah inti keamanannya; memakai kode Signal yang sudah ditinjau jauh lebih baik daripada menulis ±3.5k baris kripto TS baru yang harus diaudit sendiri |
| 3 | SPQR | **WASM dari crate `spqr` (v1.6.0)** | Crate itu **terverifikasi formal** (hax/F* panic-free + ProVerif untuk FS/PCS). Porting ML-KEM Braid + erasure coding ke TS akan membuang justru properti yang membuatnya layak dipakai |
| 4 | Mulai dari | **M1** (WS-G observability + test perilaku, lalu WS-F storage lokal) | Membuat semua milestone setelahnya terukur; tidak menyentuh format kripto |
| 5 | Spesifikasi VPS | **4 core / 8 GB RAM / 4 GB swap** (`docs/10` §10.1/§10.11 dan `AGENTS.md`) | Terkonfirmasi sesuai kondisi sekarang; catatan "low-memory" di komentar kode = konteks historis (`docs/10` §10.1 note) |

Konsekuensi teknis dari keputusan 2 & 3: build web mendapat langkah baru
**Rust → WASM** (`wasm32-unknown-unknown` + `wasm-bindgen`, protoc untuk prost di
jalur KT). Ini ditambahkan di CI/deploy sebagai job terpisah dengan artefak
ter-cache, dan **tidak** menyentuh aturan "jangan pecah file crypto worker"
(`docs/04`) — WASM dipanggil sebagai modul, bukan memecah worker.

Keputusan yang masih terbuka (dibutuhkan saat workstream-nya mulai):

- WS-C: bucket R2 privat khusus backup vs memakai bucket media yang ada.
- WS-E: coturn di VPS yang sama (port 3478/5349) vs VPS kedua.
- WS-K: platform klien native pertama (menentukan layanan push: FCM/APNs).
- Atribusi: bentuk `NOTICE` untuk kode Signal yang dipakai (KT server, `keytrans`, `spqr`) — **dijawab 2026-10-14: `NOTICE` di root**; awalnya tanpa vendor (checkout lokal + artefak WASM ter-commit), lalu **di-revisi pada hari yang sama menjadi vendor penuh** (`vendor/signal/`, `server/kt-query/vendor/`) supaya clone bersih & CI bisa membangun tanpa checkout di luar repo.

---

## 30.16b Keputusan yang perlu disetujui maintainer (arsip pra-keputusan)

1. **KT server**: pakai `key-transparency-server` (Go) apa adanya sebagai proses
   lokal **(rekomendasi)** vs port TS ke `server/` (lebih ringkas, tapi
   kehilangan auditor/tooling Signal dan menambah 10k+ baris kripto baru).
2. **Klien KT**: WASM `libsignal-keytrans` **(rekomendasi)** vs port TS
   `verify.rs` (+±3.5k baris) — hasil Spike-1 yang menentukan.
3. **SPQR**: WASM crate `spqr` **(rekomendasi)** vs port TS ML-KEM Braid (jauh
   lebih berisiko; kehilangan properti "kode terverifikasi formal").
4. **Backup**: bucket R2 privat + presign **(rekomendasi)** vs tanpa cloud backup
   (hanya file manual).
5. **coturn**: pasang di VPS yang sama (port 3478/5349) **(rekomendasi)** vs VPS
   kedua.
6. **Spesifikasi VPS**: `docs/10` §10.1/§10.11 menyatakan **4 core / 8GB**
   (upgrade 2026-10), tapi `AGENTS.md` masih menulis "1 core / ~1GB". Mana yang
   benar sekarang memengaruhi keputusan menaruh KT + Prometheus + coturn di satu
   box (dan apakah catatan low-memory di kode masih berlaku).
7. **Atribusi**: NOTICE + pin commit untuk kode Signal yang dipakai (KT server,
   `keytrans`, `spqr`) — perlu persetujuan eksplisit karena masuk ke repo AGPL
   NYX. **✅ 2026-10-14 (direvisi hari itu juga):** `NOTICE` dibuat di root
   (lisensi, commit pin, cara konsumsi) dan sumbernya **di-vendor penuh**
   (`vendor/signal/`, `server/kt-query/vendor/`) — keputusan awal "tanpa vendor"
   (pembungkus tipis + artefak build saja) dibalik karena build harus jalan di
   clone bersih dan CI tanpa checkout Signal; `scripts/check-vendor.sh` menjaga
   salinan tetap cocok dengan pin dan ter-commit.
8. **Klien native**: platform pertama (Android vs iOS vs desktop) — menentukan
   layanan push yang dipakai.

---

## 30.17 Risiko lintas-proyek

| Risiko | Dampak | Mitigasi |
|---|---|---|
| WASM compile gagal (protoc/prost/RNG) | jadwal WS-A/WS-D | Spike di M0; fallback port TS dengan vektor yang sama |
| Kode Signal berubah (fork/API) | drift | pin commit; sumber **di-vendor** (`vendor/signal/`, `server/kt-query/vendor/`) + artefak WASM ter-commit; catat pin di `NOTICE` + `docs/25`; `scripts/check-vendor.sh` memverifikasi isi vendor masih cocok dengan pin |
| Ledakan ukuran log KT | disk VPS | metrik + snapshot R2 + retensi |
| Multi-device menambah permukaan metadata | regresi privasi | device list bertanda tangan + aturan `docs/28` + audit script |
| Backup jadi jalur exfil baru | kebocoran | server hanya melihat blob; kunci dari recovery phrase; kuota |
| SPQR mengubah ukuran pesan | UX/latency | erasure coding + benchmark + jalur v1 tetap ada |
| coturn menyentuh infrastruktur | downtime call | systemd + alert + TURN Cloudflare sebagai cadangan |
| Beban maintenance test baru | CI lambat | dedup helper E2E (WS-G), jalankan fuzz/k6 nightly bukan per-PR |

---

## 30.18 Non-goals (tetap dipertahankan)

Onion routing/mixnet, multi-party SFU, MLS sebelum PQ suite RFC, ZKGroup penuh
(pairing), PII/telepon sebagai identitas. Lihat `docs/26` §26.3, `docs/27` §27.8.

**Ditambahkan 2026-10-11 — multi-device adalah non-goal permanen.** NYX memilih
satu perangkat aktif per akun sebagai **properti keamanan** (bukan kekurangan
UX):

- tidak ada device list bertanda tangan yang bisa disalahgunakan,
- tidak ada sinkronisasi state antar-perangkat yang memperluas permukaan
  serangan (contact graph, verification state, sender-key, admin token),
- tidak ada layanan storage per-akun yang menyimpan blob ber-kunci-akun,
- pencurian/cloning sesi tetap terdeteksi per-opcode (`isActiveDeviceAllowed`)
  dan kick tetap memaksa rotasi.

Konsekuensi yang WAJIB diikuti (jangan ada pekerjaan yang mengasumsikan
multi-device): `CLIENT_CAPABILITIES.MULTI_DEVICE` dihapus dari
`packages/shared/src/transport.ts`; WS-C hanya menargetkan **perangkat
pengganti** lewat alur `migration:*` yang sudah ada; KT tidak perlu melindungi
daftar device. Jalur pemulihan resmi tetap dua: recovery phrase (§30.5 WS-A)
dan backup ber-frame (§30.7 WS-C).

---

## 30.19 Definisi "selesai" untuk setiap workstream

Sebuah item dianggap selesai hanya bila **semuanya** benar:

1. Kode + test (unit/property/integrasi sesuai §30.4); test perilaku untuk
   endpoint; KAT/vektor untuk kripto.
2. `docs/` terkait diperbarui: `03` (security model), `04` (crypto protocol),
   `09` (database), `10` (deploy/ops), `12` (API reference), `14` (auth/identity),
   `16` (groups), `18` (realtime transport) — plus dokumen baru saat workstream-nya
   mulai: `31-backup-format.md`, `32-key-transparency-kt.md`,
   `33-spqr-wasm.md`, `34-key-transparency-verifier.md`.
   (Rujukan lama `32-key-transparency.md` / `33-multi-device.md` tidak pernah ada
   dengan nama itu — multi-device adalah non-goal permanen, `docs/29` §29.6.)
3. Audit privasi lulus: `privacy-dump-audit.ts` + aturan `docs/28` untuk kolom
   baru; tidak ada secret/identitas baru di Redis tanpa `identityTag`.
4. Gerbang kapabilitas: klien lama tetap jalan (tanpa perubahan perilaku),
   fitur baru hanya aktif bila dinegosiasikan.
5. Rollback terdokumentasi (env/flag/capability) + jalur degradasi yang terlihat
   (bukan gagal senyap).
6. Metrik event-only untuk fitur baru (WS-G style) + tidak ada telemetry.
7. `CHANGELOG.md` + `AGENTS.md` (bila alur build/test berubah) diperbarui.

---

## 30.20 Progress eksekusi

### M1 — sebagian landed (2026-10-11)

| Item | Status | Artefak |
|---|---|---|
| WS-G(1): metrik event-only | ✅ | `server/src/utils/metrics.ts` — deklarasi wajib di muka; nilai label berbentuk identitas (UUID/heks≥32/base64url≥22/IPv4/IPv6/email) **ditolak** dan dihitung di `nyx_metrics_rejected_total` |
| WS-G(1): exporter | ✅ | `server/src/utils/metricsEndpoint.ts` — `GET /metrics` di listener **loopback terpisah** (`METRICS_PORT`, default 9464; bukan route Express) |
| WS-G(2): sinyal operasional | ✅ | Wiring relay per opcode + blokir keamanan + sweeper (durasi, last-run, baris terhapus) |
| WS-G(2): alert | ✅ (di-drill 2026-10-14) | `ops/prometheus/{prometheus.yml,alerts.yml}` — **14 aturan** (sejak M1: 10, ditambah seri KT + backup/snapshot), termasuk `NyxMetricsIdentityLeakAttempt`. Tiap aturan punya kasus drill (`ops/prometheus/tests.yml`) dan drill-nya dijalankan satu perintah (`scripts/drill-alerts.sh`, 4 lapis); 3 aturan pertama kali di-drill mengeluarkan label yang tidak sesuai dugaan (mis. `NyxSweeperStale` menandai sampel terakhir yang `result="ok"`, `NyxMetricsExporterDown` menambah `job="nyx-api"`) — kelas kesalahan yang hanya terlihat kalau aturan benar-benar dijalankan terhadap seri time |
| WS-G(3): load test | ✅ (terukur 2026-10-14) | `scripts/load/relay.k6.js` + `scripts/load/run-relay-load.sh` (SMOKE 5 VU dulu, baru beban penuh) + `server/scripts/load-test-user.ts`. **Hasil:** 500 VU, 3.235 iterasi, 6.472 request / 24,6 req/s — send p95 **74,4 ms**, fetch p95 **68,8 ms** (gate < 200 ms), `http_req_failed` **0%**, `nyx_relay_errors` **0%**, checks 6470/6470 |
| WS-G(4): test perilaku otorisasi | ✅ (sebagian) | `server/tests/credentialAuth.test.ts` — matriks gate §7.1 dengan fake Prisma; logika dipindah ke `server/src/utils/credentialAuth.ts` agar bisa diuji perilaku |
| WS-G(4): sisa endpoint | ✅ | Ditutup bertahap: `sessions.ts` → `utils/sessionRevocation.ts` (+3 test), jalur admin grup → `utils/groupAccess.ts` (+17 test), dan **`keys.ts` prekey-bundle/OTPK** → `utils/keyBundle.ts` (`toOneTimePreKey`/`toPreKeyBundle`/`requireBundleDevice`, 9 test, termasuk urutan **kuota sebelum konsumsi OTPK** yang gagal-tutup dan kasus OTPK habis yang tetap sah tanpa `oneTimePreKey`) |
| WS-G(6): vektor DR/sender-key libsignal | ~~⬜~~ **usang — lihat baris M4 "WS-G(6): vektor DR/X3DH lintas-implementasi"** | Rencana libsignal sebagai oracle diganti oracle Go non-libsodium yang bisa dibangun dari repo (`tools/dr-oracle/`) |
| WS-F: seal sisa kolom struktural | ~~⬜~~ **usang — lihat baris M2 "WS-F: seal kolom struktural"** | Rencana lama (butuh skema urutan terenkripsi eksplisit) digantikan pendekatan yang landed: `orderBucketMs` plaintext sebagai lapis indeks + lapis presisi ter-seal, dan kolom non-pengurutan di-seal di tempat. Sisa satu-satunya: verifikasi E2E di browser (profil pengguna nyata) |
| WS-C fase 1: format backup ber-frame | ✅ | `web/src/lib/backupFormat.ts` + 13 test kripto sungguhan (roundtrip, tamper, reorder, truncate, padding anti-bocor-ukuran, KDF dipin) + spesifikasi `docs/31-backup-format.md` |
| WS-C fase 2: pengaitan payload Keychain | ✅ | `web/src/lib/backupPayload.ts` + 12 test kripto (roundtrip via arsip nyata, determinisme urutan, chunking, scramble deterministik, validasi keras) + `docs/31` §31.6a |
| WS-C fase 3: transport `.nyxbak` + R2 | ✅ | `web/src/lib/backupTransport.ts` + `server/src/routes/backup.ts` (`/api/backup/presign`, `/download-url`, `DELETE`) + `utils/backupObject.ts`; kunci objek HMAC tanpa userId, tanpa tabel DB; 10 test server + 11 test web (`docs/31` §31.6b) |
| WS-C fase 4: restore perangkat pengganti | ✅ | `web/src/lib/backupRestore.ts` + wiring `MigrationSendPage`/`MigrationReceivePage` lewat `migration:*`; 10 test (progres per frame, kunci salah ditolak sebelum tulis, adapter Dexie, phrase) — `docs/31` §31.6c |
| WS-C fase 5: benchmark 10k pesan | ✅ | `web/src/lib/backupBench.ts` + `pnpm --filter nyx-web run bench:backup`; terukur 10k pesan (20.272 catatan, arsip 4.62 MB/79 frame): export 1.3–1.5 s / restore 0.6–0.8 s, puncak heap ~147 MB — `docs/31` §31.6d |

**Keputusan 2026-10-11 (lanjutan):** multi-device **dibatalkan permanen** sebagai
non-goal keamanan (§30.6, §30.18). Dampak yang sudah dikerjakan: kapabilitas
`CLIENT_CAPABILITIES.MULTI_DEVICE` dihapus dari `packages/shared/src/transport.ts`
(test `transportCapabilities` memeriksa nilai runtime, bukan teks), KT
di-sederhanakan (tanpa daftar device), dan WS-C diarahkan ke **perangkat
pengganti** lewat alur `migration:*` yang sudah ada.

Catatan desain untuk WS-F (agar tidak dikerjakan setengah): kolom yang **tidak**
dipakai untuk pengurutan (`isGroup`, `isPinned`, `isArchived`, `senderId`,
`status`, `isViewOnce`, `expiresAt`, `repliedToId`) bisa di-seal dengan pola
`ENC1:` yang sudah ada;kolom pengurutan (`createdAt`, `seq`) butuh skema terpisah (bucket + nilai urut ter-HMAC) plus hook baca/tulis Dexie yang asinkron
dan migrasi idempoten — itulah sebabnya item ini punya langkah desain sendiri,
bukan ikut di commit observability.

**Keputusan skema (2026-10-12, langkah 1 landed):** opsi "nilai urut ter-HMAC"
di catatan di atas **ditolak saat implementasi** — HMAC adalah fungsi acak, jadi
kolom hasilnya tidak bisa di-range-scan sama sekali (query paginasi mati), dan
"order-preserving encryption" akan membocorkan hal yang sama dengan bucket tapi
dengan crypto yang lebih buruk. Yang dipakai (`web/src/lib/localOrderKey.ts`):

- **Lapis indeks (plaintext):** `orderBucketMs` = waktu di-floor ke bucket 15
  menit, satu konstanta (`LOCAL_TIME_BUCKET_MS`) dengan `localAtRest` dan bucket
  `createdAt`/`lastMessageAt` server (docs/28 Tier 2 — B3/B4) → **tidak menambah
  kebocoran baru**, dan indeks `[conversationId+orderBucketMs]` tetap bisa
  di-range-scan tanpa mendekripsi apa pun lebih dulu.
- **Lapis presisi (sealed):** `createdAtSealed` = envelope `ENC1:` (helper yang
  sama dengan `seq`). Urutan presisi dipulihkan **setelah** baris kandidat
  diambil, jadi halaman = baris presisi terbaru, bukan baris yang kebetulan
  berurutan menurut primary key di dalam bucket.
- **Konsekuensi yang harus dijaga pembaca:** indeks mengurutkan kunci yang sama
  berdasarkan primary key, jadi penyedia data harus mengambil bucket batas
  **utuh** (`where('[conversationId+orderBucketMs]').equals([conv, bucket])`)
  sebelum memangkas halaman — kalau tidak, baris lebih tua di dalam bucket batas
  terlewat permanen. Kursor `beforeDate` tetap **inklusif** seperti perilaku lama
  (baris batas muncul lagi di halaman berikutnya; store menggabung berdasarkan
  id), dan urutan keluaran tetap lama→baru.
- **Batas kerja per halaman:** loop pembaca mondar-mandir maksimum 32 bucket
  (~8 jam) dari titik awal; kehabisan jendela sebelum halaman penuh → halaman
  kosong → store jatuh ke fallback fetch server yang sudah ada (bukan menyapu
  seluruh masa lalu).
- **Titik awal halaman pertama BUKAN `now`,** melainkan bucket terbaru yang
  benar-benar ada di percakapan ini (satu baris dari `.reverse().limit(1)`):
  percakapan yang sudah sepi berhari-hari tidak boleh tampak kosong.
- **Kolom non-pengurutan di-seal DI TEMPAT (langkah 3):** satu kolom berisi
  plaintext lama ATAU envelope `ENC1:` (pola `seq`), jadi tidak perlu kolom
  bayangan: `senderId`, `repliedToId`, `isViewOnce`, `isDeletedLocal`,
  `expiresAt` (ms), `Conversation.isGroup`, `Message.reactions`. Konsekuensi yang mudah salah: nilai
  ter-seal **selalu truthy** — kode yang dulu menulis `if (row.isViewOnce ||
  row.isDeletedLocal)` harus membukanya (`openLocalFlag`) atau membaca boolean
  dari `Message` di memori, bukan dari baris DB. `expiresAt` juga: envelope
  tidak boleh diurai `Date.parse` (dipakai di write-back, lihat
  `readExpiresAt`).
- **Migrasi & jalur masuk mentah:** Dexie v9 mengisi `orderBucketMs` untuk baris
  lama saat upgrade (murni aritmetika waktu — `masterSeed` belum tentu tersedia
  saat DB dibuka, dan IndexedDB mengisi indeks setelah callback upgrade). Baris
  yang masuk **melewati** writer — restore `.nyxbak`, impor JSON — dinormalkan
  (`shadowVault.normalizeOrderIndex()`, idempoten), karena tanpa kolom bucket
  pesannya tersimpan tapi tidak pernah muncul di query berpaginasi.

### M2 — sebagian landed (2026-10-12)

| Item | Status | Artefak |
|---|---|---|
| WS-E(1): coturn self-host (kredensial HMAC) | ✅ | `/api/keys/turn` kini **coturn primer** (`TURN_URLS` + `TURN_STATIC_AUTH_SECRET`, TTL default 600 s) dengan Cloudflare TURN sebagai cadangan; username memakai `identityTag` (bukan userId). Logika murni di `server/src/utils/turnCredentials.ts` + 7 test (`turnCredentials.test.ts`); env di `.env.example` (root & server). **Sisa:** coturn process/systemd nyata di VPS. **E2E call chrome DITUTUP (2026-10-15):** `web/e2e/call.spec.ts` + coturn di CI `e2e-chrome` — lihat baris M6 "WS-E gate (1)" |
| WS-E(2): signaling call tidak ter-link ke akun | ✅ | `server/src/utils/callRelayTokens.ts` — token relay per sesi panggilan (`token → {userId, deviceId, conversationId}`, TTL pendek, kunci Redis ter-`identityTag`), target `to` adalah **token**, bukan userId; `relayCallSignal` di `redisBridge.ts` menolak token asing/kadaluarsa (fail-closed) dan tidak pernah meneruskan identitas. 12 test (`callRelayTokens.test.ts` server + `callRelayTokens.test.ts` web). **E2E call chrome dengan coturn nyata DITUTUP (2026-10-15)** — jalur produksi (`/api/keys/turn` → `RTCPeerConnection`) benar-benar merelay: lihat baris M6 "WS-E gate (1)" |
| WS-I: username links `/u/<hashId>` | ✅ | Route `/u/:hashId` (web, di dalam ProtectedRoute) → meneruskan hashId ke alur `/connect` (pencocokan persis, tanpa enumerasi). Helper `web/src/utils/usernameLink.ts` + test (`usernameLink.test.ts`) memakai aturan bentuk yang sama dengan server (`users.ts` `isExactHash`). **Dilengkapi 2026-10-16 — lihat baris M8 "WS-I gate":** produsen tautan (`ShareProfileModal` → `/u/<hashId>`, tanpa userId/profil) + konsumen QR (`parseProfileShareLink`, QR lama tetap jalan) |
| WS-H: anti-abuse tanpa PII | 🟡 sebagian | `server/src/utils/registrationGuard.ts` (kuota per sumber **IP ter-HMAC** + per instalasi, INCR+EXPIRE atomik, fail-open saat Redis error) + 5 test; wiring di `auth.ts` register via env `ABUSE_REGISTRATION_GUARD=on` (default off = no-op). **Sisa (butuh data/keputusan luar):** kuota per-hash-ASN (butuh database ASN — proksi prefix /24+/48 akan mengubah properti gate §30.12, jadi tidak dipakai diam-diam), WebAuthn attestation akun baru, pengukuran false-positive NAT |
| WS-G(4): test perilaku endpoint | ✅ | Revokasi sesi dipindah ke `server/src/utils/sessionRevocation.ts` + 3 test (ownership 404, family, blacklist TTL); pemetaan bundle `keys.ts` dipindah ke `server/src/utils/keyBundle.ts` (+ jalur OTPK dan pemilihan perangkat; 9 test). **Jalur grup** (2026-10-12) dipindah ke `server/src/utils/groupAccess.ts` + **17 test** (`groupAccess.test.ts`): tambah/kick anggota (404/403 fail-closed), leave (token grup ATAU baris delivery-token sendiri, lookup lewat nilai routing ter-seal), details (403 untuk conversation hilang = kontrak lama), rotasi kunci (admin-only), purge (404 → 400 non-grup → 403 token → admin → 409 `MEMBERS_REMAIN`), dan urutan gate (`token → admin → hitungan anggota`) |
| WS-G(5): fuzzing parser input tak terpercaya | ✅ | `web/src/lib/fuzzParsers.ts` (+ `fuzzParsers.test.ts`, 4 test incl. **self-test harness**) untuk `parseTransportHello`, `readBackupHeader`, `unpadBackupPayload`, `parseBackupArchive`, `readBackupChunk`; `cargo test` + `cargo run --release --bin fuzz-framing` untuk bingkai sidecar + HELLO (`server/transport-sidecar/src/{lib,protocol,fuzz}.rs`, 18 test Rust, differential vs implementasi referensi). Deterministik (xorshift, tanpa `Math.random`), terjadwal lewat env (`NYX_FUZZ_ITERS`/`NYX_FUZZ_SECONDS`) + script `fuzz:parsers` / `fuzz:parsers:hour`. **Terukur:** web 5×100k input ≈ 50 s; sidecar 160,9 juta iterasi / 300 s (536k/detik) → gate 1 jam ≈ 1,9 miliar input, 0 temuan. **Sisa:** kampanye fuzz ini belum mencakup verifier proof KT (modul WASM + 18 test ada di `docs/34`) |
| WS-G(1): Grafana dashboard | ✅ | `ops/grafana/dashboards/nyx-overview.json` — 18 panel (penjaga privasi harus 0, blokir keamanan per alasan, relay per hasil/opcode, backup ops, sweeper umur + p50/p95 + baris dibersihkan, disk/RAM/swap/Postgres/Redis); semua query menyebut metrik yang sudah dideklarasikan di `metrics.ts` atau exporter host, ambangnya disamakan dengan `ops/prometheus/alerts.yml`; dipasang manual (VPS, docs/10 §10.12) |
| WS-G(6): vektor DR/sender-key lintas-implementasi | ~~⬜ blocked~~ **digantikan (2026-10-14)** | Blokir saat itu nyata: harness libsignal butuh membangun workspace besar + mengekstrak `SessionRecord` secara deterministik, dan E2E belum bisa dijalankan sebagai jaring pengaman. **Yang menyelesaikannya:** oracle tidak harus libsignal — implementasi kedua tanpa libsodium sudah cukup untuk membuktikan NYX tidak salah di primitif. Lihat baris M4 "WS-G(6): vektor DR/X3DH lintas-implementasi" |
| WS-G(7): dedup helper E2E | ✅ | Helper bersama `web/e2e/helpers/registration.ts`: `registerUser` (dulu disalin di 6 spec dan **sudah menyimpang** — varian skip-biometric spesifik `settings.spec` kini dieksplisitkan sebagai `registerUserViaBiometric`), `supportsWebTransport` (dulu dua nama berbeda + satu evaluasi inline di `chat.spec`), serta `openDirectChatWith` / `sendChatMessage` / `expectPeerReceivesMessage` (blok locator yang disalin di `chat.spec` + `transport.spec` ×2). Semantik tiap spec dipertahankan — default `supportsWebTransport` tetap tanpa navigasi (perilaku lama `chat`/`transport`), sedangkan `regression.spec` memakai `{ navigateToAppOrigin: true }`. Verifikasi: web `tsc` 0, `playwright test --list` **24 test / 8 file**, `vitest` 385/385 (angka saat itu). **Sisa:** menjalankan suite E2E terhadap DB/Redis/browser nyata — Postgres lokal di mesin ini belum punya role `nyx_user`/db `nyx_app`, jadi `e2e/global.setup.ts` gagal di reset (kondisi lingkungan, bukan perubahan ini) |
| WS-F: seal kolom struktural | ✅ (verifikasi browser tersisa) | **Skema** `web/src/lib/localOrderKey.ts` (+ modul daun `localOrderBucket.ts`) + **wiring**: Dexie v9 mengisi `orderBucketMs` saat upgrade (tanpa kunci), writer `upsertMessages` menyegel `createdAt`, pembaca `getMessagesByConversation` berpaginasi per bucket utuh, `messageSearch` mengurut lewat lapis presisi, `importDatabase` + restore `.nyxbak` menormalkan baris mentah (`normalizeOrderIndex`). **Langkah 3:** kolom struktur non-pengurutan di-seal di tempat (`senderId`, `repliedToId`, `isViewOnce`, `isDeletedLocal`, `expiresAt`, `Conversation.isGroup`) lewat `sealLocalText`/`sealLocalFlag`, dan indeks sisa yang tak terpakai dilepas (Dexie v10: `senderId`, `isDeletedLocal`, `conversations.isGroup` — grep klausa query-nya bersih). `status` sengaja dilewati: tidak ada jalur tulis yang menyimpannya (hanya dibaca dari baris lama). Verifikasi: web `tsc` 0, `vitest` **427/427** (53 file), `pnpm --filter nyx-web run build` exit 0; test `localOrderKey.test.ts` (19) + `shadowVaultOrderIndex.test.ts` (16) + `dexieMigration.test.ts` (11). Yang terakhir memakai **IndexedDB nyata** (`fake-indexeddb`) + Dexie nyata: upgrade v1→v9 benar-benar mengisi `orderBucketMs`, indeks `[conversationId+orderBucketMs]` terisi dan bisa di-range-scan, v10 benar-benar melepas indeks `senderId`/`isDeletedLocal`/`conversations.isGroup`, dan pembaca vault berjalan di atasnya. **Sisa:** E2E browser (UI scroll-back, upgrade pada profil pengguna nyata) — butuh Postgres lokal (izin maintainer) |
| WS-F: migrasi at-rest saat unlock + kolom waktu kontak/profil | ✅ | `shadowVault.migrateAtRestSealing()` diperluas: `ContactRow.updatedAt` + `ProfileCacheRecord.updatedAt` (dua kolom waktu yang masih plaintext di IndexedDB) ikut di-seal di rel unlock yang sama (`keyStorage.saveDeviceAutoUnlockKey`), idempoten, dan baris terkunci tidak menghapus plaintext-nya. Pembaca kontak memakai `openLocalNumber` (baris lama tetap terbaca sebagai fallback `firstSeenAt`/`lastSeenAt`). Verifikasi: `contactStore.test.ts` (+3) & `dexieMigration.test.ts` (+1, IndexedDB nyata + Dexie nyata) |
| WS-F: pencarian terenkripsi (in-memory + benchmark) | ✅ | `web/src/lib/searchIndex.ts` — indeks in-memory saat vault terbuka (kata → messageId, tanpa FTS plaintext di disk) yang dipakai `store/messageSearch.ts`, plus `searchBench.ts` (10k pesan: waktu build indeks + memori) dengan script `bench:search`. Test: `searchIndex.test.ts` (14, semantik kandidat) + `searchBench.test.ts` (benchmark build indeks/memori) + **`web/src/store/__tests__/messageSearchIndex.test.ts` (7)** — regresi "pencarian tidak lagi mendekripsi per query" dijaga di level **store** oleh modul terakhir (menghitung panggilan `decryptVaultText` per pencarian; berkasnya SUDAH ada — catatan lama di sini yang menyebutnya "tidak ada" adalah kekeliruan, dikoreksi 2026-10-16) |

### M3 — sebagian landed (2026-10-13)

| Item | Status | Artefak |
|---|---|---|
| WS-E(2): signaling call tidak ter-link ke akun | ✅ | `server/src/utils/callRelayTokens.ts` (token acak 24 byte, peta Redis `token → sesi aktif` dengan identitas **ter-seal**, fail-closed untuk token tak dikenal) + `POST /api/call-tokens` & `/api/call-tokens/resolve` (`server/src/routes/callTokens.ts`, `requireAuth`, cap 32 peer/64 token) + relay `redisBridge.handleWebRtcRelay` kini memakai token untuk `to` **dan** `from` (userId tidak pernah masuk envelope/log/`nyx:downstream`); klien `web/src/lib/callRelayTokens.ts` (cache dua arah, batch untuk panggilan grup) + wiring `web/src/lib/webrtc.ts` semua jalur (request/accept/offer/answer/ICE) dan pemeta-an `from` → userId sebelum dipakai sebagai kunci peer. Skema shared: `CallRelayTokenSchema` + `WebRTCSignalingSchema.from` = token (userId ditolak). Test: `callRelayTokens.test.ts` server (9, termasuk guardrail envelope tidak memuat userId) + web (9, `api` di-stub). Verifikasi: web `tsc` 0, server `tsc` 0. **E2E call chrome DITUTUP (2026-10-15)** — lihat baris M6 "WS-E gate (1)" |
| WS-H: kuota per-ASN + heuristik sybil + false-positive NAT | ✅ | `server/src/utils/asnLookup.ts` — tabel prefix→ASN **lokal** (`ASN_DB_FILE`, CSV dua kolom / header GeoLite2, IPv4+IPv6, *longest prefix*, tanpa layanan pihak ketiga), 7 test termasuk batas rentang & IP tidak sah. `registrationGuard.ts` diperluas: batas keras `REGISTRATION_MAX_PER_ASN = 100` **inklusif** (akun ke-100 dari satu ASN dalam 1 jam ditahan — kriteria §30.12) + jendela velocity 10 menit (`REGISTRATION_SYBIL_BURST_MAX_PER_ASN = 25`) yang memicu **kewajiban attestation, bukan blokir**. Test NAT kantor besar: 40 akun tersebar dari satu ASN → lolos tanpa attestation; burst 30/10 menit → attestation. Key Redis selalu ter-pepper (`regburst:asn:*`, `regburst:asnfast:*`). 10 test di `registrationGuard.test.ts`. **Sisa:** pengukuran false-positive lapangan (butuh data ASN produksi) |
| WS-H: attestation WebAuthn akun baru | ✅ | `server/src/utils/webauthnAttestation.ts`: verifikasi **dua lapis** — pustaka `@simplewebauthn/server` (struktur, challenge, origin, RP ID, flag UP/UV, alg COSE, statement attestation per `fmt`) **plus** kebijakan murni NYX (`evaluateAttestationPolicy`: format allowlist, **rantai sertifikat wajib + jalur ke root yang dipin** (self ditolak secara default; root boleh tidak ikut `x5c` lewat `ABUSE_ATTESTATION_ROOTS_FILE`, `ops/attestation/README.md`), AAGUID blocklist, user-verification, single-device) + challenge sekali-pakai di Redis. Route: `POST /api/auth/register/attestation-options` (attestation `direct`, platform) dan `/register` dengan `attestation` (428 `ATTESTATION_REQUIRED` → verifikasi **sebelum** akun dibuat; sukses = `isVerified` + baris `Authenticator`). Klien: `web/src/lib/registerAttestation.ts` + retry sekali di `store/auth.ts` + 5 kunci i18n di keempat bahasa. Test: 26 test server dengan **respons registrasi WebAuthn asli** (CBOR + authenticatorData dibangun byte-per-byte, diverifikasi pustaka sungguhan — termasuk penolakan origin/challenge/RP ID salah, `none` yang sah secara kripto tetap ditolak, dan rantai `x5c` tanpa root yang diterima hanya via root dipin) + 5 test web. **E2E (2026-10-17):** browser nyata + authenticator platform virtual Chromium pada kebijakan ketat: `428` → upacara → `201` dengan `isVerified` + baris `Authenticator`; self-signed tanpa pin ditolak `CHAIN_TOO_SHORT`. **Sisa:** kunci privat di silikon sungguhan (TPM/SE/Titan) dan rantai vendor nyata — perlu perangkat fisik + bundle root vendor, bukan kode baru. |
| WS-A: **verifier klien + interop nyata** | ✅ (verified-search) | `packages/keytrans-wasm/` — `libsignal-keytrans` dikompilasi ke `wasm32-unknown-unknown` (≈293 KiB, **nol import**, ABI scratch-buffer, tanpa `wasm-bindgen`) dengan op `verify_search`/`verify_monitor`/`verify_distinguished`/`monitor_next`/`condense_update`. Klien `web/src/lib/keyTransparency.ts` + **18 test** (`keyTransparency.test.ts`) yang memverifikasi **bukti nyata dari binary Go `key-transparency-server`**: fixture dibuat `server/scripts/kt-fixtures.ts` (dua entri NYX ditulis dengan `return_update_response=true`, tree 63→64, `vrf_proof` 80 B) dan di-commit di `web/src/lib/__tests__/fixtures/kt/`. Yang diuji: bukti diterima + nilai benar, rotasi kunci, MITM (nilai palsu) **ditolak**, `vrf_proof`/`opening` diubah ditolak, dengan anchor `search`/`tree head` palsu ditolak (split-view), kunci VRF/search key salah ditolak, fuzz 200 input tanpa trap. **Temuan penting (docs/34 §34.5):** tanpa anchor (pencarian pertama) perubahan di `search`/`tree head` **tidak** terdeteksi — keamanan KT bergantung pada loop monitor. **Sisa:** gate vektor `cmd/generate-auditing-test-vectors` / interop `cmd/kt-client` tidak dijalankan di CI (keduanya `package main` upstream yang tidak di-vendor) — lihat §30.5 tahap C. Detail: `docs/34` |
| WS-A: **sisi baca KT milik NYX** | ✅ | `server/kt-query` (Go) — satu proses pemilik LevelDB yang menyajikan baca (`/search`, `/distinguished`, `/monitor`, `/config`), tulis (gRPC `KeyTransparencyTestService.Update`, protokol penulis lama **tidak berubah**), dan kunci `distinguished`. Proxy `/api/keys/kt/*` + metrik `nyx_kt_queries_total{result}` + degradasi terlihat (503 `KT_QUERY_DISABLED`). **Temuan yang memaksa desain ini** (bukti empiris, `docs/32` §32.8): query service upstream menolak nilai log NYX (`permission denied` tanpa entri ACI; error internal untuk nilai ≠ `0x00||aci16`), dan LevelDB tidak bisa dibagi dua proses (read-only mengambil `LOCK_SH` vs `LOCK_EX` penulis). Verifikasi: **31 test Go** (termasuk `VerifySearch`/`VerifyMonitor` upstream atas nilai NYX 1286 byte, layanan auditor `audit.go`, dan snapshot `snapshot.go`), 14 test proxy (`ktQuery.test.ts`), dan fixture jalur hidup yang diverifikasi WASM (18 test di `web/src/lib/__tests__/keyTransparency.test.ts`). Detail: `server/kt-query/README.md` |
| WS-A: penulis log Key Transparency | ✅ (sisa: `keyVersion` konstanta) | `server/src/utils/keyTransparency.ts` — search key `0x75\|\|usernameHash(32)`, nilai log v1 kanonik (frozen, `docs/32`), encoding protobuf `UpdateRequest` **tangan** + transport gRPC `node:http2` (framing 5 byte, `grpc-status` dari header **dan** trailer) tanpa dependensi baru; idempoten (dedupe `(searchKey, keyVersion, digest nilai)` sehingga **perubahan kunci tetap ditulis**), fail-visible (metrik `nyx_kt_writes_total{result}` + `nyx_kt_last_success_timestamp_seconds`, 2 alert Prometheus), nonaktif default (`KT_SERVER_URL`). Wiring: registrasi + `/recover` (label `KT_KEY_VERSION_*`) — keduanya fire-and-forget **setelah** commit DB dan **sebelum** respons, presisi waktu bucket harian; dijaga test sumber `wiring: registrasi … + pemulihan …`. **Rotasi kunci kini tertulis** (`utils/ktIdentityLog.ts`, 8 test): `POST /keys/prekey-bundle`, `PUT /users/me/keys`, dan re-sync kunci `POST /auth/login` — dengan verifikasi kepemilikan identifier (`identifier_mismatch` bila bukan milik pemanggil, `no_identifier` bila klien lama tidak mengirimnya) dan penyaring `identityKeysChanged` supaya upload ulang yang sama tidak membanjiri log. **Bukti live:** binary Go `key-transparency-server` dibangun (`go build ./cmd/kt-server`) dan dijalankan lokal; `KT_SERVER_URL=http://127.0.0.1:8081` (instance terisolasi, LevelDB `/tmp`) → test `live: penulisan nyata ke binary KT` **lulus** (ukuran pohon bertambah). Temuan dari live: server menolak `consistency = nil` → field itu selalu dikirim (boleh kosong). **11 test penulis** di `keyTransparency.test.ts` (2 guard wiring + 1 live opt-in `KT_SERVER_URL`; verifier klien punya 18 test sendiri). **Sisa:** (a) `keyVersion` masih label alur (registrasi/pemulihan/rotasi), bukan penghitung naik otomatis; (b) device dummy iframe B2B (`routes/engine.ts`) sengaja tidak menulis log (akun tenant, kunci dummy, tanpa identifier Argon2id). Keduanya dikunci test invariant `wiring: jalur yang menimpa Device.publicKey …` + `wiring: tiga jalur rotasi memanggil penulis log` (residual §32.7 poin 2) |
| WS-D: pembungkus SPQR WASM + test + benchmark | ✅ (pembungkus) | `packages/spqr-wasm/` — crate `spqr` v1.6.0 terkompilasi ke `wasm32-unknown-unknown` (raw module **nol import**, entropi disuntik host lewat `getrandom_backend="custom"`, tanpa `wasm-pack`/`wasm-bindgen`). Pembungkus klien `web/src/lib/spqrRatchet.ts` + **10 test** dengan modul hasil build sungguhan: ABI tanpa import, negosiasi versi, kesepakatan message key, entropi host deterministik, entropi kurang → `SpqrError(4)`, fuzz, **kehilangan 1..N−1 pesan** & **pengiriman keluar urutan** (skipped key) & kehilangan dua arah — semuanya sembuh. Benchmark terukur (`pnpm --filter nyx-web run bench:spqr`, 500 langkah/arah): pesan mapan **37 B**, **state 3,8 KiB/langkah**, `send` p50 **0,26 ms** (p95 0,60), `recv` p50 0,12 ms, modul 506,7 KiB. Gate §30.8: (2) drop **per chunk** terbukti dari test chunked di dalam crate (satu langkah `send` = satu chunk) + bentuk yang teramati dari ABI publik: pesan hilang/keluar urutan; (4) fuzz ✅; (5) benchmark ✅. Detail: `docs/33`. **Integrasi jalur pesan LANDED (2026-10-14):** header v2 `{v:2,b:[…]}` (bukan tambalan pada jalur beku), deklarasi versi in-band `ackV` di payload ter-seal (syarat kirim v2), state braid ter-seal berdampingan dengan state v1 + rollback yang mempertahankannya, op worker `spqr_ratchet_init/encrypt/decrypt` (WASM dimuat malas), kapabilitas deployment `spqr-ratchet` di sidecar, dan E2E Chrome `web/e2e/spqr.spec.ts` yang membuktikan `dr.v === 2` di amplop server + peer bisa membacanya. Gate §30.8: (1) test internal crate **lulus pada pin yang sama** — `cargo +nightly test --release --lib` di HEAD `06959b4708f9` = 57 passed/0 failed, exit 0 (stable gagal `E0658`, `assert_matches`) ✅; (2) loss per chunk terbukti di test chunked crate + bentuk yang teramati dari ABI publik ✅; (3) interop klien v2 ↔ v1 ✅ (v2 hanya dikirim setelah peer menyatakan mampu); (4) fuzz ✅; (5) benchmark ✅. **Rollback dua klien nyata ✅ (2026-10-14):** kill switch runtime DEV (`localStorage['nyx_spqr_force_v1']`, dibaca per pengiriman; `VITE_SPQR_FORCE_V1` build-time tidak bisa mem-rollback satu klien saja) + test kedua `web/e2e/spqr.spec.ts` — klien yang di-rollback mengirim v1 lagi di wire, peer tetap membacanya, pesan v2 dari peer tetap terbaca, state braid masih ada. Modul WASM juga masuk precache SW (`**/*.wasm`, ±0,8 MB install). Detail: `docs/33` §33.8/§33.10 |
| WS-G(6): vektor DR/sender-key lintas-implementasi | ~~⬜ blocked (2026-10-13)~~ **ditutup (2026-10-14), lingkup dipersempit** | Blokir 2026-10-13 (butuh libsignal + E2E) dijawab dengan mengubah bentuk, bukan menunggu: oracle berdiri sendiri tanpa libsignal, dan kelas bug yang mau ditangkap ("implementasi sama menyetujui kesalahan yang sama") sudah tertangkap di level X3DH/KEM/kdfChain. Lihat baris M4 WS-G(6) |

### M4 — sebagian landed (2026-10-14)

| Item | Status | Artefak |
|---|---|---|
| WS-A: integrasi verifikasi KT ke jalur bundle | ✅ | `web/src/lib/ktBundleProof.ts` (verdict `confirmed`/`mismatch`/`unverifiable`/`unavailable`/`unknown-subject`; Argon2id + bukti via `/api/keys/kt/*` + verifikasi WASM; TTL konfirmasi 24 jam; backoff 5 menit saat layanan mati) + `web/src/lib/ktSubject.ts` (menurunkan username peer dari profil E2EE: cache RAM → participant → dekripsi `encryptedProfile` percakapan → kontak, 8 test) + `peerIdentityTrust.ts` (verdict masuk sebelum kunci dipin: `ktVerifiedAt`/`ktKeyVersion`/`ktMismatch`, `source: 'kt'` di daftar pending, gate kirim menutup juga pada mismatch **kontak pertama**) + banner `IdentityChangeBanner` dengan copy khusus + 2 kunci i18n ×4 bahasa. **Menyimpang dari rencana** (op worker `kt_verify_search`): verifikasi butuh jaringan + state tersimpan, dan `docs/04` melarang menambah tanggung jawab jalur worker — jadi verifikasi di thread utama, jalur bundle hanya berubah di titik keputusan pin. Detail + batas jujur: `docs/34` §34.6a |
| WS-A: loop monitor KT + penjadwalan + notifikasi | ✅ | `monitorKeyTransparency()` (jembatan verifier+config ke `POST /api/keys/kt/monitor`), `startKtMonitorLoop()` (jeda awal 30 s, interval 6 jam, satu langkah pada satu waktu, gagal ≠ berhenti, `stop()` idempoten), wiring `App.tsx` (hanya saat `user && hasRestoredKeys`, impor dinamis agar WASM ≈293 KiB tidak masuk bundel awal) + toast `chat:banners.kt_key_rotation` (4 bahasa). 11 test (`ktMonitoring.test.ts`). Tiap langkah monitor juga menyegarkan **jangkar gossip** (`/api/keys/kt/head`). |
| WS-A: **auditor pihak ketiga (mode 3)** | ✅ (auditor dioperasikan) | `server/kt-query/audit.go` — layanan gRPC terpisah (`TreeSize`, `Audit`, `SetAuditorHead`) memakai kode upstream apa adanya (`tree.SetAuditorHead` → `verifyAuditorTreeHead`), nama auditor dari metadata `x-nyx-auditor-name` (loopback tanpa mTLS; kunci publik tetap dari `api.auditors` di config), penulisan diserialkan dengan update biasa (`mu` bersama). Test `audit_test.go`: mode 3 **menolak** bukti sebelum ada auditor head (`auditor tree head not provided`) dan menerimanya sesudahnya (verifier upstream yang sama dengan WASM), tanda tangan diubah / kunci penyerang / nama tak terkonfigurasi / mode bukan third-party semuanya ditolak, `Audit` menolak limit 0/terlalu besar. Proses auditor nyatanya: `server/kt-query/cmd/nyx-kt-auditor` — port Go dari auditor referensi Signal (`prefix_tree.go`/`log_tree.go` dari `key-transparency-auditor`), runner mengikuti urutan `Auditor.auditKeyTransparencyService` (state hanya disimpan **setelah** `SetAuditorHead` sukses, berhenti menandatangani saat bukti tidak konsisten), penandatanganan memakai `transparency.SignNewAuditorHead` upstream. Diuji terhadap **vektor resmi** `katie_test_vectors.pb` (10 update sukses dengan root hash cocok tiap langkah, 5 vektor gagal, tanda tangan byte-per-byte) + test unit pohon/state/runner + state bertanda tangan ed25519 yang ditolak bila diubah. Unit systemd + env: `ops/systemd/nyx-kt-auditor.*`; diterapkan di self-host pada 2026-10-16 (`/home/ken/nyx-selfhost`, mode 3 aktif: `/config` → `mode=3`, bukti ditolak verifier upstream sebelum auditor head ada dan diterima sesudahnya). **Sisa:** interop dua implementasi auditor (Java vs port ini) berdampingan belum dijalankan; auditor berjalan di host yang sama dengan log (independensi proses, bukan organisasi) |
| WS-A: **gossip tree head + deteksi split-view** | ✅ | `web/src/lib/ktGossip.ts` — jangkar `(treeSize, root)` dipertukarkan **di dalam payload ter-seal** (`ktG`, sebagaimana `ackV`; server tidak melihat apa pun) dan disimpan ter-seal (`ENC1:`, Dexie **v13** `ktGossip`, satu baris JSON). Verdict murni: ukuran sama + root sama = `consistent`; ukuran sama + root beda = **`split-view`** (satu pohon hanya punya satu root per ukuran) + toast `chat:banners.kt_split_view` (4 bahasa); head peer yang lebih baru hanya dicatat (`peer-ahead`) — tidak dipakai menyimpulkan apa pun tanpa bukti konsistensi. Sumber root: `GET /api/keys/kt/head` (JSON kecil dari `kt-query`; root tidak bisa dibaca dari byte `FullTreeHead` tanpa parser protobuf, dan parser protobuf hanya boleh di WASM). 17 test (`ktGossip.test.ts`) termasuk payload peer yang rusak, pemangkasan 64 peer, dedup tulis, dan adapter Dexie. **Sisa:** verifikasi lintas-klien nyata (dua browser) belum dijalankan |
| Ops: snapshot harian log KT → R2 | ✅ (kode; r2 perlu kredensial) | `server/kt-query/snapshot.go` — salinan **terverifikasi**: penulisan dijeda (`mu` bersama penulis), direktori LevelDB disalin, salinan dibuka ulang (`RecoverFile`) dan tree head + root-nya **dibandingkan dengan pohon hidup** (beda → arsip dibuang, tidak ada `latest.json`), lalu di-`tar.gz` dan dipangkas ke `NYX_KT_SNAPSHOT_KEEP` (default 7). Unggahan: `server/src/jobs/ktSnapshot.ts` (idempoten, retensi 30 hari, kredensial R2 hanya di proses server, metrik `nyx_kt_snapshot_upload_total`/`nyx_kt_snapshot_deleted_total`) dijadwalkan 03:30 via `index.ts`. 6 test Go (`snapshot_test.go`) + 8 test server (`ktSnapshot.test.ts`). **Sisa:** menjalankan di VPS (direktori + kredensial R2) dan membuktikan pemulihan dari arsip |
| Gate M7: lint `correctness` = error | ✅ (sisa `no-unused-vars` sengaja `warn`) | `.oxlintrc.json` — kategori `correctness` kini `error` (dulu `warn`): seluruh temuan kelas bug/keamanan **harus 0**, dan memang 0. Yang tersisa 194 `no-unused-vars` tetap `warn` karena bukan kelas bug; menaikkannya ke `error` sebelum angkanya 0 hanya membuat CI merah terus dan diabaikan. Verifikasi: `pnpm run lint` → `Found 194 warnings and 0 errors` |
| Ops: `/api/admin/cleanup` bukan stub | ✅ | Logika pembersihan dipindah dari closure cron ke `server/src/jobs/cleanup.ts` (`runCleanup`: refresh token, session key, dead-man's switch, langganan, story; tiap langkah terisolasi + laporan `errors`), dan endpoint admin memanggil **kode yang sama** serta mengembalikan hitungan per jenis (500 bila ada langkah gagal, bukan "Cleanup triggered"). 9 test (`cleanup.test.ts`), wiring dijaga `temporalBucket.test.ts` + `storyBlockPrivacy.test.ts` |
| WS-D: prasyarat integrasi SPQR (negosiasi + state) | ✅ | `web/src/lib/spqrNegotiation.ts` (keputusan versi murni: kapabilitas hanya dibaca saat sesi didirikan, anti-downgrade v2 hanya bila kedua sisi mampu, saklar tunggal `SPQR_INTEGRATION_ENABLED` — kini menyala, kill switch `VITE_SPQR_FORCE_V1` + runtime DEV — rollback eksplisit yang mempertahankan state v2; **21 test**) + `web/src/lib/spqrState.ts` (state braid per sesi ter-seal `ENC1:`, tulis di-koalesensi 250 ms, batas 64 KiB diperiksa sebelum antre, fail-closed saat dibaca, byte opaque milik WASM; 9 test). **"Sisa" yang tercatat di baris ini sudah tertutup dan diverifikasi ulang (2026-10-17):** (a) versi wire baru ada di header DR `{v:2,b:[…]}` + diparse **sebelum** jalur v1; (b) `ackV` ditulis di payload ter-seal saat kirim dan dibaca/disimpan dari plaintext yang lolos AEAD di **kedua** jalur terima; (c) modul negosiasi + state benar-benar dipanggil jalur pesan (`utils/crypto.ts` → op worker `spqr_ratchet_*`). Bukti yang bisa dijalankan di sini: `web/src/lib/__tests__/spqrMessagePath.test.ts` (**8 test**: perilaku modul-nyata+WASM-nyata — v1 dulu, lalu v2 setelah `ackV`, peer membukanya, rollback mempertahankan braid, fallback saat braid belum ada; plus guard sumber urutan panggilan) + suite SPQR/kapabilitas/`drProtocol` (**98 test** di 7 berkas). **Sisa jujur:** E2E `web/e2e/spqr.spec.ts` **tidak bisa dijalankan di mesin ini** — `NODE_ENV=production` di `server/.env` membuat `global.setup.ts` → `reset-test-env.ts` menolak duluan (exit 1, tanpa menyentuh data); hasil E2E terakhir tetap yang tercatat di `docs/33` §33.10 |
| Lingkungan E2E di mesin ini | ✅ (koreksi catatan lama) | Catatan M2/M3 ("Postgres lokal belum punya role `nyx_user`/db `nyx_app`") **sudah tidak berlaku**: Postgres 5432 + Redis 6379 hidup, role `nyx_user` + db `nyx_app` ada, dan `e2e/global.setup.ts` (`reset-test-env.ts`) berhasil mereset. Suite `playwright test --project=chromium` bisa dijalankan; **browser headless ini tetap tanpa `WebTransport`** sehingga `transport.spec`/`chat.spec` auto-skip (pakai `--project=chrome` bila perlu). Verifikasi M4 (2026-10-14, run akhir): web `tsc` 0, `vitest` **615/615 (72 file)**, server `tsc` 0, server test **379 pass/1 skip (380)**, `kt-query` Go **31 test**, `cargo test` **18 test / 2 target**, E2E `--project=chromium` **13 test / 8 file** (`playwright test --list`; 26 bila proyek `chrome` ikut dihitung) — `auth.spec` dijalankan ulang, `transport`/`chat` auto-skip karena headless ini tanpa WebTransport. Tambahan dari WS-G: `scripts/drill-alerts.sh` **exit 0** (14 aturan, 14 kasus drill, 7 metrik terdeklarasi, exporter hidup 13 keluarga metrik), `go run . -check` oracle **exit 0**, interop NYX↔oracle **4/4** |
| WS-G(2): **drill alert** — aturan dibuktikan bisa menyala | ✅ | `ops/prometheus/tests.yml` + `scripts/drill-alerts.sh` (4 lapis: `promtool check config`/`check rules` → **`promtool test rules`** dengan kasus menyala DAN tidak-menyala per aturan → kontrak metrik → cakupan drill). Lapis 3 menolak aturan yang merujuk nama metrik yang tidak dideklarasikan di `metrics.ts` (aturan seperti itu **tidak akan pernah menyala** dan tidak mengeluarkan error apa pun), lapis 4 menolak aturan baru yang belum punya kasus drill. Lapis 4 opsional men-scrape `/metrics` nyata dan menolak keluarga metrik yang tidak dideklarasikan. Wiring: job CI `alerts` (`SKIP_LIVE=1`) + langkah drill terhadap exporter hidup di job `e2e`. Verifikasi 2026-10-14: exit 0 — 14 aturan, 14 kasus drill, 7 metrik terdeklarasi, exporter hidup 13 keluarga metrik. **Temuan saat pertama di-drill:** tiga aturan mengeluarkan label yang tidak sesuai dugaan (`NyxMetricsExporterDown` menambah `job`, `NyxSweeperStale`/`NyxKtSnapshotNotUploaded` menandai sampel terakhir yang `result="ok"`) — kasus uji diselaraskan dengan perilaku nyata ekspresi, bukan sebaliknya |
| WS-G(3): **load test relay dijalankan** (angka nyata) | ✅ | `scripts/load/run-relay-load.sh` (1 API hidup → 2 akun+device+percakapan uji dari `server/scripts/load-test-user.ts` yang idempoten → 3 **SMOKE** 5 VU → 4 beban penuh) + `scripts/load/relay.k6.js`. **Terukur 2026-10-14** (500 VU, jeda 25 s/iterasi): 3.235 iterasi, 6.472 request, 24,6 req/s — send p95 **74,39 ms**, fetch p95 **68,83 ms** (gate < 200 ms); `http_req_failed` **0%**, `nyx_relay_errors` **0%**, checks 6.470/6.470; puncak `max` send 265,6 ms = ekor startup, bukan pelanggaran gate. Langkah SMOKE bukan hiasan: tanpa itu, kegagalan autentikasi/CSRF terlihat seperti "beban ringan" (401/403 dijawab cepat tanpa menyentuh DB). Dijalankan manual (menulis pesan ke DB lokal), bukan di CI |

| WS-G(6): **vektor DR/X3DH lintas-implementasi** | ✅ (primitif; ratchet penuh tetap internal) | `tools/dr-oracle/` — oracle Go yang **tidak memakai libsodium sama sekali**: X25519 (`x/crypto/curve25519`), konversi Ed25519→Montgomery ditulis sendiri, X-Wing/ML-KEM-768 (`cloudflare/circl`), BLAKE2b keyed, XChaCha20-Poly1305. Dua arah: (a) oracle→NYX — `web/src/lib/__tests__/fixtures/x3dhOracleVectors.json` (2 vektor X3DH dengan/tanpa OTPK + 4 langkah `kdfChain`) diverifikasi `x3dhOracleVectors.test.ts` lewat **worker asli** `crypto.worker.ts` (harness `helpers/workerHarness.ts`), termasuk kontrol negatif + OTPK hilang = gagal keras; (b) NYX→oracle — `x3dhOracleInterop.test.ts` menyerahkan hasil NYX ke mode `-recipient`/`-ratchet` oracle (4 test: sessionKey identik, oracle membuka ciphertext NYX, NYX membuka ciphertext oracle, dan dua kontrol negatif). Gate drift `go run . -check` menolak vektor ter-commit yang tidak lagi identik dengan hasil regenerasi; job CI `dr-oracle` menjalankan `go build/vet/test` + `-check` + kedua test. Verifikasi 2026-10-14: `-check` exit 0, interop 4/4 lulus. **Batas jujur:** yang tertutup adalah primitif di bawah ratchet (DH, KEM, KDF, AEAD + urutan/panjang rahasia); **sender-key chain, skipped key, dan `SessionRecord` libsignal tidak** dibandingkan ke oracle — tetap diuji internal (`spqrRatchet.test.ts` + crate SPQR). Nyatakan ini sebagai parsial, bukan "vektor DR penuh" |

### M6 — WS-E gate (1) ditutup (2026-10-15)

| Item | Status | Artefak |
|---|---|---|
| WS-E gate (1): E2E call chrome **dengan coturn nyata** | ✅ | `web/e2e/call.spec.ts` — tiga langkah yang dibuktikan berurutan: (a) `/api/keys/turn` lewat klien produksi `web/src/lib/api.ts` mengembalikan kredensial **coturn** (username `<unixExpiry>:<identityTag>`, identityTag bukan userId), entri Cloudflare **disaring keluar** supaya bukti relay tidak bisa lolos lewat pihak ketiga; (b) dua `RTCPeerConnection` di browser nyata dengan `iceTransportPolicy: 'relay'` benar-benar **terhubung**; (c) pasangan kandidat terpilih = `relay`↔`relay` (bukan host/srflx) dari coturn. Bukti run: `kandidat pemanggil: [{type:relay, address:127.0.0.1, protocol:udp}]` + `kandidat terpilih: {localType:relay, remoteType:relay}`. **Dua bug uji yang ditemukan & diperbaiki** (keduanya kelas "lulus/ gagal karena uji, bukan karena produk"): (1) SDP diserahkan **sebelum** ICE gathering selesai dengan asumsi ada trickle — tanpa jalur sinyal, SDP tanpa kandidat membuat ICE mandek di `new` (`pairs: []`) dan coturn seolah tidak bekerja; kini gathering ditunggu (`iceGatheringState === 'complete'`) sebelum `setRemoteDescription`. (2) `connectionState` dibaca **setelah** `close()` sehingga kegagalan selalu dilaporkan sebagai `caller=closed callee=closed` tanpa informasi; kini status diambil sebelum menutup. **CI:** job `e2e-chrome` memasang + menjalankan coturn sendiri (`TURN_URLS`/`TURN_STATIC_AUTH_SECRET` di env job, conf `listening-ip`/`relay-ip` loopback, `allow-loopback-peers` **hanya di runner** — peer di loopback; produksi memakai IP publik) dan memverifikasi listener `:3478` hidup sebelum suite. Tanpa coturn, spec **skip dengan alasan tertulis**, bukan lulus palsu. **Sisa:** coturn systemd di VPS |
| WS-G(7) lanjutan: `transport.spec` benar-benar dijalankan (bukan skip) | ✅ | Spec ini dulu **belum pernah dieksekusi** (headless tanpa `WebTransport` → auto-skip), jadi dua bug bersembunyi di dalamnya: (1) assertion tombstone mencari `/message deleted/i` sedangkan tombstone asli `"This message was deleted"` — assertion yang selalu gagal begitu spec dijalankan; (2) `page.getByText('…')` juga mencocokkan **preview di sidebar**, jadi aksi bertemu elemen kedua dan menggantung → locator di-scope ke `main` dan aksi diberi timeout. Terverifikasi lulus dengan `--project=chrome` terhadap sidecar WebTransport + coturn nyata |

### M7 — gate WS-F diverifikasi + dua kolom waktu presisi ditutup (2026-10-16)

| Item | Status | Artefak |
|---|---|---|
| WS-F gate (1): inspeksi IndexedDB mentah (test + manual) | ✅ (sampai presisi bucket) | Test baru di `web/src/lib/__tests__/dexieMigration.test.ts`: `findActivityLeaks()` menyapu **semua tabel Dexie** (baris mentah, nilai bersarang ikut ditelusuri) dan menolak (a) ISO non-bucket, (b) epoch-ms non-bucket, (c) boolean `isGroup`/`isDeletedLocal`/`isViewOnce`, (d) kolom yang seharusnya `ENC1:` tapi masih plaintext. **Kontrol negatif** membuktikan pemindainya bisa gagal (baris bocor buatan → ≥5 temuan, dan `orderBucketMs` **tidak** dilaporkan = tidak ada false positive). Bahan "manual"-nya dump ter-redaksi yang dicetak test (`messages[act1] {senderId: ENC1:…(len 9), sentAt: ENC1:…(len 25), createdAt: null, orderBucketMs: bucket@…}`). **Batas jujur:** yang terbaca setelah WS-F adalah **bucket 15 menit per baris** + **jumlah baris per bucket/percakapan** — dua hal yang tidak bisa dihilangkan tanpa berhenti menyimpan pesan, dan keduanya sudah bocor di server dengan skema yang sama (`docs/28` B3/B4). Jadi gate ini bukan "nol pola aktivitas", melainkan **presisi di bawah bucket tidak ada**. Sisa plaintext yang disengaja: `offlineQueue.timestamp` (kolom indeks `orderBy('timestamp')`, antrean kirim sementara) |
| WS-F: **temuan** `sentAt` + `lastActivity` masih plaintext | ✅ diperbaiki | Verifikasi menemukan dua kolom presisi yang tidak ada di daftar "sisa" mana pun: `DecryptedMessageRecord.sentAt` (`web/src/lib/db.ts`, ms per pesan — inilah yang membuat "jam" tetap terbaca) dan `PqDrSessionRecord.lastActivity` (ms per sesi PQ-DR). Keduanya di-seal `ENC1:` mengikuti pola `seq`: writer (`upsertMessages`, `savePqDrSession`), migrasi unlock (`sealLegacyStructFields` + loop `pqDrSessionsV2` di `migrateAtRestSealing`), pembaca (`parseRecordsToMessages` dan `getPqDrSession` — yang terakhir kini mengurutkan sesi lewat nilai yang **dibuka**, bukan pengurangan string). Baris lama berbentuk angka plaintext tetap terbaca (`openLocalNumber`). Tidak ada format beku yang disentuh: `sentAt` tetap hanya hidup di dalam ciphertext saat dikirim; yang berubah hanya bentuk at-rest lokal |
| WS-F gate (2): urutan setelah reload & wipe | ✅ | Dua test baru di `dexieMigration.test.ts` (IndexedDB nyata + Dexie nyata): (a) koneksi ditutup lalu DB dibuka ulang → urutan halaman identik; (b) `Dexie.delete` (wipe) + tulis baris arsip dalam **bentuk pra-v9** (tanpa bucket, `createdAt` plaintext) → baris belum terlihat, `normalizeOrderIndex()` memperbaiki → urutan identik dengan sebelum wipe **dan** presisi/waktu tampilan utuh (`createdAt` sama persis). Keduanya jalur restore produksi (`.nyxbak`/impor JSON), bukan simulasi tabel-palsu |
| WS-F gate (3): pencarian < 100 ms untuk 10k pesan | ✅ terukur | `pnpm --filter nyx-web run bench:search` (`searchBench.ts`, fixtur deterministik), **dua kali dijalankan 2026-10-16** (sebelum & sesudah perubahan at-rest, untuk memastikan perubahan itu tidak menggeser angka): **10.000 pesan / 20 percakapan** — build indeks **192,9–212,3 ms**, cari dingin **3,4–4,3 ms**, cari hangat **3,98–4,03 ms/query** (kandidat umum 187), puncak heap ~71,6 MB. Angka dicetak apa adanya; ambangnya `SEARCH_BENCH_BUDGET.searchMs = 100`. Gate < 100 ms terpenuhi dengan margin ~25× |
| WS-F gate (4) + regresi suite | ✅ | `localAtRest.test.ts` 7/7 + `vaultSeqPersistence.test.ts` 4/4 hijau; suite web penuh **654/654 (76 file)**, `npx tsc --noEmit` 0, `pnpm --filter nyx-web run build` exit 0 |
| Koreksi catatan lama (modul test pencarian) | ✅ | Baris M2 menyebut "modul `messageSearchIndex.test.ts` **tidak ada**" — keliru: `web/src/store/__tests__/messageSearchIndex.test.ts` ada (7 test) dan justru **itulah** penjaga regresi "tidak mendekripsi ulang per ketikan" (menghitung panggilan `decryptVaultText`). Catatan dikoreksi di baris M2 |


### M8 — gate WS-H diverifikasi + IP keluar dari key Redis (2026-10-16)

| Item | Status | Artefak |
|---|---|---|
| WS-H gate (2): audit "tidak ada IP di DB/Redis" | ❌→✅ **temuan nyata** | Ditemukan dua tempat klien terwakili mentah/tanpa kunci di Redis: (a) key limiter `express-rate-limit` memakai `ipKeyGenerator(cfAwareClientIp(req))` → `RedisStore` menulis `rl:general:<ip>`, `rl:auth:<ip>`, `rl:upload:<ip>` (TTL 15 mnt–1 jam) — snapshot Redis = daftar alamat klien; (b) `/pow/challenge` menurunkan key dari `blake2b(primaryId)` **tanpa kunci**, dipotong 16 hex (`pow:user|inst|fp|ip`) — untuk cabang IP, ruang IPv4 (2^32) bisa dienumerasi sampai cocok. Perbaikan: `utils/clientIp.ts` `clientIpTag()` (HMAC pepper atas alamat yang **sudah** dinormalkan `ipKeyGenerator`, jadi normalisasi IPv6 bawaan tetap dipakai) dipakai ketiga limiter + limiter non-API di `app.ts`; `utils/powIdentity.ts` `powRateKey()` (HMAC pepper, domain-separated `prefix:primaryId`) dipakai `/pow/challenge`. Semantik pembatasan identik (klien sama → tag sama → counter sama); key berubah bentuk ⇒ counter lama berhenti dipakai (wajar, TTL pendek), dan operator tetap bisa menghitung tag dari pepper kalau perlu menelusuri satu alamat. Guardrail: `tests/ipKey.test.ts` (+3: tag tanpa alamat, deterministik, wiring tidak kembali ke IP mentah) & `tests/powIdentity.test.ts` (+2: `powRateKey` HMAC + wiring) |
| WS-H gate (1)/(3): 100 akun/ASN tertahan + false-positive NAT | ✅ (tidak berubah) | `registrationGuard.test.ts` (10 test): batas ASN **inklusif** (akun ke-100 ditahan, `429` alasan jaringan), heuristik burst 10 menit ≥25 → **wajib attestation** (bukan blokir), NAT kantor 40 akun tersebar → nol temuan, `NaN` (Redis error) fail-open, key counter tanpa IP/instalasi/ASN mentah, mode `shadow` menghitung semua lapisan tanpa menahan siapa pun, dan label metrik shadow tidak menyalakan alarm kebocoran identitas |
| WS-H gate (4)/(5): attestation akun baru + PoW/Turnstile | ✅ | `webauthnAttestation.test.ts` (13 test, respons registrasi WebAuthn nyata dibangun byte-per-byte): `none` sah secara kripto tetap ditolak, origin/challenge/RP ID salah ditolak pustaka, `packed`+`x5c` nyata diterima, root dipin menerima root benar & menolak root lain, rantai tak tersambung/tanda tangan diubah/satu sertifikat ditolak, EKU AIK TPM wajib untuk `fmt: tpm`, challenge sekali-pakai. Wiring register: verifikasi **sebelum** `user.create` (gagal → tidak ada baris User), `428 ATTESTATION_REQUIRED` bila gerbang menyala tanpa bukti |
| WS-H: isyarat boot & pemantauan | ✅ (+1 koreksi) | `abuseGuardStates`/`startupWarnings` (7 test) + gauge `nyx_abuse_guard_enabled{guard}` dan alert `NyxAbuseGuardDisabled`. **Koreksi:** alert menyuruh operator membaca "checklist lengkap di docs/10 §10.13" — §10.13 adalah cleanup & snapshot KT, bukan guard. Checklist WS-H kini ada (§10.16 baru) dan rujukan alert + peringatan boot diarahkan ke sana (`ops/prometheus/{alerts.yml,tests.yml}`, `utils/startupSignals.ts`) |
| WS-I gate: tautan `/u/<hashId>` bisa dibagikan & dipindai | ❌→✅ **temuan nyata** | Route + validasi bentuk sudah benar, tetapi fiturnya **tak terjangkau**: (a) `ShareProfileModal` membangun `/connect?u=…&i=<userId>&p=<profil terenkripsi>` — userId mentah beredar di QR — dan **tidak ada produsen** `/u/`; (b) `ScanQRModal` menolak QR `/u/<hashId>` (hanya `/connect?u=…` diterima). Perbaikan: `ShareProfileModal` memakai `buildUsernameLink` (QR + salin = link yang sama, hanya hashId; hashId tak sah → tidak render QR, bukan melempar saat render), `ScanQRModal` memakai `parseProfileShareLink()` (satu parser: `/u/<hashId>` tervalidasi + `/connect?u=…&i=…&p=…` apa adanya supaya QR lama tetap hidup; host sengaja tidak dipatok untuk self-host). Bukti: `usernameLink.test.ts` (+8), `shareProfileModal.test.tsx` (3), `scanQrModal.test.tsx` (4) — QR dipalsukan sebagai nilai teks dan callback pemindai dijalankan sebagai perilaku. Verifikasi: web `tsc` 0, `vitest` **669/669 (78 file)**, `pnpm --filter nyx-web run build` exit 0. **Sisa jujur:** tidak ada test E2E browser (kamera + `/connect` nyata) — `playwright` butuh Postgres/Redis lokal |
| Verifikasi suite | ✅ | server `tsc --noEmit` 0; `pnpm --filter nyx-server run test` **434/435 lulus (1 skip opt-in live KT), exit 0** — naik dari 429/430 karena 5 test baru. Dua kegagalan yang lama ada (**bukan** perilaku produk) diperbaiki di test-nya: `atRestSecrets` meng-assert cabang dev padahal mesin ini punya `NODE_ENV=production` di `.env` (kini mode-aware: production → fail-closed), dan `ktSnapshot` mengharap `KT_SNAPSHOT_DIR` kosong padahal `.env` self-host mengisinya (kini env dibersihkan selama test) |
