# 29 — Analisis Komparatif NYX vs Signal (dan apa yang bisa kita adopsi)

> **Status: ANALISIS / RESEARCH.** Tidak ada perubahan kode dalam dokumen ini.
> Dibuat 2026-10-10 dengan membaca langsung source NYX + source Signal di
> `~/signal` (libsignal, Signal-Server, Signal-Desktop, key-transparency-server,
> ContactDiscoveryService-Icelake, registration-service, SparsePostQuantumRatchet,
> node-sqlcipher, Signal-FTS5-Extension). Semua klaim di bawah punya rujukan file
> atau README; yang tidak bisa saya verifikasi ditandai eksplisit.
>
> **Satu temuan yang perlu tindakan segera** ada di §7 (blind credential issuance
> tidak memverifikasi keanggotaan) — lihat juga §9 quick win #1.

---

## 1. Ringkasan eksekutif

1. **Kripto inti NYX setara atau di atas Signal pada beberapa sumbu.** PQX3DH
   (X-Wing/ML-KEM-768) wajib, DR hybrid, sender-key v2 yang meniru
   `sender_keys.rs` libsignal, plus **token-first group membership**. Blind RSA
   credential pernah ada (RFC 9474) tetapi dihapus 2026-10-23; catatan historis
   ada di §4.3/§7.1. NYX tidak perlu merasa kalah di layer protokol.
2. **Celah terbesar NYX bukan kripto, tapi *kepercayaan pada server* dan
   *perangkat*.** Tiga hal: (a) **key transparency** — belum ada sama sekali,
   jadi server tetap bisa menyajikan prekey bundle palsu secara terarah dan
   korban hanya tahu dari safety number manual; (b) **multi-device** — NYX
   mengunci 1 perangkat aktif, Signal menjalankan device-list + linked devices +
   storage service; (c) **backup/restore** — NYX hanya export/import manual,
   Signal punya format backup terenkripsi yang tervalidasi ketat.
3. **NYX unggul pada privasi identitas & data-at-rest.** Tanpa PII sama sekali
   (Signal tetap butuh nomor telepon sebagai akar identitas), blind index
   Argon2id 64MB client-side (vs hash SHA-256 + enclave SGX di Signal), hardening
   dump DB yang tidak dimiliki messenger lain (senderId/sessionId/device key
   ter-seal, bucketing waktu, Redis identityTag, token-only membership), panic
   password, burner room, dan cover traffic T4 yang **tidak** dikirim Signal.
4. **Signal unggul pada rekayasa, verifikasi, dan ekosistem.** libsignal = Rust
   core + binding multi-platform, ada verifikasi formal (SPQR dengan hax/F* dan
   model ProVerif), ribuan test, capability negotiation (`DeviceCapability`,
   `ClientRelease`), spam-filter ML, registration fraud analytics, audit
   eksternal, dan klien native di semua platform. NYX: satu worker TS monolitik,
   ratusan test web + server, lint lewat **oxlint** sejak 2026-10-15 (ESLint tidak
   pernah jalan di TS 7.0.2 dan kini dihapus — §7.4), klien web saja.
5. **Hal paling layak diadopsi, urut ROI:** (1) gate issuance credential +
   binding konteks; (2) key transparency (mulai dari versi "lite" berbasis
   gossip); (3) multi-device; (4) backup terenkripsi inkremental; (5) capability
   negotiation di handshake; (6) SPQR-style PQ ratchet (FS **dan** PCS, bukan
   cuma FS); (7) static analysis + test vector lintas-implementasi (lint:
   **oxlint blocking**, §7.4).

---

## 2. Profil kedua sistem

| | **NYX** | **Signal** |
|---|---|---|
| Bentuk | Web-only (React 19 + Vite 8), monorepo pnpm | Native Android/iOS/Desktop (Electron) + server Java |
| Bahasa | TypeScript di semua layer; Rust hanya sidecar WebTransport | Rust (libsignal, SPQR, extensions), Java (server, CDS, registration), TS (Desktop), Go (key transparency) |
| Server | Express 5 + Prisma 7 + PostgreSQL + Redis, Redis pub/sub, 1 VPS (4c/8GB, pm2) | Java + FoundationDB/DynamoDB/ScyllaDB + Redis, gRPC, fleet besar |
| Transport | WebTransport/QUIC (sidecar Rust) + REST fallback, opcode biner | WebSocket/gRPC + REST protobuf |
| Kripto inti | PQX3DH (X25519+ML-KEM-768 X-Wing), DR hybrid, sender key v2, burner PQ-DR, XChaCha20-Poly1305, BLAKE2b, Argon2id, Ed25519 | X3DH/PQXDH, Double Ratchet, Sender Keys, **SPQR** (ML-KEM Braid), AES-GCM (RustCrypto), zkgroup (pairing/BBS) |
| Identitas | Tanpa PII: `usernameHash` Argon2id 64MB client-side + recovery phrase BIP39 + hardware binding | Nomor telepon (ACI/PNI) + opsional username; PIN + Secure Value Recovery |
| Storage lokal | IndexedDB (Dexie) — kolom sensitif terenkripsi, struktur plaintext; OPFS hanya blob terenkripsi | SQLCipher (seluruh DB) + FTS5 terenkripsi |
| Verifikasi kunci | TOFU + warning perubahan kunci + safety number manual | **Key transparency** (log Merkle + monitor/auditor) |
| Lisensi | AGPL-3.0 | AGPL-3.0(-only) — semuanya, termasuk SPQR & key-transparency-server |

Skala: NYX 515 file / 1.481 commit / 2 kontributor manusia, v2.7.0, DB dev 39
pesan–3 percakapan. Signal: repo Signal-Desktop saja sudah v8.31.0-alpha dengan
ratusan migrasi SQLCipher (`Signal-Desktop/ts/sql/migrations/` sampai seri 990+).

---

## 3. Tabel perbandingan per domain

Verdict: **NYX+** = NYX jelas lebih baik · **≈** = paritas · **SIG+** = Signal jelas lebih baik.

