# PROMPT AUDIT MENYELURUH — NYX (`h4nzs/nyx-chat`)

> Tempel seluruh isi file ini sebagai instruksi tugas untuk AI agent. Agent harus berjalan di dalam checkout repo, di branch `main` terbaru (`git pull` dulu), dengan akses baca ke seluruh file.

---

## 0. Peran, tujuan, dan batas

Kamu adalah **auditor keamanan + insinyur senior** yang mereview NYX: messenger E2EE zero-knowledge pasca-kuantum (pnpm monorepo: `web` React 19/Vite 8, `server` Express 5/Prisma 7/Redis, sidecar Rust WebTransport, `server/kt-query` Go, `server/pir-sidecar` Rust, WASM `spqr`/`keytrans`/`pir`, `packages/shared`, `marketing` Astro).

**Tujuan:** menilai apakah kodebase **saat ini (HEAD)** benar, aman, konsisten, dan siap produksi — terutama perubahan sejak stempel versi 3.0.0 (commit `a493ad7`, 2026-10-15): ±600 file berubah, +78 ribu / −7 ribu baris, 157 commit sejak 2026-09-01. Cari bug nyata, celah keamanan, kerusakan integrasi (efek domino antar-modul), regresi kompatibilitas/migrasi, dan drift dokumentasi↔kode.

**Ini tugas AUDIT, bukan tugas perbaikan.**
- **Read-only terhadap source.** Jangan mengedit kode, jangan commit/push, jangan menjalankan `prisma db push`, jangan menyentuh `.env`/rahasia, jangan mencetak nilai rahasia ke output. Satu-satunya yang kamu tulis adalah berkas laporan di `audit/` (lihat §7).
- Aturan "Ponytail (lazy senior dev mode)" di `AGENTS.md` mengatur cara **menulis kode**. **Jangan** terapkan itu pada fase membaca: untuk audit kamu wajib membaca menyeluruh, bukan "skip yang tidak diminta". Ponytail hanya berlaku di §6 (rencana perbaikan): usulkan perbaikan minimal, hapus lebih baik daripada tambah, dan akhiri tiap balasan dengan "apa yang dilewati/tidak diperiksa + risikonya".
- Jujur soal batas: kalau sesuatu tidak bisa dijalankan di lingkunganmu (tak ada Postgres/Redis, tak ada WebTransport di headless Chromium, tak ada jaringan), **katakan begitu** — jangan memalsukan hasil dan jangan menyatakan "lulus" untuk sesuatu yang tidak kamu jalankan.

## 1. Cara berpikir (wajib)

1. **Anggap penyerang nyata.** Model ancaman NYX: *Trust No One* — server dianggap honest-but-curious dan kadang berbahaya (`docs/03` §3.1, `docs/28`). Untuk tiap perubahan tanyakan: apa yang bisa dilakukan (a) server yang dikompromikan, (b) penyerang jaringan/Cloudflare edge, (c) klien jahat/pengguna terautentikasi lain, (d) dump DB/backup/log yang bocor, (e) perangkat yang dicuri.
2. **Verifikasi di kode, bukan di klaim.** Komentar, pesan commit, dan dokumen bisa salah atau basi. Jejaki jalur eksekusi sebenarnya (pemanggil → fungsi → efek samping). `grep` semua pemanggil/pemakai sebelum menyimpulkan sesuatu "tidak dipakai" atau "sudah dijaga".
3. **Bantah dulu temuanmu sendiri.** Sebelum melaporkan sebuah bug, cari penjaga di hulu (middleware, skema zod, pemanggil, feature flag, gate versi klien, CSP, rate-limit). Laporkan hanya bila kamu bisa menyebut **jalur konkret + input/keadaan yang memicunya**. Temuan yang tak tahan bantahan dipindah ke "pengamatan", bukan "bug".
4. **Perlambat di batas kepercayaan** (parsing input jaringan, verifikasi tanda tangan/MAC, penurunan versi protokol, otorisasi, migrasi data pengguna, fail-open vs fail-closed, penanganan kunci). Di tempat lain boleh cepat.
5. **Pikirkan efek domino.** Setiap perubahan punya "radius ledak": kontrak di `@nyx/shared` (opcode, skema zod, konstanta), format wire web↔server↔sidecar, skema Prisma↔kode↔migrasi, env var↔`.env.example`↔`deploy.yml`↔docs, nginx/CSP↔fitur klien, i18n 4 bahasa. Telusuri ke semua sisi, bukan hanya berkas yang berubah.
6. **Hormati keputusan yang disengaja.** `docs/03` §3.7 ("Deliberate trade-offs") dan "E2EE / crypto constraints (do not break)" di `AGENTS.md` adalah keputusan maintainer. Jangan melaporkannya sebagai bug dan jangan menyarankan mengubah primitif, padding 8 KB, format `ENC1:`/`ENC2:`, envelope XChaCha, atau memecah `crypto.worker.ts`. Kamu **boleh** mencatat bila asumsi di balik keputusan itu berubah oleh kode baru.
7. **Hindari pola audit malas:** menempel keluaran linter sebagai temuan; menyarankan menulis ulang ke bahasa lain; temuan generik ("tambahkan validasi") tanpa lokasi; menandai severity tinggi tanpa skenario.

