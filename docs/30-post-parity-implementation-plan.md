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
| `key-transparency-server` | `30b7a2a40604` (2026-08-18) | server log KT (Go, gRPC) + auditor test vectors |
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
| 11 | Call privacy: coturn + signaling token (§5.7) | ⬜ | WS-E |
| 12 | KT penuh (§5.1 tahap B) | ⬜ | WS-A |
| 13 | Multi-device (§5.2) | ⛔ **DIBATALKAN** | non-goal permanen (§30.6, §30.18) — single-device = properti keamanan |
| 14 | SPQR PQ ratchet (§5.4) | ⬜ | WS-D |
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

**Arsitektur (rekomendasi: pakai kode Signal apa adanya):**

1. **Proses `nyx-kt`** = binary Go dari `key-transparency-server` (pin teratas),
   backend **LevelDB lokal** (`/root/nyx-kt/leveldb`), listen gRPC **hanya di
   loopback** (`127.0.0.1:8443`), dijalankan pm2/systemd berdampingan dengan
   `nyx-api`/`nyx-sidecar`. Snapshot LevelDB → R2 harian (tanpa kunci di box?
   kuncinya ada di box — dicatat sebagai residual).
2. **Penulis log (Node)**: `server/src/utils/keyTransparency.ts` memanggil Update
   (gRPC internal) pada tiga peristiwa: `register`, `prekey-bundle` rotate,
   `recover`. Nilai yang masuk log: `usernameHash → { identityKey, pqIdentityKey,
   signingKey, keyVersion, updatedAtBucket }`. **Tidak** ada userId, IP, nama.
   Log ditulis *setelah* commit DB sukses (idempoten lewat `keyVersion`).
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
4. **Tahap C (auditor + gossip)**: `web/src/lib/keyTransparencyAudit.ts` yang
   memverifikasi `Monitor`/`Search` secara berkala, tree head di-gossip antar
   klien lewat slot metadata pesan yang sudah ada (1:1 & grup) → dua klien yang
   melihat tree head berbeda dapat membuktikan split-view. Plus binari
   auditor mandiri (`cmd/kt-client` reuse) untuk auditor pihak ketiga.

**Yang TIDAK dilakukan:** gossip "lite" di HP sebagai pengganti log (dihapus dari
rencana — itu bukan KT, hanya TOFU kolektif).

**Acceptance gate WS-A:**

1. Vektor `cmd/generate-auditing-test-vectors` lulus 100% di klien verifikasi NYX
   (WASM maupun fallback TS) — dijalankan sebagai test di CI.
2. Interop nyata: `cmd/kt-client` melakukan insert/update di `nyx-kt`, klien web
   memverifikasi Search + Monitor untuk key itu.
3. **Simulasi MITM**: test integrasi di mana server mengembalikan bundle palsu →
   klien **menolak** dengan bukti ketidakcocokan log (bukan sekadar warning TOFU),
   dan pengiriman terblokir sampai user menyelesaikan konfirmasi.
4. Audit privasi: `privacy-dump-audit.ts` tetap lulus; log LevelDB tidak memuat
   nilai yang memetakan ke akun tanpa `usernameHash` (yang sudah memory-hard).
5. Degradasi terlihat: `nyx-kt` mati → klien jalan dengan TOFU + banner
   "verifikasi kunci tidak tersedia" (fail-visible, tercatat di metrik).
6. Rollback: mematikan fitur lewat kapabilitas di
   `packages/shared/src/transport.ts` (`CLIENT_CAPABILITIES.KT_LITE` sebagai
   gerbang minimum; bila fitur di-off kan perilaku klien lama tidak berubah).

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

---

## 30.11 WS-G — Rekayasa, observability, dan verifikasi

1. **Metrik tanpa telemetry** (`docs/27` §27.7): Prometheus + Grafana self-host
   (systemd/docker) + node/postgres/redis exporter; metrik hanya hitungan event
   (volume pesan, distribusi mode transport, error rate, latency sweeper,
   pertumbuhan DB) — **tanpa userId/IP/usernameHash**. Docs + dashboard
   di-commit.
2. **Alert**: disk, RAM, eviksi key rate-limit Redis, lag sweeper
   (`server/src/jobs/systemSweeper.ts`), expiry sertifikat sidecar
   (`cert_tests` sudah ada), lag log KT (WS-A), gagal verifikasi KT.
