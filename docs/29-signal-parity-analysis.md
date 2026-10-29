# 29 — Analisis Komparatif NYX vs Signal (dan apa yang bisa kita adopsi)

> **Status: ANALISIS + STATUS IMPLEMENTASI.** Dibuat 2026-10-10 dengan membaca
> source NYX + source Signal; **diperbarui 2026-10-28** terhadap HEAD `1664`
> commit (v3.0.0). Sejak 2026-10-16 source Signal **di-vendor di repo ini**
> (`vendor/signal/spqr`,
> `server/kt-query/vendor/github.com/signalapp/keytransparency`; verifier KT v2
> adalah fork lokal `packages/keytrans-v2`, `NOTICE` §2), jadi rujukan
> "Signal punya X" di bawah bisa dicek tanpa checkout eksternal.
>
> Klaim status di dokumen ini diverifikasi dari kode/berkas, bukan dari ingatan:
> daftar rujukan ada di akhir setiap bagian yang berubah. Yang tidak bisa
> diverifikasi ditandai eksplisit.
>
> **Banyak item yang dulu "celah" sudah selesai** (KT penuh, SPQR, backup
> ber-frame, negosiasi kapabilitas, calls). Ringkasan perubahannya ada di §1.1.

---

## 1. Ringkasan eksekutif

1. **Kripto inti NYX setara atau di atas Signal pada beberapa sumbu.** PQX3DH
   (X25519 + ML-KEM-768/X-Wing) wajib, DR hybrid, **braid SPQR PQ (FS+PCS)
   sudah live** sebagai jalur v2, sender-key v2 yang meniru `sender_keys.rs`
   libsignal, plus **token-first group membership**. Blind RSA credential
   (RFC 9474) pernah ada tetapi **dihapus 2026-10-23**; catatan historisnya ada
   di §4.3/§7.1. NYX tidak perlu merasa kalah di layer protokol.
2. **Celah "kepercayaan pada server" sudah menyusut drastis.** Key transparency
   **sudah berjalan di jalur produksi**: penulis log + verifier WASM + monitor loop +
   auditor mode 3 + gossip tree head, dengan log v2 ML-DSA-65 berjalan sebagai
   **dual-write**. Verifikasi kunci kini **bukan** lagi TOFU murni: verdict KT
   ikut memblokir pin. Sisa pekerjaan KT bersifat operasional/interop (§5.1).
3. **Celah besar yang masih tersisa bukan kripto, tapi perangkat & ekosistem.**
   (a) **multi-device tetap non-goal permanen** (satu perangkat aktif sebagai
   properti keamanan); (b) **klien hanya web**, jadi reliabilitas push/background
   di mobile tidak bisa dijamin; (c) **belum ada review kripto eksternal**
   (`docs/36` adalah paketnya, bukan hasilnya).
4. **NYX unggul pada privasi identitas & data-at-rest.** Tanpa PII (Signal
   berakar pada nomor telepon), blind index Argon2id 64 MB client-side, pencarian
   privat **OPRF + PIR (ChalametPIR) + OHTTP** (default mati di repo, hidup di
   selfhost), hardening dump DB yang tidak dimiliki messenger lain
   (senderId/sessionId/device key ter-seal, bucketing waktu, `identityTag` Redis,
   token-only membership), panic password, burner room, dan cover traffic yang
   **tidak** dikirim Signal.
5. **Signal masih unggul pada verifikasi formal, ekosistem, dan skala
   rekayasa.** libsignal = Rust core multi-platform + verifikasi formal (SPQR
   dengan hax/F* dan ProVerif), ribuan test, audit eksternal, klien native di
   semua platform. NYX: kripto di satu worker TS (tidak boleh dipecah), 128
   berkas tes web, 86 berkas / 693 tes server, 147 tes Go KT, fuzz deterministik,
   oracle DR lintas implementasi, lint **oxlint** blocking — tapi belum ada
   formal method dan belum ada audit pihak ketiga.

### 1.1 Apa yang berubah sejak analisis 2026-10-10

| Item | 2026-10-10 | Sekarang (2026-10-28) | Bukti |
|---|---|---|---|
| Key transparency | belum ada | log + verifier + monitor + auditor + gossip; v2 dual-write | `docs/32`, `docs/34`, `server/kt-query` |
| PQ ratchet (PCS) | DR hybrid (FS saja) | braid SPQR v2 **live** berdampingan, dipilih via `ackV` | `docs/33` §33.10, `packages/spqr-wasm` |
| Backup | satu JSON export | **`NYXB` v1**: ber-frame, AEAD+AAD, BIP39→Argon2id 128 MB, streaming | `docs/31`, `web/src/lib/backupFormat.ts` |
| Negosiasi kapabilitas | tidak ada | HELLO bidi (WT) + `handshake.auth.capabilities` (WSS) | `packages/shared/src/transport.ts` |
| Calls | signaling `to: userId`, fallback STUN Google | **relay token** (bukan userId), coturn primari, tanpa STUN pihak ketiga | `realtimeHandlers.ts`, `routes/keys.ts` |
| Blind RSA credential | ada, tanpa gating | **dihapus** (cutover PQ-only) | `docs/26`, `docs/35` Fase 6 |
| Verifikasi kunci | TOFU + localStorage | KT verdict + pin di keychain + **gate kirim** | `peerIdentityTrust.ts`, `docs/34` §34.6a |
| Pencarian | tukar link / hash persis | **OPRF + PIR + OHTTP** (bertahap, default mati) | `docs/35` Fase 4, `server/pir-sidecar` |
| Lint | ESLint tidak jalan | **oxlint** satu-satunya linter, blocking pada `error` | `AGENTS.md`, `.oxlintrc.json` |

---

## 2. Profil kedua sistem

