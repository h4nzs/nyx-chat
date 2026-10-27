# 04 — Drift dokumen ↔ kode

Semua baris di bawah diverifikasi dengan membaca kode/berkas, bukan dari ingatan.
Prioritas: **P1** membuat operator/kontributor salah langkah; **P2** menyesatkan
tapi tidak berbahaya; **P3** kosmetik.

> **Tindak lanjut 2026-10-26:** #19–#24, #26, dan #27 sudah diperbaiki (working
> tree, belum commit) — #19–#24/#26 di `docs/04`, #27 di `docs/16`, `docs/21`,
> `docs/26`, `docs/29`. #25 (angka layout `docs/01`) belum diperbaiki. Baris di
> bawah tetap menggambarkan keadaan HEAD `25b1699` yang diaudit.

| # | Pri | Dokumen | Klaim | Kenyataan (bukti) |
|---|---|---|---|---|
| 1 | P1 | `CONTRIBUTING.md:22` | "jalankan `pnpm dev`" | tidak ada skrip `dev` di `package.json` root (hanya `build/test/lint/bump/version`). Yang benar: `pnpm --filter nyx-server dev` + `pnpm --filter nyx-web dev` (+ sidecar). |
| 2 | P1 | `docs/18-realtime-transport.md:59` | "TURN credentials … (Cloudflare TURN; Google STUN fallback)" | `server/src/routes/keys.ts:679-686` menyatakan STUN pihak ketiga **dihapus**; urutannya coturn (`TURN_URLS`+`TURN_STATIC_AUTH_SECRET`) → Cloudflare → STUN operator (`ICE_STUN_URLS`) → 503/502. Tidak ada Google STUN. |
| 3 | P1 | `docs/29-signal-parity-analysis.md:571` (roadmap #3) | "Buang fallback Google STUN" masih berstatus pekerjaan | sudah selesai di kode (`keys.ts:679`, `web/src/lib/webrtc.ts` tidak lagi menyebut `stun.l.google.com`). |
| 4 | P1 | `AGENTS.md:39`, `docs/30:943`, `docs/34:351` | Dexie `ktGossip` di **v13** | `web/src/lib/db.ts:415-443` sudah **v16** (v14 `ktConfig`, v15 `groupCredentials`, v16 drop `groupCredentials`). Angka v13 masih benar untuk tabel gossip, tetapi "NyxUnifiedDB v13" salah. |
| 5 | P1 | `docs/37` §37.3.3 | sync: "batas ukuran respons (≤ 256 KB, ≤ 200 item)" | `MAX_SYNC_TOKENS = 500`, tidak ada batas byte/`truncated` (F-10). |
| 6 | P1 | `docs/37` §37.4 P0 | "DB lokal/selfhost di-reset" sebagai bagian hard cut | tidak ada langkah reset di `deploy.yml`; yang ada `prisma db push \|\| true` (F-04). |
| 7 | P1 | `docs/10-deployment-ops.md:114` tabel env | `NODE_ENV=production` | `deploy.yml:260-263` tidak menyetelnya; §10.20 di dokumen yang sama mencatatnya sebagai insiden terbuka (F-02). |
| 8 | P2 | `AGENTS.md` (lint) | "194 warning `no-unused-vars`" | hasil `pnpm run lint` hari ini: **193 warning, 0 error** (`web` 193; `server`/`shared` 0). |
| 9 | P2 | `AGENTS.md` (sidecar) | toolchain Rust termasuk clippy (dan `audit.md` memintanya) | clippy `transport-sidecar` **gagal** 3 lint dan tidak ada job CI yang menjalankannya (F-12). |
| 10 | P2 | `AGENTS.md` (KT) | "reads stay on v1 via `KT_QUERY_URL`" sebagai kondisi sekarang | `docs/37` §37.2/§37.4 P7 menyatakan cutover baca v2 sudah live di selfhost dan `KT_QUERY_URL` menunjuk v2. Dua dokumen saling bertentangan; kode netral (`KT_READ_MODE`). |
| 11 | P2 | `docs/37` §37.9.5 gate | "Sampai keenam gate terpenuhi, baris Fase 5 … tetap riset" | benar, **tetapi** `scripts/check-pq-only.mjs` tetap merah karena `RSABSSA` baru tidak masuk manifest (F-05). Dokumen dan gate tidak sinkron. |
| 12 | P2 | `docs/12-api-reference.md:240` | OHTTP allowlist default menyebut 4 target | cocok dengan `OHTTP_DEFAULT_ALLOWLIST`; tetapi batas body 64 KB hanya berlaku untuk `/api/groups/sync` (`ohttpBodyLimitFor`) — kalimatnya bisa dibaca berlaku umum. |
| 13 | P2 | `server/src/app.ts:237` komentar | "Syncing Prisma schema (index-only changes)" | rilis ini menambah tabel + kolom wajib; komentar menyesatkan operator yang membaca log deploy. |
| 14 | P3 | `README.md` / `docs/11` angka test | (tidak diuji ulang seluruhnya) | angka yang bisa saya konfirmasi: server 659 (657 pass/2 skip), web 1007 di 125 berkas. Jika README menyebut angka lain, itu drift. |
| 15 | P3 | `docs/37` §37.6 tabel | `nyx-ohttp-relay` port 4100 | benar (`relay.ts:19`), tetapi mode `off` tidak bisa dipakai di topologi pm2 cluster (F-06). |
| 16 | P3 | `package.json` `resolutions` | 28 pin keamanan | pnpm mengabaikannya (F-08); dokumen/komentar yang mengandalkan pin ini tidak punya dasar. |
| 17 | P3 | `pnpm-workspace.yaml` | `allowBuilds.puppeteer: "set this to true or false"` | nilai placeholder, bukan boolean. |
| 18 | P3 | `docs/12` / kode CORS | header `x-delivery-tokens` masih di-whitelist | header-nya sudah dihapus dari protokol (hard cut); sisa artefak. |
| 19 | P2 | `docs/04:5` | "All cryptographic code runs in `crypto.worker.ts`" | tidak benar: `biometricUnlock.ts:52,78,102,125`, `contactStore.ts:353`, `groupPseudonyms.ts:34`, `backupFormat.ts:141` memakai libsodium di main thread. Worker tetap satu-satunya jalur untuk operasi katalog, tetapi pernyataan menyeluruh ini menyesatkan auditor. |
| 20 | P3 | `docs/04:22-24` | Shadow Vault text memakai envelope kanonik `xchacha_seal` | `shadowVaultDb.ts:14-16` → `localAtRest.ts:90-92` → `keychainDb.ts:32-48`: memakai `ENC1:` + `encrypt_session_key` (XChaCha juga, tetapi jalur/kunci berbeda). |
| 21 | P2 | `docs/04:41` | initiator PQX3DH "verifies signed-pre-key signature" | jalur v2 tidak membacanya: `crypto.ts:3091,3115` (hanya cek ada + decode) dan `:3133-3136` menyatakan `pqSignature` sengaja tidak dipakai; autentikasi berasal dari tanda tangan ML-DSA atas transkrip handshake yang diverifikasi penerima (`crypto.worker.ts:950,1000`). Dokumen membuat pembaca mengira ada verifikasi yang tidak ada. |
| 22 | P2 | `docs/04:12`, `:30-35` | signatures hanya Ed25519; field bundle berhenti di `masterSeed` | kunci v2 memakai **ML-DSA-65** (`signingV2`, `ml_dsa_sign`, `crypto.worker.ts:697-704`), dan bundle sekarang membawa `signingV2` (`crypto.worker.ts:459-482`). |
| 23 | P2 | `docs/04:104-109` | distribusi hanya menerima envelope v2 77 byte; metadata v2 `{v,kind,chainId,ct,signature,senderDeviceKey}` | kode menerima **v3 85 byte** (`+senderKeyId`) dan **v4 2037 byte** (`+signingKeyV2`); pengirim menulis v4 bila `signingV2` ada, selain itu v2 (`crypto.ts:1276-1300`, `packages/shared/src/groupEnvelope.ts:24-41,128-167`) dan metadata membawa `sigV:2` + `senderKeyId` opsional (`crypto.ts:239-259`). |
| 24 | P2 | `docs/04:132-156` | katalog **48 op** | kode punya **50** case; 7 nama dokumen sudah tidak ada (`crypto_box_seal`, `pq_box_seal`, `x3dh_initiator`…), 9 nama baru tidak tercantum (`ml_dsa_*`, `pq_box_seal_v2*`, `x3dh_v2_*`). Siapa pun yang mengikuti katalog akan memanggil op yang tidak ada. |
| 25 | P3 | `docs/01:8-20` | `components/ ~90 file`, `routes/ 17 modul`, `jobs/ messageSweeper + systemSweeper` | aktual: **77** berkas komponen, **21** router di-mount (`app.ts:275,430-498`), **5** job (`cleanup`, `ktSnapshot`, `messageSweeper`, `pirSnapshot`, `systemSweeper`). |
| 26 | P3 | `docs/04:116-121` | nilai keychain "wrapped" `ENC1:`; hanya legacy yang plaintext | `encryptValueAtRest` **menulis plaintext** bila masterSeed tidak tersedia atau enkripsi gagal (`keychainDb.ts:33-47`, hanya `console.warn`). Perilaku fail-open ini tidak didokumentasikan (D7). |
| 27 | P3 | `docs/16:54,87,176`, `docs/21:50`, `docs/26:92,105,133,508`, `docs/29:218` | sealing per-device memakai `pq_box_seal`; `docs/21` juga mendaftar `worker_crypto_box_seal(_open)` dan `worker_pq_box_seal(_open)` | op klasik sudah dihapus; yang ada `pq_box_seal_v2` (X-Wing, magic `NYS2`, parameter kunci klasik diabaikan — `pqBoxSeal.ts:5-30`). Sudah diperbarui 2026-10-26. |

## Drift yang **tidak** saya temukan (klaim yang ternyata benar)

- Paritas kunci i18n 4 bahasa: 0 hilang, 0 yatim, 7 namespace.
- `scripts/check-vendor.sh` dan `scripts/check-wasm-artifacts.sh` lulus → pin vendor
  dan manifest WASM cocok dengan isi repo.
- `tools/dr-oracle -check` lulus → vektor yang dikomit identik dengan regenerasi.
- Daftar 83 berkas test server benar-benar dijalankan semua.
- `docs/03` §3.7 (trade-off) dan `AGENTS.md` (format beku) konsisten dengan kode
  yang saya periksa: `ENC1:`/`ENC2:` berdampingan, padding 8 KB, envelope tidak berubah.