3. **k6 load test**: 500 user konkuren, 20 pesan/s agregat, badai fan-out grup;
   gate p95 < 200ms untuk operasi relay; jalankan nightly + sebelum rilis besar.
4. **Test perilaku menggantikan regex source**: untuk endpoint kripto/otorisasi
   (`keys.ts`, `conversations.ts` credential, `sessions.ts`) pakai supertest +
   fake Prisma/Redis (pola `node:test` + fake yang sudah dipakai server).
   Target: setiap endpoint otorisasi punya ≥1 test perilaku.
5. **Fuzzing**: parser framing sidecar (cargo-fuzz), `parseTransportHello`,
   parser backup (WS-C), verifier proof KT (Spike-1 output).
6. **Vektor lintas-implementasi DR/sender-key**: harness Rust kecil yang memakai
   **libsignal** sebagai oracle (pin §30.2) menghasilkan vektor (ratchet step,
   sender-key chain, skipped key) → test TS memverifikasi output NYX identik
   untuk primitif yang sama.
7. **Dedup helper E2E** (`docs/29` §7.5): satu `web/e2e/helpers/registration.ts`
   + import di semua spec; target suite chrome lebih cepat & stabil.

**Acceptance gate WS-G:** (1) alert benar-benar menyala dalam game-day drill;
(2) k6 lolos p95 < 200ms; (3) `pnpm -r lint` kategori `correctness` → `error`
(temuan lama dibersihkan, `docs/29` QW5 residual); (4) fuzz jalan ≥1 jam tanpa
crash; (5) vektor DR/sender-key lulus.

---

## 30.12 WS-H — Anti-abuse bertingkat tanpa PII

- Kuota bertingkat mengikuti pola `server/src/utils/otpkQuota.ts`: per
  `identityTag`, per-hash-ASN (HMAC pepper — **IP mentah tidak pernah disimpan**),
  per-installation tag (sudah ada di `Device.installationTag`).
- WebAuthn attestation untuk akun baru (perangkat keras), PoW adaptif
  (`server/src/routes/auth.ts` jalur PoW sudah ada), Turnstile tetap.
- Deteksi sybil = heuristik burst (bukan ML, tidak butuh data pribadi).
- Acceptance: 100 akun dari satu ASN dalam 1 jam → tertahan; audit: tidak ada IP
  di DB/Redis (sudah jadi aturan `docs/28`); test false-positive untuk jaringan
  besar (NAT kantor).

---

## 30.13 WS-I — Username links (contact discovery tanpa graph sosial)