| # | Domain | NYX hari ini | Signal | Verdict |
|---|---|---|---|---|
| 1 | Registrasi & identitas | tanpa PII, Argon2id blind index, PoW/Turnstile | nomor telepon via registration-service (SMS/voice, fraud analytics) | **NYX+** (privasi) / SIG+ (sybil resistance) |
| 2 | Key agreement PQ | PQX3DH X-Wing wajib, tolak downgrade klasik | PQXDH + Kyber, PQ opsional-per-kapabilitas | **≈** (NYX lebih ketat) |
| 3 | Ratchet 1:1 | DR hybrid (KEMs/KEMr/savedCt) — PQ **FS**; jalur v2 **braid SPQR** (PQ **FS + PCS**) sudah live berdampingan, dipilih lewat deklarasi peer (`docs/33` §33.10) | DR + **SPQR** (ML-KEM Braid) — PQ **FS + PCS**, terverifikasi formal | **≈** (kripto setara; formal verification masih SIG+) |
| 4 | Grup | sender key v2 (model libsignal) + rotasi era, pseudonym, metadata-key terpisah | Sender Keys + zkgroup GroupSendEndorsement, sedang menuju QR/MLS | **≈** |
| 5 | Kredensial keanggotaan anonim | **token-first** (group/delivery token); blind RSA dihapus 2026-10-23 (§4.3 historis) | zkgroup (pairing, redemption time, presentation context) | **≈** (NYX lebih sederhana, tanpa unlinkability) |
| 6 | Key transparency | tidak ada | key-transparency-server (Merkle log, VRF, monitor) + klien `keytrans` | **SIG+** (celah terbesar) |
| 7 | Verifikasi kunci user | TOFU warning + safety number manual, state di localStorage | otomatis + monitor, manual jadi opsional | **SIG+** |
| 8 | Contact discovery | tukar link / cari usernameHash persis; tanpa social graph | SGX/Icelake PSI atas nomor telepon; username links | **SIG+** (fitur) / NYX+ (privasi terhadap Intel) |
| 9 | Multi-device | **1 perangkat aktif** (sidecar), migrasi manual via QR+chunk | device list, linked devices, provisioning, device-transfer, storage service | **SIG+** |
| 10 | Backup/restore | export/import JSON (opsional terenkripsi), migrasi streaming | format backup protobuf tervalidasi ketat + SVR/PIN + frame/padding/scramble | **SIG+** |
| 11 | At-rest server (dump) | **sealed senderId/sessionId/device key, bucketing waktu, identityTag Redis, token-only membership, audit script** | sealed sender di transit, tapi kolom DB tetap ter-join ke akun | **NYX+** |
| 12 | Sealed sender | 1:1 `senderId` tersimpan ter-seal/NULL; server tetap tahu penulis saat write | sealed sender + sender certificate + access-key/rate-limit token | **≈** (tujuan sama, mekanisme beda) |
| 13 | Storage lokal | Dexie; konten/nama/participant/contact terenkripsi, struktur plaintext | SQLCipher penuh + FTS5 terenkripsi | **SIG+** |
| 14 | Media/lampiran | R2 presigned + secretstream, deleteAt | CDN + `media` crate (thumbnail/transcode terkendali) | **≈** |
| 15 | Calls | WebRTC P2P; signaling `to: userId`; TURN Cloudflare + **STUN Google** | RingRTC, call links, blinded signaling, SFU-less multi-party | **SIG+** |
| 16 | Push | VAPID, body generik, payload per-device ter-seal ≤3KB | push tanpa konten + NSE/notification extension native | ≈ untuk web, **SIG+** untuk mobile |
| 17 | Anti-spam | PoW (client-mined, server-verified), Turnstile, tier sandbox/VIP, rate limit Lua atomik | spam-filter ML, rate-limit challenge, registration fraud analytics | **≈** (filosofi beda) |
| 18 | Panic/deniability | panic password + nuke wipe | tidak ada | **NYX+** |
| 19 | Burner/ephemeral | burner room (guest, PQ-DR, RAM-only) | tidak ada | **NYX+** |
| 20 | Cover traffic | T4 opt-in (chaff 1KB/3s + dummy message ber-jitter) | tidak ada (Signal menolak trade-off ini) | **NYX+** |
| 21 | Negosiasi kapabilitas | tidak ada (opcode + version byte per-payload) | `DeviceCapability`, `ClientRelease`, gRPC/protobuf ter-skema | **SIG+** |
| 22 | Jaminan rekayasa | 602 vitest + 374 node:test + 31 test Go (`server/kt-query`) + 18 cargo test + 24 Playwright; fuzz deterministik parser (web & sidecar framing, `docs/30` WS-G(5)); lint hidup (oxlint); tanpa formal method | ribuan test, verifikasi formal hax/F*/ProVerif, fuzzing (libFuzzer), audit eksternal, reproducible build | **SIG+** |
| 23 | Operabilitas/self-host | 1 VPS, pm2, deploy SCP — siapa pun bisa jalankan | butuh FDB/Dynamo/Scylla — praktis tidak self-hostable | **NYX+** |
| 24 | Ekosistem produk | web + marketing + tenant B2B/subscription | semua platform, stickers, call links, backup, donations | **SIG+** |

---

## 4. Di mana NYX sudah bagus (jangan diubah tanpa alasan)

**4.1 Identitas tanpa PII dan blind index memory-hard.**
`usernameHash` dihitung client-side dengan Argon2id 64MB/3 iter
(`docs/14-auth-identity.md` §14.1, `web/src/workers/crypto.worker.ts` op
`hashUsername`). Konsekuensinya: server tidak bisa reverse, dan **dump DB pun
tidak bisa di-dictionary-attack murah** — berbeda dari Signal yang menaruh hash
nomor telepon sebagai search key (Signal menutup ini dengan enclave + key
transparency, bukan dengan biaya memori). Ini aset paling khas NYX; fitur baru
(termasuk key transparency nanti) harus mempertahankannya.

**4.2 Hardening at-rest yang tidak dimiliki Signal.** `docs/28-db-dump-threat-model.md`
+ `server/src/utils/atRestSecrets.ts`, `senderIdentity.ts`, `redisIdentity.ts`,
`temporalBucket.ts`, `groupMetadataBlob.ts`, dengan pemeriksa otomatis
`server/src/utils/dumpAudit.ts` dan `server/scripts/privacy-dump-audit.ts`.
Kombinasi "seal nilai identitas di DB + buka saat relay" adalah pola yang Signal
**tidak** terapkan (Signal menyembunyikan pengirim di *transit*, bukan di kolom).
Pertahankan, dan jadikan rujukan saat menambah fitur baru.

**4.3 Blind RSA membership credential (26.8.1) — historis, dihapus 2026-10-23.**
> **Dihapus pada cutover PQ-only.** `groupCredentials.ts`, endpoint issuance/
> commit/revoke, dan persist Dexie tidak ada lagi. Grup memakai token-first;
> bagian di bawah hanya catatan desain lama dan tidak boleh dijadikan acuan
> implementasi.

`server/src/lib/groupCredentials.ts` + `web/src/lib/groupCredentials.ts` +
op worker `credential_blind`/`credential_finalize`. Ini menjawab kebutuhan
"presentation moment" (docs/26.8.1) tanpa pairing/BBS+: suite
`RSABSSA-SHA384-PSS-Randomized` (RFC 9474), private key issuer **wajib dari env**
(`GROUP_ISSUER_KEY_PKCS8`), fail-closed di production, DB hanya menyimpan material
publik. Revocation = hapus row serial. Dibanding zkgroup Signal: lebih kecil,
lebih standar, tapi **kurang binding** (lihat §7). Klaim rotasi key yang
membatalkan credential lama juga tidak ditegakkan oleh `verifyPresentation`.

