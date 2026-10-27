# 00 — Ringkasan audit NYX (HEAD `25b1699`, 2026-10-25)

**Vonis keseluruhan: BLOKIR RILIS** — bukan karena kripto pesannya rusak (bagian
itu justru paling rapi), tetapi karena (a) tiga gate CI merah di HEAD, (b) deploy
dapat hijau dengan skema DB lama, dan (c) satu kontrol anti-abuse baru tidak
berfungsi sama sekali.

## Vonis per area

| Area | Vonis | Alasan singkat |
|---|---|---|
| A. Kriptografi & protokol | **Perlu perbaikan** | Cutover PQ benar-benar fail-closed di klien (X3DH v2 wajib, tanpa fallback). Yang gagal adalah **gate**-nya: `check-pq-only` merah (F-05), dan server masih menerima bundle klasik — dijaga hanya oleh klien (residual bermetrik, bukan kebocoran). |
| B. Key Transparency | **Aman (dengan catatan)** | Mismatch tidak pernah jadi pin, memicu peringatan; monitor fail-closed. Gap: error tak terduga = tanpa peringatan apa pun (F-09). |
| C. Privasi metadata / closure | **Perlu perbaikan** | Token hash-at-rest + sync anonim + mailbox memang ada dan diuji; tetapi skema barunya tidak punya jalur migrasi (F-04), respons sync tanpa batas (F-10), dan log produksi memuat identifier (F-02). |
| D. OPRF + PIR | **Aman bersyarat** | Pencarian menolak identifier mentah (anti-oracle), OPRF default mati, PIR default mati, query hanya diteruskan. Angka/keamanan PIR tetap tidak diaudit (dinyatakan). |
| E. Auth, sesi, perangkat | **Perlu perbaikan** | Device-linking QR solid (state machine + 10 test). Dua masalah nyata: Privacy Pass replay (F-01) dan cookie tanpa `Secure` di produksi (F-02). |
| F. Transport & relay | **Aman** | Empat lubang paritas benar-benar ditutup; rate limit satu sumber di handler; KICK terkirim sebelum close. Catatan: clippy merah (F-12), duplikasi frame KICK (D5). |
| G. Server umum | **Perlu perbaikan** | Otorisasi rute dan group-gate terkunci di util + test. Masalah ada di operasional: `NODE_ENV` (F-02), migrasi (F-04), override dependensi inert (F-08). |
| H. Frontend | **Perlu perbaikan ringan** | i18n sempurna (0 hilang), CSP tanpa `unsafe-eval`, Dexie aditif. Gap KT tidak terlihat pengguna (F-09) + drift v13/v16. Cakupan XSS terbatas (lihat `06`). |
| I. Infra, supply chain, ops | **Blokir rilis** | `pnpm audit --prod` merah (3 high), PQ gate merah, `db push \|\| true`, job singleton di semua worker cluster, `resolutions` inert. |
| J. Test & CI | **Perlu perbaikan** | Suite hijau (server 659/657 pass/2 skip, web 1007) dan semua 83 berkas test terdaftar — tetapi test tidak menangkap F-01, dan tiga job CI merah. |

## 10 risiko teratas

1. **F-04** — deploy hijau + skema DB lama (kolom wajib baru, `db push || true`)
   → discovery grup mati total, rollback tidak otomatis.
2. **F-02** — `NODE_ENV` tidak pernah `production`: cookie sesi tanpa `Secure`,
   morgan mencatat identifier/token di query, CORS menerima origin `http://`.
3. **F-03** — 3 kerentanan high di dependensi produksi (zod, body-parser,
   undici); job `audit` merah.
4. **F-01** — redemption Privacy Pass tidak `NX`/`EX`: token bisa di-replay
   selamanya dan key Redis tumbuh tanpa batas.
5. **F-07** — job singleton berjalan di setiap worker pm2; exporter metrik hanya
   hidup di satu worker → alert memakai 1/4 data, R2/PIR 4×.
6. **F-05** — guard PQ-only merah; pengecualian baru tidak tercatat.
7. **F-06** — `OHTTP_TOKEN_MODE=off` tidak bisa dipakai di topologi cluster
   (rahasia acak per proses).
8. **F-10** — `/api/groups/sync` tanpa batas ukuran respons (dokumen menjanjikan
   256 KB/200 item) — endpoint tanpa sesi.
9. **F-08** — 28 pin keamanan di `resolutions` tidak pernah berlaku (pnpm),
   memberi rasa aman palsu.
10. **F-09** — kegagalan verifikasi KT tidak pernah terlihat pengguna.

## Status klaim keamanan (C1…C18)