Link `https://nyx-app.my.id/u/<hashId>` → halaman yang hanya mengirim
`hashId` (nilai ter-pepper yang sudah ada) ke server untuk memetakan ke
`usernameHash`; tanpa enumerasi (rate limit + exact match; pola
`users.ts` `isExactHash` sudah ada). Ini fitur parity yang murah.

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
   mulai: `31-backup-format.md`, `32-key-transparency.md`, `33-multi-device.md`.
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
| WS-G(2): alert | ✅ (belum di-drill) | `ops/prometheus/{prometheus.yml,alerts.yml}` — 10 aturan, termasuk `NyxMetricsIdentityLeakAttempt` |
| WS-G(3): load test | ✅ (belum dijalankan) | `scripts/load/relay.k6.js` — 500 VU, p95 < 200 ms |
| WS-G(4): test perilaku otorisasi | ✅ (sebagian) | `server/tests/credentialAuth.test.ts` — matriks gate §7.1 dengan fake Prisma; logika dipindah ke `server/src/utils/credentialAuth.ts` agar bisa diuji perilaku |
| WS-G(4): sisa endpoint | ⬜ | `keys.ts` (prekey-bundle/OTPK), `sessions.ts`, jalur admin grup lain |
| WS-G(6): vektor DR/sender-key libsignal | ⬜ | butuh harness Rust oracle |
| WS-F: seal sisa kolom struktural | ⬜ | butuh skema **urutan terenkripsi** (sorting/paginasi) + hook Dexie async + migrasi — jangan dikerjakan sebagai tambalan |
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
  `expiresAt` (ms), `Conversation.isGroup`. Konsekuensi yang mudah salah: nilai
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
| WS-E(1): coturn self-host (kredensial HMAC) | ✅ | `/api/keys/turn` kini **coturn primer** (`TURN_URLS` + `TURN_STATIC_AUTH_SECRET`, TTL default 600 s) dengan Cloudflare TURN sebagai cadangan; username memakai `identityTag` (bukan userId). Logika murni di `server/src/utils/turnCredentials.ts` + 7 test (`turnCredentials.test.ts`); env di `.env.example` (root & server). **Sisa:** coturn process/systemd nyata di VPS + E2E call chrome |
| WS-E(2): signaling call tidak ter-link ke akun | ⬜ **belum dikerjakan** | `redisBridge.handleWebRtcRelay` masih `{ from: userId }` + rute `to: userId`. Butuh pemetaan `token → sesi aktif` (Redis, ter-`identityTag`) untuk 1:1 sebelum bisa memenuhi gate §30.9 (3). **Sengaja belum disentuh** di audit ini: perubahan ada di jalur call yang HANYA bisa diverifikasi lewat E2E chrome (di luar instruksi sekarang) |
| WS-I: username links `/u/<hashId>` | ✅ | Route `/u/:hashId` (web, di dalam ProtectedRoute) → meneruskan hashId ke alur `/connect` (pencocokan persis, tanpa enumerasi). Helper `web/src/utils/usernameLink.ts` + 5 test (`usernameLink.test.ts`) memakai aturan bentuk yang sama dengan server (`users.ts` `isExactHash`) |
| WS-H: anti-abuse tanpa PII | 🟡 sebagian | `server/src/utils/registrationGuard.ts` (kuota per sumber **IP ter-HMAC** + per instalasi, INCR+EXPIRE atomik, fail-open saat Redis error) + 5 test; wiring di `auth.ts` register via env `ABUSE_REGISTRATION_GUARD=on` (default off = no-op). **Sisa (butuh data/keputusan luar):** kuota per-hash-ASN (butuh database ASN — proksi prefix /24+/48 akan mengubah properti gate §30.12, jadi tidak dipakai diam-diam), WebAuthn attestation akun baru, pengukuran false-positive NAT |
| WS-G(4): test perilaku endpoint | ✅ | Revokasi sesi dipindah ke `server/src/utils/sessionRevocation.ts` + 3 test (ownership 404, family, blacklist TTL); pemetaan bundle `keys.ts` dipindah ke `server/src/utils/keyBundle.ts` + 5 test. **Jalur grup** (2026-10-12) dipindah ke `server/src/utils/groupAccess.ts` + **17 test** (`groupAccess.test.ts`): tambah/kick anggota (404/403 fail-closed), leave (token grup ATAU baris delivery-token sendiri, lookup lewat nilai routing ter-seal), details (403 untuk conversation hilang = kontrak lama), rotasi kunci (admin-only), purge (404 → 400 non-grup → 403 token → admin → 409 `MEMBERS_REMAIN`), dan urutan gate (`token → admin → hitungan anggota`) |
| WS-G(5): fuzzing parser input tak terpercaya | ✅ | `web/src/lib/fuzzParsers.ts` (+ `fuzzParsers.test.ts`, 4 test incl. **self-test harness**) untuk `parseTransportHello`, `readBackupHeader`, `unpadBackupPayload`, `parseBackupArchive`, `readBackupChunk`; `cargo test` + `cargo run --release --bin fuzz-framing` untuk bingkai sidecar + HELLO (`server/transport-sidecar/src/{lib,protocol,fuzz}.rs`, 17 test Rust, differential vs implementasi referensi). Deterministik (xorshift, tanpa `Math.random`), terjadwal lewat env (`NYX_FUZZ_ITERS`/`NYX_FUZZ_SECONDS`) + script `fuzz:parsers` / `fuzz:parsers:hour`. **Terukur:** web 5×100k input ≈ 50 s; sidecar 160,9 juta iterasi / 300 s (536k/detik) → gate 1 jam ≈ 1,9 miliar input, 0 temuan. **Sisa:** verifier proof KT (belum ada kodenya) |
| WS-G(1): Grafana dashboard | ✅ | `ops/grafana/dashboards/nyx-overview.json` — 18 panel (penjaga privasi harus 0, blokir keamanan per alasan, relay per hasil/opcode, backup ops, sweeper umur + p50/p95 + baris dibersihkan, disk/RAM/swap/Postgres/Redis); semua query menyebut metrik yang sudah dideklarasikan di `metrics.ts` atau exporter host, ambangnya disamakan dengan `ops/prometheus/alerts.yml`; dipasang manual (VPS, docs/10 §10.12) |
| WS-G(6): vektor DR/sender-key lintas-implementasi | ⬜ **blocked** | Butuh harness Rust yang memakai libsignal (pin §30.2) sebagai oracle lalu vektor ikut di-commit. Di mesin ini `~/signal/libsignal` ada tetapi belum pernah dibangun (tanpa `target/`); membangun + mengekstrak primitif ratchet NYX secara deterministik menyentuh jalur kripto **beku** (`docs/04`), jadi tidak dikerjakan tanpa E2E yang bisa memverifikasinya. Jalur lanjut: oracle offline → vektor di `packages/shared/src/__tests__/` (docs/11 §11.4) |
| WS-G(7): dedup helper E2E | ✅ | Helper bersama `web/e2e/helpers/registration.ts`: `registerUser` (dulu disalin di 6 spec dan **sudah menyimpang** — varian skip-biometric spesifik `settings.spec` kini dieksplisitkan sebagai `registerUserViaBiometric`), `supportsWebTransport` (dulu dua nama berbeda + satu evaluasi inline di `chat.spec`), serta `openDirectChatWith` / `sendChatMessage` / `expectPeerReceivesMessage` (blok locator yang disalin di `chat.spec` + `transport.spec` ×2). Semantik tiap spec dipertahankan — default `supportsWebTransport` tetap tanpa navigasi (perilaku lama `chat`/`transport`), sedangkan `regression.spec` memakai `{ navigateToAppOrigin: true }`. Verifikasi: web `tsc` 0, `playwright test --list` 22 test / 7 file, `vitest` 385/385. **Sisa:** menjalankan suite E2E terhadap DB/Redis/browser nyata — Postgres lokal di mesin ini belum punya role `nyx_user`/db `nyx_app`, jadi `e2e/global.setup.ts` gagal di reset (kondisi lingkungan, bukan perubahan ini) |
| WS-F: seal kolom struktural | ✅ (verifikasi browser tersisa) | **Skema** `web/src/lib/localOrderKey.ts` (+ modul daun `localOrderBucket.ts`) + **wiring**: Dexie v9 mengisi `orderBucketMs` saat upgrade (tanpa kunci), writer `upsertMessages` menyegel `createdAt`, pembaca `getMessagesByConversation` berpaginasi per bucket utuh, `messageSearch` mengurut lewat lapis presisi, `importDatabase` + restore `.nyxbak` menormalkan baris mentah (`normalizeOrderIndex`). **Langkah 3:** kolom struktur non-pengurutan di-seal di tempat (`senderId`, `repliedToId`, `isViewOnce`, `isDeletedLocal`, `expiresAt`, `Conversation.isGroup`) lewat `sealLocalText`/`sealLocalFlag`, dan indeks sisa yang tak terpakai dilepas (Dexie v10: `senderId`, `isDeletedLocal`, `conversations.isGroup` — grep klausa query-nya bersih). `status` sengaja dilewati: tidak ada jalur tulis yang menyimpannya (hanya dibaca dari baris lama). Verifikasi: web `tsc` 0, `vitest` **427/427** (53 file), `pnpm --filter nyx-web run build` exit 0; test `localOrderKey.test.ts` (19) + `shadowVaultOrderIndex.test.ts` (14) + `dexieMigration.test.ts` (9). Yang terakhir memakai **IndexedDB nyata** (`fake-indexeddb`) + Dexie nyata: upgrade v1→v9 benar-benar mengisi `orderBucketMs`, indeks `[conversationId+orderBucketMs]` terisi dan bisa di-range-scan, v10 benar-benar melepas indeks `senderId`/`isDeletedLocal`/`conversations.isGroup`, dan pembaca vault berjalan di atasnya. **Sisa:** E2E browser (UI scroll-back, upgrade pada profil pengguna nyata) — butuh Postgres lokal (izin maintainer) |
| WS-F: migrasi at-rest saat unlock + kolom waktu kontak/profil | ✅ | `shadowVault.migrateAtRestSealing()` diperluas: `ContactRow.updatedAt` + `ProfileCacheRecord.updatedAt` (dua kolom waktu yang masih plaintext di IndexedDB) ikut di-seal di rel unlock yang sama (`keyStorage.saveDeviceAutoUnlockKey`), idempoten, dan baris terkunci tidak menghapus plaintext-nya. Pembaca kontak memakai `openLocalNumber` (baris lama tetap terbaca sebagai fallback `firstSeenAt`/`lastSeenAt`). Verifikasi: `contactStore.test.ts` (+3) & `dexieMigration.test.ts` (+1, IndexedDB nyata + Dexie nyata) |
| WS-F: pencarian terenkripsi (in-memory + benchmark) | ✅ | `web/src/lib/searchIndex.ts` — indeks in-memory saat vault terbuka (kata → messageId, tanpa FTS plaintext di disk) yang dipakai `store/messageSearch.ts`, plus `searchBench.ts` (10k pesan: waktu build indeks + memori) dengan script `bench:search`. Test: `searchIndex.test.ts`, `messageSearchIndex.test.ts` (regresi: pencarian tidak lagi mendekripsi per query) |