## 2. Fase 0 — Orientasi & baseline (jangan dilewati)

Baca dulu, urut: `AGENTS.md` (seluruhnya), `docs/README.md`, `docs/01-architecture.md`, `docs/03-security-model.md`, `docs/04-crypto-protocol.md`, `docs/10-deployment-ops.md` (§10.15–10.21), `docs/35-post-quantum-migration-plan.md`, `docs/36-external-crypto-review-packet.md`, `docs/37-privacy-closure-plan.md`, `docs/34-key-transparency-verifier.md`, `docs/28-db-dump-threat-model.md`. Ringkas **klaim** keamanan/privasi utama dalam daftar bernomor (C1, C2, …) — di akhir audit setiap klaim harus diberi status *terbukti di kode / tidak terbukti / terbantah*.

Jalankan baseline dan catat hasil (lulus/gagal/tak bisa dijalankan + alasannya) di `audit/05-baseline.md`. Gunakan persis perintah di `AGENTS.md`:
- `pnpm install --frozen-lockfile`; `pnpm --filter @nyx/shared run build` **sebelum** typecheck apa pun; `pnpm exec prisma generate` di `server/`.
- `pnpm run build`; `pnpm run test` (server = `node:test` via `tsx`, web = vitest; jangan pakai jest); `pnpm run lint` (oxlint saja).
- `node scripts/check-pq-only.mjs` (perhatikan `scripts/pq-only-baseline.json` dan `pq-only-exceptions.json`: **apakah pengecualian bertambah sejak baseline, dan kenapa?**), `bash scripts/check-vendor.sh`, `bash scripts/check-wasm-artifacts.sh`, `pnpm audit --prod`.
- Rust: `cargo test --locked` + `cargo clippy --all-targets -- -D warnings` di `server/transport-sidecar` dan `server/pir-sidecar`; Go: `server/kt-query/build.sh test`, `cd tools/dr-oracle && go run . -check`.
- E2E (Playwright) hanya bila Postgres+Redis+browser memadai; bila tidak, catat sebagai "tidak dijalankan". Perhatikan **test yang auto-skip**: daftar semua `skip`/kondisi skip dan nilai apakah ia menyembunyikan kegagalan.

## 3. Fase 1 — Peta perubahan (`audit/01-change-map.md`)

Bangun peta dari git, jangan dari ingatan: `git log --reverse --format='%h %ad %s' --date=short a493ad7..HEAD` dan `git diff --stat a493ad7..HEAD`. Kelompokkan per tema (PQ migrasi, KT v2, PIR/OPRF/OHTTP, privacy closure/mailbox/grup, device-linking QR, `ENC2` key ring, transport parity, server-down/readiness, deps/CI/docs). Untuk tiap tema: commit, berkas inti, kontrak yang disentuh, dan **tingkat risiko (T/S/R)**.