| # | Klaim (sumber) | Status |
|---|---|---|
| C1 | Isi pesan tidak bisa dibaca server (XChaCha + padding 8 KB) — `docs/03` | **Terbukti di kode** (envelope & padding tidak berubah; tidak dikriptanalisis di sini) |
| C2 | Username tidak terlihat server (Argon2id klien) — `docs/03` | **Terbukti sebagian** — tidak bisa dibalik, tetapi `usernameHash`/`oprfIndex` adalah pengenal stabil yang bisa diuji tebakannya oleh server yang memegang seed |
| C3 | Server tidak bisa merekonstruksi graf sosial — `docs/03`, `docs/28` | **Terbantah untuk server hidup** (inviter mengirim `userIds`, `UPSERT membership` menyimpan routing identity yang dibuka server); **terbukti untuk dump DB** (kolom disegel) dan untuk sync anonim |
| C4 | Token grup/anggota hanya tersimpan sebagai hash — `docs/37` | **Terbukti** (`tokenHash @unique`, `authSecret` hash, timing-safe compare) |
| C5 | Sync anonim tanpa `userId`/JWT — `docs/37` §37.3.3 | **Terbukti** (route hanya memakai hash token; sumber diuji) |
| C6 | PQ-only tanpa fallback klasik — `docs/35` | **Terbukti di klien**; **tidak** di server (bundle klasik masih diterima, dihitung metrik) |
| C7 | Ratchet v2 hanya dipakai setelah peer membuktikan bisa membaca (`ackV`) | **Terbukti di kode + test**; E2E tidak dijalankan |
| C8 | KT fail-closed / mismatch memblokir pin — `docs/34` | **Terbukti** untuk monitor & pin; **gagal-terbuka tanpa peringatan** saat error (F-09) |
| C9 | PCS per-pesan untuk grup | **Terbantah** — yang ada rotasi epoch kasar (didokumentasikan jujur di `docs/37` §37.3.6) |
| C10 | Dump DB tidak memuat identifier (ENC2/pepper) — `docs/28` | **Terbukti** untuk kolom disegel; blind index tidak bisa dirotasi (batas yang diakui) |
| C11 | OHTTP menyembunyikan IP klien dari API — `docs/35` Fase 3 | **Terbukti bersyarat** — header identitas dibuang & allowlist sempit, tetapi relay default masih satu host/proses |
| C12 | Privacy Pass = anti-abuse unlinkable | **Terbantah untuk anti-abuse** (F-01: replay tak terbatas); unlinkability tetap bergantung OHTTP |
| C13 | Pencarian menolak identifier mentah (anti-oracle) — R5 | **Terbukti** (`isSearchableIdentifier` sebelum DB) |
| C14 | Query PIR opaque bagi server | **Terbukti** (proxy byte); fitur default mati, angka tidak diaudit |
| C15 | Atestasi perangkat fail-closed | **Terbukti** (rantai diverifikasi sebelum akun dibuat; root basi = alert) |
| C16 | Sesi: HttpOnly + rotasi refresh + deteksi replay | **Terbukti** (kode + test) — tetapi cookie tanpa `Secure` di produksi (F-02) |
| C17 | Gate lint/keamanan memblokir CI | **Terbantah** — 3 job merah (F-03, F-05, plus F-12 di luar CI) |
| C18 | Log server tidak memuat identifier/rahasia — `docs/28` | **Terbantah** — morgan `dev` mencatat URL penuh termasuk `?q=<hash>` dan `?token=` (F-02) |

### Klaim `docs/01` & `docs/04` (C19–C35)

Diverifikasi baris-per-baris; bukti per klaim di `notes/K-docs-claims.md`.