### M3 — sebagian landed (2026-10-13)

| Item | Status | Artefak |
|---|---|---|
| WS-E(2): signaling call tidak ter-link ke akun | ✅ | `server/src/utils/callRelayTokens.ts` (token acak 24 byte, peta Redis `token → sesi aktif` dengan identitas **ter-seal**, fail-closed untuk token tak dikenal) + `POST /api/call-tokens` & `/api/call-tokens/resolve` (`server/src/routes/callTokens.ts`, `requireAuth`, cap 32 peer/64 token) + relay `redisBridge.handleWebRtcRelay` kini memakai token untuk `to` **dan** `from` (userId tidak pernah masuk envelope/log/`nyx:downstream`); klien `web/src/lib/callRelayTokens.ts` (cache dua arah, batch untuk panggilan grup) + wiring `web/src/lib/webrtc.ts` semua jalur (request/accept/offer/answer/ICE) dan pemeta-an `from` → userId sebelum dipakai sebagai kunci peer. Skema shared: `CallRelayTokenSchema` + `WebRTCSignalingSchema.from` = token (userId ditolak). Test: `callRelayTokens.test.ts` server (9, termasuk guardrail envelope tidak memuat userId) + web (9, `api` di-stub). Verifikasi: web `tsc` 0, server `tsc` 0. **Sisa:** E2E call chrome (butuh coturn + browser nyata) |
| WS-H: kuota per-ASN + heuristik sybil + false-positive NAT | ✅ | `server/src/utils/asnLookup.ts` — tabel prefix→ASN **lokal** (`ASN_DB_FILE`, CSV dua kolom / header GeoLite2, IPv4+IPv6, *longest prefix*, tanpa layanan pihak ketiga), 8 test termasuk batas rentang & IP tidak sah. `registrationGuard.ts` diperluas: batas keras `REGISTRATION_MAX_PER_ASN = 100` **inklusif** (akun ke-100 dari satu ASN dalam 1 jam ditahan — kriteria §30.12) + jendela velocity 10 menit (`REGISTRATION_SYBIL_BURST_MAX_PER_ASN = 25`) yang memicu **kewajiban attestation, bukan blokir**. Test NAT kantor besar: 40 akun tersebar dari satu ASN → lolos tanpa attestation; burst 30/10 menit → attestation. Key Redis selalu ter-pepper (`regburst:asn:*`, `regburst:asnfast:*`). 12 test di `registrationGuard.test.ts`. **Sisa:** pengukuran false-positive lapangan (butuh data ASN produksi) |
| WS-H: attestation WebAuthn akun baru | ✅ | `server/src/utils/webauthnAttestation.ts`: verifikasi **dua lapis** — pustaka `@simplewebauthn/server` (struktur, challenge, origin, RP ID, flag UP/UV, alg COSE, statement attestation per `fmt`) **plus** kebijakan murni NYX (`evaluateAttestationPolicy`: format allowlist, **rantai sertifikat wajib** (self ditolak secara default), AAGUID blocklist, user-verification, single-device) + challenge sekali-pakai di Redis. Route: `POST /api/auth/register/attestation-options` (attestation `direct`, platform) dan `/register` dengan `attestation` (428 `ATTESTATION_REQUIRED` → verifikasi **sebelum** akun dibuat; sukses = `isVerified` + baris `Authenticator`). Klien: `web/src/lib/registerAttestation.ts` + retry sekali di `store/auth.ts` + 5 kunci i18n di keempat bahasa. Test: 8 test server dengan **respons registrasi WebAuthn asli** (CBOR + authenticatorData dibangun byte-per-byte, diverifikasi pustaka sungguhan — termasuk penolakan origin/challenge/RP ID salah dan `none` yang sah secara kripto tetap ditolak) + 5 test web. **Sisa:** attestation perangkat keras sungguhan (packed/tpm + x5c) tidak bisa dibangkitkan di unit test → perlu E2E authenticator nyata |
| WS-A: **verifier klien + interop nyata** | ✅ (verified-search) | `packages/keytrans-wasm/` — `libsignal-keytrans` dikompilasi ke `wasm32-unknown-unknown` (295 KB, **nol import**, ABI scratch-buffer, tanpa `wasm-bindgen`) dengan op `verify_search`/`verify_monitor`/`verify_distinguished`/`monitor_next`/`condense_update`. Klien `web/src/lib/keyTransparency.ts` + **12 test** (`keyTransparency.test.ts`) yang memverifikasi **bukti nyata dari binary Go `key-transparency-server`**: fixture dibuat `server/scripts/kt-fixtures.ts` (dua entri NYX ditulis dengan `return_update_response=true`, tree 63→64, `vrf_proof` 80 B) dan di-commit di `web/src/lib/__tests__/fixtures/kt/`. Yang diuji: bukti diterima + nilai benar, rotasi kunci, MITM (nilai palsu) **ditolak**, `vrf_proof`/`opening` diubah ditolak, dengan anchor `search`/`tree head` palsu ditolak (split-view), kunci VRF/search key salah ditolak, fuzz 200 input tanpa trap. **Temuan penting (docs/34 §34.5):** tanpa anchor (pencarian pertama) perubahan di `search`/`tree head` **tidak** terdeteksi — keamanan KT bergantung pada loop monitor. **Sisa:** integrasi jalur bundle (`processPreKeyBundle`, jalur kripto beku + E2E), op WASM `monitor_build` untuk loop monitor (endpoint server-nya sudah ada), auditor/`SetAuditorHead` + gossip. Detail: `docs/34` |
| WS-A: **sisi baca KT milik NYX** | ✅ | `server/kt-query` (Go) — satu proses pemilik LevelDB yang menyajikan baca (`/search`, `/distinguished`, `/monitor`, `/config`), tulis (gRPC `KeyTransparencyTestService.Update`, protokol penulis lama **tidak berubah**), dan kunci `distinguished`. Proxy `/api/keys/kt/*` + metrik `nyx_kt_queries_total{result}` + degradasi terlihat (503 `KT_QUERY_DISABLED`). **Temuan yang memaksa desain ini** (bukti empiris, `docs/32` §32.8): query service upstream menolak nilai log NYX (`permission denied` tanpa entri ACI; error internal untuk nilai ≠ `0x00||aci16`), dan LevelDB tidak bisa dibagi dua proses (read-only mengambil `LOCK_SH` vs `LOCK_EX` penulis). Verifikasi: 18 test Go (termasuk `VerifySearch`/`VerifyMonitor` upstream atas nilai NYX 1286 byte), 13 test proxy, dan fixture jalur hidup yang diverifikasi WASM (18 test di `web/src/lib/__tests__/keyTransparency.test.ts`). Detail: `server/kt-query/README.md` |
| WS-A: penulis log Key Transparency | 🟡 penulis landed | `server/src/utils/keyTransparency.ts` — search key `0x75\|\|usernameHash(32)`, nilai log v1 kanonik (frozen, `docs/32`), encoding protobuf `UpdateRequest` **tangan** + transport gRPC `node:http2` (framing 5 byte, `grpc-status` dari header **dan** trailer) tanpa dependensi baru; idempoten (dedupe `(searchKey, keyVersion, digest nilai)` sehingga **perubahan kunci tetap ditulis**), fail-visible (metrik `nyx_kt_writes_total{result}` + `nyx_kt_last_success_timestamp_seconds`, 2 alert Prometheus), nonaktif default (`KT_SERVER_URL`). Wiring: registrasi (keyVersion 1) + `/recover` (keyVersion 2). **Bukti live:** binary Go `key-transparency-server` dibangun (`go build ./cmd/kt-server`) dan dijalankan lokal; `KT_SERVER_URL=http://127.0.0.1:8081` → test `live: penulisan nyata ke binary KT` **lulus** (ukuran pohon bertambah). Temuan dari live: server menolak `consistency = nil` → field itu selalu dikirim (boleh kosong). 8 test di `keyTransparency.test.ts`. **Sisa:** verifier klien (Spike-1 KT→WASM: VRF/commitment + monitor), auditor/`SetAuditorHead`, `keyVersion` masih konstanta alur (residual §32.7) |
| WS-D: pembungkus SPQR WASM + test + benchmark | ✅ (pembungkus) | `packages/spqr-wasm/` — crate `spqr` v1.6.0 terkompilasi ke `wasm32-unknown-unknown` (raw module **nol import**, entropi disuntik host lewat `getrandom_backend="custom"`, tanpa `wasm-pack`/`wasm-bindgen`). Pembungkus klien `web/src/lib/spqrRatchet.ts` + **10 test** dengan modul hasil build sungguhan: ABI tanpa import, negosiasi versi, kesepakatan message key, entropi host deterministik, entropi kurang → `SpqrError(4)`, fuzz, **kehilangan 1..N−1 pesan** & **pengiriman keluar urutan** (skipped key) & kehilangan dua arah — semuanya sembuh. Benchmark terukur (`pnpm --filter nyx-web run bench:spqr`, 500 langkah/arah): pesan mapan **37 B**, **state 3,8 KiB/langkah**, `send` p50 **0,26 ms** (p95 0,60), `recv` p50 0,12 ms, modul 506,7 KiB. Gate §30.8: (2) drop **per chunk** terbukti dari test chunked di dalam crate (satu langkah `send` = satu chunk) + bentuk yang teramati dari ABI publik: pesan hilang/keluar urutan; (4) fuzz ✅; (5) benchmark ✅. Detail: `docs/33`. **Integrasi jalur pesan LANDED (2026-10-14):** header v2 `{v:2,b:[…]}` (bukan tambalan pada jalur beku), deklarasi versi in-band `ackV` di payload ter-seal (syarat kirim v2), state braid ter-seal berdampingan dengan state v1 + rollback yang mempertahankannya, op worker `spqr_ratchet_init/encrypt/decrypt` (WASM dimuat malas), kapabilitas deployment `spqr-ratchet` di sidecar, dan E2E Chrome `web/e2e/spqr.spec.ts` yang membuktikan `dr.v === 2` di amplop server + peer bisa membacanya. Gate §30.8: (1) test internal crate **lulus pada pin yang sama** — `cargo +nightly test --release --lib` di HEAD `06959b4708f9` = 57 passed/0 failed, exit 0 (stable gagal `E0658`, `assert_matches`) ✅; (2) loss per chunk terbukti di test chunked crate + bentuk yang teramati dari ABI publik ✅; (3) interop klien v2 ↔ v1 ✅ (v2 hanya dikirim setelah peer menyatakan mampu); (4) fuzz ✅; (5) benchmark ✅. **Rollback dua klien nyata ✅ (2026-10-14):** kill switch runtime DEV (`localStorage['nyx_spqr_force_v1']`, dibaca per pengiriman; `VITE_SPQR_FORCE_V1` build-time tidak bisa mem-rollback satu klien saja) + test kedua `web/e2e/spqr.spec.ts` — klien yang di-rollback mengirim v1 lagi di wire, peer tetap membacanya, pesan v2 dari peer tetap terbaca, state braid masih ada. Modul WASM juga masuk precache SW (`**/*.wasm`, ±0,8 MB install). Detail: `docs/33` §33.8/§33.10 |
| WS-G(6): vektor DR/sender-key lintas-implementasi | ⬜ **blocked (dikonfirmasi ulang 2026-10-13)** | Tidak berubah. Yang berhasil dibangun di mesin ini hanyalah crate `keytrans` → WASM (`docs/34`), yang sama sekali bukan primitif DR. Harness oracle butuh: (a) membangun libsignal (workspace besar) dan mengekstrak `SessionRecord`/`MessageEncryptor` secara deterministik, (b) memotong langkah ratchet NYX di `web/src/utils/crypto.ts` (jalur kripto **beku**, `docs/04`) agar bisa dibandingkan vektor per vektor, dan (c) E2E untuk membuktikan tidak ada regresi — (c) tidak tersedia (Postgres/Redis lokal belum siap, suite E2E tidak bisa dijalankan). Urutan yang benar: E2E hijau dulu → harness oracle → vektor di-commit di `packages/shared/src/__tests__/` |

