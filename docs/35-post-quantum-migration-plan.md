# 35 — Rencana Migrasi Post-Quantum (Tier A)

> **Status: rencana, belum ada implementasi.** Dokumen ini adalah hasil analisis
> codebase dan keputusan arah. Format v2 di §35.6 masih **usulan**; spec final,
> test vector, dan review kriptografi wajib selesai sebelum kode produksi.
>
> Dokumen terkait: `docs/03`, `docs/04`, `docs/26`, `docs/28`, `docs/33`,
> `docs/34`.

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

### 35.2.3 Credentials

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
- Belum ada OHTTP/PIR.
- Cover traffic (`web/src/lib/coverTraffic.ts`):
  - λ = 0.5 pesan cover/menit/conversation,
  - hanya grup yang opt-in dan burner,
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

- Belum ada ML-DSA di repo.
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

## 35.5 Perubahan schema (usulan)

Semua kolom baru nullable dan additive. Deploy memakai `prisma db push || true`;
kegagalan push tidak boleh dianggap sukses, jadi verifikasi manual tetap wajib.

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

## 35.6 Usulan format v2

> Bagian ini adalah **usulan**. Spec final + test vector harus direview sebelum
> implementasi. Jangan menganggap format di bawah sudah final.

### 35.6.1 Bundle v2

```text
version            = 2
cryptoVersion      = 2
identityKem        = pqIdentityKey (X-Wing, 1216 B)
signedPreKeyKem    = pqKey (X-Wing, 1216 B)
signingKey         = Device.signingKeyV2 (ML-DSA-65, 1952 B)
signature          = ML-DSA-65(
                       "NYX-PQ-BUNDLE-V2" || deviceId ||
                       identityKem || signedPreKeyKem
                     ) (3309 B)
oneTimePreKeyKem   = optional X-Wing (1216 B)
```

Initiator memverifikasi `signature` sebelum memakai bundle. Bundle v2 tidak
memakai X25519 identity atau Ed25519 signature.

### 35.6.2 X3DH v2 (KEM-X3DH)

Tujuan: menghapus DH1–DH4 dan konversi Ed25519→X25519. Semua kerahasiaan berasal
dari X-Wing; autentikasi initiator memakai ML-DSA.

```text
magic            = 0x4E
version          = 0x02
flags            = bit 0: OTPK present
ctIdentity       = X-Wing encapsulation ke recipient identity (1120 B)
ctSignedPreKey   = X-Wing encapsulation ke recipient signed prekey (1120 B)
ctOneTimePreKey  = optional X-Wing encapsulation ke OTPK (1120 B)
initiatorSignKey = ML-DSA-65 public key (1952 B)
signature        = ML-DSA-65(
                     "NYX-PQ-HANDSHAKE-V2" || flags ||
                     ctIdentity || ctSignedPreKey || [ctOneTimePreKey]
                   ) (3309 B)
```

Alur:
1. Initiator memverifikasi signature signed prekey recipient.
2. Initiator melakukan X-Wing encaps ke identity, signed prekey, dan OTPK (jika ada).
3. Initiator menandatangani transcript dengan ML-DSA.
4. Recipient melakukan X-Wing decaps, memverifikasi signature initiator terhadap
   `initiatorSignKey` yang dipercaya (KT/TOFU), lalu menurunkan session key.
5. Session key = `BLAKE2b-256(ssIdentity || ssSignedPreKey || [ssOneTimePreKey] || transcriptHash)`.

Catatan desain:
- Tidak ada ephemeral X25519 terpisah; X-Wing ciphertext sudah membawa material
  ephemeral di dalamnya.
- `initiatorSignKey` harus diikat ke identitas yang dipercaya. Jika belum ada
  pin/KT, klien memakai TOFU dan mencatatnya.
- Format ini belum menggantikan analisis formal X3DH; review kriptografi wajib
  sebelum produksi.

### 35.6.3 Sealed box v2

```text
version   = 0x02
ct        = X-Wing ciphertext (1120 B)
nonce     = 24 B
ciphertext = XChaCha20-Poly1305(
               key = BLAKE2b-256("NYX-PQ-SEAL-V2" || ss),
               nonce,
               plaintext
             )
```

