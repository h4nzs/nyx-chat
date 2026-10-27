# G — Server umum

Diperiksa: `server/src/app.ts`, `config.ts`, `middleware/*`,
`routes/{conversations,messages,uploads,admin,backup,subscriptions,engine,
system}.ts`, `utils/{groupAccess,adminCapability,conversationSchemas,
uploadLimits,r2,secureLinkPreview,metrics}.ts`, `jobs/{cleanup,messageSweeper,
systemSweeper,pirSnapshot}.ts`, `prisma/schema.prisma`.

## Yang terbukti benar

- **Otorisasi grup ada di util yang bisa diuji**, bukan inline:
  `utils/adminCapability.ts` (`requireAdminCapability`, hash NULL = fail-closed)
  dan `utils/groupAccess.ts` (urutan gate token → admin → jumlah anggota,
  status string `BLIND_AUTH_REQUIRED`/`ADMIN_AUTH_REQUIRED`/`MEMBERS_REMAIN`
  dipertahankan). `PUT /:id/details` tetap **403** untuk conversation hilang.
- **CSRF per-instalasi** di `app.ts`; `/api/groups` di-mount sebelum CSRF
  karena semua route-nya token-first tanpa cookie — konsisten.
- **OHTTP** membuang header identitas (`sanitizeOhttpForwardHeaders`),
  allowlist sempit, target relay dari konfigurasi, body dibatasi 64 KB.
- **Upload/R2**: batas ukuran di `uploadLimits` + test; presigned URL dibuat
  server, bukan dari input klien.
- **Metrik event-only**: `utils/metrics.ts` menolak label berbetuk identitas
  (UUID/hash/token/IP/email) dan menghitung percobaan, bukan nilainya.

## Temuan terkait

- **F-04** — skema Prisma ↔ `prisma db push` tanpa migrate flow; kolom wajib
  baru + `|| true` di deploy (detail di `02-findings.md`).
- **F-07** — `deploy.yml:260-264` memakai `pm2 start … -i max` untuk API,
  sedangkan `startMessageSweeper`/`startSystemSweeper`/`startKtSnapshotUploader`/
  `startPirSnapshotRefresher` dipanggil tanpa kunci tunggal (`index.ts`) →
  job berjalan di setiap worker; `startMetricsServer` hanya hidup di satu
  worker sehingga Prometheus melihat sebagian data.
- **F-13** — 8 env server tidak ada di `.env.example` (termasuk
  `OHTTP_RELAY_*` dan `PP_ISSUER_PRIVATE_JWK`).
- **D1** — `MIN_CLIENT_VERSION` meloloskan request tanpa header versi
  (fail-open) sehingga bukan kontrol keamanan.
- **D2** — `GET /api/messages/:conversationId` tanpa cek keanggotaan adalah
  trade-off Opaque Mailbox yang didokumentasikan; tidak dilaporkan sebagai bug.

## Batas

Tidak menguji IDOR tiap rute secara dinamis (tanpa DB), tidak menjalankan
`drill-alerts.sh`, dan tidak memverifikasi dashboard Grafana terhadap metrik
nyata.