| | **NYX** | **Signal** |
|---|---|---|
| Bentuk | Web-only (React 19 + Vite 8), monorepo pnpm (`web`, `server`, `marketing`, `packages/*`) | Native Android/iOS/Desktop (Electron) + server Java |
| Bahasa | TypeScript di semua app; **Rust** (sidecar WebTransport, sidecar PIR), **Go** (`server/kt-query`), **WASM** (`spqr-wasm`, `keytrans-wasm(-v2)`, `pir-wasm`) | Rust (libsignal, SPQR, extensions), Java (server, CDS, registration), TS (Desktop), Go (key transparency) |
| Server | Express 5 + Prisma 7 + PostgreSQL + Redis (pub/sub), 1 VPS 4c/8GB; pm2 untuk API/sidecar + systemd untuk KT log/auditor, PIR, OHTTP relay | Java + FoundationDB/DynamoDB/ScyllaDB + Redis, gRPC, fleet besar |
| Transport | WebTransport/QUIC (sidecar Rust) + **fallback WSS socket.io**, opcode biner, negosiasi kapabilitas di kedua jalur | WebSocket/gRPC + REST protobuf |
| Kripto inti | PQX3DH (X25519 + ML-KEM-768 X-Wing), DR hybrid, **braid SPQR**, sender key v2, burner PQ-DR, XChaCha20-Poly1305, BLAKE2b, Argon2id, Ed25519 + **ML-DSA-65** | X3DH/PQXDH, Double Ratchet, Sender Keys, **SPQR** (ML-KEM Braid), AES-GCM (RustCrypto), zkgroup (pairing/BBS) |
| Identitas | Tanpa PII: `usernameHash` Argon2id 64 MB client-side + index OPRF hibrida + `shareId` publik + recovery phrase (BIP39) + attestation WebAuthn | Nomor telepon (ACI/PNI) + opsional username; PIN + Secure Value Recovery |
| Storage lokal | IndexedDB (Dexie) — **struktur & konten sensitif ter-seal `ENC1:`**, urutan dua lapis; OPFS hanya blob terenkripsi | SQLCipher (seluruh DB) + FTS5 terenkripsi |
| Verifikasi kunci | **KT** (log Merkle, monitor, auditor, gossip) + pin + safety number manual + gate kirim saat `mismatch` | Key transparency (log Merkle + monitor/auditor), tanpa safety number wajib |
| Pencarian user | hash identifier (Argon2id) → OPRF → PIR (ChalametPIR) via OHTTP; tanpa social graph | SGX/Icelake PSI atas nomor telepon; username links |
| Lisensi | AGPL-3.0 | AGPL-3.0(-only) — termasuk SPQR & key-transparency-server |

Skala NYX (terukur 2026-10-28): **1.664 commit**, 2 kontributor manusia (+1 bot),
v3.0.0, 2.722 berkas terindeks, 128 berkas tes web, 86 berkas / 693 tes server,
147 test Go, 2 crate Rust dengan test, 14 spec Playwright. Signal: repo
Signal-Desktop saja sudah v8.31.0-alpha dengan ratusan migrasi SQLCipher
(`Signal-Desktop/ts/sql/migrations/` sampai seri 990+) — angka itu berasal dari
pembacaan 2026-10-10 dan tidak diverifikasi ulang.

---

## 3. Tabel perbandingan per domain

Verdict: **NYX+** = NYX jelas lebih baik · **≈** = paritas · **SIG+** = Signal jelas lebih baik.