**4.4 Timing/covers & deniability.** Chaff 1000B/3s (`CHAFF = 0x00`, sidecar
mengabaikan), padding 8KB, cover traffic T4 opt-in (docs/26.10), panic password,
nuke wipe. Signal secara sadar **tidak** mengirim cover traffic; di dimensi
"menyembunyikan kapan", NYX lebih jauh.

**4.5 Sederhana dan bisa di-self-host.** 1 VPS + pm2 vs fleet FDB/Dynamo/Scylla.
Ini bukan sekadar hemat biaya: memperkecil permukaan operasional memperkecil
permukaan kebocoran (dan membuat audit oleh pihak ketiga realistis).

---

## 5. Celah NYX vs Signal — detail + cara menutup

### 5.1 Key transparency (celah nomor satu)

**Masalah.** Root of trust pemetaan `username → prekey bundle` adalah server
(`server/src/routes/keys.ts`). Penyerang dengan akses server (atau backup dump)
bisa menyajikan bundle palsu **hanya untuk satu target** dan tidak ada yang bisa
membuktikannya. NYX hanya punya TOFU + warning bubble
(`web/src/utils/crypto.ts` `identityChanged`, `web/src/utils/verification.ts`,
state di **localStorage** — mudah dibersihkan, hilang saat wipe, dan tidak
ditandatangani). Safety number ada (`web/src/utils/safetyNumber.ts`) tapi manual
dan tidak pernah di-*re-verify*.

**Yang dipakai Signal.** `key-transparency-server` (Go): log append-only
gaya Merkle + prefix tree, VRF, endpoint Search/Monitor + auditor, mengikuti
`draft-ietf-keytrans-protocol`, dengan klien verifikasi di
`libsignal/rust/keytrans` (`verify_search`, `verify_monitor`,
`verify_distinguished`, commitment/prefix proof) dan pemanggilan server di
`Signal-Server/.../controllers/KeyTransparencyController.java`. **Semuanya
AGPL-3.0** → secara lisensi bisa diadopsi langsung.

**Rencana bertahap (disarankan):**

- **Tahap A — "KT lite" (1–2 minggu, tanpa server baru).** Log identitas
  append-only **di perangkat**: setiap kali klien mengamati
  `(usernameHash → identityKey)` dari bundle atau pesan, catat
  `(peer, key, timestamp)` ke keychain `ENC1:`. Sertakan *observasi* itu
  (ditandatangani klien, ikut di payload pesan 1:1/grup — sudah ada slot
  metadata) sehingga kontak Anda menyimpan observasi independen. Bila ada konflik
  (dua observasi berbeda untuk peer yang sama), **dua-duanya** munculkan warning
  keras, bukan hanya sisi yang kebetulan melihat bundle baru. Ini mengubah
  serangan dari "tidak terdeteksi" menjadi "terdeteksi oleh pihak ketiga yang
  tidak dikendalikan penyerang" — persis properti yang membuat full KT berguna,
  dengan biaya nol server.
- **Tahap B — KT penuh (4–8 minggu).** Reuse `key-transparency-server` + port
  klien `keytrans` (Rust → WASM via wasm-bindgen) atau implementasi TS dari
  `verify.rs`. Search key = `usernameHash` (bukan nomor telepon) — dan karena
  hasilnya Argon2id memory-hard, **log-nya sendiri tidak menciptakan kamus**
  (ini justru lebih kuat dari pada Signal). Update log dipicu pada
  register/rotate prekey/recover.
- **Tahap C.** Monitor/auditor pihak ketiga (siapa pun bisa menjalankan
  auditor yang sama, seperti Signal) + gossip antar-klien atas tree head.

**Alternative label: SIGNAL-ONLY.** Jika server server ini dijalankan oleh
operator tunggal, KT penuh pun bergantung pada auditor independen. Tahap A
adalah mitigasi minimum yang praktis.

### 5.2 Multi-device — **KEPUTUSAN MAINTAINER: tidak dikerjakan (non-goal permanen)**

> **Update 2026-10-11.** Ini bukan celah yang akan ditutup: NYX memilih satu
> perangkat aktif per akun sebagai **properti keamanan** (tanpa device list, tanpa
> fan-out kunci per device, tanpa layanan storage ber-kunci-akun). Rencana
> implementasinya dibatalkan di `docs/30` §30.6 dan dicatat sebagai non-goal di
> §30.18; kapabilitas `CLIENT_CAPABILITIES.MULTI_DEVICE` sudah dihapus dari
> `packages/shared/src/transport.ts`. Jalur pemulihan resmi: recovery phrase dan
> backup ber-frame (`docs/31`). Analisis di bawah dipertahankan sebagai konteks
> tentang apa yang Signal lakukan — **bukan** sebagai backlog.

**Masalah.** Sidecar menegakkan satu sesi WebTransport per user
(`docs/14` §14.7) dan `redisBridge.isActiveDeviceAllowed` menolak perangkat
kedua, kecuali mode migrasi (`is_migrating:<userId>`) yang memindahkan vault,
bukan menambah perangkat.

**Signal.** `DeviceController`, `ProvisioningController`, `device-transfer`
(libsignal), `DeviceCapability`, `DeviceKEMPreKeyPages` (server storage),
device list per akun, dan satu `storage service` untuk sinkronisasi
setelan/kontak antar perangkat.

**Yang sudah ada di NYX (modal awal):** amplop **per-device** sudah jadi norma
(`pq_box_seal_v2` + `targetDeviceId`/`targetDeviceKey` di envelope sender-key v2/v4),
`SessionKey` per device, `contactStore` sudah terenkripsi dan kuncinya
deterministik dari identity key (jadi bisa di-restore/di-sync lintas perangkat),
dan alur QR (`auth:request_linking_qr`, `migration:start|chunk|ack`) sudah ada
untuk pemindahan.

**Langkah:** (1) perluas "1 aktif" → "N linked" dengan device list bertanda
tangan + fan-out per device (mekanisme sealer sudah ada); (2) keluarga pesan
`SYNC`/`COPY` untuk riwayat & setelan antar perangkat (mulai dari contactStore +
admin token + verification state, bukan riwayat pesan); (3) QR "Add device"
memakai alur linking yang sudah ada; (4) storage service minimal: blob
terenkripsi per akun (R2) yang hanya bisa dibuka perangkat dengan kunci akun.
Ini proyek multi-minggu dan mengubah banyak asumsi (`docs/03` §3.3, docs/16),
jadi harus masuk backlog resmi — bukan tambalan.

### 5.3 Backup/restore

**NYX:** `exportDatabaseToJson`/`importDatabaseFromJson`
(`web/src/lib/keychainDb.ts`) — ada envelope terenkripsi opsional + password,
plus migrasi perangkat streaming. Tidak ada backup otomatis, tidak ada format
yang tervalidasi, dan export berisi seluruh tabel sekaligus.