| # | Klaim (sumber) | Status |
|---|---|---|
| C19 | Semua kode kripto di `crypto.worker.ts`, main thread hanya lewat proxy — `docs/04:5` | **Terbantah sebagian** — `biometricUnlock`, `contactStore`, `groupPseudonyms`, `backupFormat` memakai libsodium di main thread; worker tetap satu-satunya jalur untuk op katalog |
| C20 | Envelope kanonik dipakai story/call/profile/ShadowVault, biometrik pengecualian — `docs/04:22-25` | **Terbukti sebagian** — story/call/profile ✓; ShadowVault memakai `ENC1:` (`encrypt_session_key`), bukan `xchacha_seal`; biometrik `{ciphertext, iv}` ✓ |
| C21 | Bundle `salt.JSON({iv:number[],data:number[]})` + field tetap — `docs/04:30-35` | **Terbukti**, tetapi field `signingV2` tidak tercantum di dokumen |
| C22 | Initiator PQX3DH memverifikasi tanda tangan signed-pre-key — `docs/04:41` | **Terbantah untuk v2** — `crypto.ts:3133-3136` menyatakan `pqSignature` sengaja tidak dibaca; autentikasi lewat ML-DSA atas transkrip handshake yang diverifikasi **penerima** (`crypto.worker.ts:950,1000`) |
| C23 | DR: state/mk/skipped ter-seal, `waiting_for_key`, x3dh-until-confirmed + `ackKem` — `docs/04:47-52` | **Terbukti** |
| C24 | Ratchet v2: gate dua relay, `ackV:2`, header ≤16 frame/4096 char, state `ENC1` debounce 250 ms, kill switch hanya kirim — `docs/04:56-99` | **Terbukti** (E2E tidak dijalankan) |
| C25 | Grup v2: metadata keluar chain, chainId acak, arsip ≤5, distribusi 77 B, v0/v1 dibuang — `docs/04:104-109` | **Terbukti sebagian** — envelope **v3 85 B** (+`senderKeyId`) dan **v4 2037 B** (+`signingKeyV2`) kini diterima; pengirim menulis v4 bila `signingV2` ada, jika tidak v2. Metadata membawa `sigV:2` & `senderKeyId` opsional (tidak didokumentasikan) |
| C26 | Primitif: XChaCha, X-Wing, Argon2id (128/4, 64/3, 19/2), BLAKE2b, Ed25519, secretstream — `docs/04:9-14` | **Terbukti sebagian** — parameter Argon2 & primitif cocok; tanda tangan **ML-DSA-65** untuk kunci v2 tidak tercantum |
| C27 | `ENC1:` diterapkan pada chain/skipped/story/braid, legacy terbaca, migrasi saat unlock — `docs/04:116-121` | **Terbukti**; catatan fail-open: penulisan jatuh ke plaintext bila masterSeed tak tersedia (D7) |
| C28 | Attachment secretstream: header+1 MB+TAG_FINAL, alokasi sekali, kunci 32 B di metadata — `docs/04:124-126` | **Terbukti** |
| C29 | Padding 8192 B (v1 & v2); chaff 1000 B/~3 s opcode `0x00` — `docs/04:129-130` | **Terbukti** |
| C30 | Proxy: `{id,type,payload}`, typed array + transferable, timeout 120/600/300 s — `docs/04:160-161` | **Terbukti** (kecuali `ENCRYPT_DATA` yang membawa `number[]` sesuai §4.3) |
| C31 | Relay buta; jalur realtime QUIC→sidecar→Redis→Node→Prisma; KT satu pemilik LevelDB (:8081 tulis, :8085 baca); PG18 — `docs/01:44-60` | **Terbukti** di kode/konfigurasi; kapasitas VPS 4c/8G hanya dari dokumen |
| C32 | Batas dependensi: `@nyx/shared` dari dist, web/server tak berbagi runtime lain, marketing independen, sidecar hanya Redis — `docs/01:89-93` | **Terbukti** |
| C33 | Kepemilikan data: pesan ≤14 hari, kunci `ENC1`, profil terenkripsi, R2+OPFS, story terenkripsi — `docs/01:99-103` | **Terbukti** (`messageSweeper.ts:101`, `schema.prisma:27`, `opfsStorage.ts`) |
| C34 | Layout: 17 route module, komponen ~90, jobs messageSweeper/systemSweeper — `docs/01:8-20` | **Terbantah angka** — 21 router di-mount, 77 berkas komponen, 5 job |
| C35 | Katalog worker **48 op** — `docs/04:132-156` | **Terbantah** — 50 op; 7 nama usang (`crypto_box_seal`, `pq_box_seal`, `x3dh_initiator`…), 9 nama baru tak tercantum (`ml_dsa_*`, `pq_box_seal_v2*`, `x3dh_v2_*`) |

## Apa yang tidak diperiksa

E2E Playwright, migrasi DB nyata, review baris-per-baris seluruh
`crypto.worker.ts`, KAT independen, WASM reprodusibel, benchmark PIR, XSS
per-komponen, `drill-alerts.sh`, fuzz 1 jam, dan konfigurasi nyata di VPS.
Alasan + risiko tiap baris: `06-tidak-diperiksa.md`.

Berkas audit: `01-change-map.md`, `02-findings.md` (15 temuan + 7 pengamatan +
konfirmasi positif), `03-domino-matrix.md`, `04-docs-drift.md` (27 drift),
`05-baseline.md`, `06-tidak-diperiksa.md`, `07-fix-plan.md`, dan catatan
per-domain di `notes/A-…`–`notes/K-…`.