| # | Domain | NYX hari ini | Signal | Verdict |
|---|---|---|---|---|
| 1 | Registrasi & identitas | tanpa PII, Argon2id blind index, PoW/Turnstile, attestation WebAuthn | nomor telepon via registration-service (SMS/voice, fraud analytics) | **NYX+** (privasi) / SIG+ (sybil resistance) |
| 2 | Key agreement PQ | PQX3DH X-Wing wajib, tolak downgrade klasik | PQXDH + Kyber, PQ opsional-per-kapabilitas | **≈** (NYX lebih ketat) |
| 3 | Ratchet 1:1 | DR hybrid + **braid SPQR jalur v2** (FS+PCS), dipilih setelah peer meng-ack (`ackV`) | DR + **SPQR** (ML-KEM Braid) — FS+PCS, terverifikasi formal | **≈** (kripto setara; formal verification & laporan audit masih SIG+) |
| 4 | Grup | sender key v2 + rotasi era, pseudonym, metadata-key terpisah, envelope v2/v3/v4 (77/85/2037 B) | Sender Keys + zkgroup GroupSendEndorsement, menuju QR/MLS | **≈** |
| 5 | Kredensial keanggotaan | **token-first** (group/delivery token); blind RSA dihapus 2026-10-23 | zkgroup (pairing, redemption time, presentation context) | **≈** (NYX lebih sederhana, tanpa unlinkability) |
| 6 | Key transparency | **ada**: penulis log, `kt-query` (pemilik LevelDB), verifier WASM, monitor loop, auditor mode 3, gossip; v2 dual-write | key-transparency-server (Merkle log, VRF, monitor) + klien `keytrans` | **≈** (fitur setara; interop `kt-client` & cutover baca v2 masih SIG+) |
| 7 | Verifikasi kunci user | KT verdict + pin terenkripsi + gate kirim saat `mismatch`; safety number manual tersedia | otomatis + monitor, manual opsional | **≈** (residual: `unavailable`/`unknown-subject` fail-open yang terlihat) |
| 8 | Contact discovery | hash identifier → OPRF → PIR di balik OHTTP; tanpa social graph; default mati di repo | SGX/Icelake PSI atas nomor telepon; username links | **≈** (fitur) / NYX+ (privasi terhadap Intel, tanpa PII) |
| 9 | Multi-device | **1 perangkat aktif** (non-goal permanen, `docs/30` §30.6/§30.18) | device list, linked devices, provisioning, device-transfer, storage service | **SIG+** (dipilih tidak ditutup) |
| 10 | Backup/restore | **format `NYXB` v1** ber-frame, AEAD+AAD, kunci dari recovery phrase, opsional di R2 + migrasi streaming | format backup protobuf tervalidasi ketat + SVR/PIN + frame/padding/scramble | **≈** |
| 11 | At-rest server (dump) | sealed senderId/sessionId/device key, bucketing waktu, `identityTag` Redis, token-only membership, audit script | sealed sender di transit, kolom DB tetap ter-join ke akun | **NYX+** |
| 12 | Sealed sender | 1:1 `senderId` ter-seal/NULL; server tahu penulis saat write | sealed sender + sender certificate + access-key/rate-limit token | **≈** (tujuan sama, mekanisme beda) |
| 13 | Storage lokal | Dexie; konten + kolom struktur ter-seal, sisa plaintext = primary key & bucket indeks | SQLCipher penuh + FTS5 terenkripsi | **SIG+** (lebih sederhana: satu kunci DB) |
| 14 | Media/lampiran | R2 presigned + secretstream, deleteAt, batas ukuran per tier | CDN + `media` crate (thumbnail/transcode terkendali) | **≈** |
| 15 | Calls | WebRTC P2P; signaling lewat **token relay** (bukan userId); coturn primari → Cloudflare → STUN operator → 503 | RingRTC, call links, blinded signaling, SFU-less multi-party | **SIG+** (fitur); mekanisme privasi NYX kini setara arah |
| 16 | Push | VAPID, body generik, payload per-device ter-seal ≤3 KB | push tanpa konten + NSE/notification extension native | ≈ untuk web, **SIG+** untuk mobile |
| 17 | Anti-spam | PoW (client-mined, server-verified), Turnstile, attestation WebAuthn, heuristik per-ASN, tier sandbox/VIP, rate limit Lua atomik | spam-filter ML, rate-limit challenge, registration fraud analytics | **≈** (filosofi beda) |
| 18 | Panic/deniability | panic password + nuke wipe | tidak ada | **NYX+** |
| 19 | Burner/ephemeral | burner room (guest, PQ-DR, RAM-only) | tidak ada | **NYX+** |
| 20 | Cover traffic | chaff 1000 B/3 s (visibility-aware) + padding 8 KB + dummy message ber-jitter, opt-in | tidak ada (Signal menolak trade-off ini) | **NYX+** |
| 21 | Negosiasi kapabilitas | **ada** di kedua relay: `hello-v1`, `spqr-ratchet`, `pq-v2`; klien lama (tanpa daftar) tetap legacy | `DeviceCapability`, `ClientRelease`, gRPC/protobuf ter-skema | **≈** |
| 22 | Jaminan rekayasa | 128 berkas tes web, 86/693 server, 147 Go, 2 crate Rust, 14 spec Playwright; fuzz deterministik; oracle DR non-libsodium; 40 aturan alert + drill; oxlint blocking; **tanpa** formal method/audit eksternal | ribuan test, verifikasi formal hax/F*/ProVerif, fuzzing (libFuzzer), audit eksternal, reproducible build | **SIG+** |
| 23 | Operabilitas/self-host | 1 VPS, pm2 + beberapa unit systemd — siapa pun bisa jalankan | butuh FDB/Dynamo/Scylla — praktis tidak self-hostable | **NYX+** |
| 24 | Ekosistem produk | web + marketing + tenant B2B/subscription | semua platform, stickers, call links, backup, donations | **SIG+** |
| 25 | Privasi pencarian | OPRF + PIR + OHTTP; snapshot PIR disegarkan lewat penanda generasi (≤3 menit) | ContactDiscovery (SGX), tanpa PIR | **NYX+** (privasi kueri) / SIG+ (laten si & skala) |

---

## 4. Di mana NYX sudah bagus (jangan diubah tanpa alasan)

**4.1 Identitas tanpa PII dan blind index memory-hard.**
`usernameHash` dihitung client-side dengan Argon2id 64 MB/3 iter
(`docs/14` §14.1, `web/src/workers/crypto.worker.ts` op `hashUsername`).
Konsekuensinya: server tidak bisa reverse, dan **dump DB pun tidak bisa
di-dictionary-attack murah** — berbeda dari Signal yang menaruh hash nomor
telepon sebagai search key (Signal menutup ini dengan enclave + key
transparency, bukan dengan biaya memori). Sejak 2026-10-23 identitas pencarian
memakai **index OPRF hibrida** (`User.oprfIndex`) tanpa memutus baris legacy,
dan sejak 2026-10-25 pencarian privat OPRF→PIR→OHTTP tersedia (default mati).
Ini aset paling khas NYX; fitur baru harus mempertahankannya.

**4.2 Hardening at-rest yang tidak dimiliki Signal.** `docs/28`
+ `server/src/utils/atRestSecrets.ts`, `senderIdentity.ts`, `redisIdentity.ts`,
`temporalBucket.ts`, `groupMetadataBlob.ts`, dengan pemeriksa otomatis
`server/src/utils/dumpAudit.ts` dan `server/scripts/privacy-dump-audit.ts`.
Kombinasi "seal nilai identitas di DB + buka saat relay" adalah pola yang Signal
**tidak** terapkan (Signal menyembunyikan pengirim di *transit*, bukan di kolom).
Pertahankan, dan jadikan rujukan saat menambah fitur baru.