**Signal:** `libsignal/rust/message-backup` — validator format backup dengan
framing berurutan, derivasi kunci (`key.rs`), padding, dan pengacakan field
(`scramble/`) supaya bentuk backup tidak membocorkan struktur; tujuannya
eksplisit agar dua implementasi bisa dibandingkan (`serialize(backup) ==
serialize(export(restoreFrom(backup)))`).

**Rekomendasi:** format backup ber-frame (bukan satu JSON besar) yang
sepenuhnya terenkripsi, diturunkan dari recovery phrase (Argon2id) atau kunci
backup terpisah, opsional tersimpan client-side-encrypted di R2 untuk restore
lintas perangkat. Prasyarat teknis: **§5.2 harus jalan dulu** (restore lintas
perangkat tanpa multi-device hanya menghasilkan vault orphan).

### 5.4 PQ ratchet: FS vs FS+PCS (SPQR)

**NYX:** DR dengan langkah KEM (`KEMs`/`KEMr`/`savedCt` di
`web/src/workers/crypto.worker.ts`, header membawa `ct` 1120 byte sampai
peer meng-ack `ackKem`) → PQ **forward secrecy** sudah ada, tapi PCS
(post-compromise security) untuk komponen PQ tidak dijamin: setelah state
dicuri, penyerang mengikuti rantai sampai ada DH/KEM baru yang benar-benar
independen.

**(2026-10-14)** Jalur **v2** sudah live berdampingan: message key dari braid
ML-KEM (`spqr`) di header `{v:2,b:[…]}`, dipakai hanya setelah peer menyatakan
mampu (`ackV`), state braid ter-seal berdampingan dengan state v1 dan bisa
di-rollback tanpa kehilangan riwayat (`docs/33` §33.10). Jadi klaim "PCS PQ
belum ada" pada paragraf di atas kini hanya berlaku untuk sesi v1 (peer lama /
kill switch) — primitif v1 sendiri tetap beku.

**Signal:** `SparsePostQuantumRatchet` — ratchet publik ML-KEM **Braid**
(`src/v1/{chunked,unchunked}`) + erasure coding Reed–Solomon supaya pesan
KEM besar tidak rapuh terhadap paket hilang, chain simetris untuk FS, **dan
verifikasi formal** (hax/F* untuk panic-free + ProVerif untuk FS/PCS), AGPL-3.0.

**Rekomendasi:** jadikan ini proyek kripto berikutnya setelah KT lite, dengan
caveat penting: **format baru = jalur versi paralel**, bukan perubahan format
beku (aturan `docs/04` tetap berlaku). Karena SPQR adalah Rust dan lisensinya
kompatibel, opsi realistis adalah mengompilasinya ke WASM dan memanggilnya dari
`crypto.worker.ts` dengan API "output message keys" — pola yang sama seperti
libsodium sekarang. Ini juga kesempatan mengganti bagian ratchet yang paling
sulit diaudit di worker TS dengan kode yang sudah diverifikasi.

### 5.5 Storage lokal & pencarian terenkripsi

**NYX:** IndexedDB Dexie; kolom sensitif terenkripsi
(`content`, `senderName`, `participants`, `ContactRow.data`) tapi **struktur
tetap plaintext**: `id`, `isGroup`, `lastMessageAt`, `seq`, `updatedAt`
(`web/src/lib/db.ts` `ConversationRecord`/`DecryptedMessageRecord`).

> **[2026-10-12 — WS-F] Sebagian besar sudah ditutup:** `lastMessageAt`
di-bucket 15 menit (bucket yang sama dengan server), `seq`/`senderId`/
`repliedToId`/`isViewOnce`/`isDeletedLocal`/`expiresAt`/`Conversation.isGroup`/
`Message.reactions` ter-seal `ENC1:` di tempat, urutan pesan memakai skema dua lapis
(`orderBucketMs` plaintext + `createdAtSealed`), pencarian lewat indeks
in-memory saat vault terbuka, dan `ContactRow.updatedAt` /
`ProfileCacheRecord.updatedAt` di-seal di rel migrasi unlock. OPFS sudah benar
(hanya blob terenkripsi, `opfsStorage.ts`).
>
> **[2026-10-16 — status setelah verifikasi gate `docs/30` §30.10] Yang masih
plaintext (dan memang tidak bisa dihilangkan):** `id` (primary key —
tidak bisa dienkripsi tanpa mematikan indeks), `orderBucketMs` /
`Conversation.lastMessageAt` (indeks; granularitasnya **sudah** terpublikasi di
server `temporalBucket.ts`, docs/28 B3/B4) dan `offlineQueue.timestamp` (kolom
indeks `orderBy('timestamp')` pada antrean kirim yang sementara). Yang **tidak**
lagi plaintext sejak verifikasi: `sentAt` dan `pqDrSessionsV2.lastActivity`
(keduanya ms presisi → kini `ENC1:`); sebelumnya dua kolom itu lolos dari daftar
"sisa" dan praktis membatalkan gate "jam tidak terbaca".
>
> Artinya penyerang yang memegang profil browser (atau backup profil, atau
device tercuri) hanya melihat **pola aktivitas sampai presisi bucket 15 menit**
(berapa pesan per bucket/percakapan) — bukan jam per pesan. Isi pesan tetap
tidak terbaca. Ini kontras dengan `docs/28` yang justru berjuang membucket
`lastMessageAt` **di sisi server** (`temporalBucket.ts`) — jadi aneh kalau sisi
klien membiarkannya presisi.

**Signal:** SQLCipher mengenkripsi seluruh DB + FTS5 untuk pencarian (dan
ekstensi SQLCipher-nya sendiri).

**Rekomendasi (murah, cocok jadi quick win):** bucket `lastMessageAt`/`seq`
atau bungkus field struktural itu dengan `ENC1:`. Pencarian lokal penuh ala FTS5
tidak realistis di IndexedDB; alternatifnya indeks pencarian terenkripsi di
memori saat vault dibuka (bukan di disk).

### 5.6 Negosiasi kapabilitas & evolusi protokol

NYX memakai opcode + version byte per-payload (`packages/shared/src/transport.ts`)
dan tidak mengirim daftar kapabilitas saat AUTH. Signal punya `DeviceCapability`
dan `ClientRelease` di server, plus skema protobuf/gRPC.

**Kenapa ini penting untuk NYX sekarang:** seluruh roadmap di atas (KT, SPQR,
multi-device, backup) membutuhkan klien baru + lama hidup berdampingan. Tanpa
`capabilities[]` di handshake, setiap fitur baru harus mengandalkan "tebak dari
version byte di payload" — pola yang sudah terbukti rapuh di jalur sender-key
(docs/16: lima invariant era harus ditambal berulang kali karena routing antar
versi). Tambahan `protocolVersion` + `capabilities` (server mengabaikan yang tak
dikenal) adalah perubahan kecil dengan nilai besar.

**Status implementasi (2026-10-16):** negosiasi berjalan di **kedua** transport,
sebab satu transport saja tidak cukup — klien di jaringan yang memblokir QUIC
memakai WSS, dan di sanalah kapabilitas dulu tidak pernah ada:

| Transport | Klien → relay | Relay → klien | Kode |
|---|---|---|---|
| WebTransport (sidecar) | frame `HELLO` (opcode `0x0B`) di stream **bidi** | frame `HELLO` balasan, irisan kapabilitas | `server/transport-sidecar/src/protocol.rs` |
| WSS (socket.io) | `handshake.auth.capabilities` (array string pendek) | event `capabilities`, irisan kapabilitas | `server/src/realtime/gateway.ts` + `server/src/utils/transportCapability.ts` |

Aturan yang sama di kedua jalur: klien **lama** yang tidak mengirim apa pun =
legacy (daftar kosong), bentuk cacat **tidak** memutus koneksi, irisan dihitung
klien **dan** server (server tidak boleh mengaktifkan kapabilitas yang belum
diiklankan klien), dan nama kapabilitas hidup di satu tempat —
`SERVER_CAPABILITIES` di `packages/shared/src/transport.ts`.

Kenapa ini menentukan untuk ratchet v2 (braid SPQR, `docs/33` §33.7): klien hanya
mengirim v2 bila relay **aktif** mengiklankan `spqr-ratchet`. Sebelum gateway WSS
ikut menegosiasikan, semua klien di jalur WSS selalu dilihat sebagai legacy — jadi
jalur v2 praktis tidak pernah terpakai walau kedua peer sudah saling menyatakan
mampu lewat `ackV` (bukti peer itu in-band dan tetap satu-satunya syarat
sesungguhnya). Rollout-nya bisa diukur: `nyx_wss_capability_total{capability}`.

### 5.7 Calls

`docs/27` §27.5 sudah mencatat jujur bahwa media DTLS-SRTP E2E **tetapi**
signaling `WEBRTC_SIGNAL` dirutekan `to: userId`. Untuk ICE, dua jalur memakai
**STUN Google** (diverifikasi, koreksi terhadap klaim docs/27 bahwa fallback
ditambahkan di atas TURN):

- `server/src/routes/keys.ts:590,607,610` — `GET /api/keys/turn` mengembalikan
  `stun:stun.l.google.com:19302` ketika TURN tidak dikonfigurasi, ketika respons
  Cloudflare tidak memuat `iceServers`, atau ketika terjadi error;
- `web/src/lib/webrtc.ts:29` — klien jatuh ke STUN Google bila request TURN gagal.

Artinya bukan "selalu bocor", tapi **setiap jalur gagal (TURN down / env
kosong / error transient) mengirim IP klien ke Google** — dan itu justru terjadi
pada momen paling sensitif. Signal: RingRTC, call links, blinded signaling,
multi-party tanpa SFU.

**Langkah murah (minggu ini):** ganti kedua fallback itu ke coturn sendiri
(atau Cloudflare-only) dan buat kegagalan TURN jadi error yang terlihat, bukan
fallback senyap ke pihak ketiga. **Langkah menengah:** signaling berbasis
delivery token T3b (bukan `to: userId`) supaya percobaan call tidak ter-link ke
akun.

### 5.8 Anti-abuse & rekayasa

- **Abuse:** model NYX (PoW client-mined + Turnstile + tier sandbox/VIP) bagus
  untuk privasi tapi lemah terhadap sybil berbiaya rendah dibanding nomor
  telepon + fraud analytics Signal (`registration-service`: Bigtable/PubSub,
  multi-provider SMS/voice, fictitious numbers untuk testing). Karena "tanpa
  PII" adalah prinsip, jalur realistis: perkuat attestation (WebAuthn sudah ada),
  tambah heuristik per-ASN/IP (tanpa menyimpan IP), dan kuota bertingkat seperti
  pola `otpkQuota.ts`.
- **ESLint mati repo-wide** karena `typescript-eslint` belum mendukung
  TypeScript 7.0.2 (`web/package.json`, `server/package.json`). Efeknya: **nol
  static analysis** pada basis kode yang memegang kripto. Perbaikan murah:
  jalankan ESLint dengan alias `typescript@5` khusus lint (parser bisa
  diarahkan), atau adopsi linter berbasis Rust (`oxlint`) sebagai gantinya, lalu
  buat sebagian rule jadi blocking di CI.
  → **Diselesaikan 2026-10-15 lewat jalur kedua (oxlint); ESLint dihapus
  sepenuhnya. Lihat §7.4.**
- **Test berbasis source-text.** `server/tests/groupCredentials.test.ts` (dan
  pola serupa di `schemaPrivacy.test.ts`) meng-assert regex atas source.
  Roundtrip kriptonya nyata (bagus), tapi klaim perilaku (endpoint, otorisasi)
  hanya diuji sebagai string. Test yang mengunci *perilaku* endpoint akan
  langsung menangkap §7 di bawah.

---

## 6. Kelebihan & kekurangan, sisi per sisi

### NYX lebih baik dari Signal pada
1. **Tidak ada PII** — Signal tetap berakar pada nomor telepon (username adalah
   lapisan di atasnya).
2. **Blind index memory-hard** (Argon2id 64MB) vs hash + enclave (SGX
   menambah trust ke vendor CPU & supply chain enclosure).
3. **Hardening at-rest DB** yang terukur & punya audit script otomatis —
   senderId/sessionId/device key ter-seal, bucketing waktu, Redis bersih dari
   userId, token-only membership, `ENC1:`.
4. **Deniability & ephemerality**: panic password, nuke wipe, burner room
   (PQ-DR, RAM-only) — tidak ada padanannya di Signal.
5. **Cover traffic T4 + chaff** — Signal menolak trade-off ini.
6. **Operabilitas**: bisa dijalankan satu orang di satu VPS.
7. **Group membership token-first** yang sederhana (blind RSA pernah ada,
   dihapus 2026-10-23; private key issuer klasik tidak lagi dipakai).
8. **Verifikasi safety number tidak wajib** di Signal karena KT — tapi NYX punya
   *manual* verification + safety number sendiri; bila KT lite dibangun, NYX
   bisa menyamai sambil tetap tanpa PII.

### Signal lebih baik dari NYX pada
1. **Key transparency** (log + monitor + auditor klien) — kemampuan mendeteksi
   MITM terarah.
2. **Multi-device** lengkap (linked devices, provisioning, device-transfer,
   storage service).
3. **Backup** berformat, tervalidasi, dapat di-restore (dan SVR/PIN).
4. **SPQR**: PQ FS **dan** PCS, terverifikasi formal (hax/F*, ProVerif).
5. **libsignal** sebagai library lintas platform yang diaudit & berversi, vs
   kripto NYX di worker TS monolitik yang tidak boleh dipecah (`docs/04`).
   Trade-off desain NYX ("jangan dipecah") bagus untuk konsistensi format, tapi
   mempersulit audit independen.
