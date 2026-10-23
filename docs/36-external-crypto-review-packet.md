# 36 — Paket Review Kriptografi Eksternal (Tier A PQ + KT v2)

> **Status (2026-10-23): paket siap dikirim; review belum dilakukan.** Dokumen
> ini adalah bahan untuk reviewer independen — bukan klaim bahwa sistem sudah
> diaudit. Sampai review selesai dan temuannya ditutup, NYX tetap **belum boleh
> diklaim** "post-quantum" untuk produksi dan belum pernah ada build produksi
> dengan gerbang PQ menyala.

## 36.1 Tujuan review

Meminta penilaian independen atas implementasi kriptografi NYX yang **baru dan
belum teruji waktu**, dengan fokus pada jalur yang berubah pada migrasi
post-quantum (Tier A) dan log Key Transparency v2. Reviewer tidak diminta
mengaudit seluruh aplikasi; batasnya ada di §36.2.

Keluaran yang diharapkan: temuan ber-severity (Critical/High/Medium/Low) dengan
`file:line`, skenario serangan, dan dampak; plus pernyataan eksplisit bila suatu
klaim di §36.3 tidak dapat diverifikasi dari bahan ini.

## 36.2 Ruang lingkup

**Termasuk (in scope, Tier A):**

| Area | Konstruksi | Berkas utama |
|---|---|---|
| Tanda tangan identitas v2 | ML-DSA-65 (FIPS 204), context domain per pemakaian | `packages/shared/src/mlDsa.ts`, `cryptoSuite.ts`, `web/src/workers/crypto.worker.ts` |
| Bundle pre-key v2 | Identitas ML-KEM (X-Wing) + ML-DSA-65, tanda tangan atas seluruh material | `packages/shared/src/pqBundle.ts`, `server/src/routes/keys.ts`, `utils/mlDsa.ts` |
| X3DH v2 | **Tanpa DH klasik**; X-Wing sebagai satu-satunya KEM, ML-DSA untuk otentikasi | `packages/shared/src/pqHandshake.ts`, worker op `x3dh_*` |
| Sealed box v2 | X-Wing + AEAD, satu penerima | `packages/shared/src/pqSeal.ts` |
| Pesan grup v4 | Sender key + ML-DSA-65 atas header+ciphertext | `packages/shared/src/groupEnvelope.ts`, `web/src/lib/groupCredentials.ts` |
| Ratchet v2 | braid SPQR (ML-KEM), state ter-seal, negosiasi `ackV:2` | `web/src/lib/spqr*.ts`, `packages/spqr-wasm`, `vendor/signal/spqr` |
| Credential keanggotaan | Blind RSA RSABSSA-SHA384-PSS-Randomized + commit serial | `server/src/lib/groupCredentials.ts`, `web/src/workers/crypto.worker.ts`, `packages/shared/src/credentials.ts` |
| Anonymous issuance | Bank token, redeem tanpa JWT, commit ticket single-use | `server/src/routes/conversations.ts`, `web/src/lib/credentialTokens.ts`, `utils/credentialAuth.ts` |
| KT v2 | Log ML-DSA-65 + indeks SHA-256, verifier WASM, monitor/gossip | `packages/keytrans-v2`, `server/kt-query`, `web/src/lib/ktMonitoring.ts`, `ktGossip.ts` |
| Metadata | OHTTP (RFC 9458, P-256 HPKE), cover traffic 1:1 | `packages/shared/src/ohttp.ts`, `server/src/ohttp/*`, `web/src/lib/coverTraffic.ts` |
| PIR direktori | ChalametPIR keyword PIR (LWE), record 2 KB, epoch + hint | `server/pir-sidecar/*`, `server/src/pir/*`, `server/src/routes/pir.ts` |
| At-rest | XChaCha20-Poly1305 + `ENC1:`, Argon2id, domain-separated seed | `web/src/lib/keychainDb.ts`, worker `storePrivateKeys` |

**Tidak termasuk (out of scope, sengaja):**

- **Tier B** yang memang masih classical/hybrid: TLS/QUIC, WebRTC DTLS-SRTP,
  WebAuthn, Web Push VAPID, sertifikat WebTransport. Ini exception yang
  didokumentasikan, bukan bug yang perlu "dipost-quantum-kan" di review ini.
- **PIR client/WASM (4c) dan benchmark/audit eksternal (4d)** — service 4b
  (ChalametPIR sidecar + proxy) sudah ada tetapi default mati; klien
  Rust→WASM/worker, OHTTP POST/binary, benchmark produksi, dan audit belum.
- **BRaccoon / blind UOV** — riset, belum ada kode produksi.
- Format v1/frozen (`docs/04`) — reviewer boleh memeriksa apakah jalur baca v1
  melemahkan jalur v2, tetapi perubahan format v1 di luar cakupan.

## 36.3 Klaim yang diminta diverifikasi

1. **Tidak ada classical-only di jalur aplikasi Tier A.** X25519 hanya muncul di
   dalam X-Wing (hedge), bukan sebagai DH mandiri; tidak ada
   `crypto_box_seal`/`crypto_sign_ed25519_*` untuk data baru.