**4.3 Blind RSA membership credential (26.8.1) — historis, dihapus 2026-10-23.**
> **Dihapus pada cutover PQ-only.** `groupCredentials.ts`, endpoint issuance/
> commit/revoke, op worker `credential_*`, dan persist Dexie tidak ada lagi.
> Grup memakai token-first; route `POST /api/groups/:id/credential/present`
> (`server/src/routes/groups.ts`, di-mount di `/api/groups`) masih ter-mount
> tetapi **fail-closed**: tanpa issuer/verifier semua presentasi dijawab **403**
> (`docs/16` §16.5.1), untuk membekukan wire format. Bagian di bawah hanya catatan
> desain lama dan tidak boleh dijadikan acuan implementasi.

Dulu: suite `RSABSSA-SHA384-PSS-Randomized` (RFC 9474), private key issuer dari
env (`GROUP_ISSUER_KEY_PKCS8`), fail-closed di production, DB hanya menyimpan
material publik. Dibanding zkgroup Signal: lebih kecil, lebih standar, tapi
**kurang binding** (lihat §7.1) — dan karena itu dihapus, bukan diperbaiki.

**4.4 Timing/covers & deniability.** Chaff 1000 B/3 s (`CHAFF = 0x00`, sidecar
mengabaikan; tab background berhenti mengirim), padding 8 KB
(`PADDING_BLOCK_SIZE = 8192` di `crypto.worker.ts`), cover traffic T4 opt-in
(`docs/26` §26.10), panic password, nuke wipe (wipe lokal selalu didahului
`POST /api/auth/logout-all`). Signal secara sadar **tidak** mengirim cover
traffic; di dimensi "menyembunyikan kapan", NYX lebih jauh.

**4.5 Sederhana dan bisa di-self-host.** 1 VPS + pm2 (+ systemd untuk KT/PIR/OHTTP)
vs fleet FDB/Dynamo/Scylla. Ini bukan sekadar hemat biaya: memperkecil permukaan
operasional memperkecil permukaan kebocoran (dan membuat audit oleh pihak ketiga
realistis).

---

## 5. Celah yang tersisa — dan yang sudah ditutup

Bagian ini dulu daftar "celah"; sekarang dibagi menjadi **status** dan **sisa
pekerjaan**. Angka "tingkat keparahan" dipertahankan untuk konteks historis.

### 5.1 Key transparency — **CELAH UTAMA SUDAH DITUTUP** (residual: interop & cutover)

**Dulu (2026-10-10):** root of trust pemetaan `username → prekey bundle` adalah
server; bundle palsu terarah tak bisa dibuktikan siapa pun.

**Sekarang.** KT berjalan di jalur produksi, bukan rencana:

| Bagian | Implementasi |
|---|---|
| Penulis log | `server/src/utils/keyTransparency.ts` — tulis update saat register/rotasi; nonaktif tanpa `KT_SERVER_URL`; **dual-write** ke log v2 (ML-DSA-65) bila `KT_V2_SERVER_URL` diisi |
| Penyaji bukti | `server/kt-query` (Go) — **pemilik tunggal** LevelDB (goleveldb `LOCK_EX`), `/search`, `/distinguished`, `/monitor`, `/config`, `/head`; 147 test Go |
| Proxy API | `/api/keys/kt/*` meneruskan protobuf base64url apa adanya (server tidak mem-parse bukti) |
| Verifier | `packages/keytrans-wasm` (+ `keytrans-wasm-v2`) dipanggil dari `web/src/lib/keyTransparency.ts`; jangkar `distinguished` di-pin (`ktConfigPin.ts`) |
| Integrasi pin | `ktBundleProof.ts` → `peerIdentityTrust.ts`: verdict `confirmed`/`mismatch`/`unverifiable`/`unavailable`/`unknown-subject`; hanya `mismatch` (yang butuh bukti terverifikasi) memblokir kirim |
| Monitor | `runKtMonitorOnce` **fail-closed** (state hanya ditulis setelah `verifyMonitor` sukses) + loop di `App.tsx` |
| Auditor | `server/kt-query/cmd/nyx-kt-auditor` (mode 3, `TreeSize`/`Audit`/`SetAuditorHead`) + varian v2 |
| Gossip | `ktGossip.ts`: jangkar `(treeSize, root)` di payload ter-seal (field `ktG`) → `split-view` saat dua klien melihat root berbeda untuk ukuran sama |
| State klien | tabel Dexie `ktMonitoring`/`ktGossip`, ter-seal `ENC1:`, dibersihkan saat wipe |

**Batasan yang jujur (tetap ada).**
`unavailable` (KT mati/jaringan), `unverifiable` (anchor basi), dan
`unknown-subject` (username peer belum diketahui) **tidak** memblokir — memblokir
kirim karena layanan mati akan membuat NYX tak bisa dipakai; setiap verdict
dicatat di baris pin, dan `ChatWindow` menampilkan banner informasi (audit F-09).
Username peer datang dari profil E2EE yang dibagikan peer, jadi peer tanpa profil
tidak bisa di-*search* di log.

**Sisa pekerjaan** (`docs/34` §34.6): interop `cmd/kt-client` upstream, dua
implementasi auditor berdampingan, auditor di host terpisah dari log, dan
**cutover baca ke v2** (sekarang: dual-write, baca tetap v1). Kapabilitas
`KT_LITE` masih dideklarasikan klien tetapi tidak pernah diiklankan relay — sisa
tahap A yang dibatalkan; jangan dihidupkan kembali tanpa alasan.

### 5.2 Multi-device — **KEPUTUSAN MAINTAINER: tidak dikerjakan (non-goal permanen)**

> **Update 2026-10-11, masih berlaku.** Ini bukan celah yang akan ditutup: NYX
> memilih satu perangkat aktif per akun sebagai **properti keamanan** (tanpa
> device list, tanpa fan-out kunci per device, tanpa layanan storage ber-kunci
> akun). Kapabilitas `MULTI_DEVICE` sudah dihapus dari
> `packages/shared/src/transport.ts` (dan komentar di sana menjelaskan kenapa).
> Jalur pemulihan resmi: recovery phrase dan backup ber-frame (`docs/31`).