6. **Contact discovery** (SGX PSI) + username links.
7. **Full-DB encryption lokal** (SQLCipher) + FTS5.
8. **Calls** (RingRTC, call links, blinded signaling, multi-party).
9. **Rekayasa**: capability negotiation, skema gRPC, ribuan test, spam-filter,
   fraud analytics, reproducible build, audit eksternal.
10. **Ekosistem**: klien native semua platform (termasuk background push iOS
    yang di web tidak bisa dijamin), stickers, backup, donations.

---

## 7. Temuan konkret saat audit lintas-baca (perlu tindakan)

### 7.1 `POST /api/conversations/credential-issuance` tidak memverifikasi keanggotaan — **HIGH (historis, dihapus 2026-10-23)**

> **Resolved by deletion.** Endpoint, blind RSA, dan seluruh alur credential
> dihapus pada cutover PQ-only. Temuan ini disimpan sebagai catatan audit; jangan
> menghidupkan kembali credential tanpa memperbaiki gating keanggotaan dan
> binding issuance/commit.

`server/src/routes/conversations.ts` (blok issuance, ±baris 66–114): body
`{ conversationId, blindedMsg }`, dibatasi hanya oleh `req.user` + kuota Redis
`cred:issue:<userId>:<conversationId>:<hari>` (maks 3/hari). **Tidak ada** cek
`X-Group-Token`/admin token/delivery token, dan **tidak ada** verifikasi bahwa
user adalah anggota `conversationId`. Server menandatangani blinded message apa
pun (≤512 byte) dan mengembalikan `blindSig` + `keyVersion`.

Klien lalu `POST /credential-commit` dengan `(conversationId, keyVersion, serial)`
— dan commit **tidak memverifikasi apa pun** (`recordIssuedCredential` hanya
upsert row).

Akibatnya, presentasi `X-Group-Credentials` (dipakai di `GET /api/conversations`
sync untuk *discovery* membership) memvalidasi tiga hal saja
(`verifyPresentation`, `server/src/lib/groupCredentials.ts`): tanda tangan issuer
valid, serial terdaftar, dan `conversationId` row == yang diklaim. Salah satu
akun terdaftar yang mengetahui UUID `conversationId` sebuah grup **dapat
menerbitkan credential untuk grup itu dan menambahkannya ke sync-nya** — tanpa
token grup, tanpa keanggotaan. Eksploitabilitas dibatasi oleh kerahasiaan
`conversationId` (UUID tak bisa ditelusuri) **dan** oleh fakta bahwa
`GET /api/messages/:conversationId` sudah tidak memeriksa keanggotaan (Opaque
Mailbox, `docs/03` §3.7) — jadi dampak utamanya adalah kebocoran *daftar
percakapan + metadata* dan hilangnya arti "token-only membership" yang justru
jadi inti T3b.

**Perbaikan (kecil, 1 sesi):**
1. Gate issuance dengan bukti keanggotaan: hash `X-Group-Token`/delivery token
   (pola `credentialTokenMatches` sudah dipakai di route lain).
2. Verifikasi binding di `verifyPresentation`: prepared message NYX punya format
   tetap `nyx-grp-cred:v1:<convId>:<hex>` (`web/src/lib/groupCredentials.ts`
   `randomMessage`) → server bisa **mencocokkan prefiks convId di dalam
   `preparedMsg`** dengan `conversationId` yang diklaim, tanpa perlu tahu
   blinding factor. Ini menutup pemakaian silang antar-conversation secara
   gratis.
3. Commit: kaitkan serial ke issuance yang sudah ditandatangani (simpan ctx
   issuance keyed by blind-hash + convId, lalu di commit pastikan ada) supaya
   klien tidak bisa menyuntikkan serial sembarang.
4. Jadikan credential **bukan bearer bebas**: sertakan nonce/challenge dari
   server (atau `purpose` + `expiresAt`) di dalam message yang ditandatangani
   agar presentasi tidak bisa di-replay pihak lain (Signal menyematkan group
   identifier + redemption time + presentation context di zkgroup).
5. Tambah test perilaku (bukan source-regex): issuance tanpa token → 403;
   presentasi dengan convId tidak cocok → ditolak.

### 7.2 Verifikasi kunci disimpan di localStorage — **MEDIUM**

`web/src/utils/verification.ts` menyimpan `verified_conversation_*` di
localStorage **tanpa tanda tangan dan tanpa proteksi**. Siapa pun yang bisa
menulis localStorage (skrip injeksi via XSS, atau akses perangkat) bisa
"memverifikasi" percakapan, dan `nukeProtocol`/wipe akan menghapusnya tanpa
jejak. Rekomendasi: pindahkan ke keychain `ENC1:` (terikat masterSeed) +
sertakan `identityKey` yang diverifikasi di dalam state terenkripsi, dan ubah
perubahan kunci dari "warning bubble" menjadi **hard gate** (blokir kirim sampai
user konfirmasi), minimal sebagai opsi "pinned identity" per kontak.

### 7.3 Metadata struktur lokal masih plaintext — **MEDIUM**

Lihat §5.5. Bucket/`ENC1:`-kan `lastMessageAt`, `seq`, `updatedAt`, `isGroup`
(bucket yang sama dengan `temporalBucket.ts` supaya konsisten sisi klien-server).

**Status 2026-10-12 (WS-F): SELESAI.** Keempat kolom ditutup
(`localAtRest.ts` + skema urutan `localOrderKey.ts` + migrasi unlock
`migrateAtRestSealing`); sisa plaintext hanya primary key dan bucket indeks yang
memang harus bisa di-range-scan (§5.5).

**Status 2026-10-16 (verifikasi gate `docs/30` §30.10):** klaim "sisa plaintext
hanya primary key dan bucket indeks" di atas ternyata **belum lengkap** —
`Message.sentAt` dan `pqDrSessionsV2.lastActivity` (dua-duanya ms presisi) masih
plaintext dan membuat "jam" tetap terbaca dari IndexedDB. Keduanya kini ter-seal
`ENC1:` (writer + migrasi unlock + pembaca; baris lama tetap terbaca) dan ada
**pemindai baris mentah** yang menjaganya (`dexieMigration.test.ts`, dengan
kontrol negatif). Sisa yang disengaja plaintext hanya `id`, kolom bucket indeks,
dan `offlineQueue.timestamp`.

### 7.4 ESLint tidak berjalan sama sekali — **MEDIUM (selesai 2026-10-15)**

Tidak ada static analysis di repo yang memegang kripto. Lihat §5.8.

**Status 2026-10-15: SELESAI — oxlint menjadi satu-satunya linter.** ESLint tidak
pernah bisa dijalankan di repo ini (`typescript-eslint` menolak TypeScript 7), jadi
jalannya bukan "perbaiki ESLint" melainkan menggantinya: `pnpm run lint` menjalankan
`oxlint src` di tiap paket dengan konfigurasi tunggal `.oxlintrc.json`, job CI `lint`
**blocking** untuk rule level `error` dan kategori `correctness` (0 temuan), sisa
`no-unused-vars` sengaja `warn`.