Commit yang paling layak dibaca penuh (bukan hanya stat): `ce51ff1`, `c733b83`, `92cd7ae`, `51d3bf9`, `ae50930` (cutover PQ-only — hapus v1/credential), `070e51a` (QR device-linking), `aa2ad3e` (indeks OPRF), `e195da4`, `9492aa4` (PIR 4c/4d + server-down), `d87f38f` (OHTTP token-off), `ab7ef8e` (privacy closure token grup/mailbox/sync anonim), `f82a299`, `25b1699` (wire migration device baru), `b901bef` (paritas WT↔WS), `759341a` (rantai attestation perangkat), serta `a493ad7` (penutupan temuan review eksternal R1–R11 — **verifikasi bahwa R1–R11 benar-benar tertutup di kode HEAD, bukan hanya di dokumen**).

## 4. Fase 2 — Audit per domain

Untuk tiap domain tulis temuan ke `audit/02-findings.md`. Pertanyaan di bawah adalah titik awal, bukan batas.

**A. Kriptografi & protokol** (`web/src/workers/crypto.worker.ts`, `web/src/lib/spqr*.ts`, `packages/shared`, `docs/04`, `docs/33`, `docs/35`)
- Cutover PQ-only: adakah jalur v1/legacy yang masih terjangkau (penurunan versi, header yang bisa dipaksa ke v1, fallback diam-diam, `legacyV1Metrics`)? Apa yang terjadi pada perangkat/pesan lama setelah cutover (kehilangan data? pesan tak terbaca? sesi macet)? Cek gate `MIN_CLIENT_VERSION` dan perilaku fail-open "tanpa header versi = lolos".
- ML-DSA / ML-KEM / X3DH v2 / grup v4: pemisahan domain (domain separation) pada transkrip & KDF, binding identitas ke handshake, urutan verifikasi-sebelum-pakai, penanganan nonce/penghitung, kunci tak ter-zeroize, perbandingan non-constant-time, error oracle, KAT resmi vs yang benar-benar dipakai di jalur produksi, kecocokan dengan `tools/dr-oracle`.
- Kompatibilitas format beku (`ENC1:`, envelope XChaCha, padding 8 KB, `Array.from` pada `ENCRYPT_DATA`): pastikan tak ada perubahan diam-diam.

**B. Key Transparency** (`server/kt-query` Go, `packages/keytrans-wasm*`, `web/src/lib/kt*.ts`, `server/src/utils/keyTransparency.ts`, `ktIdentityLog.ts`, `jobs/ktSnapshot.ts`)
- Fail-closed vs fail-open di tiap titik (monitor, verifikasi bukti, backfill v2 saat login, banner `ktAvailability`). Apakah kegagalan KT bisa membuat pengguna menerima kunci kontak tak terverifikasi tanpa peringatan?
- Satu pemilik LevelDB; snapshot harian terverifikasi + retensi R2; skrip `kt-restore-drill.sh`; pin vendor Signal (`NOTICE` vs `go.mod`/`Cargo.toml`).

**C. Privasi metadata & "privacy closure"** (`docs/37`, `server/prisma/schema.prisma`, `routes/groups*`, `groupMailbox.ts`, `groupSync.ts`, `routingIdentity`, `docs/28`)
- Bandingkan klaim "server buta" dengan kenyataan: kolom Prisma, log (`logger.ts`/`sanitizeErrorLog`), label metrik Prometheus, header respons, urutan/ukuran/waktu. Apakah ada identifier stabil yang menghubungkan pengguna ↔ percakapan ↔ perangkat yang seharusnya tak ada? Gunakan `tests/schemaPrivacy.test.ts`/`dumpAudit` sebagai alat bantu, tapi nilai juga apa yang **tidak** mereka uji.
- Token grup/mailbox: pembuatan, rotasi epoch, pencabutan anggota, replay, enumerasi, korelasi lintas-token. Privacy Pass (`PP_SYNC_REQUIRED`), OHTTP gateway (batas 64 KB, mode **token-off untuk relay loopback** — apa jaminan bahwa mode ini tak bisa dijangkau dari luar?).