**Penegakan saat ini.** Sidecar menegakkan satu sesi WebTransport per user
(`docs/14` §14.7) dan `redisBridge.isActiveDeviceAllowed` menolak perangkat
kedua, kecuali mode migrasi (`is_migrating:<tag>`) yang **memindahkan** vault,
bukan menambah perangkat. Analisis di bawah dipertahankan sebagai konteks tentang
apa yang Signal lakukan — **bukan** backlog.

**Signal.** `DeviceController`, `ProvisioningController`, `device-transfer`
(libsignal), `DeviceCapability`, `DeviceKEMPreKeyPages` (server storage), device
list per akun, dan satu `storage service` untuk sinkronisasi setelan/kontak.

**Modal yang tetap berguna** (dipakai jalur migrasi/linking): amplop **per-device**
(`pq_box_seal_v2` + `targetDeviceId`/`targetDeviceKey` di envelope sender-key
v2/v4), `SessionKey` per device, `contactStore` terenkripsi dengan kunci turunan
identity, dan alur QR (`auth:request_linking_qr`, `migration:start|chunk|ack`)
untuk pemindahan.

### 5.3 Backup/restore — **SELESAI** (format `NYXB` v1)

**Dulu (2026-10-10):** `exportDatabaseToJson`/`importDatabaseFromJson` — satu
JSON besar, opsional terenkripsi, tanpa validasi.

**Sekarang** (`docs/31`, `web/src/lib/backupFormat.ts` dkk.):

- **ber-frame**: tiap frame di-pad ke blok tetap (bentuk tidak membocorkan jumlah
  pesan/kontak), di-AEAD dengan AAD yang mengikat `(type, index, jumlah frame)` →
  tamper/reorder/truncate gagal keras;
- **kunci dari recovery phrase** (BIP39) + salt header lewat Argon2id 128 MB —
  tidak ada kunci backup di server;
- parser **streaming** (bukan `JSON.parse` seluruh vault), plus
  `backupPayload`/`backupTransport`/`backupRestore` dan bench;
- opsional diunggah terenkripsi ke R2 (kunci objek HMAC tanpa userId, dihapus
  saat akun dihapus).

Sisa perbedaan dengan Signal: tidak ada backup otomatis berjadwal dan tidak ada
SVR/PIN; restore lintas perangkat tetap terbatas oleh pilihan satu-perangkat.

### 5.4 PQ ratchet: FS vs FS+PCS (SPQR) — **SELESAI untuk jalur v2**

**NYX.** v1 = DR hybrid (`KEMs`/`KEMr`/`savedCt`): PQ **forward secrecy**.
v2 = braid ML-KEM via **`packages/spqr-wasm`** (crate SPQR Signal di-vendor),
header `{v:2,b:[frames]}` (`web/src/lib/spqrWire.ts`), orkestrasi
`spqrSession.ts`, op worker `spqr_ratchet_*`, state braid ter-seal
`nyx_spqr_state_v1:*`, dan **dikirim hanya setelah peer meng-ack `ackV:2`**
(bukti in-band di payload ter-seal). Ada rollback test dua-klien dan kill switch
`VITE_SPQR_FORCE_V1` (berhenti *mengirim/mengiklankan*, tidak pernah berhenti
membaca). Detail: `docs/33` §33.10.

**Signal.** `SparsePostQuantumRatchet` — ratchet ML-KEM **Braid**
(`src/v1/{chunked,unchunked}`) + erasure coding Reed–Solomon, chain simetris
untuk FS, **dan verifikasi formal** (hax/F* panic-free, ProVerif FS/PCS).

**Yang masih berbeda:** NYX memakai kode SPQR yang sama (vendored, tanpa patch)
tetapi **tidak** membawa bukti formalnya ke dalam CI, dan tidak menguji vector
erasure-coding lintas implementasi. Format v1 tetap beku; perubahan hanya lewat
jalur versi paralel seperti di atas.

### 5.5 Storage lokal & pencarian terenkripsi — **SEBAGIAN BESAR SELESAI**

**NYX.** IndexedDB Dexie; kolom sensitif **dan** kolom struktur ter-seal.

> **[2026-10-12 — WS-F]** `lastMessageAt` di-bucket 15 menit (bucket sama dengan
> server), `seq`/`senderId`/`repliedToId`/`isViewOnce`/`isDeletedLocal`/`expiresAt`/
> `Conversation.isGroup`/`Message.reactions` ter-seal `ENC1:` di tempat, urutan
> pesan dua lapis (`orderBucketMs` plaintext + `createdAtSealed`), pencarian lewat
> indeks in-memory saat vault terbuka, `ContactRow.updatedAt`/
> `ProfileCacheRecord.updatedAt` di-seal saat migrasi unlock.
>
> **[2026-10-16 — verifikasi gate `docs/30` §30.10]** `sentAt` dan
> `pqDrSessionsV2.lastActivity` sempat lolos plaintext (presisi ms) dan **kini**
> ter-seal, dengan pemindai baris mentah di `dexieMigration.test.ts` (plus kontrol
> negatif). Sisa yang disengaja plaintext: `id` (primary key), kolom bucket indeks
> (`orderBucketMs`, `Conversation.lastMessageAt`), dan `offlineQueue.timestamp`
> (antrean kirim sementara).

Artinya penyerang yang memegang profil browser hanya melihat **pola aktivitas
sampai presisi bucket 15 menit** — bukan jam per pesan. Isi pesan tetap tidak
terbaca.