Envelope: `[0x02][ct][nonce][ciphertext]`.

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
  - `sigV2` = ML-DSA-65 atas `"NYX-PQ-GROUP-V4" || u32 N || ciphertext`.
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
identityKem   = X-Wing (1216 B)
signingKeyV2  = ML-DSA-65 public key (1952 B)
updatedAtDay  = u32 (4 B)
total         = 3174 B
```

- `searchKey` tetap `0x75 || usernameHash(32)`.
- Client v2 membandingkan **identityKem dan signingKeyV2** ke bundle peer.
- `peerIdentityTrust` menyimpan digest semua key (mis. SHA-256 dari
  `identityKem || signingKeyV2`), bukan hanya X25519.
- `ktMonitoring` dan `ktGossip` mendapat `logVersion`/`logId` agar baris v1/v2
  tidak bertabrakan.
- `/api/keys/kt/config` harus dipin ke build/release manifest; config dari
  server tidak boleh dipercaya mentah-mentah.

### 35.6.6 Credential suite abstraction

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

Status (2026-10-19): **selesai, belum di-deploy.** `@noble/post-quantum@0.7.1`
(pinned exact), `cryptoSuite.ts`, capability `pq-v2` (shared + Rust + client
lewat `advertisedPqCapabilities()` dengan `VITE_PQ_V2=1`, default mati), kolom
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

Status (2026-10-20): **seluruh langkah 1–9 selesai di kode**, termasuk residual cross-check `signingKeyV2` payload vs bundle, tanda tangan pesan + metadata grup v4, envelope distribusi grup v4 (kunci verifikasi ter-seal di dalam envelope), burner v2, recovery/device-linking/migration/push v2, test vector lintas-implementasi (oracle Go) untuk X3DH v2, dan audit persistensi/relay yang mengunci `signingKeyV2`/`senderKeyId` di state grup. Belum di-deploy dan gerbang `VITE_PQ_V2` masih default mati.
- Langkah 1–3 (ML-DSA, device key v2, bundle v2) selesai; lihat status Fase 0 dan catatan KT Scope A.
- Langkah 4 (X3DH v2) selesai sebagian — **hanya jalur 1:1**:
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
  - Gerbang: `resolvePqV2Enabled()` (`VITE_PQ_V2=1`) **dan** bundle peer memuat `signingKeyV2`.
    Default OFF; jalur v1 tetap utuh dan dipakai bila gerbang mati.
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

Pekerjaan:
- OHTTP client worker + relay/gateway untuk REST.
- Cover traffic 1:1 opt-in; adaptive λ; budget baterai/bandwidth.
- Batch/jitter real message 200–800 ms pada mode “Maximum”.
- Chaff visibility-aware dan configurable.
- Dokumentasikan Tier B OHTTP/HPKE.

Acceptance:
- API tidak melihat IP client langsung saat OHTTP aktif,
- cover tidak mengganggu real send,
- tidak ada ledakan volume default,
- setting client-local, server tidak mengetahuinya.

### Fase 4 — Discovery

Pekerjaan:
- Hapus kandidat raw value dari `identifierLookupCandidates`.
- Search hanya menerima 43-char hash; update link share/profil.
- Rate limit per akun/IP.
- OHTTP + padded query untuk search/prekey.
- PIR spike: direktori `usernameHash → encryptedProfile + device keys`,
  padding ~2 KB, evaluasi SimplePIR/OnionPIRv2, client hint + WASM.
- Pisahkan konsumsi OTPK dari pembacaan bundle untuk jalur PIR.

Acceptance:
- R5 tertutup: nilai mentah tidak lagi dicari,
- link lama yang memakai 64-hex punya jalur migrasi,
- PIR tidak masuk default sebelum benchmark + audit.

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
- issuance tidak lagi menyimpan `user ↔ conversation`,
- token dapat di-redeem tanpa JWT/user id,
- replay token ditolak,
- kuota dan revocation tetap berfungsi.

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

### Fase 8 — Removal, audit, dan dokumentasi

Pekerjaan:
- CI denylist Tier A harus 0.
- KAT ML-DSA, X-Wing, X3DH v2, group v4, KT v2.
- E2E: handshake, prekey, recovery, device linking, group, credential, OHTTP.
- Benchmark worker, ukuran pesan, latensi KT/PIR, baterai.
- Update `docs/04`, `docs/26`, `docs/28`, `docs/30`, `docs/33`, `docs/34`.
- Catat Tier B exception dan residual.

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

Test baru:
- ML-DSA-65 FIPS 204 known-answer test.
- X-Wing KAT.
- X3DH v2 oracle Go (tanpa libsodium).
- Group v4 wrapper/signature.
- KT value v2 parsing + bundle binding.
- Config pinning fail-closed.
- Credential suite v1/v2 dual verify.
- Anonymous issuance replay/quota.
- OHTTP request/response.
- PIR record lookup (spike).

## 35.9 Rollout dan rollback

1. Deploy schema additive.
2. Deploy server yang menerima v2 tetapi belum mengirim v2.
3. Deploy client dengan `pq-v2` capability; v2 hanya untuk peer yang mendukung.
4. Aktifkan v2 per fitur: 1:1 → group → burner → recovery → device linking.
5. Pantau error handshake/decrypt, ukuran pesan, latensi, dan crash worker.
6. Kill switch per fitur: berhenti mengirim/mengadvertise v2, tetap membaca v2.
7. Rollback server: client v2 tetap bisa membaca; jangan hapus kolom/schema.
8. Jangan pernah menghapus v1 reader selama masih ada pesan/sesi v1.

## 35.10 Risiko dan residual

| Risiko | Dampak | Mitigasi |
|---|---|---|
| X-Wing tetap memuat X25519 | klaim “nol EC” tidak tercapai | dokumentasikan sebagai hedge; target “no classical-only” |
| ML-DSA memperbesar pesan | group +3,3 KB, bundle +5,2 KB | resize schema/state; benchmark; batasi group metadata |
| BRaccoon belum produksi | credential PQ tertunda | research spike + audit; fallback blind UOV; RSA v1 exception |
| KT v1 classical | log auth belum PQ | Scope A cepat; Scope B service terpisah |
| Config KT dari server | server bisa forge log | pin config di build/release; fail-closed |
| PIR kompleks | discovery privacy tertunda | OHTTP/exact-hash dulu; PIR spike |
| OHTTP/HPKE classical | metadata layer bukan pure PQ | Tier B exception; dokumentasikan |
| Deploy `prisma db push || true` | schema gagal diam-diam | verifikasi manual pasca-deploy |
| Noble ML-DSA JS | timing/perf | benchmark; worker-only signing; pertimbangkan liboqs |
| v1/v2 state bercampur | decrypt gagal | version scoping, archive cap, test migrasi |

Residual yang harus ditulis jujur:
- metadata (graph, timing, volume) tidak hilang hanya dengan PQ,
- KT v1 tetap classical sampai Scope B,
- Tier B tetap hybrid/classical,
- BRaccoon/blind UOV belum tentu lolos audit,
- X-Wing bukan “pure ML-KEM”.

## 35.11 Keputusan yang masih terbuka

1. ML-DSA runtime: `@noble/post-quantum` vs `@oqs/liboqs-js`. Rekomendasi: noble
   dulu, benchmark sebelum produksi.
2. BRaccoon: go/no-go setelah spike + audit; fallback blind UOV.
3. PIR: library vs service sendiri; kapan ambang direktori membuat PIR wajib.
4. OHTTP: relay/gateway self-host vs Cloudflare; ini keputusan Tier B.
5. Kapan Scope B KT dimulai; jangan mulai sebelum format bundle v2 stabil.

## 35.12 Referensi

- `docs/04-crypto-protocol.md` — format dan primitif frozen.
- `docs/26-group-privacy-blueprint.md` — metadata, cover traffic, residual.
- `docs/28-db-dump-threat-model.md` — R4/R5, threat model dump.
- `docs/33-spqr-wasm.md` — ratchet PQ, negosiasi, rollback.
- `docs/34-key-transparency-verifier.md` — KT verifier, monitor, auditor.
- FIPS 204 — ML-DSA.
- RFC 9474 — RSA blind signatures.
- draft-ietf-ohai-ohttp — OHTTP.
