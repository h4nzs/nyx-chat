# 35 — Rencana Migrasi Post-Quantum (Tier A)

> **Status (2026-10-23): cutover PQ-only selesai di kode — belum commit/deploy.**
> Fase 0–8 selesai di kode (Fase 4 kecuali PIR; Fase 7 = log KT ML-DSA +
> dual-write, **belum cutover baca**). Fase 8 mendaratkan KAT resmi **ML-DSA-65
> ACVP** + **X-Wing draft-06**, KAT lintas-implementasi X3DH v2/group v4/KT v2,
> `bench:pq`, audit residual v1, dan E2E recovery/device-linking/OHTTP.
>
> **Cutover PQ-only 2026-10-23:** Fase 5 (credential suite) dan Fase 6 (anonymous
> issuance) **dihapus dari kode** karena suite credential PQ belum lolos gate;
> grup memakai delivery token. Jalur v1 (X3DH, `crypto_box_seal`, recovery
> Ed25519, migrasi QR v1) juga dihapus, jadi **arsip v1 lama tidak dapat
> didekripsi oleh build ini** — ini break kompatibilitas yang disengaja, bukan
> klaim bahwa v1 masih terbaca. Denylist Tier A baru = 0; tersisa **2 berkas
> `hybrid-v2-identity`** (`scripts/pq-only-exceptions.json`): X25519 identity
> yang terikat di transkrip X3DH v2 dan `signingKey` Ed25519 non-nullable yang
> tidak lagi ditandatangani. Gerbang `VITE_PQ_V2`/`VITE_ANON_CREDENTIALS`
> **diabaikan/dihapus**; PQ selalu aktif. **Belum di-deploy.**
>
> Format di §35.6 adalah desain historis; bagian credential (§35.2.3, §35.6.6,
> §35.6.7) **tidak lagi menggambarkan kode**. Sisa Fase 8 adalah residual
> non-kode: benchmark perangkat rendah/baterai, review kriptografi eksternal,
> KT v2 read cutover, dan keputusan BRaccoon/blind UOV bila credential PQ
> dihidupkan lagi. Tiga alur browser pelengkap (recovery, device-linking,
> OHTTP) punya spec Playwright; spec credential ikut dihapus.
>
> Dokumen terkait: `docs/03`, `docs/04`, `docs/26`, `docs/28`, `docs/33`,
> `docs/34`.

## 35.0 Status per fase