### M4 — sebagian landed (2026-10-14)

| Item | Status | Artefak |
|---|---|---|
| WS-A: integrasi verifikasi KT ke jalur bundle | ✅ | `web/src/lib/ktBundleProof.ts` (verdict `confirmed`/`mismatch`/`unverifiable`/`unavailable`/`unknown-subject`; Argon2id + bukti via `/api/keys/kt/*` + verifikasi WASM; TTL konfirmasi 24 jam; backoff 5 menit saat layanan mati) + `web/src/lib/ktSubject.ts` (menurunkan username peer dari profil E2EE: cache RAM → participant → dekripsi `encryptedProfile` percakapan → kontak, 7 test) + `peerIdentityTrust.ts` (verdict masuk sebelum kunci dipin: `ktVerifiedAt`/`ktKeyVersion`/`ktMismatch`, `source: 'kt'` di daftar pending, gate kirim menutup juga pada mismatch **kontak pertama**) + banner `IdentityChangeBanner` dengan copy khusus + 2 kunci i18n ×4 bahasa. **Menyimpang dari rencana** (op worker `kt_verify_search`): verifikasi butuh jaringan + state tersimpan, dan `docs/04` melarang menambah tanggung jawab jalur worker — jadi verifikasi di thread utama, jalur bundle hanya berubah di titik keputusan pin. Detail + batas jujur: `docs/34` §34.6a |
| WS-A: loop monitor KT + penjadwalan + notifikasi | ✅ | `monitorKeyTransparency()` (jembatan verifier+config ke `POST /api/keys/kt/monitor`), `startKtMonitorLoop()` (jeda awal 30 s, interval 6 jam, satu langkah pada satu waktu, gagal ≠ berhenti, `stop()` idempoten), wiring `App.tsx` (hanya saat `user && hasRestoredKeys`, impor dinamis agar WASM 295 KiB tidak masuk bundel awal) + toast `chat:banners.kt_key_rotation` (4 bahasa). 7 test baru (`ktMonitoring.test.ts`). **Sisa:** auditor/`SetAuditorHead` + gossip (mode 3) |
| WS-D: prasyarat integrasi SPQR (negosiasi + state) | ✅ | `web/src/lib/spqrNegotiation.ts` (keputusan versi murni: kapabilitas hanya dibaca saat sesi didirikan, anti-downgrade v2 hanya bila kedua sisi mampu, saklar tunggal `SPQR_INTEGRATION_ENABLED=false`, rollback eksplisit yang mempertahankan state v2; 9 test) + `web/src/lib/spqrState.ts` (state braid per sesi ter-seal `ENC1:`, tulis di-koalesensi 250 ms, batas 64 KiB diperiksa sebelum antre, fail-closed saat dibaca, byte opaque milik WASM; 9 test). **Sisa:** versi wire baru di header DR + ack + pemanggilan modul ini dari jalur pesan + verifikasi E2E — `docs/33` §33.7/§33.9 |
| Lingkungan E2E di mesin ini | ✅ (koreksi catatan lama) | Catatan M2/M3 ("Postgres lokal belum punya role `nyx_user`/db `nyx_app`") **sudah tidak berlaku**: Postgres 5432 + Redis 6379 hidup, role `nyx_user` + db `nyx_app` ada, dan `e2e/global.setup.ts` (`reset-test-env.ts`) berhasil mereset. Suite `playwright test --project=chromium` bisa dijalankan; **browser headless ini tetap tanpa `WebTransport`** sehingga `transport.spec`/`chat.spec` auto-skip (pakai `--project=chrome` bila perlu). Verifikasi M4: web `tsc` 0, `vitest` 551/551 (67 file), server `tsc` 0, server test 351 pass/1 skip, E2E `auth.spec` dijalankan ulang (lihat ringkasan sesi) |
