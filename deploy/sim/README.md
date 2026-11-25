# `deploy/sim` — lingkungan simulasi penuh (staging-like) di satu host

Stack ini menyalakan **semua** layanan NYX dengan topologi yang sama seperti
deployment: web (Vite dev) di belakang nginx, API, sidecar WebTransport (QUIC/UDP), relay
OHTTP proses terpisah, dua sidecar XOR-PIR, log KT v2 + auditor, Postgres,
Redis, dan coturn. Tujuannya: E2E Playwright dan uji manual memakai aplikasi
nyata, bukan dev server dengan separuh layanan dimatikan.

```bash
bash scripts/sim/up.sh        # build + nyalakan, cetak URL
bash scripts/sim/smoke.sh     # cek setiap layanan + isolasi jaringan
bash scripts/sim/down.sh      # hentikan (volume dipertahankan)
bash scripts/sim/e2e.sh       # Playwright penuh terhadap stack
```

Aplikasi: <http://localhost:8080> (API same-origin di `/api`).

## Yang dibuat `up.sh`

| Artefak | Lokasi | Catatan |
|---|---|---|
| Rahasia acak | `.sim/env` (0600, gitignored) | DB, JWT/CSRF/CHAT, pepper, token internal OHTTP/PIR, TURN |
| Kunci gateway OHTTP | `.sim/env` | P-256, dibuat sekali; rotasi = hapus dua baris lalu `up.sh` |
| Kunci manifest PIR | `.sim/pir-keys/{a,b}.key` + `.sim/env` | ML-DSA-65 deterministik untuk simulasi |
| Sertifikat WebTransport | volume `sidecar-certs` | Self-signed, hash di-pin ke build web |
| Config + kunci KT v2 | volume `ktdata` | Dibuat `nyx-kt-v2-init`; **tidak** pernah lewat CI |

Build pertama beberapa menit (Rust sidecar + PIR, Go KT, Node, Vite). Berikutnya
memakai cache layer.

## Port

| Port | Layanan | Eksposur |
|---|---|---|
| 8080/tcp | nginx: web + `/api` + `/socket.io` + `/uploads` + `/api/ohttp/relay` | host |
| 33333/udp | sidecar WebTransport | host |
| 3478/udp + 49160–49200/udp | coturn | host (`network_mode: host`) |
| 55432/tcp, 56379/tcp | Postgres/Redis | **hanya** override E2E, loopback |

Postgres, Redis, PIR, KT, dan relay tidak pernah dipublikasikan ke host pada
`up.sh` biasa.

## Batas jaringan

- `edge` — web, API, relay, sidecar, coturn.
- `appnet` (internal) — API ↔ relay ↔ PIR ↔ KT.
- `data` (internal) — Postgres/Redis; hanya API dan sidecar.
- `e2e-publish` (bridge, non-internal) — **hanya** saat override E2E; dipakai
  Postgres/Redis. Docker tidak mempublikasikan port container yang hanya
  terhubung ke network `internal: true`, jadi tanpa network ini
  `127.0.0.1:55432`/`56379` tidak pernah listening walau config compose benar.

`smoke.sh` memeriksa bahwa container `web` **tidak** bisa me-resolve
`postgres`/`redis`. Itu batas nyata, bukan sekadar nama jaringan.

## Perbedaan yang disengaja dari produksi

- **Aplikasi dilayani Vite dev server, bukan bundle produksi.** Suite E2E
  mengimpor modul sumber (`await import('/src/lib/…')` di dalam
  `page.evaluate`), jadi container `web` menjalankan `vite` dan nginx hanya
  mem-proxy `/` ke `web:5173`. Konsekuensinya `VITE_*` dibaca saat start
  (bukan dibakar), dan minify/tree-shake tidak diuji di stack — itu tugas
  `vite build` + job `build` di CI. Yang diuji stack adalah integrasi layanan
  nyata: API, coturn, WebTransport, OHTTP, PIR, KT, dan isolasi jaringan.
- **Sertifikat WebTransport self-signed dan di-pin.** Stack memakai Vite dev,
  jadi `VITE_TRANSPORT_CERT_HASH` dibaca saat start. Tanpa pin, browser menolak
  QUIC self-signed. Build produksi mengabaikan pin ini dan memakai sertifikat
  CA publik.
- **`NODE_ENV=development` di API.** Halaman disajikan `http://localhost`;
  cookie `secure` tidak akan terkirim. Selfhost produksi memakai TLS di edge.
- **PIR klien hidup di E2E** (`SIM_PIR_CLIENT=1`). Override E2E mengubah cron
  dirty dari 3 menit menjadi 5 detik (`PIR_DIRTY_REFRESH_CRON` di
  `docker-compose.e2e.yml`), dan helper pencarian menunggu satu tick sebelum
  mencari user baru. Uji manual memakai default 3 menit — tunggu ≤3 menit atau
  jalankan `docker compose exec server pnpm exec tsx scripts/pir-snapshot.ts`.
- **Tidak ada R2, push notification, Turnstile, pembayaran.** Jalur itu
  membutuhkan kredensial pihak ketiga; layanannya tetap boot dengan peringatan.
- **Satu host.** KT auditor berjalan di host yang sama; itu membuktikan
  konsistensi riwayat, bukan independensi organisasi.

## E2E

`scripts/sim/e2e.sh` memakai `web/playwright.stack.config.ts`:

- project `chrome` (WebTransport/QUIC nyata), `workers: 1`;
- tidak ada `webServer` — halaman dilayani Vite dev di container `web`
  (nginx stack mem-proxy `/`); API, coturn, WebTransport, OHTTP, PIR, dan KT
  adalah layanan nyata di jaringan Compose;
- global setup tetap `web/e2e/global.setup.ts`; Postgres/Redis dipublikasikan
  loopback lewat `deploy/sim/docker-compose.e2e.yml` karena
  `reset-test-env.ts` sengaja menolak host non-loopback;
- himpunan spec sama dengan snapshot gate `chrome` (a11y/PIR/storage/opfsApp
  punya stack sendiri), lalu `verify-required-tests.mjs --project chrome`
  dijalankan.

Spec PIR tetap diuji job terpisah (`test:e2e:pir`) karena membutuhkan snapshot
yang dibangun di tengah spec. Stack ini memverifikasi PIR di level layanan
(`smoke.sh` + job cron internal), bukan lewat UI.

## CI

Job `e2e-stack` di `.github/workflows/ci.yml` menjalankan `scripts/sim/e2e.sh`
di runner Linux: Docker Compose membangun seluruh image, menyalakan stack, lalu
Playwright berjalan di host terhadap `http://localhost:8080`.