**Signal:** SQLCipher mengenkripsi seluruh DB + FTS5 untuk pencarian.

Sisa perbedaan nyata: SQLCipher menyembunyikan **semua** kolom (termasuk primary
key & jumlah baris) dengan satu kunci; Dexie menyembunyikan nilai tetapi tidak
bentuk. Pencarian lokal penuh ala FTS5 tidak realistis di IndexedDB; NYX memakai
indeks in-memory saat vault terbuka — trade-off yang didokumentasikan.

### 5.6 Negosiasi kapabilitas & evolusi protokol — **SELESAI**

NYX mengirim daftar kapabilitas di **kedua** transport (satu transport saja tidak
cukup: klien di jaringan yang memblokir QUIC memakai WSS):

| Transport | Klien → relay | Relay → klien | Kode |
|---|---|---|---|
| WebTransport (sidecar) | frame `HELLO` (opcode `0x0B`) di stream **bidi** | frame `HELLO` balasan, irisan kapabilitas | `server/transport-sidecar/src/protocol.rs` |
| WSS (socket.io) | `handshake.auth.capabilities` | event `capabilities`, irisan kapabilitas | `server/src/realtime/gateway.ts` + `utils/transportCapability.ts` |

Aturan: klien **lama** tanpa daftar = legacy (daftar kosong); bentuk cacat tidak
memutus koneksi; irisan dihitung klien **dan** server; nama kapabilitas hidup di
satu tempat — `SERVER_CAPABILITIES` di `packages/shared/src/transport.ts`,
sekarang `hello-v1`, `spqr-ratchet`, `pq-v2`. Menghapus `spqr-ratchet` dari daftar
itu = kill switch setingkat deployment (`docs/33` §33.7). Rollout terukur lewat
`nyx_wss_capability_total{capability}`.

### 5.7 Calls — **SELESAI** (STUN pihak ketiga hilang, signaling token)

Signaling **tidak lagi** dirutekan ke `userId`: `handleWebRtcRelay`
(`server/src/network/realtimeHandlers.ts`) meneruskan lewat **token relay**
(`relayCallSignal`, `docs/30` §30.9 WS-E(2)); token tak dikenal = drop
fail-closed + dihitung sebagai blokir keamanan; envelope yang diteruskan memuat
token pengirim, jadi jalur relay/log/pub-sub tidak pernah melihat pasangan
userId→userId. Logika yang sama dipakai kedua relay (WT dan WSS).

ICE (`GET /api/keys/turn`, `server/src/routes/keys.ts`) urutannya: **coturn
sendiri** (kredensial HMAC time-limited, username = `identityTag`, bukan userId)
→ Cloudflare TURN → **STUN operator** (`ICE_STUN_URLS`) → `503
TURN_NOT_CONFIGURED`. **Tidak ada** `stun.l.google.com` di mana pun; kegagalan
TURN menjadi error yang terlihat, bukan fallback senyap ke pihak ketiga.
Gate E2E: `web/e2e/call.spec.ts` membuktikan dua peer `iceTransportPolicy:'relay'`
terhubung dengan pasangan `relay`↔`relay` terhadap coturn nyata (CI `e2e-chrome`
memasang coturn).

Sisa perbedaan: RingRTC, call links, blinded signaling, multi-party tanpa SFU.

### 5.8 Anti-abuse & rekayasa

- **Abuse.** Model NYX: PoW client-mined + Turnstile + attestation WebAuthn
  (tier `hardware` → `isVerified`) + tier sandbox/VIP + heuristik **per-ASN**
  (`server/src/utils/asnLookup.ts`, tabel prefix lokal, ambang 100/jam/ASN dan
  burst sybil 25/10 menit yang menuntut attestation alih-alih memblokir) +
  rate limit Lua atomik. Signal: spam-filter ML + fraud analytics
  berbasis nomor telepon. Filosofinya berbeda; NYX tidak bisa memakai nomor
  telepon tanpa membuang prinsipnya.
- **Static analysis.** **oxlint satu-satunya linter** sejak 2026-10-15: ESLint
  dihapus total (3 config + 20 devDependency), `pnpm run lint` =
  `oxlint src` per paket, job CI `lint` **blocking** untuk rule `error` dan
  kategori `correctness`; sisa `no-unused-vars` sengaja `warn` (web 190, server
  45 saat dokumen ini diperbarui). Detail: §7.4.
- **Test berbasis source-text.** `groupCredentials.test.ts` sudah hilang bersama
  fiturnya. Pola "assert regex atas sumber" masih ada di beberapa tempat
  (`usernameBlindIndex.test.ts`, `deployWorkflow.test.ts`, `lintGate.test.ts`),
  tetapi yang menyangkut **perilaku** sudah dipindahkan (audit D6:
  `gatewayParity`/`redisIdentity` menguji tabel registrasi & tulisan Redis nyata,
  bukan teks). Sisa pemindaian sumber diberi komentar eksplisit.

---

## 6. Kelebihan & kekurangan, sisi per sisi

### NYX lebih baik dari Signal pada
1. **Tidak ada PII** — Signal tetap berakar pada nomor telepon.
2. **Blind index memory-hard** (Argon2id 64 MB) + pencarian **OPRF→PIR→OHTTP**
   vs hash + enclave SGX (menambah trust ke vendor CPU & supply chain).
3. **Hardening at-rest DB** yang terukur & punya audit script otomatis.
4. **Deniability & ephemerality**: panic password, nuke wipe, burner room.
5. **Cover traffic + chaff** — Signal menolak trade-off ini.
6. **Operabilitas**: satu VPS, pm2/systemd, Prometheus/Grafana/Alertmanager lokal.
7. **Group membership token-first** yang sederhana (tanpa pairing/BBS+).
8. **Signaling call tidak membawa identitas akun** (token relay) — Signal memakai
   mekanisme lain (blinded signaling) untuk tujuan serupa.

