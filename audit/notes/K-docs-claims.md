# K — Audit baris-per-baris `docs/01` & `docs/04`

HEAD `25b1699`, diperiksa 2026-10-26. Setiap klaim diuji ke kode; hasilnya
dipetakan ke klaim **C19–C35** di `00-ringkasan.md` dan drift **#19–#26** di
`04-docs-drift.md`.

## `docs/01-architecture.md`

| Klaim (baris) | Bukti di kode | Status |
|---|---|---|
| `components/` ~90 file (:8) | `find web/src/components -type f` = **77** | angka basi (drift #25) |
| `store/` 21 Zustand store (:9) | `ls web/src/store/*.ts` = **21** | OK |
| `routes/` 17 modul (:17) | **21** router di-mount di `app.ts` (`/api/groups` :275, `/api/keys/kt` :430, `/api/keys` :435, `/api/call-tokens` :436, `/api/pir` :441, `/api/auth`…`/api/system` :481-498, `/api/stories` :497), 23 berkas di `routes/` | angka basi (drift #25) |
| `jobs/` hanya messageSweeper & systemSweeper (:20) | 5 job: `cleanup`, `ktSnapshot`, `messageSweeper`, `pirSnapshot`, `systemSweeper` | daftar tidak lengkap (drift #25) |
| `prisma/ … migrations (baseline 0_init)` (:23) | `server/prisma/migrations/0_init` ada | OK |
| `packages/shared` dari `dist/` (:26) | `packages/shared/package.json` → `main: dist/index.js` | OK |
| `nyx-sdk removed` (:27) | tidak ada direktori `packages/*sdk*` | OK |
| `marketing` independen (:28) | 0 impor `web/src` dari `marketing/src` | OK |
| Worker crypto hanya via proxy (:37-39, :92) | `crypto-worker-proxy.ts:7` (`?worker`), `:14` satu instance; tidak ada `new Worker(crypto…)` lain | OK |
| Jalur realtime QUIC→sidecar→Redis→Node→Prisma (:44) | `main.rs:765` publish `nyx:upstream:<op>`, `redisBridge.ts:78` `pSubscribe('nyx:upstream:*')` | OK |
| KT satu pemilik LevelDB, tulis :8081, baca :8085 (:58-60) | `.env.example:117,129`; `docs/10:11` (8081 gRPC, 8085 HTTP); `kt-query` flock test | OK |
| PostgreSQL 18 (:52) | `docker-compose.yml:4` `postgres:18-alpine` | OK untuk compose; versi VPS tidak diverifikasi |
| VPS 4 core / 8 GB (:51) | hanya dokumen (`docs/26`); tidak ada di kode | tidak diverifikasi |
| Sidecar UDP :33333 (:109) | `main.rs:268` default `33333`, `:506` log listen | OK |
| `main.tsx` impor zodSetup pertama, lalu i18n (:12) | `main.tsx:1-6` (`./zodSetup` → `./i18n`) | OK |
| `initSocketListeners` jalan sekali saat impor (:107) | `App.tsx:98` impor, `:102` panggil di top-level modul | OK (top-level, bukan saat impor `socketListeners`) |
| Server `index.ts` konek Redis dulu (:108) | `index.ts:8` `await connectRedis()` sebelum `import('./app.js')` | OK |
| Batas dependensi: web/server hanya `@nyx/shared` (:89-90) | `grep from '@nyx/` di `server/src` & `web/src` → hanya `@nyx/shared` | OK |
| Sidecar hanya Redis, tanpa HTTP (:91) | `Cargo.toml` tidak punya warp/hyper/axum/reqwest/actix | OK |
| Pesan di server ≤14 hari (:99) | `messageSweeper.ts:101` `14 * 24*60*60*1000` | OK |
| Profil terenkripsi (:101) | `schema.prisma:27` `encryptedProfile String? @db.Text` | OK |
| Attachment R2 + OPFS (:102) | `web/src/lib/opfsStorage.ts`; route upload R2 | OK |
| Story terenkripsi (:103) | `routes/stories.ts:66,81` hanya `encryptedPayload` | OK |

## `docs/04-crypto-protocol.md`

| Klaim (baris) | Bukti di kode | Status |
|---|---|---|
| "All cryptographic code runs in `crypto.worker.ts`" (:5) | libsodium dipakai di main thread: `biometricUnlock.ts:52,78,102,125` (BLAKE2b + XChaCha AEAD), `contactStore.ts:353`, `groupPseudonyms.ts:34`, `backupFormat.ts:141` | **salah sebagai pernyataan menyeluruh** (drift #19) |
| Primitif XChaCha20-Poly1305 (:9) | worker `xchachaSealBytes`, `crypto_secretbox_*` | OK |
| X25519 + ML-KEM-768 via X-Wing (:10) | `crypto_kem_xwing_enc/seed_keypair` (`crypto.worker.ts:891-905,700`) | OK |
| Argon2id 128MB/4, 64MB/3, 19MB/2 (:11) | `ARGON_VAULT_CONFIG` 131072/4 dan `ARGON_INDEX_CONFIG` 65536/3 (`crypto.worker.ts:94-108`); panic 19456/2 (`keyStorage.ts:49-53`) | OK |
| BLAKE2b (:11) | `crypto_generichash` (`crypto.worker.ts:240-241,508`) | OK |
| Tanda tangan "Ed25519" (:12) | Ed25519 masih ada, tetapi **ML-DSA-65** dipakai untuk kunci v2 (`signingV2`, `ml_dsa_sign`, `crypto.worker.ts:697-704,771`; `crypto.ts:232-235`) | **tidak lengkap** (drift #22) |
| Envelope `base64url(nonce24‖ct)` (:20) | `xchachaSealBytes` + `sodium.to_base64(...URLSAFE_NO_PADDING)` | OK |
| Envelope dipakai story/call/profile/ShadowVault (:22-24) | story `storyCrypto.ts:24`; call `crypto.ts:902-905`; profile `crypto.worker.ts:1324-1338`; ShadowVault → `localAtRest.ts:90-92` → `keychainDb.ts:32-48` (**ENC1**, op `encrypt_session_key`, bukan `xchacha_seal`) | **sebagian** (drift #20) |
| Biometrik `{ciphertext, iv}` + kunci PRF (:25) | `biometricUnlock.ts:99,125,322-327` | OK |
| Bundle `salt.JSON({iv:number[],data:number[]})`, field tetap (:30-35) | `DECRYPT_DATA` membaca `iv`/`data`; field `encryption,pqEncryption,signing,signedPreKey,pqSignedPreKey,masterSeed` (`crypto.worker.ts:459-482`), **plus `signingV2`** | **tidak lengkap** (drift #22) |
| PQX3DH: initiator memverifikasi tanda tangan signed-pre-key (:41) | Jalur v2 **tidak** memverifikasi `pqSignature`: hanya dicek ada (`crypto.ts:3091`) lalu di-decode (`:3115`) dan tidak dipakai — komentar `:3133-3136` ("`pqSignature` sengaja tidak dibaca"); autentikasi = ML-DSA atas transkrip handshake yang diverifikasi **penerima** (`crypto.worker.ts:950,1000`) | **terbantah untuk v2** (C22) |
| X-Wing + BLAKE2b → `dr_init_alice/bob` (:42-43) | `crypto.worker.ts:891-931` (`crypto_generichash(32, concatenated)`), lalu `dr_init_*` | OK |
| DR: state & mk ter-seal, skipped keys ter-seal (:47-50) | `keychainDb.ts:68-75` (`encryptSkippedKeysAtRest`), helper `storeRatchetStateSecurely` | OK |
| Own-message: mk dulu, fallback DR, lalu `waiting_for_key` (:51) | `messagePipeline.ts` (jalur `waiting_for_key`), `docs/04` sesuai perilaku | OK |
| x3dh-until-confirmed, `ackKem`/`peerAckedKem`, tolak `ct` hilang (:52) | `drProtocol.ts:32,43,84,105-109`; `crypto.worker.ts:1762` error sebelum mutasi | OK |
| Ratchet v2: gate dua relay, `ackV:2`, header `{v:2,b:[]}` ≤16 frame/4096 char (:56-75) | `spqrWire.ts:47,54,78-80`; `SERVER_CAPABILITIES` di `packages/shared/src/transport.ts:67`; `transportCapability.ts` | OK |
| State braid `nyx_spqr_state_v1:*` ENC1, debounce 250 ms (:86-90) | `spqrState.ts:44,55,192` | OK |
| Kill switch hanya kirim, bukan baca (:92-99) | `spqrNegotiation.ts` (`VITE_SPQR_FORCE_V1`, `nyx_spqr_force_v1`); pembaca v2 tetap aktif | OK (E2E tidak dijalankan) |
| Grup: metadata keluar chain, chainId acak 64-bit, arsip era ≤5 (:104-109) | `crypto.ts:246-260` (tipe `group_metadata`, signature atas `ct`), `keychainDb.ts:315-332` (`MAX_ARCHIVED_RECEIVER_STATES = 5`) | OK |
| Distribusi hanya v2 77 byte; v0/v1 dibuang dengan peringatan (:109) | v2 77 B, **v3 85 B** (+senderKeyId), **v4 2037 B** (+signingKeyV2) di `packages/shared/src/groupEnvelope.ts:24-41,128-167`; pengirim menulis v4 bila `signingV2` ada, else v2 (`crypto.ts:1276-1300`); v3/v4 diterima `:1635-1644`; laporan legacy `:1444-1467` | **tidak lengkap** (drift #23) |
| Metadata v2 `{v,kind,chainId,ct,signature,senderDeviceKey}` (:106) | `crypto.ts:239-259` juga menulis `sigV` dan (opsional) `senderKeyId` | **tidak lengkap** (drift #23) |
| Reload paksa satu kali per tab per sesi (:109) | `serviceWorkerRegistration.ts:15-20,45` (`SW_RELOAD_MARKER`) | OK |
| `426 CLIENT_TOO_OLD` bila `MIN_CLIENT_VERSION` diset (:109) | `middleware/clientVersion.ts:63`; `clientVersionGate` di `app.ts:269` | OK (fail-open tanpa header → D1) |
| Burner PQ-DR + `burner:terminated` (:111-112) | `crypto.worker.ts:2208-2360`; `realtimeHandlers.ts:954-957`, TTL 86400 | OK |
| `ENC1:` = prefix + `encrypt_session_key(bytes, masterSeed)` (:116) | `keychainDb.ts:32-48` | OK |
| Diterapkan pada chain/skipped/story/braid (:118) | `keychainDb.ts:68-75,773`; `keyStorage.ts:266-283` migrasi saat unlock | OK |
| Legacy plaintext terbaca; gagal dekripsi → `null` (:120-121) | `keychainDb.ts:50-64` | OK, **tetapi** penulisan gagal → plaintext (D7, drift #26) |
| Attachment: header+chunk 1MB+TAG_FINAL, alokasi sekali (:124-126) | `crypto.worker.ts:1042-1063`; `file_decrypt` cek TAG_FINAL `:1134` | OK |
| Padding 8192 B; chaff 1000 B/~3 s opcode 0x00 (:129-130) | `crypto.worker.ts:127,1698`; `transport.worker.ts:13-16,131`; `TransportOpCode.CHAFF = 0x00` (`packages/shared/src/transport.ts:2`) | OK |
| Katalog 48 op (:132-156) | **50** case (`crypto.worker.ts`), 7 nama dokumen sudah tidak ada (`crypto_box_seal`, `pq_box_seal`, `x3dh_initiator`, …), 9 nama baru tidak tercantum (`ml_dsa_*`, `pq_box_seal_v2*`, `x3dh_v2_*`) | **terbantah** (drift #24) |
| Proxy `{id,type,payload}`, typed array + transferable, timeout 120/600/300 s (:160-161) | `crypto-worker-proxy.ts:56,58,72,191,359-367` | OK (kecuali `ENCRYPT_DATA` yang membawa `number[]` sesuai §4.3) |

## Ringkas

- **Terbukti:** 10 (C21, C23, C24, C27, C28, C29, C30, C31, C32, C33).
- **Terbukti sebagian / tidak lengkap:** 3 (C20 ShadowVault via ENC1, C25 v3/v4,
  C26 ML-DSA-65 tidak tercantum).
- **Terbantah:** 4 (C19 "semua kripto di worker", C22 verifikasi SPK v2,
  C34 angka layout, C35 katalog 48 op).

Total 17 klaim (C19–C35).
- Tidak ada klaim yang salah arah secara keamanan **kecuali C22**: dokumen
  menyiratkan signed-pre-key diverifikasi, padahal jalur v2 menggantinya dengan
  tanda tangan transkrip handshake (verifikasi di penerima) dan hanya memeriksa
  keberadaan `pqSignature`.