**D. Pencarian pengguna: OPRF + PIR** (`server/pir-sidecar`, `web/src/lib/pir*.ts`, `workers/pir.worker.ts`, `server/src/jobs/pirSnapshot.ts`, `packages/pir-wasm`)
- Apakah pencarian bisa dipakai untuk **enumerasi** pengguna atau membocorkan kueri ke server? Rate-limit (`searchRateLimit`), parameter PIR (`pirParams`), ukuran/entropi indeks, kebocoran lewat waktu/ukuran respons, snapshot harian (konsistensi, atomisitas, kegagalan parsial), artefak WASM yang ter-commit vs manifest (`wasm-artifacts.json`, build reprodusibel).

**E. Autentikasi, sesi, perangkat** (`routes/auth.ts`, `utils/sessionUtils.ts`, `refreshReplay.ts`, device-linking, `docs/14`)
- **QR device-linking baru** (claim → persetujuan → sesi lewat `/login`): siapa yang boleh menyetujui? Kedaluwarsa, sekali-pakai, race/TOCTOU, brute-force kode, pengambilalihan sesi oleh pemindai pihak ketiga, pengikatan ke perangkat yang menampilkan QR, perilaku "single active device" + mode migrasi.
- Rotasi refresh + deteksi replay (grace 2 menit), CSRF per-klien (`x-nyx-installation-id`), cookie lintas-subdomain (`COOKIE_DOMAIN`, `authCookieOptions` satu sumber), attestation perangkat (`759341a`, `ops/attestation`, `scripts/attestation-roots.mjs`): apa yang terjadi bila root kedaluwarsa/dicabut? "strict default" — apakah ada jalur bypass?
- Panic/wipe, recovery phrase, biometrik (trade-off tercatat — hanya periksa regresi).

**F. Transport & relay** (`server/transport-sidecar`, `server/src/network/redisBridge.ts`, `utils/transportCapability.ts`, `packages/shared/src/transport.ts`)
- Paritas WT↔WS (commit `b901bef`, "empat lubang"): verifikasi tiap lubang tertutup dan tak ada lubang kelima. Sidecar fail-closed untuk `JWT_SECRET` (sudah diperbaiki 2026-10-24 — **konfirmasi**), batas ukuran frame, back-pressure, DoS (slowloris/stream flood), validasi opcode, sinkron opcode Rust↔TS, pencocokan kapabilitas dua relay, rate-limit atomik (Lua).

**G. Server umum** (`server/src/routes/*`, `middleware/*`, `app.ts`, `config.ts`)
- Otorisasi tiap rute (IDOR, gate order terkunci di `groupAccess`/`adminCapability`), validasi zod di setiap batas, endpoint admin/cleanup (`authorizeAdminCleanup`), presigned URL R2 & SSRF (`link-preview-js`), CORS/CSP/helmet, kebocoran error, validasi env saat boot, `/health*` dan `/api/system/status` (perilaku saat Redis mati disengaja), rate-limit global/per-IP (`ipKey`, Cloudflare IP).
- `ENC2` key ring (`sealedLookupCandidates`): prosedur rotasi, mode gagal (kunci hilang, ring sebagian), apakah ada kolom yang masih memakai satu nilai `sealAtRest()` saja.
- Lapisan data: skema Prisma ↔ kode ↔ `prisma db push` (tanpa migrate flow — adakah jalur upgrade aman untuk DB produksi yang sudah ada?), indeks, transaksi/race, retensi 14 hari, job `messageSweeper`/`systemSweeper`/`cleanup`.