### Signal lebih baik dari NYX pada
1. **Verifikasi formal** (SPQR: hax/F*, ProVerif) dan **audit eksternal**;
   NYX memakai crate SPQR yang sama tetapi tidak membawa bukti formal itu ke CI,
   dan `docs/36` (review kripto eksternal) belum dijalankan.
2. **Multi-device** lengkap — dipilih **tidak** ditutup oleh NYX.
3. **Ekosistem/klien native** (reliabilitas push iOS/Android di web tidak bisa
   dijamin).
4. **Skala & format ter-skema** (protobuf/gRPC) vs opcode biner + TS monolitik.
5. **Contact discovery SGX** dengan latensi & skala yang sudah terbukti (PIR NYX
   default mati, setup superlinear).
6. **Full-DB encryption lokal** (SQLCipher) + FTS5.
7. **Calls**: RingRTC, call links, multi-party tanpa SFU.
8. **Operasi fleet**: KT multi-auditor independen, storage service, dsb.

---

## 7. Temuan konkret saat audit lintas-baca (status)

### 7.1 `POST /api/conversations/credential-issuance` tidak memverifikasi keanggotaan — **HIGH, historis: dihapus 2026-10-23**

> **Resolved by deletion.** Endpoint, blind RSA, op worker `credential_*`, dan
> persist Dexie dihapus pada cutover PQ-only. Temuan ini disimpan sebagai catatan
> audit: **jangan hidupkan kembali credential tanpa** (1) gate keanggotaan
> (hash group/delivery token), (2) binding `conversationId` di dalam message yang
> ditandatangani, (3) kaitan serial↔issuance di commit, (4) nonce/purpose/expiry
> agar bukan bearer bebas, dan (5) test **perilaku** (bukan regex sumber).

Konteks historis: body `{ conversationId, blindedMsg }` hanya dibatasi `req.user`
+ kuota Redis `cred:issue:…` (3/hari), tanpa cek token/keanggotaan; commit hanya
upsert row; `verifyPresentation` memeriksa tanda tangan issuer, serial terdaftar,
dan `conversationId` row == klaim. Siapa pun yang terautentikasi dan tahu UUID
percakapan bisa menerbitkan credential untuk grup itu. Eksploitabilitas dibatasi
kerahasiaan `conversationId` **dan** Opaque Mailbox (`docs/03` §3.7.1) —
dampaknya kebocoran daftar percakapan + metadata, bukan isi pesan. Route
presentasi sekarang tetap ter-mount tetapi fail-closed (`docs/16` §16.5.1).

### 7.2 Verifikasi kunci di localStorage — **MEDIUM, SELESAI**

State verifikasi lama disimpan di localStorage tanpa tanda tangan. Sekarang:
`peerIdentityTrust.ts` menyimpan pin **terenkripsi di keychain** (`ENC1:`),
membawa `ktVerifiedAt`/`ktKeyVersion`/`ktLastVerdict`, dan perubahan kunci
menjadi **gate kirim** (`hasPendingPeerIdentityChange`) sampai user
mengonfirmasi; pin lama tidak ditimpa. Bukti: `peerIdentityTrust.test.ts`
(14 tes), `docs/34` §34.6a.

### 7.3 Metadata struktur lokal masih plaintext — **MEDIUM, SELESAI**

Lihat §5.5. Keempat kolom ditutup (`localAtRest.ts`, `localOrderKey.ts`, migrasi
unlock `migrateAtRestSealing`), lalu `sentAt`/`pqDrSessionsV2.lastActivity`
menyusul. Sisa plaintext: primary key, kolom bucket indeks, `offlineQueue.timestamp`.

### 7.4 ESLint tidak berjalan sama sekali — **MEDIUM, SELESAI 2026-10-15**

**Status: SELESAI — oxlint menjadi satu-satunya linter.** ESLint tidak pernah bisa
dijalankan di repo ini (`typescript-eslint` menolak TypeScript 7), jadi jalannya
bukan "perbaiki ESLint" melainkan menggantinya: `pnpm run lint` menjalankan
`oxlint src` di tiap paket dengan konfigurasi tunggal `.oxlintrc.json`, job CI
`lint` **blocking** untuk rule `error` dan kategori `correctness` (0 temuan),
sisa `no-unused-vars` sengaja `warn`.

Pada 2026-10-15 sisa ESLint dihapus tuntas: ketiga `eslint.config.js`, 20
devDependency, dan semua direktif `eslint-disable` lama. Satu direktif
`no-control-regex` di `server/src/utils/logger.ts` **benar-benar dipakai** dan
dipindahkan ke sintaks `oxlint-disable-next-line`; 4 direktif lain terbukti mati
(`--report-unused-disable-directives`).

### 7.5 Duplikasi helper E2E antar-spec — **LOW, SELESAI 2026-10-12**

Helper diekstrak ke `web/e2e/helpers/registration.ts`: rantai onboarding
(`registerUser`, `registerUserViaBiometric`), probe WebTransport, dan alur
"cari peer → buka chat → kirim → peer menerima". Perbaikan alur onboarding kini
cukup di satu berkas.

### 7.6 Snapshot PIR basi membuat user baru tak ditemukan — **MEDIUM, SELESAI 2026-10-28**

