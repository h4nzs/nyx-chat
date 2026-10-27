# I — Infra, supply chain, ops

Diperiksa: `.github/workflows/{ci,deploy}.yml`, `ops/{nginx,systemd,prometheus,
alertmanager,grafana}`, `vendor/`, `scripts/*`, `pnpm-workspace.yaml`,
`.env.example`, `docker-compose.yml`.

## Yang terbukti benar

- **Install deterministik**: CI memakai `--frozen-lockfile`, pnpm dipin
  (`packageManager: pnpm@11.4.0`).
- **Gate keamanan yang ada** dijalankan CI: `check-pq-only`, `check-vendor`,
  `check-wasm-artifacts`, `pnpm audit --prod`, `drill-alerts.sh`, DR oracle.
- **Alert ↔ metrik**: `scripts/drill-alerts.sh` mencocokkan nama `nyx_*` dengan
  sumber metrik nyata (TS/Go/Rust) dan menuntut kasus firing + non-firing.
- **Vendor Signal tidak dipatch**; `check-vendor.sh` memeriksa pin `NOTICE`,
  tidak ada `replace`, dan status git-tracked.
- **Exporter metrik loopback-only** (6 port), tidak ada yang menjadi route
  Express.

## Temuan terkait (terverifikasi ulang di sesi ini)

- **F-03** — `pnpm audit --prod` di HEAD: **10 kerentanan (3 high, 5 moderate,
  2 low)**, exit 1 → job CI `audit` merah.
- **F-05** — `node scripts/check-pq-only.mjs` exit 1: RSABSSA baru di
  `server/src/utils/privacyPass.ts` (0→4) dan `web/src/lib/privacyPass.ts`
  (0→3) tidak ada di baseline/exception.
- **F-08** — `resolutions` ada di root `package.json:18-47` (31 entri) tetapi
  pnpm hanya membaca `overrides:` di `pnpm-workspace.yaml` (hanya `mysql2`,
  `deepmerge-ts`). Terverifikasi: `package.json` tidak punya field `pnpm`;
  lock hanya memuat dua override. Pin `undici >=7.24.0` karena itu tidak
  berlaku — konsisten dengan undici yang tetap muncul di audit. Bonus:
  `allowBuilds: puppeteer: "set this to true or false"` adalah placeholder.
- **F-04** — `deploy.yml:238` menjalankan `prisma db push … || true`.
- **F-07** — `deploy.yml:260-264` `pm2 start … -i max`; job singleton dan
  exporter metrik tidak dibatasi satu worker.
- **F-15** — `uses:` tidak dipin ke SHA (`dtolnay/rust-toolchain@master` di
  `ci.yml:73,117` dan `deploy.yml:40`); `permissions:` hanya ada di
  `codeql.yml`. Deploy memegang `secrets` VPS, jadi pergeseran branch action =
  akses host produksi.
- **Catatan deploy** — `deploy.yml` menimpa `server/.env` dengan `.env` root
  (prod secrets hanya di VPS), sesuai `AGENTS.md`; bukan temuan, tetapi
  berarti variabel yang hanya ada di `server/.env` akan hilang setiap deploy.

## Batas

Tidak menyentuh VPS; tidak menjalankan `drill-alerts.sh` (butuh promtool,
diunduh) atau `prisma db push`; pin/izin workflow diperiksa dari YAML, tetapi
isi action pihak ketiga tidak ditinjau.