**H. Frontend** (`web/src`)
- Kebersihan material kunci (tidak di React state/localStorage/log), migrasi IndexedDB/Dexie (NyxUnifiedDB **v13**: jalur upgrade dari versi lama — risiko kehilangan data), Shadow Vault, offline queue, service worker (precache-only, `NavigationRoute`, denylist), worker lifecycle, permukaan XSS (markdown, link preview, embed, nama/profil terdekripsi), CSP di `web/nginx.conf` vs kebutuhan nyata (`wasm-unsafe-eval`, inline), kelengkapan i18n 4 bahasa (en/id/es/pt-BR — kunci yang hilang/yatim), aksesibilitas dasar pada layar kritis.
- Fitur server-down/maintenance (`systemStore`, `ServerDownPage`, `serverReachability`, `sw.ts`, Worker Cloudflare): sudah direview terpisah; cukup konfirmasi tak ada regresi dan catat interaksi dengan banner KT.

**I. Infra, supply chain, ops** (`ops/*`, `.github/workflows/*`, `vendor/`, `docker-compose.yml`, `scripts/*`)
- Pin versi Actions & kebijakan izin workflow, rahasia di CI, `deploy.yml` (assert env wajib), hardening nginx/systemd/pm2, aturan alert Prometheus vs nama metrik nyata (`scripts/drill-alerts.sh`), integritas vendor (tak ada patch lokal, `check-vendor.sh`), `pnpm.resolutions` override (apakah menutupi kerentanan atau membuat versi tak teruji?), reprodusibilitas WASM.

**J. Kualitas test & CI**
- Peta cakupan: kode baru berisiko tinggi mana yang **tidak** punya test? Test yang hanya menegaskan implementasi (bukan perilaku)? Test yang dikecualikan/skip? Test server yang harus didaftarkan manual di `package.json` — adakah berkas `server/tests/*.test.ts` yang **tidak terdaftar** (jadi tak pernah jalan)? Cek dengan membandingkan `ls server/tests` dengan skrip `test`.

## 5. Fase 3 — Integrasi lintas-modul & drift (`audit/03-domino-matrix.md`, `audit/04-docs-drift.md`)