| Fase | Isi | Status | Bukti |
|---|---|---|---|
| 0 | Fondasi: dependency, `cryptoSuite` + domain, capability `pq-v2`, schema aditif, guard PQ-only | **landed** 2026-10-19 | §35.7 Fase 0, `scripts/check-pq-only.mjs` (CI job `lint`) |
| 1 | Core PQ: ML-DSA-65, bundle v2, X3DH v2, sealed box v2, grup v4, burner, recovery/linking/migration/push v2 | **landed** 2026-10-20 | §35.7 Fase 1, `web/e2e/pqV2.spec.ts` |
| 2 | KT Scope A: nilai log v2, verifikasi tiga kunci, pin config TOFU | **landed** (inti) | §35.7 Fase 2 |
| 3 | Metadata (OHTTP, cover traffic 1:1) | **landed di kode** 2026-10-21 — OHTTP dipakai jalur pencarian lewat token scoped, rotasi 2 slot, metrik; λ adaptif + budget, jitter/batching, chaff visibility-aware. Default mati, belum di-deploy | §35.7 Fase 3 |
| 4 | Discovery (tutup R5, OHTTP search, PIR spike) | **landed kecuali PIR** 2026-10-21 — R5 penuh (shareId terpisah dari blind index), search lewat OHTTP + padded query, rate limit per akun/IP, baca bundle tanpa mengonsumsi OTPK. PIR **ditunda** dengan kriteria go (§35.11 #3) | §35.7 Fase 4 |
| 5 | Credential PQ (suite abstraction, BRaccoon) | **dihapus 2026-10-23** — cutover PQ-only menghapus suite credential blind RSA, endpoint, persist Dexie, dan tesnya. Tidak ada pengganti PQ; BRaccoon/blind UOV tetap riset | §35.2.3, §35.6.6 |
| 6 | Anonymous issuance | **dihapus 2026-10-23** — bank token/redeem/commit ikut dihapus bersama credential; tidak ada endpoint `/api/credentials/*` | §35.6.7 |
| 7 | KT Scope B (log crypto PQ) | **landed di kode** 2026-10-21 — fork `tree/transparency` + ABI WASM v2 (ML-DSA-65, SHA-256 index), service/DB/port/systemd/metrik/snapshot v2, auditor v2, dual-write server + pemilihan ABI klien. Belum di-deploy | §35.7 Fase 7 |
| 8 | Removal, audit, dokumentasi | **selesai di kode** 2026-10-23 — KAT resmi ML-DSA ACVP + X-Wing draft-06, X3DH v2 oracle, `bench:pq` desktop + throttle, audit residual v1, E2E recovery/device-linking/OHTTP; denylist baru 0, sisa 2 exception `hybrid-v2-identity` | §35.8, §35.10 |

**PQ-only:** `resolvePqV2Enabled()` selalu `true`; `VITE_PQ_V2` tidak lagi
mengubah perilaku dan `VITE_ANON_CREDENTIALS` sudah tidak dipakai. Tidak ada
fallback v1 untuk handshake/pesan baru. **Data v1 lama tidak punya pembaca di
build ini**; jangan deploy ke instalasi yang masih membutuhkan arsip v1.

## 35.1 Tujuan dan definisi selesai

Tujuan: menghilangkan **classical-only cryptography** dari kriptografi aplikasi
NYX (Tier A), tanpa memutus kompatibilitas pesan/sesi lama.

Definisi selesai untuk Tier A:

1. Tidak ada panggilan classical-only di jalur aplikasi:
   - `crypto_scalarmult` / X25519 DH standalone,
   - `crypto_box_seal` untuk data aplikasi,
   - `crypto_sign_ed25519_*` untuk identity, prekey, group, recovery,
   - RSA blind signature untuk credential,
   - ECVRF/Ed25519 untuk autentikasi log KT.
2. X25519 hanya boleh muncul **di dalam X-Wing** sebagai hedge. X-Wing tetap
   dipakai sesuai keputusan pemilik proyek.
3. Semua format baru punya versi, capability, kill switch, dan jalur baca v1.
4. Klaim “post-quantum” hanya dipakai untuk jalur yang benar-benar sudah v2.
   KT v1 dan platform Tier B tidak diklaim PQ sampai diganti.

Target ini **bukan** “nol kurva eliptik”. X-Wing mengandung X25519, dan Tier B
(TLS/QUIC, WebRTC DTLS-SRTP, WebAuthn, Web Push VAPID, sertifikat WebTransport)
masih memakai primitif classical atau hybrid pada 2026. Tier B didokumentasikan
sebagai exception, bukan diabaikan.

## 35.2 Ringkasan analisis codebase

### 35.2.1 Peta kriptografi

| Lapisan | Primitif saat ini | Berkas utama |
|---|---|---|
| Device identity + vault | Argon2id, X25519, X-Wing, Ed25519, BLAKE2b | `web/src/workers/crypto.worker.ts` |
| At-rest sealing | XChaCha20-Poly1305, prefix `ENC1:` | `web/src/lib/keychainDb.ts`, `keyStorage.ts` |
| Pairwise handshake | X3DH X25519 + X-Wing + Ed25519 | worker `x3dh_*`, `web/src/utils/crypto.ts` |
| Ratchet v1 | Double Ratchet X25519 + X-Wing | worker `dr_*` |
| Ratchet v2 | braid SPQR (ML-KEM) | `web/src/lib/spqr*.ts`, `packages/spqr-wasm` |
| Group | Sender Key + Ed25519 signature | worker `group_*` |
| Key delivery | `pq_box_seal` = X25519 + X-Wing | `web/src/utils/crypto.ts` |
| Burner | v1: X25519 + X-Wing; v2: X-Wing saja (`pqOnly`) | worker `burner_dr_*`, `web/src/store/burner.ts` |
| Credential | blind RSA 2048 | `server/src/lib/groupCredentials.ts` |
| Key Transparency | Ed25519 tree head + ECVRF-Ed25519 | `server/kt-query`, `vendor/signal/libsignal-keytrans` |

Temuan penting: jalur yang disebut “PQ” saat ini hampir selalu **hybrid**.
X3DH, `pq_box_seal`, group signature, burner, recovery, dan KT semuanya masih
memiliki komponen classical-only. SPQR v2 adalah pengecualian: runtime
dependency-nya hanya ML-KEM/HKDF/SHA2, sehingga ratchet v2 sendiri sudah PQ.
Akar sesi SPQR berasal dari X3DH; karena itu X3DH v2 adalah prasyarat.

> **Catatan (2026-10-20):** tabel dan temuan di §35.2 adalah **baseline audit
> sebelum Fase 1** dan dipertahankan sebagai rekam jejak. Jalur yang kini punya
> v2 (ML-DSA untuk tanda tangan, X3DH/sealed box/burner tanpa DH klasik, grup
> v4, KT value v2) dijelaskan di §35.6 dengan status per langkah di §35.7;
> sisanya masih seperti tabel ini.

### 35.2.2 Inventaris classical-only (non-test)

| Berkas | Lokasi | Pemakaian |
|---|---|---|
| `web/src/workers/crypto.worker.ts` | 865, 937 | `pq_box_seal` memakai X25519 ephemeral |
| `web/src/workers/crypto.worker.ts` | 981 | konversi Ed25519 secret → X25519 untuk DH1 |
| `web/src/workers/crypto.worker.ts` | 988-990, 1012 | X3DH DH1–DH3 initiator |
| `web/src/workers/crypto.worker.ts` | 1060, 1068-1070, 1086 | konversi Ed25519 public + X3DH recipient |
| `web/src/workers/crypto.worker.ts` | 1697-1715 | regenerasi X3DH recipient |
| `web/src/workers/crypto.worker.ts` | 2369, 2418 | burner X25519 scalarmult (jalur v1; v2 `pqOnly` melewatinya) |
| `web/src/workers/crypto.worker.ts` | 965, 976, 1336, 2212, 2244, 2327 | verifikasi/sign Ed25519 |
| `web/src/store/auth.ts` | 84-85, 540, 562, 948, 963 | prekey signature + X25519 keygen |
| `web/src/utils/crypto.ts` | 213, 269 | group metadata Ed25519 (jalur v1; v4 ML-DSA saat gerbang aktif) |
| `web/src/pages/MigrationSendPage.tsx` | 140 | `crypto_box_seal` hanya untuk QR lama; `sealForDevice` (hybrid v1 / X-Wing v2) |
| `web/src/pages/MigrationReceivePage.tsx` | 103 | `crypto_box_seal_open` untuk QR lama; `openSealedForDevice` mendeteksi magic v2 |
| `web/src/store/message.ts` | 1015, 1136 | `crypto_box_seal` untuk device tanpa `pqPublicKey`; `sealForDevice` saat v2 aktif |
| `server/src/routes/auth.ts` | 939 | verifikasi recovery Ed25519 (v1); ML-DSA-65 (`PQ_V2_DOMAINS.RECOVERY`) bila `signatureV2` |
| `server/src/lib/groupCredentials.ts` | seluruh suite | RSA-PSS blind signature |
| `server/kt-query` + `vendor/signal/libsignal-keytrans` | tree head/VRF | Ed25519 + ECVRF-Edwards25519 |

Tier B yang tidak masuk target migrasi ini: VAPID P-256, WebAuthn P-256/Ed25519,
TLS/QUIC ECDHE/ECDSA, WebRTC DTLS-SRTP, dan sertifikat self-signed WebTransport.

Catatan (2026-10-20): daftar di atas adalah **baseline audit sebelum Fase 1**.
Sisa pemakaian classical-only yang masih disengaja sekarang dijaga
`scripts/check-pq-only.mjs` terhadap `scripts/pq-only-baseline.json` (step CI
`PQ-only guard` di job `lint`), sehingga call classical-only baru menggagalkan
gate alih-alih menumpang di daftar ini.

### 35.2.3 Credentials (dihapus 2026-10-23 — historis)

> **Tidak ada lagi di kode.** Seluruh suite credential (blind RSA, endpoint,
> persist Dexie, tes) dihapus pada cutover PQ-only. Bagian di bawah adalah
> catatan desain/baseline lama, bukan status implementasi.

- Suite: `RSABSSA-SHA384-PSS-Randomized` (RFC 9474), modulus 2048.
- Message: `nyx-grp-cred:v1:<conversationId>:<32 hex random>`.
- Serial: `SHA-384(preparedMessage)` → 96 hex.
- Server hanya menyimpan public JWK + serial; private issuer key dari
  `GROUP_ISSUER_KEY_PKCS8` atau file dev `.nyx-issuer-key`.
- Endpoint (`server/src/routes/conversations.ts:57-201`):
  - `GET /credential-issuer-key`
  - `POST /credential-issuance` (quota 3/hari)
  - `POST /credential-commit`
  - `POST /:id/credential-revoke`
  - `GET /sync` (presentation header `X-Group-Credentials`)
- Masalah:
  - issuance/commit masih `requireAuth`, quota per `identityTag(userId)` →
    server melihat `user ↔ conversation`.
  - `credCache` in-memory; commit fire-and-forget; serial tidak dipersist.
  - revoke tidak dipanggil client dan tidak mengecek admin capability.
  - blind RSA memberi unlinkability, tetapi bukan PQ unforgeability.

### 35.2.4 Discovery dan metadata

- `GET /api/users/search` memakai
  `identifierLookupCandidates(q) = [HMAC(pepper,q), q]`
  (`server/src/utils/atRestSecrets.ts`). Kandidat kedua adalah residual R5:
  pemegang dump DB bisa mengirim nilai mentah ke API hidup.
- `GET /api/keys/prekey-bundle/:userId` memakai userId langsung; server melihat
  requester → target.
- OHTTP **sudah dipakai alur aplikasi** untuk `GET /api/users/search` bila
  diaktifkan (token scoped 120 s dengan mode `on`/`off`; §35.7 Fase 3).
  Default mati di kedua sisi. PIR sengaja ditunda (§35.11 #3).
- Cover traffic (`web/src/lib/coverTraffic.ts`):
  - λ = 0.5 pesan cover/menit/conversation,
  - grup opt-in, burner, dan **1:1 opt-in setelah ada pesan nyata**
    (`coverTargetAllowed` — cover tidak boleh memulai sesi baru),
  - tidak menunda real send,
  - payload `COVER` di-drop setelah dekripsi,
  - estimasi ~5,6 MB/hari/conversation.
- Chaff WT: 1000 byte setiap ~3 detik; WSS memetakan `CHAFF` ke noop.
- Ephemeral receipts + jitter sudah ada (`RECEIPT_JITTER_MAX_MS = 45_000`).

### 35.2.5 Key Transparency

- Nilai log v1 = 1286 byte:
  `version(1) | keyVersion(1) | X25519 identity(32) | X-Wing(1216) | Ed25519 signing(32) | updatedAtDay(4)`.
- Search key: `0x75 || usernameHash(32)`.
- Autentikasi log: Ed25519 tree-head signature + ECVRF-Edwards25519.
- Client mengambil `/api/keys/kt/config` dari server yang sama tanpa pinning
  (`web/src/lib/ktBundleProof.ts:313`). Server jahat dapat mengganti config dan
  memalsukan seluruh log.
- Verifikasi bundle saat ini hanya membandingkan X25519 `identityKey`
  (`ktBundleProof.ts:520-546`), bukan X-Wing identity atau signing key.
- Go query service memperlakukan value sebagai opaque (`write.go`), sehingga
  value v2 bisa lewat tanpa mengubah tree.
- Scope A: value/verification v2, log crypto v1 tetap. Scope B: log crypto PQ,
  service terpisah.

### 35.2.6 Dependency dan ukuran

- ~~Belum ada ML-DSA di repo.~~ **Sudah ada (2026-10-19):** `packages/shared/src/mlDsa.ts`
  (ML-DSA-65 di atas `@noble/post-quantum`, domain separation lewat ML-DSA
  `context` = `PQ_V2_DOMAINS`), dipakai worker, web, dan server
  (`server/src/utils/mlDsa.ts`).
- `@noble/post-quantum@0.7.1` tersedia (MIT, pure JS) dan mendukung
  `ml_dsa44`, `ml_dsa65`, `ml_dsa87`.
- ML-DSA-65: public key 1952 B, secret key 4032 B, signature 3309 B.
- X-Wing: public key 1216 B, ciphertext 1120 B.
- Konsekuensi: prekey bundle, handshake, group wrapper, state, dan KT value
  membesar. Semua schema/JSON/IndexedDB yang menyimpan key atau signature harus
  diperiksa.

## 35.3 Keputusan arsitektur

1. **Scope Tier A saja.** Kriptografi aplikasi NYX harus PQ; platform Tier B
   tetap hybrid atau documented exception.
2. **X-Wing dipertahankan.** Target adalah “tidak ada classical-only”, bukan
   “nol elliptic curve”. X25519 hanya boleh berada di dalam X-Wing.
3. **ML-DSA-65** untuk signature aplikasi (device, prekey, group, recovery,
   KT tree head, auditor).
4. **Format baru selalu versioned.** v1 tetap bisa dibaca; v2 hanya dikirim
   setelah peer membuktikan dukungan.
5. **Capability `pq-v2`** menjadi gerbang negosiasi. Tidak ada downgrade diam-diam
   untuk pesan yang sudah v2.
6. **KT dua tahap.** Scope A segera; Scope B sebagai service terpisah. Jangan
   mem-patch `vendor/signal/libsignal-keytrans`; fork hanya untuk service v2.
7. **Credential dua tahap.** Refactor suite + reliability dulu; BRaccoon adalah
   research spike dengan go/no-go, bukan dependency produksi langsung.
8. **Metadata:** OHTTP + cover traffic. Mixnet tidak masuk rencana saat ini.
9. **Discovery:** perbaiki R5 dan OHTTP dulu; PIR adalah spike terpisah.

### 35.3.1 Pilihan ML-DSA

Rekomendasi awal: `@noble/post-quantum@0.7.1` di web worker dan server.

Alasan:
- pure JS, tidak menambah aset WASM baru ke worker,
- API ML-DSA-65 tersedia,
- mudah dipakai di browser dan Node,
- test vector FIPS 204 bisa dijalankan di unit test.

Risiko:
- implementasi JS belum tentu constant-time; signing dilakukan di worker,
  verifikasi menerima input publik.
- performa harus diukur ulang di perangkat rendah, bukan hanya angka README.

Alternatif: `@oqs/liboqs-js@0.15.1` (WASM). Dipakai hanya jika benchmark noble
gagal memenuhi budget atau jika dibutuhkan test oracle independen.

## 35.4 Prinsip migration dan kompatibilitas

- **v1 read-only.** Format v1 tidak diubah:
  - `ENC1:`, XChaCha envelope `base64url(nonce(24)||ct)`,
  - `ENCRYPT_DATA` number arrays,
  - handshake magic/version 1 dan ukuran X-Wing 1120,
  - DR v1 header `{kemPk, ct, n, pn}`,
  - SPQR v2 `{v:2,b:[frames]}` dan `ackV:2` di sealed payload,
  - 8 KB padding + marker `0x80`,
  - group envelope v2 77 byte,
  - `kdfChain` info `0x01`/`0x02`.
- **v2 hanya setelah capability + ack.** Untuk pesan, v2 dikirim hanya jika
  peer sudah membuktikan bisa membaca v2 (pola yang sudah dipakai SPQR).
- **Kill switch** menghentikan pengiriman/advertising v2, tetapi tidak pernah
  menghentikan pembacaan v2.
- **Tidak ada silent downgrade** setelah sesi v2 aktif. Jika peer kehilangan
  capability, sesi tetap v2 sampai ada rollback eksplisit.
- **Semua key generation deterministik dari `masterSeed`** dengan label domain
  baru, supaya existing user bisa mendapat key v2 saat unlock tanpa reset
  password.
- **Domain separation** wajib untuk setiap signature/format baru:
  `NYX-PQ-BUNDLE-V2`, `NYX-PQ-HANDSHAKE-V2`, `NYX-PQ-SEAL-V2`,
  `NYX-PQ-GROUP-V4`, `NYX-KT-VALUE-V2`, `NYX-CRED-V2`.

## 35.5 Perubahan schema (sudah diterapkan)

Kolom di bawah sudah ada di `server/prisma/schema.prisma` dan semuanya
nullable/aditif — **tetapi baru ada di DB setelah `prisma db push` berjalan saat
deploy.** Deploy memakai `prisma db push || true`; kegagalan push tidak boleh
dianggap sukses, jadi verifikasi manual tetap wajib.

```prisma
model Device {
  // existing...
  signingKeyV2   Bytes?
  cryptoVersion  Int    @default(1)
}

model PreKeyBundle {
  // existing...
  signatureV2    Bytes?
  cryptoVersion  Int    @default(1)
}

model CredentialIssuerKey {
  // existing...
  suite          String?
}

model GroupCredential {
  // existing...
  suite          String?
}
```

Catatan:
- `Device.pqPublicKey` (X-Wing identity), `PreKeyBundle.pqIdentityKey`
  (X-Wing identity), `PreKeyBundle.pqKey` (X-Wing signed prekey), dan
  `OneTimePreKey.pqPublicKey` (X-Wing OTPK) dipakai ulang untuk v2.
- `Device.signingKeyV2` = ML-DSA public key.
- `PreKeyBundle.signatureV2` = ML-DSA signature atas bundle v2.
- Tidak perlu kolom X25519 baru; v1 tetap menyimpan field lama.

## 35.6 Format v2 (diimplementasikan)

> Bagian ini **sudah diimplementasikan** (2026-10-20). Sejak cutover PQ-only
> 2026-10-23 gerbang `VITE_PQ_V2` dihapus; yang tertulis di bawah adalah bentuk
> yang benar-benar ada di kode — koreksi terhadap proposal awal ditandai
> “koreksi”. Format v1 di §35.4 tetap beku, tetapi build ini tidak lagi membacanya.

### 35.6.1 Bundle v2

```text
version            = 2                 (kolom DB `cryptoVersion`)
identityKey        = X25519 (32 B)      (dipakai ulang dari v1)
pqIdentityKey      = X-Wing (1216 B)    (dipakai ulang dari v1)
signedPreKey       = X25519 (32 B)
pqSignedPreKey     = X-Wing (1216 B)
signingKeyV2       = Device.signingKeyV2 (ML-DSA-65, 1952 B)
signature          = ML-DSA-65(
                       context "NYX-PQ-BUNDLE-V2",
                       u32len(identityKey) || u32len(pqIdentityKey) ||
                       u32len(signedPreKey) || u32len(pqSignedPreKey) ||
                       u32len(signingKeyV2)
                     ) (3309 B)
```

Koreksi terhadap proposal awal: **tidak ada `deviceId`** di pesan tanda tangan,
**OTPK tidak ikut ditandatangani** (bundle menandatangani material prekey saja),
dan domain separation memakai ML-DSA `context`, bukan prefix byte. Setiap field
diawali panjang `u32` BE (`packages/shared/src/pqBundle.ts`) agar urutan/encode
klien dan server identik.

Initiator memverifikasi `signature` sebelum memakai bundle. Bundle v2 tidak
memakai X25519 identity atau Ed25519 signature. Server memverifikasi tanda tangan
ini di `POST /api/keys/prekey-bundle` **sebelum menyentuh DB**; kehadiran salah
satu field v2 tanpa pasangannya ditolak `400`.

### 35.6.2 X3DH v2 (KEM-X3DH)

Tujuan: menghapus DH1–DH4 dan konversi Ed25519→X25519. Semua kerahasiaan berasal
dari X-Wing; autentikasi initiator memakai ML-DSA.

```text
magic            = 0x4E ('N', sama dengan v1)
version          = 0x02
flags            = bit 0: OTPK present
pad              = 0x00
ctIdentity       = X-Wing encapsulation ke recipient identity (1120 B)
ctSignedPreKey   = X-Wing encapsulation ke recipient signed prekey (1120 B)
ctOneTimePreKey  = optional X-Wing encapsulation ke OTPK (1120 B)
signature        = ML-DSA-65(
                     context "NYX-PQ-HANDSHAKE-V2",
                     u32len(initiatorSigningKeyV2 1952) ||
                     u32len(responderIdentityKey 32) ||
                     u32len(ctIdentity) || u32len(ctSignedPreKey) ||
                     u32len(ctOneTimePreKey)   // 0 byte bila absen
                   ) (3309 B)
```

Total wire: **5553 B tanpa OTPK, 6673 B dengan OTPK**. Koreksi terhadap proposal
awal: public key ML-DSA inisiator **tidak** dibawa di wire handshake — ia
dikirim di payload ter-seal (`handshakeVersion: 2`, `initiatorSigningKeyV2`) dan
wajib sama dengan `signingKeyV2` bundle peer.

Alur:
1. Initiator memverifikasi signature signed prekey recipient.
2. Initiator melakukan X-Wing encaps ke identity, signed prekey, dan OTPK (jika ada).
3. Initiator menandatangani transcript dengan ML-DSA.
4. Recipient melakukan X-Wing decaps, memverifikasi signature initiator dengan
   `signingKeyV2` yang diterima dari payload ter-seal — dan klien **mewajibkan**
   nilai itu sama dengan `signingKeyV2` bundle peer — lalu menurunkan session key.
5. Session key = `BLAKE2b-256(ssIdentity || ssSignedPreKey [|| ssOneTimePreKey])`
   — **tanpa** hash transkrip; transkrip hanya ditandatangani/diverifikasi.

Catatan desain:
- Tidak ada ephemeral X25519 terpisah; X-Wing ciphertext sudah membawa material
  ephemeral di dalamnya. Transkrip mengikat `signingKeyV2` inisiator, identitas
  X25519 penerima, dan semua ciphertext (OTPK diwakili field panjang 0 bila
  absen).
- Kunci verifikasi inisiator harus diikat ke identitas yang dipercaya: klien
  membandingkannya dengan bundle peer yang sudah dicek ke KT, di dua jalur
  (`messagePipeline` dan offline sync `session:new_key`). Tanpa pengikatan itu,
  siapa pun bisa meng-encapsulate dan mengaku sebagai pengirim.
- Format ini belum menggantikan analisis formal X3DH; review kriptografi
  eksternal wajib sebelum produksi.

### 35.6.3 Sealed box v2

```text
magic      = "NYS2" (4 B, 0x4E595332)
ct         = X-Wing ciphertext (1120 B)
nonce      = 24 B
ciphertext = XChaCha20-Poly1305(
               key = BLAKE2b-256(ss),   // koreksi: tanpa prefix domain
               nonce,
               plaintext
             )
```

Envelope: `[magic 4][ct 1120][nonce 24][ciphertext]`, minimum **1164 B**.

Koreksi terhadap proposal awal: envelope memakai magic ASCII `"NYS2"`, bukan
byte versi `0x02`, karena v1 dibungkus sebagai
`[ephemeral X25519 32][ct 1120][nonce 24][ct]` sehingga byte pertama bukan
penanda versi. Peluang kunci ephemeral v1 kebetulan berawalan magic adalah
2^-32; `isPqSealV2` tetap memeriksa panjang minimum sebelum memilih jalur v2.

Dipakai untuk:
- distribusi group sender key,
- session-key delivery,
- push payload,
- admin capability token,
- migration vault key,
- pairwise key delivery.

### 35.6.4 Group v4

- Group metadata v4 menyimpan untuk setiap anggota:
  - pseudonym,
  - `signingKeyV2` (ML-DSA public key),
  - key ID / generation.
- Group message wrapper v4:
  - `sigV: 2` = ML-DSA-65 (context `"NYX-PQ-GROUP-V4"`) atas
    `u32(N) BE || nonce(24) || ciphertext`; `sigV: 1` tetap Ed25519.
  - `senderKeyId` untuk memilih public key anggota =
    `BLAKE2b-256("NYX-PQ-GROUP-V4" || signingKeyV2)[:8]` (base64url di wrapper).
- Distribution envelope v3/v4:
  - v3: `[0x03][chainId(8)][u32 iter][CK(32)][metadataKey(32)][senderKeyId(8)]` (85 byte),
  - v4: v3 + `signingKeyV2(1952)` (2037 byte) — kunci verifikasi pengirim ikut
    di dalam envelope yang sudah diseal per-device, sehingga penerima tidak perlu
    lookup bundle (penting saat pseudonym pengirim belum bisa di-resolve karena
    metadata grup belum ter-decrypt),
  - diseal dengan `pq_box_seal_v2`; v2 (77 byte) dan v3 tetap dibaca.
- v2/v3 lama tetap bisa dibaca; pengiriman grup baru memakai v4 setelah semua
  anggota yang relevan mendukung.

### 35.6.5 KT value v2 (Scope A)

```text
version       = 2
keyVersion    = 1 byte
identityKey   = X25519 (32 B)
pqIdentityKey = X-Wing (1216 B)
signingKey    = Ed25519 (32 B)              // tetap ada, v1 compatibility
signingKeyV2  = ML-DSA-65 public key (1952 B)
updatedAtDay  = u32 (4 B)
total         = 3238 B                      // v1 (1286 B) + 1952 B
```

- `searchKey` tetap `0x75 || usernameHash(32)`.
- Client v2 membandingkan **tiga** kunci ke bundle peer: X25519 `identityKey`,
  X-Wing `pqIdentityKey`, dan ML-DSA `signingKeyV2`; mismatch mana pun →
  verdict `mismatch` (fail-closed untuk pinning).
- `ktConfig` (Dexie v14) + `web/src/lib/ktConfigPin.ts` menyimpan
  `signatureKey`/`vrfKey`/`auditorKeys` pertama ter-seal `ENC1:` dan menolak
  perubahan (verdict `unverifiable`).
- `peerIdentityTrust` menyimpan digest semua key (mis. SHA-256 dari
  `identityKem || signingKeyV2`), bukan hanya X25519.
- `ktMonitoring` dan `ktGossip` mendapat `logVersion`/`logId` agar baris v1/v2
  tidak bertabrakan.
- `/api/keys/kt/config` harus dipin ke build/release manifest; config dari
  server tidak boleh dipercaya mentah-mentah.

### 35.6.6 Credential suite abstraction (Fase 5 — dihapus 2026-10-23)

> **Dihapus.** Interface/suite di bawah adalah desain historis. Cutover PQ-only
> menghapus blind RSA beserta client/server/persistensinya karena tidak ada suite
> PQ yang lolos gate; grup memakai delivery token. Jangan menganggap kode ini
> ada saat mengerjakan BRaccoon/blind UOV.

Interface yang dibutuhkan:

```ts
interface CredentialSuite {
  id: string;
  keyVersion: number;
  blind(publicKey: unknown, message: Uint8Array): Promise<Blinded>;
  blindSign(privateKey: unknown, blinded: Uint8Array): Promise<Uint8Array>;
  finalize(publicKey: unknown, message: Uint8Array, blindSig: Uint8Array, inv: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: unknown, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  serial(preparedMessage: Uint8Array): string;
}
```

- Suite v1 = RSA blind signature; tetap ada selama migrasi.
- Suite v2 = BRaccoon (pilot) atau blind UOV (fallback).
- API issuer key mengembalikan `suite`; client memilih suite yang didukung.
- Credential disimpan di IndexedDB (`ENC1:`), bukan hanya memory.
- Commit di-await; jika gagal, credential tidak di-cache.
- Revoke dipanggil saat kick/leave; serial dipersist.

Status (2026-10-21): suite mengalir dari issuer key → `worker_credential_blind`
(`suite`) → verifikasi server (`GroupCredential.suite`/`CredentialIssuerKey.suite`
diisi saat issuance; baris legacy nullable tetap v1/RSA). Credential dipersist
di Dexie **v15** (`groupCredentials`, blob `ENC1:`), jadi reload tidak memicu
issuance ulang: `ensureCredential` memuat baris tersimpan sebelum issuance,
commit **di-await** (gagal → credential tidak di-cache/dipersist dan
`ensureCredential` mengembalikan `null`), serial dihitung klien sebagai hex
SHA-384 dari prepared message dan divalidasi `/^[0-9a-f]{96}$/` sebelum commit.
Leave memanggil `revokeMyCredential` (best-effort, `X-Group-Token` bila ada)
sebelum `POST /leave`, lalu membuang baris lokal. Deviasi: revocation anggota
yang **di-kick belum mungkin** — server hanya menyimpan hash serial anonim yang
cuma diketahui pemiliknya; perlu distribusi serial antar-anggota di metadata
(belum ada). Suite v2 (BRaccoon/blind UOV) tetap riset: jangan implementasi
lattice sendiri sebelum test vector paper + benchmark + audit + dual verify.

### 35.6.7 Anonymous issuance (Fase 6 — dihapus 2026-10-23)

> **Dihapus.** Bank token, redeem tanpa JWT, dan commit ticket dihapus bersama
> fitur credential. Endpoint `/api/credentials/*` tidak ada lagi. Bagian di
> bawah adalah desain historis; residualnya tidak berlaku sampai credential PQ
> dihidupkan kembali.

Tujuan: issuance/commit credential tidak lagi menyimpan `user ↔ conversation`
di jalur baru. Dua bagian:

1. **Bank token (terautentikasi).** `POST /api/credentials/tokens` (butuh
   sesi + CSRF) menerbitkan batch token single-use `nct1_<43 base64url>`
   (32 byte acak). Server hanya menyimpan **SHA-256(token)** di Redis dengan
   TTL 24 jam, dan membatasi jumlah token per user per hari
   (`cred:tokens:<identityTag>:<hari>`, Lua INCR+EXPIRE). Token asli hanya
   dikembalikan sekali ke klien.
2. **Redeem (tanpa JWT).** `POST /api/credentials/issuance` menerima
   `{ token, conversationId, blindedMsg }` + **hanya** `X-Group-Token`
   (bukti grup-level; delivery token pseudonim stabil sengaja TIDAK diterima di
   jalur anonim). Token dikonsumsi atomik (Lua GET+DEL) setelah bukti
   keanggotaan lolos, jadi replay = 403 `CREDENTIAL_TOKEN_INVALID`.
   Respons menambah `commitTicket` (`cct1_<43>`, single-use, TTL 10 menit,
   terikat `conversationId`). `POST /api/credentials/commit` menukar ticket itu
   dengan baris `GroupCredential` — tanpa identitas pemanggil.

Residual yang harus jujur: **akuisisi batch tetap menghubungkan batch ↔ user**
(server tahu siapa membeli token, bukan siapa memakainya); satu token = satu
issuance sehingga kehilangan token = kuota terpakai; dan endpoint lama
`/api/conversations/credential-*` tetap ada untuk klien lama (kuota per user).
Rate limit per IP tetap berlaku pada jalur redeem; `requireAuth` tidak dipasang
di router ini dan CSRF dikecualikan karena tidak ada cookie/sesi yang bisa
dipalsukan (token bearer ada di body).

## 35.7 Fase implementasi

### Fase 0 — Fondasi

Tujuan: menyiapkan versi, dependency, schema, dan gate tanpa mengubah perilaku.

Pekerjaan:
- Tambah `@noble/post-quantum` exact version di `web` dan `server`.
- Buat `packages/shared/src/cryptoSuite.ts` (versi, suite ID, ukuran,
  domain separation).
- Tambah capability `pq-v2` di:
  - `packages/shared/src/transport.ts`,
  - `server/transport-sidecar/src/protocol.rs`,
  - client `advertisedCapabilities()`.
- Tambah kolom schema §35.5.
- Tambah `scripts/check-pq-only.mjs` + CI denylist.
- Tulis spec final `docs/35` (dokumen ini) dan test vector awal.

Acceptance:
- build/typecheck/lint tetap hijau,
- tidak ada perubahan wire,
- schema push terverifikasi,
- capability parity shared ↔ Rust ↔ client.

Status (2026-10-19; gerbang `VITE_PQ_V2` dihapus 2026-10-23): **selesai, belum di-deploy.** `@noble/post-quantum@0.7.1`
(pinned exact), `cryptoSuite.ts`, capability `pq-v2` (shared + Rust + client
lewat `advertisedPqCapabilities()`, dulu `VITE_PQ_V2=1`), kolom
schema aditif (`Device.signingKeyV2`/`cryptoVersion`,
`PreKeyBundle.signatureV2`/`cryptoVersion`, `GroupCredential.suite`,
`CredentialIssuerKey.suite`), dan `scripts/check-pq-only.mjs` +
`scripts/pq-only-baseline.json` + CI step `PQ-only guard` sudah ada. Belum ada
perubahan wire dan belum ada kode jalur v2. Tiga error oxlint yang sudah merah
di HEAD ikut diperbaiki agar gate tetap hijau.

### Fase 1 — Core PQ

Urutan:
1. ML-DSA keygen/sign/verify di worker + server.
2. Device key v2 deterministik dari `masterSeed`.
3. Upload bundle v2 (`auth.ts`, `keys.ts`).
4. X3DH v2 + test vector + oracle Go.
5. `pq_box_seal_v2` dan penggantian call site.
6. SPQR v2 memakai session key X3DH v2.
7. Group metadata v4 / wrapper v4 / distribution v3.
8. Burner v2.
9. Recovery v2, device linking v2, migration v2, push payload v2.

Berkas utama:
- `web/src/workers/crypto.worker.ts`
- `web/src/utils/crypto.ts`
- `web/src/store/auth.ts`
- `web/src/lib/keychainDb.ts`
- `web/src/lib/groupCredentials.ts` (nanti)
- `web/src/lib/peerIdentityTrust.ts`
- `web/src/pages/MigrationSendPage.tsx`, `MigrationReceivePage.tsx`
- `web/src/store/message.ts`
- `server/src/routes/auth.ts`, `keys.ts`
- `server/src/utils/keyTransparency.ts`
- `packages/shared/src/types.ts`, `transport.ts`
- `tools/dr-oracle`

Acceptance:
- dua klien v2 bisa handshake, kirim pesan 1:1, grup, burner,
- v1 tetap bisa dibaca,
- kill switch menghentikan v2 send/advertise,
- oracle Go menghasilkan session key yang sama,
- tidak ada classical-only call baru di jalur v2.

Status (2026-10-20; gerbang `VITE_PQ_V2` dihapus 2026-10-23): **seluruh langkah 1–9 selesai di kode**, termasuk residual cross-check `signingKeyV2` payload vs bundle, tanda tangan pesan + metadata grup v4, envelope distribusi grup v4 (kunci verifikasi ter-seal di dalam envelope), burner v2, recovery/device-linking/migration/push v2, test vector lintas-implementasi (oracle Go) untuk X3DH v2, dan audit persistensi/relay yang mengunci `signingKeyV2`/`senderKeyId` di state grup. Belum di-deploy; sejak PQ-only tidak ada fallback v1.
- Langkah 1–3 (ML-DSA, device key v2, bundle v2) selesai; lihat status Fase 0 dan catatan KT Scope A.
- Langkah 4 (X3DH v2) selesai untuk **jalur 1:1** — satu-satunya jalur yang memakai X3DH (grup memakai distribusi sender key, bukan handshake per-anggota):
  - `packages/shared/src/pqHandshake.ts` mendefinisikan wire v2 (`HANDSHAKE_V2_VERSION = 0x02`,
    `[magic][version][flags][pad][ctId][ctSpk][ctOtpk?][signature]`) dan pembangun transkrip
    tanda tangan yang mengikat identitas inisiator (signingKeyV2) + identitas X25519 penerima +
    semua ciphertext.
  - Worker op `x3dh_v2_initiator`/`x3dh_v2_recipient`/`x3dh_v2_recipient_regenerate`:
    `sessionKey = BLAKE2b-256(ss_id ‖ ss_spk [‖ ss_otpk])` dari **hanya** encapsulation X-Wing
    (tanpa `crypto_scalarmult`, tanpa konversi Ed25519→X25519). Inisiator menandatangani transkrip
    dengan ML-DSA (`PQ_V2_DOMAINS.HANDSHAKE`); penerima memverifikasi dengan `signingKeyV2`
    inisiator dari payload, **dan** `messagePipeline` menolak bila `signingKeyV2` payload ≠
    `signingKeyV2` bundle peer (yang sudah dicek terhadap KT).
  - Gerbang (historis; dihapus 2026-10-23): `resolvePqV2Enabled()` (`VITE_PQ_V2=1`) **dan** bundle peer memuat `signingKeyV2`.
    Dulu default OFF; sekarang PQ selalu aktif dan fallback v1 tidak ada.
  - Payload `x3dh` kini membawa opsional `handshakeVersion` + `initiatorSigningKeyV2`
    (`drProtocol.DrHandshakePayload`, `typeGuards.isX3dhHeader`, `messagePipeline`, kelompok state DR).
- Langkah 5 (sealed box v2) selesai:
  - `packages/shared/src/pqSeal.ts`: envelope murni X-Wing `[magic "NYS2" 4B][X-Wing ct 1120][nonce 24][ct]`
    dengan `serializePqSealV2`/`deserializePqSealV2`/`isPqSealV2` (magic 4 byte membedakan dari v1
    `[ephemeral X25519 32][ct 1120][nonce 24][ct]`; peluang salah deteksi 2^-32).
  - Worker op `pq_box_seal_v2`/`pq_box_seal_v2_open`: rahasia = X-Wing encapsulation saja
    (`derivedKey = BLAKE2b-256(ss)`), **tanpa** `crypto_scalarmult`.
  - `utils/crypto.ts` mendapat choke point `sealForDevice()`/`openSealedForDevice()`: menyegel
    memakai v2 bila `resolvePqV2Enabled()`, membuka mendeteksi versi dari magic (jadi pesan v1
    yang beredar tetap bisa dibuka). Semua call site lama `worker_pq_box_seal`/`worker_pq_box_seal_open`
    dialihkan: ratchet session-key, distribusi sender key grup, pembukaan distribusi, admin token
    (seal+open), fulfillment key, dan self round-trip.
  - Migrasi vault (`MigrationSend/ReceivePage`) ikut pindah: QR penerima kini membawa
    `pqPubKey` (X-Wing) bersama `pubKey`; pengirim menyegel lewat `sealForDevice` (v1 klasik
    untuk QR lama tanpa `pqPubKey`), penerima membuka lewat `openSealedForDevice` (deteksi magic).
  - Push payload menyusul di langkah 9: kini `store/message.ts` membaca `pqPublicKey` per device
    (fallback `user.pqPublicKey`) dan memakai `sealForDevice` saat gerbang v2 aktif; jalur
    `crypto_box_seal` hanya tersisa sebagai fallback perangkat tanpa kunci PQ. SW memang tidak
    mendekripsi payload, jadi tidak ada perubahan sisi baca.
- Langkah 7 (sebagian — tanda tangan pesan grup v4) selesai:
  - Worker op `group_ratchet_encrypt` menerima `signingV2PrivateKey` opsional dan menandatangani
    `dataToSign = u32(n) BE ‖ nonce(24) ‖ ct` dengan ML-DSA-65 (`PQ_V2_DOMAINS.GROUP`), mengembalikan
    `signatureVersion` (`2` = ML-DSA, `1` = Ed25519). `group_ratchet_decrypt`/`group_decrypt_skipped`
    menerima `signatureVersion` + `senderSigningKeyV2` dan memverifikasi dengan `mlDsaVerify` bila
    `signatureVersion === 2`, jika tidak jalur Ed25519 lama. Framing diverifikasi test
    `web/src/lib/__tests__/groupV4Signature.test.ts` (4 test, termasuk domain separation + tolak
    perubahan counter/ciphertext).
  - Distribusi kunci grup (envelope v2 77B) kini membawa `senderSigningKeyV2` di
    `sendGroupSenderKeyDistribution` → `sendGroupKeyDistributionPairwise` → `group:fulfilled_key` →
    `storeReceivedSessionKey` → `handleGroupKeyDistribution` (disimpan di `GroupReceiverState.signingKeyV2`
    bersama `signingKey`); `ReceiveKeyPayload`, `transportClient` (`emitGroupKeyDistribution`/
    `emitGroupKeyFulfillment`), `socketListeners` (`session:new_key`), `store/message.ts`, dan
    `messagePipeline.ts` semuanya meneruskan field itu. `GroupSenderState`/`GroupReceiverState`
    (`keychainDb.ts`) + `Participant` (`packages/shared/src/types.ts`, top-level/`user`/`devices[]`)
    mendapat `signingKeyV2`.
  - `doDecryptMessage`: wrapper pesan membawa `sigV`; bila `2`, verifikasi memakai
    `receiverState.signingKeyV2` → fallback bundle device (match `senderDeviceKey`) → participant/user;
    error `Missing sender signing key v2` bila tidak ada. Gerbang hanya untuk **kirim**: `encryptMessage`
    memakai `signingKeyV2` bila `resolvePqV2Enabled()`, jika tidak tetap Ed25519.
  - Metadata grup v4: `encryptGroupMetadata` menandatangani byte ciphertext XChaCha
    dengan ML-DSA-65 (`PQ_V2_DOMAINS.GROUP`) saat v2 aktif dan menulis `sigV: 2` di wrapper
    (default `1` = Ed25519); `decryptGroupMetadata` memilih jalur verifikasi dari `sigV`,
    memakai `GroupReceiverState.signingKeyV2` (yang diikat distribusi) ala v1 Ed25519.
    Wrapper pesan **dan** metadata v4 kini juga membawa `senderKeyId`
    (`BLAKE2b-256("NYX-PQ-GROUP-V4" || signingKeyV2)[:8]`, base64url) dan penerima membandingkannya
    dengan id turunan dari kunci verifikasi yang dipakai (`constantTimeEqual`, fail-closed).
  - Verifikasi: `pnpm --filter @nyx/shared run build`, `npx tsc -b --noEmit` (web) dan
    `npx tsc --noEmit` (server) bersih; vitest `groupV4Signature`/`groupEra`/`groupMetadata`/
    `groupPseudonyms` 38 lulus; `node scripts/check-pq-only.mjs` lulus tanpa perubahan baseline.
- Langkah 8 (burner v2) selesai:
  - `burner_dr_init_guest`/`burner_dr_init_host` menerima `pqOnly?: boolean`. Saat aktif, init
    **tidak** membuat keypair X25519 dan **tidak** memanggil `crypto_scalarmult`; root key =
    `generichash(64, X-Wing shared secret)`. Guest mengembalikan `guestClassicalPk: ''` dan host
    memakai `KEMr: null` (ratchet penuh pada pesan pertama). Jalur pembacaan v1 tidak berubah
    (hybrid `X25519 ‖ X-Wing`, `KEMr` = kunci klasik guest).
  - Ratchet lanjutan (`burner_dr_encrypt`/`burner_dr_decrypt`) memang sudah X-Wing saja, jadi
    tidak ada versi tambahan di state/header — hanya init yang berversi.
  - Link burner mendapat bagian ke-6 opsional: `…:<HostClassicalPublicKey>:<version>` dengan
    `2` = v2. Guest build lama hanya membaca 5 bagian pertama (`parts.length < 5` tetap valid),
    dan `hostClassicalPk` tetap dikirim di link agar fallback v1 mungkin.
  - Gerbang: `resolvePqV2Enabled()` di kedua sisi. Guest memakai v2 hanya bila link menandai `2`
    **dan** gerbang aktif; host menginisialisasi `pqOnly` hanya bila payload `burnerVersion === 2`
    **dan** gerbang aktif (payload tetap membawa `guestClassicalPk` kosong). Kill switch
    mengembalikan pengiriman ke v1, tetapi pesan v2 yang sudah terkirim tetap bisa dibaca selama
    state ratchet-nya ada.
  - Verifikasi: `npx tsc -b --noEmit` (web) bersih; vitest `burnerSession` (11, termasuk gerbang
    v2 + payload `burnerVersion`) dan `burnerV2RootKey` (2, kesamaan RK/CK guest-host PQ-only +
    bukti RK v2 ≠ RK hybrid v1) lulus; `node scripts/check-pq-only.mjs` lulus tanpa perubahan
    baseline (jalur v1 tetap memakai `crypto_scalarmult`).
- Langkah 9 (recovery/device-linking/migration/push v2) selesai:
  - **Recovery v2**: domain baru `PQ_V2_DOMAINS.RECOVERY`. Worker
    `recoverAccountWithSignature` menandatangani `messageString` yang identik dengan v1
    (`identifier:timestamp:nonce:newPassword:keys:pubEnc:pubPq:pubSign`) memakai ML-DSA-65,
    mengembalikan `signatureV2B64`; `Restore.tsx` mengirim `signatureV2`; server `/recover`
    memverifikasi terhadap `Device.signingKeyV2` (`verifyMlDsaSignature`, fail-closed) **atau**
    jalur Ed25519 lama — akun tanpa kunci v2 tetap bisa pulih.
  - **Device linking v2**: `DeviceLinkClaimInput` + `LinkDevicePage` meneruskan
    `signingKeyV2`; `/link/claim` memvalidasi panjang ML-DSA-65, menyimpannya di pending
    ter-seal (`PendingDeviceLink.signingKeyV2`, `parsePending`) dan meneruskannya di event
    `auth:linking_request`; `/link/approve` menulis `signingKeyV2` + `cryptoVersion: 2` pada
    `Device` baru dan menyertakannya di `publishIdentityKeyChange` (entri KT v2).
  - **Migration v2**: sudah selesai di langkah 5 (QR `pqPubKey` + `sealForDevice`), tanpa
    perubahan lanjutan.
  - **Push payload v2**: `store/message.ts` menambah `pqPublicKey` pada tipe device partisipan,
    mendekode kunci PQ, dan menyegel payload via `sealForDevice` hanya bila gerbang aktif dan
    kunci PQ tersedia; selain itu tetap `crypto_box_seal` (perilaku v1 identik). SW tidak
    mendekripsi payload, jadi tidak ada jalur baca yang perlu diubah.
  - Verifikasi: `npx tsc -b --noEmit` (web) dan `npx tsc --noEmit` (server) bersih;
    `deviceLinking` server 11 lulus (termasuk round-trip `signingKeyV2`);
    `mlDsa`/`keyBundle`/`ktIdentityLog` lulus; vitest `recoveryV2Signature` (4), `pqSeal`,
    `pqCapability`, dan seluruh `src/store/__tests__` (67) lulus;
    `node scripts/check-pq-only.mjs` lulus tanpa perubahan baseline.
- Envelope distribusi grup v3/v4 selesai (`packages/shared/src/groupEnvelope.ts`):
  - v2 beku tetap `[0x02][chainId(8)][u32 iter][CK(32)][metadataKey(32)]` = 77 byte;
    v3 = v2 + `senderKeyId(8)` = 85 byte, aktif saat pengirim punya `signingKeyV2`
    (`BLAKE2b-256("NYX-PQ-GROUP-V4" || signingKeyV2)[:8]`). `parseGroupEnvelope` menerima keduanya
    dan melempar untuk versi/panjang tak dikenal (dilaporkan sebagai legacy, bukan dibuang diam-diam).
  - **v4** (2026-10-20) = v3 + `signingKeyV2(1952)` = 2037 byte, dan `packGroupEnvelope`
    menolak `senderKeyId` yang tidak cocok dengan `signingKeyV2` (fail-closed). Ini
    perbaikan bug nyata: penerima grup yang metadata-nya belum ter-decrypt menyimpan
    pseudonym pengirim, sehingga `fetchPreKeyBundles` tidak menemukan bundle perangkat
    pengirim dan semua pesan/metadata `sigV:2` gagal ("Missing sender signing key v2").
    Dengan v4 kunci verifikasi ikut ter-seal per-device dan pengikatan ke receiver state
    tidak lagi bergantung pada lookup jaringan.
  - `sendGroupSenderKeyDistribution` memilih v4 (bila `signingKeyV2` ada) / v3 / v2;
    `handleGroupKeyDistribution` mengambil `signingKeyV2` dari envelope v4 (menolak bila
    event mengklaim kunci berbeda), lalu tetap memvalidasi `senderKeyId` terhadap kunci
    yang dipakai (`constantTimeEqual`) **sebelum** menyentuh state, dan menyimpannya di
    `GroupReceiverState.senderKeyId`/`signingKeyV2`. Metadata dan pesan grup juga membawa
    `senderKeyId` dan memverifikasinya saat `sigV === 2`.
  - Fallback `resolveDeviceSigningKeys` (match `senderDeviceKey` → bundle participant, cache
    10 menit) tetap ada untuk envelope v3 lama dan state penerima pra-fix.
  - Verifikasi: `groupEnvelopeV3` kini 8 test (termasuk round-trip v4, tolak panjang/id
    salah) lulus; regresi `groupMetadata`/`groupV4Signature` lulus; `tsc -b` web bersih;
    `node scripts/check-pq-only.mjs` lulus tanpa perubahan baseline.
- **Audit end-to-end 2026-10-20 — akar sebenarnya bug "Missing sender signing key v2"**:
  lapisan persistensi Dexie (`web/src/lib/keychainDb.ts`) menulis/membaca state dengan
  daftar field eksplisit (whitelist), dan `signingKeyV2`/`senderKeyId` tidak ada di daftar
  itu. Akibatnya kunci yang sudah terikat saat distribusi **hilang setiap kali state dibaca
  ulang** — metadata dan pesan `sigV:2` selalu gagal walau relay dan envelope sudah benar.
  - Ditambal di `save/getGroupReceiverState`, `archiveGroupReceiverState`,
    `listGroupReceiverStates` (`signingKeyV2` + `senderKeyId`) **dan** di
    `save/getGroupSenderState` (`signingKeyV2`; nilainya kunci publik, disimpan plaintext
    seperti `signingKey`).
  - Regresi dikunci oleh `web/src/lib/__tests__/keychainDbPersistence.test.ts` (6 test:
    round-trip receiver/sender, arsip era, `listGroupReceiverStates`) dan
    `server/tests/realtimeHandlers.test.ts` (25 test; `group:fulfilled_key` kini diuji
    membawa `senderSigningKey`/`senderSigningKeyV2` di relay live **dan** content SYSTEM).
  - `TransportEvents['session:new_key']` juga mendeklarasikan kedua field agar seam transport
    tidak bisa membuangnya tanpa error tipe.
  - Dua temuan terpisah dari audit yang sama sudah diperbaiki:
    - **Filter offline sync vs `deviceId` stale.** Envelope distribusi kini juga membawa
      `targetDeviceKey` (identity key X25519 perangkat target, stabil lintas re-register);
      `group:fulfilled_key` mempersist-nya sebagai `targetIdentityKey` (ikut ter-seal:
      `SYSTEM_DEVICE_FIELDS` di `server/src/utils/senderIdentity.ts`), dan
      `web/src/store/message.ts` menerima baris bila `targetDeviceKey ===
      localStorage.deviceId` **atau** identity key kita sama dengan `targetIdentityKey`
      maupun `targetDeviceKey`. Device yang di-reset tetap dapat catch-up.
    - **Metadata grup multi-era.** `decryptGroupMetadata` tidak lagi bergantung pada satu
      receiver state: ia mengumpulkan kandidat era (`findGroupReceiverState` untuk
      `chainId` di wrapper + semua `listGroupReceiverStates` milik `senderDeviceKey`),
      memverifikasi signature per kandidat (fail-closed: `senderKeyId` mismatch atau
      signature salah → kandidat dilewati) dan mencoba `xchacha_open` dengan `metadataKey`
      masing-masing, sehingga metadata era lama tetap terbaca setelah state aktif pindah era.
  - Verifikasi: `tsc` web+server bersih, `vitest groupMetadata/groupMetadataRotation/
    groupEra/keychainDbPersistence` (27 test) dan `realtimeHandlers` (25 test) lulus,
    oxlint 0 error, guard PQ-only lulus.
- Oracle Go X3DH v2 selesai (`tools/dr-oracle/main.go`): vektor `x3dhV2` berisi
  `x3dh-v2-plain` dan `x3dh-v2-with-otpk`. Oracle memakai `cloudflare/circl` `mldsa65`
  dengan context `NYX-PQ-HANDSHAKE-V2` (`SignTo` deterministik, tanpa libsodium), transkrip
  length-prefixed yang identik dengan `buildHandshakeV2Transcript`, dan
  `sessionKey = BLAKE2b-256(ss_id ‖ ss_spk [‖ ss_otpk])` tanpa DH klasik. `go run . -check`
  lulus (vektor deterministik); test TS `x3dhOracleVectors` 15/15 memverifikasi sessionKey NYX
  == oracle untuk kedua kasus serta menolak kunci verifikasi lain, ciphertext yang diubah, dan
  blob ber-OTPK tanpa kunci lokal; `x3dhOracleInterop` 4/4 tetap lulus.
  SPQR memakai akar X3DH v2 (langkah 6 — sudah otomatis karena `spqrAuthKey` = session key X3DH).
- Cross-check `signingKeyV2` payload terhadap bundle **selesai** (residual Fase 1.4 ditutup): jalur pesan
  sudah ada di `messagePipeline.ts`, kini jalur offline sync `session:new_key` di `storeReceivedSessionKey`
  (`utils/crypto.ts`) juga mewajibkan `metadata.initiatorSigningKeyV2 === fetchPreKeyBundle(peer).signingKeyV2`
  saat `handshakeVersion === 2` (throw → tidak menyimpan kunci). Jalur grup memakai kunci yang diikat
  distribusi terenkripsi per-device (`GroupReceiverState.signingKeyV2`).

### Fase 2 — KT Scope A

Pekerjaan:
- Encoder/decoder KT value v2.
- Verifikasi bundle membandingkan identityKem + signingKeyV2.
- `peerIdentityTrust` menyimpan digest semua key.
- `ktMonitoring`/`ktGossip` version scoping.
- Config pinning di `ktBundleProof.ts` + release manifest.
- Test dengan fixture v2.

Acceptance:
- MITM yang mengganti X-Wing atau ML-DSA key ditolak,
- config server yang berbeda dari pin ditolak fail-closed,
- baris monitoring v1 dan v2 tidak collide.

Status (2026-10-19): **inti Scope A selesai di kode, belum di-deploy.**
- Nilai log v2 (`packages/shared/src/ktValue.ts`, 3238 B = v1 + `signingKeyV2`
  ML-DSA-65 1952 B) dan encoder server (`encodeKtValueV2`, dipilih otomatis bila
  `signingKeyV2` tersedia). Nilai v1 tetap 1286 B dan tetap dibaca.
- Verifikasi bundle kini membandingkan **tiga** kunci terhadap log: X25519
  `identityKey`, X-Wing `pqIdentityKey`, dan ML-DSA `signingKeyV2`; mismatch
  mana pun → verdict `mismatch` (fail-closed untuk pinning).
- `signingKeyV2` mengalir end-to-end: derive dari masterSeed di worker →
  disimpan di bundle privat → diunggah pada register/recover/prekey-bundle →
  disajikan ke peer (`keyBundle.ts`, `routes/keys.ts`) → dibandingkan di klien.
- Pin konfigurasi TOFU: tabel Dexie `ktConfig` (v14, aditif) + `ktConfigPin.ts`;
  `resolveConfig` menyimpan `signatureKey`/`vrfKey`/`auditorKeys` pertama
  ter-seal `ENC1:` dan menolak perubahan (verdict `unverifiable`).
- Belum: scoping versi log di PK `ktMonitoring`/anchor `ktGossip` (ditunda — baru
  relevan saat Scope B menghadirkan log kedua); pin kuat dari manifest rilis.
  (`signingKeyV2` pada flow device-linking **sudah** dikirim/tervalidasi/tercatat di KT
  sebagai bagian dari langkah 9.)

### Fase 3 — Metadata resistance

Status (2026-10-21): **seluruh pekerjaan Fase 3 landed di kode, default mati,
belum di-deploy.** Ringkas:

- **OHTTP dipakai alur aplikasi** untuk `GET /api/users/search` (dan siap untuk
  prekey): token bearer 120 detik ber-scope `ohttp` diletakkan DI DALAM amplop.
  Mode `on` (default) menerbitkannya lewat `POST /api/auth/ohttp-token`
  (cookie + CSRF); mode `off` mewajibkan auth+CSRF di `/relay` dan server
  mencetak token di relay. `requireAuth` menolak token itu di luar
  allowlist/method GET, jadi token yang bocor tidak bisa dipakai untuk mutasi.
  Tanpa fallback diam-diam ke HTTP biasa.
- **Rotasi kunci dua slot**: `/api/ohttp/config` mempublikasikan key id 1 dan 2,
  gateway memilih slot dari byte pertama amplop, klien mem-pin per key id
  (kunci yang sudah dipin tidak boleh berubah; kunci baru hanya diadopsi setelah
  kunci lama pensiun). Metrik `nyx_ohttp_ops_total{route,result}`.
- **Cover traffic**: λ adaptif terhadap laju kirim nyata per percakapan
  (0.2–2.0/menit), plafon byte harian 25 MB/percakapan (reset UTC, persisted),
  dan cover 1:1 opt-in hanya setelah ada pesan nyata (tidak pernah memulai sesi).
- **Jitter/batching 200–800 ms** pada mode Maximum untuk pesan user: satu
  jendela per percakapan, urutan tetap, silent/receipt tidak ditahan.
- **Chaff visibility-aware**: tab background berhenti mengirim (interval/ukuran
  dapat diubah runtime lewat `CHAFF_CONFIG`, ≤1000 byte agar tidak di-drop QUIC).
- **Uji jalur nyata**: client → relay HTTP → gateway → dispatch → response
  terenkripsi (14 test di `server/tests/ohttp.test.ts`).

Yang TIDAK diklaim: metadata (graf, timing, volume) tidak hilang oleh fase ini;
OHTTP/HPKE tetap Tier B classical; relay dan gateway masih di host yang sama
sehingga operator VPS tetap melihat IP.

#### Desain relay & gateway OHTTP (2026-10-20)

Topologi yang dipilih: **self-hosted, dua peran pada jalur yang sama** — tidak
ada relay pihak ketiga (katalog layanan tidak menyediakan OHTTP relay, dan
privacy tidak boleh bergantung pada satu operator eksternal).

```text
client ──message/ohttp-req──▶ relay /api/ohttp/relay
       ──message/ohttp-req──▶ gateway /api/ohttp/gateway
       ──HTTP biasa (loopback)──▶ target /api/...
```

- **Relay** melihat IP + waktu, tidak pernah isi: ia hanya mem-POST byte ke
  `OHTTP_RELAY_TARGET` yang berasal dari env, bukan input klien — tidak ada
  open proxy/SSRF.
- **Gateway** membuka HPKE, menegakkan allowlist, melakukan dispatch ke API
  lewat loopback dengan header jaringan dibuang (`x-forwarded-for`,
  `cf-connecting-ip`, `forwarded`, …), lalu membalas `message/ohttp-res`.
- **Kejujuran deployment:** di VPS yang sama kedua peran dijalankan operator
  yang sama. Keuntungannya menyembunyikan path/header/konten dari edge
  Cloudflare dan access log nginx, **bukan** dari operator VPS. Memindahkan
  relay ke host lain cukup mengubah `OHTTP_RELAY_TARGET`/URL klien — protokol
  tidak berubah.
- **Profil kripto:** DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM,
  semuanya WebCrypto native (tanpa WASM/dependency kripto baru di worker).
  Wire mengikuti RFC 9458 §4.1–4.4 apa adanya; isi = Binary HTTP (RFC 9292)
  known-length, request framing 0 / response framing 1. Ini **Tier B
  (classical)** dan tidak diklaim PQ.
- **Allowlist** (`packages/shared/src/ohttp.ts`): hanya
  `GET /api/users/search` dan `GET /api/keys/prekey-bundle/<id>` (pathname,
  query bebas). Gateway menjawab 403 terenkripsi untuk target lain, body
  dibatasi 128 KiB, dan relay/gateway dibatasi 120 req/menit.
- **Pin config:** klien mengambil `/api/ohttp/config` (`application/ohttp-keys`)
  dan mem-pin SHA-256-nya di `localStorage` (TOFU). Config berubah tanpa rotasi
  eksplisit → `OHTTP_CONFIG_CHANGED`, fail-closed (pola yang sama dengan pin KT).
- **Carriage token (`OHTTP_TOKEN_MODE`, landed 2026-10-23):** cookie sesi
  `HttpOnly` tidak bisa dibaca JS. Mode `on` (default) menukar sesi menjadi
  token bearer scoped 120 s lewat `POST /api/auth/ohttp-token`, lalu
  memasukkannya ke amplop. Mode `off` tidak memanggil endpoint itu: `/relay`
  wajib auth+CSRF, server mencetak token scoped di relay, dan gateway hanya
  menerimanya lewat header internal dari relay loopback. Mode `off` hanya untuk
  relay loopback/same-host; token tetap 120 s dan scope GET allowlist.
- **Aktivasi:** `OHTTP_ENABLED=1` + `OHTTP_PRIVATE_KEY`/`OHTTP_PUBLIC_KEY`
  (`pnpm --filter nyx-server run ohttp-key:generate`), klien
  `VITE_OHTTP_ENABLED=1`. Untuk token-off same-host: `OHTTP_TOKEN_MODE=off` dan
  `VITE_OHTTP_TOKEN_MODE=off` (relay wajib loopback; `/relay` tetap auth+CSRF).
  Default mati di kedua sisi: saat mati router tidak dipasang (404). Rotasi
  kunci dua slot dan metrik `nyx_ohttp_ops_total` sudah landed.

Pekerjaan (semua ✅ landed di kode, default mati):
- ✅ OHTTP client worker + relay/gateway untuk REST.
- ✅ Carriage token (scoped, 120 s) dengan mode `on`/`off`; OHTTP dipakai jalur pencarian.
- ✅ Rotasi kunci dua slot + metrik `nyx_ohttp_ops_total`.
- ✅ Cover traffic 1:1 opt-in + adaptive λ + budget byte harian.
- ✅ Batch/jitter real message 200–800 ms pada mode “Maximum”.
- ✅ Chaff visibility-aware dan configurable.
- ✅ Dokumentasikan Tier B OHTTP/HPKE (§35.7 desain + §35.10 residual).

Acceptance:
- API tidak melihat IP client langsung saat OHTTP aktif,
- cover tidak mengganggu real send,
- tidak ada ledakan volume default,
- setting client-local, server tidak mengetahuinya.

### Fase 4 — Discovery

Status (2026-10-21): **R5 ditutup.** `identifierLookupCandidates` tidak lagi
mengembalikan nilai kiriman mentah — 43-char hash klien di-pepper (satu
kandidat), 64-hex (blind index yang di-echo server) dipakai apa adanya. Route
`GET /api/users/search` menolak apa pun yang bukan kedua bentuk hash dengan 400
`INVALID_IDENTIFIER_HASH`, **sebelum** menyentuh DB, sehingga dump DB + akses
API hidup bukan lagi oracle keanggotaan untuk tebakan plaintext. Tool WebMCP
`search_users` ikut meng-hash di klien, dan `searchUsers` store meneruskan
64-hex apa adanya supaya link lama tetap berfungsi (jalur migrasi). Client-side
OHTTP sudah aktif untuk jalur ini (Fase 3).

Pekerjaan:
- ✅ Hapus kandidat raw value dari `identifierLookupCandidates`.
- ✅ Search hanya menerima bentuk hash; link lama 64-hex diteruskan apa adanya.
- ✅ Rate limit per akun (30/menit) + per IP (90/menit): kunci `identityTag`/
  `clientIpTag` (HMAC), bukan userId/IP mentah — `utils/searchRateKey.ts`,
  `middleware/rateLimiter.ts` (`rl:search:` + `rl:search-ip:`).
- ✅ OHTTP (Fase 3) + padded query: `paddedSearchPath()` mengisi sisa slot q
  sampai 64 karakter sehingga panjang path sama untuk hash 43-char dan 64-hex.
- ✅ Konsumsi OTPK dipisah dari pembacaan bundle: `GET /prekey-bundle/:id`
  default tetap `consume` (klien X3DH lama), `?otpk=read` mengembalikan
  identitas + signed pre-key **tanpa** menghapus OTPK dan **tanpa**
  `oneTimePreKey` (OTPK yang beredar tanpa dihapus bisa dipakai dua inisiator).
  Jalur PIR/preview wajib memakai `read` supaya retry jaringan tidak membakar
  pre-key peer.
- ✅ `shareId` terpisah dari blind index (docs/28 §R5): `User.shareId`
  (`s1_` + 32 byte acak, `@unique`) diisi saat register dan lazily saat
  login/`GET /me`; `/api/users/search` me-lookup kolom itu untuk handle `s1_…`;
  tautan baru `/u/<shareId>`. Tautan lama 43-char/64-hex tetap dibaca (jalur
  migrasi); penghapusan kandidat kedua dari jalur auth menunggu deprekasi.
- ⏸ PIR spike: direktori `usernameHash → encryptedProfile + device keys`,
  padding ~2 KB, evaluasi SimplePIR/OnionPIRv2, client hint + WASM.
  **Diputuskan tunda** (2026-10-21, §35.11 #3): PIR tidak menutup enumerasi
  terautentikasi maupun residual R5, jadi R5 penuh (shareId terpisah) dan
  pengurangan daya enumerasi dikerjakan lebih dulu; PIR baru dimulai bila
  ambang + benchmark + audit di §35.11 #3 terpenuhi.

Acceptance:
- ✅ R5 tertutup: nilai mentah tidak lagi dicari,
- ✅ R5 penuh: ID berbagi terpisah dari blind index (`shareId`),
- ✅ link lama yang memakai 64-hex punya jalur migrasi,
- ✅ pembacaan bundle untuk PIR tidak menguras OTPK,
- ⏸ PIR tidak masuk default; keputusan **tunda** + kriteria go tercatat di
  §35.11 #3 (2026-10-21).

### Fase 5 — Credentials PQ

Pekerjaan:
- Refactor `CredentialSuite` di shared/server/client.
- `CredentialIssuerKey.suite`, `GroupCredential.suite`, API `suite`.
- Persist credential di IndexedDB; await commit; validasi serial hex.
- Revoke saat kick/leave; admin capability check.
- BRaccoon research spike:
  - implementasi terisolasi + test vector paper,
  - benchmark browser/server,
  - audit eksternal,
  - dual verify + kill switch.
- Fallback blind UOV jika BRaccoon tidak layak.

Acceptance:
- RSA v1 masih bisa diverifikasi selama migrasi,
- tidak ada credential hilang karena reload,
- commit failure tidak menghasilkan credential “sukses”,
- credential v2 tidak diklaim PQ sebelum audit.

Status (2026-10-23): **dihapus.** Cutover PQ-only menghapus suite credential
blind RSA, endpoint issuance/commit, persist Dexie, dan seluruh tesnya
(`credentialSuite`, `groupCredentials`, `credentialIssuance`,
`groupCredentialPersistence`). Acceptance di atas tidak lagi berlaku. Grup
memakai delivery token. BRaccoon/blind UOV tetap riset dan harus dibangun dari
nol bila credential PQ dihidupkan kembali.

### Fase 6 — Anonymous issuance

Pekerjaan:
- Endpoint issuance/commit token-only tanpa `req.user`.
  Karena `router.use(requireAuth)` global, buat router terpisah atau endpoint
  baru `/api/credentials/*`.
- Quota per token, bukan per user.
- Blind token bank: batch token diperoleh dengan sesi terautentikasi; redeem
  token tanpa identitas.
- BRaccoon dipakai jika sudah lolos gate.
- Catat residual: batch acquisition masih menghubungkan batch ↔ user.

Acceptance:
- ✅ issuance tidak lagi menyimpan `user ↔ conversation` (jalur baru),
- ✅ token dapat di-redeem tanpa JWT/user id,
- ✅ replay token ditolak (Lua GET+DEL),
- ✅ kuota dan revocation tetap berfungsi.

Status (2026-10-23): **dihapus.** Bank token, redeem anonim, commit ticket, dan
klien `credentialTokens.ts` dihapus bersama Fase 5. Tidak ada endpoint
`/api/credentials/*`; `VITE_ANON_CREDENTIALS` tidak dipakai. Acceptance di atas
adalah catatan historis, bukan status kode.

### Fase 7 — KT Scope B

Pekerjaan:
- Fork hanya `tree/transparency` + verifier Rust; `vendor/` tetap referensi
  immutable.
- Ganti Ed25519 tree head → ML-DSA-65.
- Hapus ECVRF; index = `SHA-256("nyx-kt-v2-index" || searchKey)`.
- WASM ABI v2 dengan key length-prefixed.
- Service/DB/port/systemd/metrics/snapshot sendiri; v1 tetap read-only.
- Auditor + gossip pindah ke ML-DSA.

Acceptance:
- log v2 tidak memakai Ed25519/ECVRF,
- client v2 memverifikasi proof,
- auditor v2 berjalan terpisah,
- v1 tetap tersedia selama transisi,
- residual index privacy didokumentasikan.

Status implementasi (2026-10-21, belum di-deploy):

- Fork hanya `server/kt-query/v2/transparency` (ML-DSA-65, index =
  `SHA-256("nyx-kt-v2-index" || searchKey)`); `vendor/` tidak disentuh.
- WASM ABI v2 (`packages/keytrans-wasm-v2`, `abiVersion` 2, kunci
  length-prefixed) + wrapper web `keyTransparencyV2.ts`; ABI dipilih dari
  `/api/keys/kt/config` dan pin `ktConfigPin` mendukung 1→2 (tanpa downgrade).
- Service v2 `cmd/nyx-kt-query-v2` (port 8089/8088/8087, metrik 9468,
  LevelDB + snapshot sendiri), auditor v2 `cmd/nyx-kt-auditor-v2` (metrik
  9469), unit systemd + deploy gated `systemctl is-enabled`.
- Server menulis ke v1 dan v2 bila `KT_V2_SERVER_URL` diisi (dedupe/metrik
  terpisah); pembacaan pindah dengan mengarahkan `KT_QUERY_URL` ke :8089.
- Vektor lintas implementasi: Go fixtures → Rust verifier + WASM klien.
- Residual: index v2 tetap deterministik (SHA-256 tanpa VRF), jadi server yang
  memegang log bisa menguji tebakan `searchKey`; ini **lebih lemah dari ECVRF
  v1** dan diterima hanya karena v2 menghapus primitif non-PQ. Mitigasi ada di
  lapisan akses (OHTTP/token scoped), bukan di log. Rollback baca setelah klien
  mem-pin ABI 2 bersifat satu arah (anti-downgrade) sampai ada jalur reset pin.

### Fase 8 — Removal, audit, dan dokumentasi

Status (2026-10-22): **selesai di kode, dengan residual non-kode**. Yang sudah landed:

- **KAT resmi**: ML-DSA-65 dari NIST ACVP (`server/tests/fixtures/mlDsaAcvp65.json`,
  keygen tcId 26 + deterministic siggen tcId 31) dan X-Wing draft-06 Appendix C
  (`server/tests/fixtures/xwing-draft06.json`) di
  `server/tests/cryptoKnownAnswer.test.ts` + `server/tests/mlDsa.test.ts`.
- **KAT lintas-implementasi**: X3DH v2 di
  `web/src/lib/__tests__/x3dhOracleVectors.test.ts` (vektor Go `tools/dr-oracle`,
  tanpa libsodium; `go run . -check` menjaga drift), group v4 via
  `groupV4Signature.test.ts`, KT v2 via fixture Go→Rust/WASM.
- **Benchmark**: `web/src/lib/pqBench.ts` + `bench:pq`. Hasil desktop
  2026-10-22 (20 iterasi, p95): ML-DSA-65 keygen 11,33 ms, sign 82,79 ms,
  verify 18,17 ms; X-Wing keypair 4,42 ms, encaps 2,63 ms, decaps 5,34 ms.
  Ukuran: ML-DSA pk/sk/sig = 1952/4032/3309 B; X-Wing pk/ct/ss =
  1216/1120/32 B.
- **Proxy perangkat rendah** (2026-10-23): `bench:pq:throttle` menjalankan
  harness yang sama di Chromium dengan CPU throttling CDP 1x/4x/6x (5 iterasi,
  p95). 6x: ML-DSA keygen 79,1 ms, sign 186,5 ms, verify 71,3 ms; X-Wing
  keypair 10,8 ms, encaps 8,1 ms, decaps 10,3 ms. 1x pada run yang sama:
  22,0 / 38,1 / 11,3 ms dan X-Wing ≤ 2,7 ms. Ukuran output identik di semua
  laju (kalau berubah, yang diukur bukan primitif yang sama). Ini pendekatan
  "HP kelas bawah", **bukan** pengukuran baterai/perangkat nyata — residual itu
  tetap terbuka.
- **Harness perangkat fisik** (2026-10-23): halaman `/bench/pq`
  (`web/src/pages/PqDeviceBenchPage.tsx`) menjalankan `runPqBenchmark` di
  browser HP, menampilkan p95 vs `PQ_BENCH_BUDGET`, ukuran output, dan konteks
  baterai (`navigator.getBattery()`, hanya Chromium/Android dan dibulatkan 1%).
  Halaman nonaktif pada build default; aktif lewat dev server `--host` atau
  `pnpm --filter nyx-web run build:pq-bench`. Level baterai adalah proxy kasar
  konsumsi energi, bukan pengukuran mWh — angka p95 tetap skor utamanya.
- **Registry exception**: `scripts/pq-only-exceptions.json` sekarang hanya
  menyimpan **2 berkas `hybrid-v2-identity`** dengan `tier`, `rationale`, dan
  `removalGate`. Guard `scripts/check-pq-only.mjs` menolak entri hilang/usang,
  tier tak dikenal, atau rationale/removal gate kosong, lalu mencetak
  `Tier A baru: 0; Tier B: 0; legacy v1: 0; hybrid v2 identity: 2`.
  - `web/src/store/auth.ts`: X25519 identity terikat di transkrip X3DH v2; dua
    tanda tangan Ed25519 prekey tersisa karena kolom bundle/DB belum nullable
    dan server tidak lagi memverifikasinya.
  - `web/src/workers/crypto.worker.ts`: `signingKey` Ed25519 masih diturunkan
    dari device seed untuk kontrak bundle/Device non-nullable; tidak ada
    signature baru setelah cutover.
- **E2E browser pelengkap** (2026-10-23): tiga alur yang sebelumnya hanya
  dijaga unit test kini punya spec Playwright — `recovery.spec.ts` (frasa dari
  vault → `/restore`, dan request `POST /api/auth/recover` wajib membawa
  `signatureV2` + `signingKeyV2` yang diterima server 200),
  `deviceLinking.spec.ts` (QR perangkat lama → claim → approve → login perangkat
  baru), dan `ohttp.spec.ts` (pencarian lewat `POST /api/ohttp/relay` berisi
  amplop `message/ohttp-req`, pin key gateway tersimpan, dan **tidak ada**
  request `GET /api/users/search` langsung). Spec credential grup dihapus
  bersama fiturnya. OHTTP memakai stack sendiri:
  `web/playwright.ohttp.config.ts` menyalakan API 4100 + Vite 5273 dengan
  `OHTTP_ENABLED=1` dan kunci P-256 yang dibuat saat config dimuat (tidak ada
  kunci privat di repo); jalankan `pnpm --filter nyx-web run test:e2e:ohttp`.
  Spec OHTTP di suite utama skip dengan alasan tertulis karena server default
  memang mematikan gateway. Run selfhost 2026-10-23 (DB kosong): recovery +
  deviceLinking **2 passed (6,7 m)**, OHTTP **1 passed (2,7 m)**; run itu
  terjadi **sebelum** credential dihapus dan belum diulang setelah cutover.
  Stack OHTTP mematikan `METRICS_PORT` supaya tidak bentrok dengan API dev di
  9464.
- **Dokumentasi**: status/angka di `docs/35`, `docs/README`, `docs/30`,
  `docs/32`, `docs/34`, `AGENTS`, dan `README` sudah diselaraskan dengan kode.
  `docs/04`, `docs/26`, `docs/28`, `docs/33` tidak memuat klaim status usang.

Residual non-kode (tidak memblokir Fase 8 di repo):

- **Dua exception `hybrid-v2-identity`**: bukan Tier A baru. X25519 identity
  masih terikat di transkrip X3DH v2, dan `signingKey` Ed25519 masih ada di
  kontrak bundle/Device non-nullable. Removal gate: kolom signature nullable +
  handshake v3 untuk identitas X25519, serta drop `signingKey` + re-key migrasi.
  Tidak ada sesi/pesan/credential v1 yang menjadi alasan exception ini.
  Agar sisa artefak v1 terukur (bukan diasumsikan), jalankan
  `pnpm --filter nyx-server run audit:v1`
  (`server/scripts/audit-v1-residuals.ts`, read-only). Skrip menghitung agregat:
  Device tanpa `signingKeyV2`, PreKeyBundle tanpa `signatureV2`, OneTimePreKey
  klasik, GroupCredential bersuite NULL, dan amplop pesan X3DH v1 / grup
  `sigV` v1. `--json` untuk diproses mesin, `--check` keluar 1 selama masih ada
  sisa v1. Tidak ada id/username/isi pesan yang dicetak.
- **Benchmark perangkat rendah/baterai**, termasuk keputusan tetap di noble atau
  pindah ke liboqs (§35.11 #1). E2E yang baru berjalan di mesin dev/CI, bukan
  pengukuran perangkat pengguna.
- **Review kriptografi eksternal** sebelum produksi (§35.11). Paketnya sudah
  disusun di `docs/36`: ruang lingkup, klaim yang diminta diverifikasi, bukti
  yang bisa dijalankan ulang, residual, dan pertanyaan spesifik. Dokumen itu
  **bukan** hasil audit; status review tetap belum dilakukan.
- **Tier B platform** (TLS/QUIC, WebRTC DTLS-SRTP, WebAuthn, VAPID, sertifikat
  WebTransport) tetap classical/hybrid dan dicatat di §35.10; bukan exception
  denylist aplikasi.

## 35.8 Test dan CI

Wajib:
- `pnpm -r run build`
- `pnpm --filter @nyx/shared run build` sebelum typecheck web/server
- `npx tsc --noEmit` per package
- `pnpm run lint` (oxlint)
- `node scripts/check-pq-only.mjs`
- `pnpm -r --if-present run test`
- `cd tools/dr-oracle && go run . -check`
- `cd server/transport-sidecar && cargo test`
- `server/kt-query/build.sh test`
- Playwright chromium + chrome (WT/coturn)

Test yang sudah ada (Fase 0–7):
- ML-DSA-65: `web/src/lib/__tests__/mlDsa.test.ts`,
  `server/tests/mlDsa.test.ts`.
- Bundle v2 (kanonik + verifikasi server): `server/tests/pqBundle.test.ts`.
- X3DH v2: `web/src/lib/__tests__/pqHandshake.test.ts`, plus oracle Go (tanpa
  libsodium) di `x3dhOracleVectors.test.ts` (15 vektor) dan
  `x3dhOracleInterop.test.ts`.
- OHTTP (Fase 3): `server/tests/ohttp.test.ts` (14 test — round-trip
  klien↔relay↔gateway↔dispatch lewat HTTP nyata, rotasi dua slot, key id tak
  dikenal, allowlist, pembuangan header identitas, amplop diubah ditolak, token
  scoped), `web/src/lib/__tests__/ohttpPin.test.ts` (6 test rotasi/fail-closed),
  `ohttpClient.test.ts` (5 test guard target + fitur mati).
- Metadata lain (Fase 3): `sendTiming.test.ts` (9 test jitter/batching urutan),
  `chaff.test.ts` (3 test visibility/ukuran datagram), dan `coverTraffic.test.ts`
  (29 test — termasuk λ adaptif + budget harian).
- Sealed box v2: `pqSeal.test.ts`; gerbang/negosiasi: `pqCapability.test.ts`,
  `transportCapabilities.test.ts`.
- Grup v2/v3/v4: `groupEnvelopeV3.test.ts`, `groupV4Signature.test.ts`,
  `groupMetadata.test.ts`, `keychainDbPersistence.test.ts`.
- KT value v2 + config pin: `ktBundleProof.test.ts`, `ktConfigPin.test.ts`.
- Recovery/burner: `recoveryV2Signature.test.ts`, `burnerV2RootKey.test.ts`.
- End-to-end: `web/e2e/pqV2.spec.ts` (X3DH v2, grup `sigV: 2`, burner PQ-only).
  Tidak ada lagi skip gate `VITE_PQ_V2`: klien selalu PQ-only. CI tetap
  menjalankannya di **step terpisah** pada job `e2e`.

Belum ada (fase lanjut):
- Benchmark perangkat rendah dan baterai (desktop + throttle proxy sudah ada).
- BRaccoon/blind UOV + dual verify/kill switch untuk credential PQ. Fitur
  credential v1 **sudah dihapus**; suite baru harus dibangun dari nol.
- Migrasi/arsip data v1 lama — build PQ-only ini tidak punya pembaca v1.
- Interop `cmd/kt-client` upstream dan dua implementasi auditor berdampingan.
- PIR record lookup (spike; sengaja ditunda, §35.11 #3).

## 35.9 Rollout dan rollback

Status (2026-10-23): **rollout bertahap di bawah tidak dipakai lagi.** Cutover
PQ-only menghapus fallback v1, jadi tidak ada lagi “aktifkan v2 per fitur” atau
kill switch yang kembali ke v1. Build ini hanya boleh dipasang pada instalasi
yang tidak membutuhkan arsip v1.

1. Deploy schema additive (riwayat; kolom v2 tetap ada).
2. Deploy server yang menerima v2 (riwayat).
3. Deploy client PQ-only; semua handshake/pesan baru wajib v2.
4. Jangan mengaktifkan `VITE_PQ_V2`/`VITE_ANON_CREDENTIALS` — keduanya sudah
   tidak berpengaruh.
5. Pantau error handshake/decrypt, ukuran pesan, latensi, dan crash worker.
6. Rollback = deploy ulang build sebelumnya yang masih punya pembaca v1; jangan
   menghapus kolom/schema.
7. Jangan menjalankan build ini pada data v1 yang belum diarsipkan — v1 reader
   sudah dihapus dan tidak ada jalur migrasi di kode saat ini.

## 35.10 Risiko dan residual

| Risiko | Dampak | Mitigasi |
|---|---|---|
| X-Wing tetap memuat X25519 | klaim “nol EC” tidak tercapai | dokumentasikan sebagai hedge; target “no classical-only” |
| ML-DSA memperbesar pesan | group +3,3 KB, bundle +5,2 KB | resize schema/state; benchmark; batasi group metadata |
| BRaccoon belum produksi | tidak ada credential PQ; fitur credential v1 sudah dihapus | bangun ulang + audit + dual verify; fallback blind UOV; jangan hidupkan RSA v1 |
| KT v1 classical | log auth belum PQ | Scope A cepat; Scope B service terpisah |
| Config KT dari server | server bisa forge log | pin config di build/release; fail-closed |
| PIR kompleks | discovery privacy tertunda | OHTTP/exact-hash dulu; PIR spike |
| OHTTP/HPKE classical | metadata layer bukan pure PQ | Tier B exception; dokumentasikan |
| Deploy `prisma db push || true` | schema gagal diam-diam | verifikasi manual pasca-deploy |
| Noble ML-DSA JS | timing/perf | **dipakai** (keputusan §35.11); signing worker-only; `bench:pq` desktop 2026-10-22: keygen p95 11,33 ms, sign 82,79 ms, verify 18,17 ms; proxy throttle 6x 2026-10-23: 79,1 / 186,5 / 71,3 ms — budget desktop tetap terpenuhi, benchmark baterai/perangkat nyata masih terbuka |
| v1/v2 state bercampur | arsip v1 lama tidak terbaca | arsipkan sebelum deploy; rollback = build lama; jangan hapus kolom/schema |

Residual yang harus ditulis jujur:
- metadata (graph, timing, volume) tidak hilang hanya dengan PQ,
- KT v1 tetap classical sampai Scope B,
- Tier B tetap hybrid/classical,
- credential v1 dihapus; build ini tidak punya credential PQ,
- BRaccoon/blind UOV belum tentu lolos audit (hanya relevan jika credential dibangun ulang),
- X-Wing bukan “pure ML-KEM”,
- arsip v1 lama tidak terbaca oleh build ini.

## 35.11 Keputusan yang masih terbuka

1. ~~ML-DSA runtime: `@noble/post-quantum` vs `@oqs/liboqs-js`.~~ **Diputuskan:**
   `@noble/post-quantum@0.7.1` (pinned exact) dipakai di web, worker, dan server.
   Proxy CPU throttling 6x (`bench:pq:throttle`, 2026-10-23) masih di bawah
   200 ms untuk sign dan budget desktop terpenuhi; pindah ke liboqs **tidak**
   dipicu. Yang masih terbuka hanya pengukuran baterai/perangkat fisik — bukan
   keputusan library.
2. BRaccoon: credential v1 sudah dihapus; fitur credential tidak ada di build
   PQ-only ini. BRaccoon/blind UOV hanya relevan jika credential dibangun ulang
   dari nol — go/no-go setelah spike + audit, fallback blind UOV.
3. PIR: library vs service sendiri; kapan ambang direktori membuat PIR wajib.
   **Diputuskan (2026-10-21): tunda — no-go untuk implementasi sekarang.**
   PIR hanya menyembunyikan *record mana* yang diambil dari gateway/operator
   (OHTTP sudah menyembunyikan *pemanggil*); ia tidak menutup enumerasi oleh
   akun terautentikasi (`/search` 30/menit mengembalikan profil + public key)
   maupun residual R5 penuh (`usernameHash` masih dipakai sebagai ID berbagi).
   Keduanya lebih murah dan dikerjakan lebih dulu. Syarat go: (a) direktori
   username melewati ambang ~100k akun **atau** traffic pencarian cukup untuk
   membangun graf, (b) benchmark membuktikan biaya hint/download, latensi, dan
   staleness (user baru tidak langsung ketemu) dapat diterima untuk record
   ~2 KB dengan hint client O(√N), (c) audit eksternal tersedia. Pilihan
   library vs service diputuskan SETELAH benchmark — jangan menulis kripto PIR
   sendiri.
4. ~~OHTTP: relay/gateway self-host vs Cloudflare.~~ **Diputuskan:** self-host,
   dua peran (`/api/ohttp/relay` + `/api/ohttp/gateway`, default mati).
   Yang masih terbuka: apakah relay dipindah ke host/operator lain (hanya
   mengganti `OHTTP_RELAY_TARGET`), dan kapan carriage token diaktifkan.
5. Kapan cutover **baca** KT ke v2 (`KT_QUERY_URL` diarahkan ke `:8089`)
   setelah populasi log v2 cukup. Scope B sudah dimulai dan berjalan sebagai
   **dual-write** (`KT_V2_SERVER_URL`); pembacaan masih v1, dan rollback baca
   setelah klien mem-pin ABI 2 bersifat satu arah sampai ada jalur reset pin.

## 35.12 Referensi

- `docs/04-crypto-protocol.md` — format dan primitif frozen.
- `docs/26-group-privacy-blueprint.md` — metadata, cover traffic, residual.
- `docs/28-db-dump-threat-model.md` — R4/R5, threat model dump.
- `docs/33-spqr-wasm.md` — ratchet PQ, negosiasi, rollback.
- `docs/34-key-transparency-verifier.md` — KT verifier, monitor, auditor.
- FIPS 204 — ML-DSA.
- RFC 9474 — RSA blind signatures.
- draft-ietf-ohai-ohttp — OHTTP.