2. **X3DH v2 mengikat seluruh transkrip.** Identitas, signed pre-key, OTPK
   (klasik & PQ), dan tanda tangan ML-DSA masuk ke derivasi kunci dengan
   pemisahan domain; tidak ada unknown-key-share atau substitusi kunci.
3. **Domain separation ML-DSA memadai** untuk bundle, handshake, grup, recovery,
   KT, dan burner — satu tanda tangan tidak bisa dipakai ulang di konteks lain.
4. **Sealed box v2 aman untuk penerima tunggal**: nonce unik, AAD mengikat
   konteks, tidak ada pemakaian ulang kunci ephemeral.
5. **Grup v4**: tanda tangan mencakup header + ciphertext + `senderKeyId`;
   distribusi sender key tidak membocorkan identitas; rotasi/penghapusan anggota
   benar-benar memutus akses.
6. **Blind credential tidak linkable** ke anggota, meski server menyimpan
   `serial ↔ conversationId`: serial dibangun dari random message, bukan
   identitas; presentasi tidak bisa di-replay lintas percakapan/versi kunci.
7. **Anonymous issuance** memutus hubungan pembelian token ↔ pemakaian, dan
   commit ticket single-use tidak bisa dipakai dua kali.
8. **KT v2**: tree head ditandatangani ML-DSA, verifier fail-closed, monitor
   tidak menulis state sebelum verifikasi, gossip mendeteksi split-view; tidak
   ada downgrade diam-diam ke v1.
9. **SPQR**: akar sesi berasal dari X3DH v2; v2 hanya dikirim setelah peer
   membuktikan bisa membaca (`ackV:2`); kill switch menghentikan pengiriman,
   bukan pembacaan.
10. **Fallback v1 tidak membuka downgrade**: penyerang jaringan/server tidak
    bisa memaksa v1 tanpa terdeteksi, dan menerima v1 tidak melemahkan sesi v2
    yang sudah ada.
11. **OHTTP**: relay tidak melihat isi, gateway tidak melihat IP; token scoped
    tidak bisa dipakai untuk mutasi; key pin fail-closed pada rotasi tak wajar.
12. **At-rest**: `ENC1:` memakai kunci turunan master seed dengan pemisahan
    domain; password/recovery phrase tidak bisa dipulihkan dari DB.

## 36.4 Bukti yang sudah ada (dapat dijalankan ulang)

| Bukti | Perintah | Cakupan |
|---|---|---|
| KAT resmi | `cd server && npx tsx --test tests/cryptoKnownAnswer.test.ts tests/mlDsa.test.ts` | X25519/Ed25519/BLAKE2b/ChaCha20 KAT RFC; XChaCha lintas implementasi; Argon2id RFC 9106; **ML-DSA-65 ACVP**; **X-Wing draft-06 App. C** |
| Oracle lintas bahasa | `cd tools/dr-oracle && go run . -check` | X3DH v2, KEM, kdfChain, AEAD — implementasi Go tanpa libsodium |
| Vektor oracle di klien | `cd web && npx vitest run src/lib/__tests__/x3dhOracleVectors.test.ts src/lib/__tests__/x3dhOracleInterop.test.ts` | Klien memakai vektor yang sama |
| Grup v4 | `cd web && npx vitest run src/lib/__tests__/groupV4Signature.test.ts` | Tanda tangan ML-DSA atas amplop grup |
| KT v1/v2 | `cd server/kt-query && bash build.sh test` + `web/src/lib/__tests__/keyTransparency.test.ts`, `ktMonitoring.test.ts`, `ktGossip.test.ts` | Proof/read, auditor, snapshot, fail-closed monitor, split-view |
| E2E browser | `cd web && pnpm exec playwright test --project=chromium` | X3DH v2, grup `sigV:2`, burner PQ-only, recovery ML-DSA, device linking, credential grup, OHTTP |
| Benchmark | `pnpm --filter nyx-web run bench:pq` dan `bench:pq:throttle` | Desktop + proxy CPU throttling 6x |
| PIR service | `cd server/pir-sidecar && cargo test && cargo clippy --all-targets -- -D warnings`; `cd server && npx tsx --test tests/pir.test.ts tests/pirSnapshot.test.ts` | Snapshot/epoch, query opaque, proxy auth/rate-limit, end-to-end ChalametPIR |
| Guard klasik | `node scripts/check-pq-only.mjs` | 0 simbol Tier A baru; 13 exception legacy terdaftar dengan `removalGate` |

Angka saat paket ini ditulis: server suite 561+ test (0 gagal), KAT 11 test,
KT Go 31 test, web KT 12+9+17 test, E2E PQ v2 + 4 alur residual lulus. Reviewer
sebaiknya menjalankan sendiri, bukan menerima angka ini.

## 36.5 Residual yang harus dibaca reviewer

Ini bukan "catatan kaki" — semuanya membatasi klaim keamanan:

- **Metadata tidak hilang dengan PQ.** Graf sosial, timing, volume, dan pola
  online tetap ada; OHTTP/cover traffic hanya mengurangi sebagian.