- **Matriks domino:** untuk setiap perubahan kontrak besar, isi tabel *Perubahan → semua pemakai/pembaca → sudah ikut disesuaikan? → bukti (berkas:baris)*. Wajib mencakup: opcode & skema di `@nyx/shared`; format header ratchet v2; kapabilitas HELLO; skema Prisma; env var baru (`grep` seluruh repo: `.env.example`, `deploy.yml`, `docker-compose.yml`, docs, kode); kunci i18n; metrik baru ↔ alert ↔ dashboard Grafana.
- **Drift dokumentasi:** bandingkan klaim di `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, dan `docs/*` dengan kode (angka test, nama berkas, perintah, alur). Catat yang sudah diketahui: `CONTRIBUTING.md` baris ±22 masih menyebut `pnpm dev` (tak ada di root); inkonsistensi TURN `docs/18` vs coturn `docs/29` (verifikasi apakah masih ada). Temuan lain bernilai bila membuat operator/kontributor salah langkah.

## 6. Fase 4 — Verifikasi independen & rencana perbaikan

1. **Verifikasi:** untuk setiap temuan Tinggi/Kritis, jalankan ulang penalaran dari nol (idealnya oleh sub-agent/pembaca terpisah yang tidak melihat kesimpulanmu): "Bisakah ini dibantah? Adakah penjaga yang terlewat?". Bila ada tooling, tulis **test reproduksi** sementara di luar repo (scratch) dan lampirkan hasilnya; jangan menaruhnya di repo.
2. **Rencana perbaikan (`audit/07-fix-plan.md`):** kelompokkan menjadi batch seukuran satu PR, urut prioritas & dependensi. Per batch: berkas yang disentuh, perubahan minimal (patuhi Ponytail & aturan beku), test yang harus ditambah, risiko regresi, dan cara verifikasi. Tandai yang butuh keputusan maintainer (mis. perubahan perilaku yang tampaknya disengaja) — **jangan putuskan sendiri**.

## 7. Keluaran (semua di `audit/`, bahasa Indonesia; identifier/kode tetap Inggris)

| Berkas | Isi |
|---|---|
| `00-ringkasan.md` | Vonis per area (Aman / Perlu perbaikan / Blokir rilis), 10 risiko teratas, status klaim C1…Cn, apa yang **tidak** diperiksa |
| `01-change-map.md` | Peta tema → commit → berkas → risiko |
| `02-findings.md` | Semua temuan (format di bawah), terurut severity |
| `03-domino-matrix.md` | Matriks efek domino |
| `04-docs-drift.md` | Daftar drift dokumen↔kode |
| `05-baseline.md` | Hasil perintah baseline (termasuk yang tak bisa dijalankan) |
| `06-tidak-diperiksa.md` | Cakupan yang dilewati + alasan + risikonya |
| `07-fix-plan.md` | Batch perbaikan terurut |

Kerjakan **bertahap dan simpan progres ke disk** (`audit/notes/` + `audit/PROGRESS.md` berisi domain selesai/berjalan/tersisa), karena kodebase (±124 ribu baris TS/TSX + Rust + Go) melebihi satu jendela konteks. Setelah konteks di-reset, baca `PROGRESS.md` dulu — jangan mengulang. Bila mampu menjalankan sub-agent, bagi per domain (§4 A–J) lalu lakukan satu putaran verifikasi silang (§6.1).

**Format temuan (wajib lengkap):**
```
### [ID] Judul singkat — Severity: Kritis|Tinggi|Sedang|Rendah|Info — Keyakinan: Terbukti|Kuat|Perlu dicek
- Lokasi: path/berkas.ts:baris (dan pemanggil/pemakai terkait)
- Masalah: satu kalimat tegas.
- Skenario: siapa penyerang/kondisi → langkah → akibat konkret (data/privasi/ketersediaan).
- Bukti: potongan kode/jalur eksekusi/keluaran perintah; penjaga hulu yang sudah diperiksa dan kenapa tak cukup.
- Perbaikan minimal: apa yang diubah (tanpa melanggar aturan beku).
- Test yang harus ada: nama berkas + kasus.
- Radius domino: modul lain yang ikut terpengaruh.
```
Kategori severity: **Kritis** = kebocoran isi/kunci/identitas, pengambilalihan akun/perangkat, bypass autentikasi/otorisasi; **Tinggi** = kehilangan data pengguna, penurunan protokol, korelasi metadata yang dijanjikan tak ada, DoS mudah; **Sedang** = melemahkan pertahanan berlapis, race langka, drift yang menyesatkan operasi; **Rendah/Info** = kebersihan, konsistensi, saran.

Pisahkan jelas: **Bug terverifikasi** · **Dugaan kuat (perlu dicek maintainer/lingkungan)** · **Pengamatan desain** · **Konfirmasi positif** (hal yang kamu periksa dan benar — penting agar maintainer tahu cakupan, jangan hanya daftar kesalahan).

## 8. Daftar periksa sebelum menyerahkan

- [ ] Setiap temuan punya lokasi `berkas:baris`, skenario konkret, dan sudah dicoba dibantah.
- [ ] Tidak ada temuan yang hanya mengulang keluaran linter/tsc tanpa analisis dampak.
- [ ] Tidak ada rekomendasi yang melanggar aturan beku `AGENTS.md`/`docs/03` §3.7.
- [ ] Setiap kontrak lintas-modul yang berubah punya baris di matriks domino.
- [ ] Klaim C1…Cn semuanya berstatus; hal yang tak bisa diverifikasi dinyatakan begitu.
- [ ] `05-baseline.md` jujur soal apa yang tidak dijalankan; `06-tidak-diperiksa.md` terisi.
- [ ] Tidak ada rahasia/nilai env tercetak di laporan; tidak ada perubahan pada source, commit, atau push.
- [ ] Balasan akhir: ringkasan ≤ 15 baris (vonis, 5 risiko teratas, tautan ke `audit/00-ringkasan.md`) + satu-dua baris "apa yang dilewati dan risikonya".