Saat `VITE_PIR_ENABLED=1`, klien **tidak** punya fallback (`userSearch.ts`
mengembalikan `[]` pada miss), sedangkan snapshot hanya dibangun cron 04:15 —
jadi pendaftar baru (dan profil/verifikasi/perangkat yang berubah) tidak terlihat
hingga ~24 jam. Perbaikan: penanda generasi Redis (`server/src/pir/dirty.ts`,
`pir:snapshot:gen`/`pir:snapshot:built`) di semua jalur tulis
(register/login/profil/verifikasi/onboarding/kunci/perangkat/hapus akun) + tick
rebuild 3 menit yang hanya jalan bila generasi naik, berbagi job lock dengan
rebuild harian. Uji: `pirSnapshotJob.test.ts` (7 tes, termasuk "perubahan saat
rebuild tidak hilang" dan "Redis mati = lewati, bukan rebuild buta").

---

## 8. Roadmap usulan (urut ROI, bukan urut besar)

### 8.1 Quick wins — status

| # | Item | Status |
|---|---|---|
| 1 | Gate + binding credential (§7.1) | **Tidak berlaku** — fitur dihapus 2026-10-23; jangan hidupkan tanpa 5 syarat di §7.1 |
| 2 | Verification state ke keychain + hard gate | **Selesai** (`peerIdentityTrust.ts`) |
| 3 | Buang fallback STUN pihak ketiga | **Selesai** (coturn → Cloudflare → `ICE_STUN_URLS` → 503) |
| 4 | Bucket/`ENC1:` metadata lokal | **Selesai** (termasuk `sentAt`, `lastActivity`) |
| 5 | Nyalakan lint | **Selesai** (oxlint blocking) |
| 6 | Test vector lintas-implementasi | **Sebagian** — KAT primitif + oracle DR non-libsodium (`tools/dr-oracle`, job CI `dr-oracle`); **residual**: sender-key chain/skipped key/`SessionRecord` internal |
| 7 | Capability negotiation | **Selesai** (dua transport) |

### 8.2 Yang masih terbuka (2026-10-28)

| # | Item | Kenapa / target |
|---|---|---|
| 1 | **Review kripto eksternal** (`docs/36`) | Satu-satunya cara menutup "tidak ada audit pihak ketiga"; paketnya sudah disusun |
| 2 | **KT: cutover baca ke v2** + interop `cmd/kt-client` | Log v2 baru dual-write; pembacaan masih v1 (`KT_QUERY_URL`) |
| 3 | **KT: dua auditor berdampingan + auditor di host terpisah** | Auditor yang tinggal semeja dengan log tidak membuktikan banyak |
| 4 | **PIR skala**: sharding / epoch inkremental | Setup ChalametPIR superlinear (10k user ≈ 18 menit); NYX hanya menutup staleness, bukan skalanya |
| 5 | **Ukur false-positive ASN/NAT** | Heuristik per-ASN sudah ada, angka lapangan belum |
| 6 | **Bawa bukti formal SPQR** (hax/F*/ProVerif) ke CI atau dokumen jaminan | Crate sudah vendored; yang belum adalah jaminannya |
| 7 | **Klien native** (wrapper push/background iOS/Android) | Tanpa ini, reliabilitas notifikasi selalu kalah |
| 8 | **MLS saat PQ suite matang** | Sudah tercatat di `docs/26` §26.8.2; bukan pekerjaan 2026 |

### 8.3 Non-goal (jangan diusulkan lagi)

Multi-device (`docs/30` §30.6/§30.18), onion routing/mixnet, SFU multi-party,
ZKGroup penuh/pairing (blind RSA sudah dihapus — tidak ada "versi cukup" yang
tersisa untuk dihidupkan tanpa desain baru), dan pemecahan `crypto.worker.ts`
(aturan maintainer: perbaiki di tempat).

---

## 9. Non-goals yang tetap dipertahankan

Sesuai `docs/26` §26.3 / `docs/27` §27.8, analisis ini tidak mengubahnya: onion
routing/mixnet, MLS sebelum PQ suite RFC, SFU multi-party, dan pairing penuh.
**Koreksi terhadap versi sebelumnya dokumen ini:** klaim "versi blind-RSA sudah
cukup dan lebih standar" **tidak berlaku lagi** — blind RSA dihapus 2026-10-23
dan grup memakai token-first. Yang benar sekarang: tidak ada implementasi
kredensial anonim di repo; menghidupkannya berarti desain baru + gate keamanan
§7.1.

---

## 10. Batasan analisis ini

- **Diperbarui 2026-10-28 dari kode**, bukan dari eksperimen runtime: angka tes
  diukur (web: 128 berkas; server: 86 berkas / 693 tes — 691 lulus, 2 skip; Go:
  147 test; Playwright: 14 spec), tetapi tidak ada uji beban/benchmark baru.
- **E2E tidak dijalankan di sesi pembaruan ini.** CI menjalankan
  `e2e`/`e2e-chrome` (termasuk coturn nyata dan sidecar WebTransport), dan
  `web/e2e/call.spec.ts` sudah terbukti relay↔relay; sesi ini hanya membaca
  spec + kode.
- **Klaim "Signal punya X"** merujuk keberadaan modul/kode (sekarang bisa dicek
  di `vendor/signal/*`), bukan berarti fitur aktif di semua klien. Nomor versi
  Signal-Desktop di §2 berasal dari pembacaan 2026-10-10 dan tidak diverifikasi
  ulang.
- **Tidak ada review lisensi formal.** Repo Signal yang di-vendor AGPL-3.0(-only);
  adopsi kode *mungkin* legal tetapi tetap butuh keputusan maintainer (atribusi,
  NOTICE, kompatibilitas "or-later" vs "only"). `scripts/check-vendor.sh`
  menjaga pin + NOTICE, bukan lisensi.
- **Tidak ada benchmark kinerja baru.** Rekomendasi berbasis CPU/RAM (KT, SPQR,
  PIR) belum diukur ulang terhadap VPS 4c/8GB; angka PIR yang ada berasal dari
  `bench:pir` di Celeron N2940 (`docs/35` §35.11).