- **PIR 4b baru service + proxy.** Klien WASM/worker, OHTTP POST/binary,
  benchmark produksi, dan audit belum; hint ~9,85 MB untuk N=1000/record 2 KB;
  default mati. Staleness epoch (user baru belum masuk snapshot) belum
  ditangani. Jangan klaim produksi.
- **KT v1 masih classical** (Ed25519 + ECVRF) dan **masih dipakai untuk baca**;
  KT v2 berjalan dual-write. Cutover baca belum dilakukan.
- **Tier B** tetap hybrid/classical (lihat §36.2).
- **Blind RSA v1 masih diterbitkan** sampai suite credential PQ ada
  (BRaccoon belum lolos riset/audit).
- **X-Wing bukan ML-KEM murni**; ia hedge dengan X25519.
- **PIR 4b sudah ada tetapi default mati.** `/api/pir/*` hanya proxy ke
  sidecar ChalametPIR loopback; klien WASM/worker, OHTTP POST, benchmark
  produksi, dan audit belum. Jalur `/search` terautentikasi masih mengembalikan
  profil + public key (dibatasi rate limit per akun/IP), jadi enumerasi
  terautentikasi belum tertutup oleh PIR.
- **Legacy v1 tetap terbaca** (pesan/sesi/credential lama). Denylist baru boleh
  0 setelah audit v1 bersih; lihat `pnpm --filter nyx-server run audit:v1`.
- **Benchmark perangkat nyata/baterai** belum ada; hanya desktop + proxy
  throttling.
- **Review ini belum dilakukan** — dokumen ini adalah permintaan, bukan hasil.

## 36.6 Pertanyaan spesifik untuk reviewer

1. Apakah X3DH v2 tanpa DH klasik tetap memberikan forward secrecy dan
   otentikasi yang setara, mengingat X-Wing sudah mengandung X25519?
2. Apakah `PQ_V2_DOMAINS` (string context FIPS 204) cukup mencegah
   cross-protocol signature reuse, termasuk untuk data yang panjangnya sama?
3. Apakah derivasi kunci X3DH v2 mengikat semua field bundle (termasuk OTPK
   klasik/PQ) sehingga substitusi salah satu komponen selalu menghasilkan kunci
   berbeda?
4. Apakah sealed box v2 dan envelope grup v4 punya nonce/AAD yang benar dan
   tidak bisa dipakai ulang lintas penerima/percakapan?
5. Apakah skema commit `serial = SHA-384(preparedMsg)` menambah linkability yang
   tidak terlihat? Apakah serial perlu di-HMAC sebelum disimpan?
6. Apakah anonymous issuance (token bank → redeem → commit ticket) benar-benar
   memutus link pembelian ↔ presentasi, atau ada korelasi waktu yang harus
   didokumentasikan sebagai residual?
7. Apakah verifier KT v2 menolak semua jalur downgrade ke v1, dan apakah
   monitor/gossip fail-closed pada state yang belum terverifikasi?
8. Apakah negosiasi SPQR (`ackV:2`) bisa dipaksa turun oleh MITM, dan apakah
   kill switch meninggalkan pesan v2 yang tidak terbaca?
9. Apakah fallback v1 (prekey, recovery, migration, credential) membuka
   downgrade yang tidak terdeteksi? Metrik `nyx_legacy_v1_usage_total` dan audit
   DB disediakan untuk mengukur pemakaian, bukan untuk mencegahnya.
10. Apakah OHTTP allowlist + token scoped cukup membatasi gateway sebagai
    confused deputy, terutama untuk endpoint yang mengembalikan data pengguna?
11. Apakah padding 8 KB dan cover traffic 1:1 cukup untuk klaim yang ditulis di
    `docs/26`, atau klaim itu perlu dilemahkan?
12. Apakah ada masalah kriptografis pada penggunaan ulang `masterSeed` untuk
    beberapa seed turunan (encryption, PQ, signing, prekey, signing-v2)?

## 36.7 Format temuan yang diminta

Untuk setiap temuan:

```
Severity: Critical | High | Medium | Low
Lokasi: path/file.ts:line (dan spec/vektor terkait)
Konstruksi: apa yang seharusnya terjadi
Skenario: langkah penyerang + asumsi (network, server, dump DB, perangkat)
Dampak: kerahasiaan/integritas/otentikasi/metadata
Perbaikan yang disarankan: perubahan minimal, bukan redesign
```

Temuan yang memerlukan perubahan format frozen (`docs/04`) harus ditandai
eksplisit: perubahan itu memutus kompatibilitas v1 dan butuh rencana migrasi,
bukan sekadar patch.

## 36.8 Yang tidak diklaim dokumen ini

- Tidak ada jaminan bebas bug.
- Tidak ada klaim "tahan kuantum" untuk Tier B, KT v1 read path, atau credential
  v1.
- Tidak ada klaim bahwa metadata (graf/timing/volume) tersembunyi.
- Tidak ada klaim bahwa kode sudah diaudit — justru sebaliknya.