Pada 2026-10-15 sisa ESLint dihapus tuntas supaya tidak ada dua sumber kebenaran:
ketiga `eslint.config.js` (`web`, `server`, `marketing`), 20 devDependency
(`eslint`, `@eslint/js`, `typescript-eslint`, plugin react/astro/import/n/promise,
`globals`, parser-nya) dan semua direktif `eslint-disable` lama. Bukti bahwa ini
bukan sekadar pembersihan kosmetik: satu direktif `no-control-regex` di
`server/src/utils/logger.ts` **benar-benar dipakai** (menghapus keduanya membuat
lint gagal), jadi ia dipindahkan ke sintaks `oxlint-disable-next-line` tepat di atas
baris kodenya; 4 direktif lain terbukti mati (`--report-unused-disable-directives`)
dan diganti komentar biasa yang tetap menjelaskan alasannya.

### 7.5 Duplikasi helper E2E antar-spec — **LOW (selesai 2026-10-12)**

`AGENTS.md` dulu menyatakan duplikasi helper per spec sebagai konvensi; itu
menambah biaya perawatan pada suite yang sudah flaky di paralel (`workers: 1`).
**Sudah diekstrak** ke `web/e2e/helpers/registration.ts` (WS-G(7)): rantai
onboarding (`registerUser` + varian `registerUserViaBiometric` untuk spec
Settings — sebelumnya hanya berbeda satu langkah skip biometric dan sudah
menyimpang), probe WebTransport (dulu dua nama + satu evaluasi inline), serta
alur "cari peer → buka chat → kirim → peer menerima". Perbaikan alur onboarding
ke depan cukup di satu berkas, sehingga regresi flaky tidak perlu disinkronkan
manual ke enam spec.

---

## 8. Roadmap usulan (urut ROI, bukan urut besar)

### Quick wins (≤1 minggu total)
| # | Item | Target file | Kriteria selesai |
|---|---|---|---|
| 1 | Gate + binding credential (§7.1) | `server/src/routes/conversations.ts`, `server/src/lib/groupCredentials.ts`, `web/src/lib/groupCredentials.ts` | Test perilaku: issuance tanpa token → 403; convId mismatch → ditolak; presentasi context-bound |
| 2 | Pindahkan verification state ke keychain + hard gate perubahan kunci | `web/src/utils/verification.ts`, `web/src/utils/crypto.ts`, `web/src/lib/messagePipeline.ts` | Perubahan identitas → kirim diblokir sampai konfirmasi; state tahan reload & wipe terkelola |
| 3 | Buang fallback Google STUN — **landed**: `keys.ts` tidak lagi menyebut STUN pihak ketiga; urutan coturn → Cloudflare → `ICE_STUN_URLS` → 503/502 | `server/src/routes/keys.ts`, `web/src/lib/webrtc.ts` | Tidak ada `google.com` di jalur ICE; kegagalan TURN jadi error eksplisit |
| 4 | Bucket/`ENC1:` metadata lokal | `web/src/lib/db.ts`, `shadowVaultDb.ts`, `keychainDb.ts` | Tidak ada `lastMessageAt` presisi & `seq` plaintext di IndexedDB |
| 5 | Nyalakan kembali lint (alias TS 5 untuk lint atau oxlint) — **landed 2026-10-15**: oxlint menggantikan ESLint sepenuhnya; config ESLint dihapus | `.oxlintrc.json`, `package.json` (per paket `lint: oxlint src`) | `pnpm run lint` jalan; rule `error` + kategori `correctness` blocking di CI (0 temuan) |
| 6 | Test vector lintas-implementasi (DR/sender-key/era) | `web/src/lib/__tests__/`, `server/tests/`, `tools/dr-oracle/` | Vektor dari libsignal/SPQR lulus untuk primitif yang identik. **Landed:** KAT primitif (`cryptoKnownAnswer`, `argonKnownAnswer`) **plus** oracle Go non-libsodium dua arah untuk X3DH/KEM/kdfChain/AEAD (`docs/30` WS-G(6)); **residual:** sender-key chain / skipped key / `SessionRecord` tetap internal |
| 7 | Capability negotiation di handshake | `packages/shared/src/transport.ts`, sidecar `main.rs`, `web/src/lib/transportClient.ts` | Klien lama tanpa `capabilities` tetap jalan |

**Status implementasi (2026-10-11).** Ketujuhnya sudah landed di branch ini,
masing-masing dengan test yang menguncinya. Item 8–16 (KT penuh, multi-device,
backup, SPQR, calls, observability, anti-abuse, MLS, klien native) sudah punya
rencana eksekusi bertahap dengan acceptance gate di
[`docs/30-post-parity-implementation-plan.md`](30-post-parity-implementation-plan.md)
— termasuk alasan kenapa "KT lite" (item 8 di tabel di bawah) **tidak**
dikerjakan dan diganti KT penuh (§30.3, §30.5).

| # | Item | Test/bukti pengunci | Catatan penting |
|---|---|---|---|
| 1 | Gate + binding credential | `server/tests/credentialIssuance.test.ts` (**dihapus 2026-10-23** bersama credential blind RSA — grup kini token-first, lihat docs/26 banner + docs/35 Fase 6) | issuance butuh bukti keanggotaan + tiket; presentasi context-bound ke conversation |
| 2 | Verification state ke keychain + hard gate | `web/src/lib/__tests__/peerIdentityTrust.test.ts` | kunci berubah → kirim diblokir sampai konfirmasi; pin lama TIDAK ditimpa dan tersimpan terenkripsi |
| 3 | Tanpa STUN pihak ketiga | `server/tests/turnIceServers.test.ts` | kegagalan TURN = error eksplisit + kunci `call_no_turn` di 4 bahasa |
| 4 | Metadata lokal di-bucket / `ENC1:` | `web/src/lib/__tests__/localAtRest.test.ts`, `localOrderKey.test.ts`, `dexieMigration.test.ts` (IndexedDB nyata), `vaultSeqPersistence.test.ts`, `vaultReactionsPersistence.test.ts`, `contactStore.test.ts` | `seq`/`senderId`/`repliedToId`/`isViewOnce`/`isDeletedLocal`/`expiresAt`/`isGroup`/`Message.reactions`/`ContactRow.updatedAt`/`ProfileCacheRecord.updatedAt` tidak lagi plaintext, `lastMessageAt` dipotong 15 menit (baris lama plaintext tetap terbaca + di-seal saat unlock) |
| 5 | Lint hidup lagi | `pnpm run lint` (oxlint, CI blocking pada `error`; kategori `correctness` **`error`** sejak 2026-10-14, 0 error) | sisa 194 `no-unused-vars` yang sengaja tetap `warn` dan dibersihkan bertahap |
| 6 | KAT lintas-implementasi | `server/tests/cryptoKnownAnswer.test.ts` (RFC 7748/8032/7693/8439/9106 + invarian X-Wing), `web/src/lib/__tests__/argonKnownAnswer.test.ts` | `hash-wasm` tidak mengekspos associated data → tag RFC 9106 §5.3 diikat di server; sisi klien mengunci nilai penengah A/B yang sama |
| 7 | Negosiasi kapabilitas | `web/src/lib/__tests__/transportCapabilities.test.ts`, `cargo test` di sidecar (`protocol::tests`) | HELLO wajib lewat stream **bidi**; di jalur uni/datagram sidecar mengabaikannya supaya opcode 0x0B tidak pernah muncul di `nyx:upstream:*` |

**Residual setelah audit 2026-10-12, diperbarui 2026-10-14 (lihat `docs/30`
§30.20 untuk status lengkap):** WS-G(4) test perilaku endpoint ✅ (jalur grup
lengkap di `utils/groupAccess.ts`), WS-G(5) fuzz parser ✅ (web + framing
sidecar), WS-G(1) dashboard Grafana ✅, WS-F kolom waktu kontak/profil ✅,
WS-G(2) drill alert ✅ (**14** aturan; tiap aturan punya kasus menyala **dan**
tidak-menyala, dijalankan per-PR oleh `scripts/drill-alerts.sh` + job CI
`alerts`), WS-G(3) load test ✅ terukur (500 VU: send p95 74,4 ms / fetch p95
68,8 ms, 0% error), WS-H per-hash-ASN ✅ (`utils/asnLookup.ts` — tabel prefix→ASN
lokal tanpa layanan pihak ketiga, ambang 100/jam/ASN + burst sybil 25/10 menit
yang menuntut attestation **bukan** memblokir); **WS-A ✅ dan WS-D ✅
(2026-10-14)**: KT penuh (penulis + verifier + `server/kt-query` + monitor +
**auditor/mode 3** + **gossip tree head**) dan SPQR terintegrasi ke jalur pesan
(detail `docs/33`, `docs/34`); **WS-G(6) 🟡 parsial**: primitif X3DH/KEM/KDF/AEAD
sudah dibuktikan dua arah terhadap oracle non-libsodium (`tools/dr-oracle`, job
CI `dr-oracle`), tapi sender-key chain/skipped key/`SessionRecord` libsignal
tidak — itu tetap internal (`spqrRatchet.test.ts` + crate SPQR); **WS-E gate (1)
✅ (2026-10-15)**: `web/e2e/call.spec.ts` dijalankan Chrome penuh terhadap
coturn nyata (kredensial `/api/keys/turn` → dua peer `iceTransportPolicy:'relay'`
terhubung, pasangan terpilih `relay`↔`relay`), dan job CI `e2e-chrome` kini
memasang + menjalankan coturn sendiri sehingga gate itu bukan klaim.

Masih terbuka: pengukuran
false-positive NAT/ASN di lapangan, attestation WebAuthn perangkat keras
sungguhan, dan kedua gate CI auditor (`cmd/generate-auditing-test-vectors`,
`cmd/kt-client`) yang binari upstream-nya tidak di-vendor.

Residual jujur:

- Jalur WT nyata (E2E `transport.spec.ts`) **sudah** dijalankan (2026-10-15) dengan
  `--project=chrome` terhadap sidecar WebTransport sungguhan — dan benar begitu:
  headless Chromium di mesin ini tidak punya WebTransport, jadi selama spec itu
  hanya auto-skip, dua bug di dalamnya (assertion tombstone yang tidak pernah
  cocok, locator `getByText` yang juga mengenai preview sidebar sehingga aksi
  menggantung) tidak pernah terlihat. Sesi QUIC jarak jauh (WAN, handshake
  lintas jaringan) tetap tidak diuji di sini.
- `associatedData` Argon2 tidak tersedia di `hash-wasm`. Kalau nanti ada fitur klien
  yang butuh AD, itu berarti implementasi baru — bukan sekadar menyalakan opsi.
- Item 2 hanya menutup TOFU lokal; deteksi serangan tetap butuh KT (§5.1).

### Menengah (1–8 minggu)
8. **KT lite** (§5.1 tahap A) — log identitas lokal + gossip observasi; ini
   menutup "deteksi serangan" tanpa infra baru.
9. **Backup terenkripsi ber-frame** (§5.3) + simpan opsional di R2.
10. **Observability tanpa telemetry + load test k6** (`docs/27` §27.7) supaya
    perubahan besar di atas punya gerbang objektif.
11. **Call privacy**: coturn sendiri + signaling berbasis delivery token.

### Proyek besar (persetujuan eksplisit, ada dokumen desain sendiri)
12. **KT penuh** (§5.1 tahap B) — reuse `key-transparency-server` + klien
    `keytrans` (AGPL, kompatibel) atau implementasi TS dari `verify.rs`.
13. **Multi-device** (§5.2) — prasyarat untuk banyak hal lain, termasuk restore.
14. **SPQR-style PQ ratchet** (§5.4) — jalur versi paralel, target: PQ FS+PCS
    yang terverifikasi formal; ini pembeda terbesar yang tersisa.
15. **MLS saat PQ suite matang** (2027+, sudah tercatat di `docs/26.8.2`).
16. **Klien native** (minimal wrapper push/background untuk iOS/Android) —
    tanpa ini, "messenger" NYX selalu kalah pada reliabilitas notifikasi.

---

## 9. Non-goals (tetap dipertahankan)

Sesuai `docs/26.3`/`docs/27.8`, dan analisis ini tidak mengubahnya: onion
routing/mixnet, MLS sebelum PQ suite RFC, SFU multi-party, ZKGroup penuh
(pairing) — versi blind-RSA sudah cukup dan lebih standar. Yang **berubah**
adalah status "ZKGroup tidak dibangun": versi RFC 9474 sudah ada di repo, jadi
yang kurang hanyalah binding + gating (§7.1), bukan kemampuan baru.

---

## 10. Batasan analisis ini

- **Statis.** Tidak ada E2E/runtime yang dijalankan (Redis/Postgres/sidecar
  tidak diboot); klaim server di §7 berasal dari membaca route + lib, bukan dari
  eksploitasi nyata. Klaim exploitability credential bergantung pada kerahasiaan
  `conversationId` — perlu satu eksperimen lokal untuk memastikan dampak penuh.
- **Signal dibaca selektif**, bukan seluruh ~1.5GB: README, struktur direktori,
  daftar modul/crate, dan controller/store tertentu. Klaim "Signal punya X"
  merujuk keberadaan modul/kode, bukan berarti fitur aktif di semua klien.
- **Tidak ada review lisensi formal.** Semua repo Signal yang ada di `~/signal`
  berlisensi AGPL-3.0(-only), sama dengan NYX — jadi adopsi kode *mungkin*
  legal, tapi tetap butuh keputusan maintainer (atribusi, NOTICE, kompatibilitas
  "or-later" vs "only").
- **Tidak ada benchmark kinerja.** Rekomendasi CPU/RAM (mis. KT, SPQR) belum
  diukur terhadap VPS 4c/8GB.
