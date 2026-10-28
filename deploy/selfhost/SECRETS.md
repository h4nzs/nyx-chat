# Inventaris rahasia

Jangan pernah menaruh nilai di file ini atau di git. Sumber nilai: `server/.env`,
`web/.env`, `~/nyx-selfhost/*/*.env`, `~/nyx-selfhost/kt/v2/etc/*`.

## Wajib dipertahankan (tidak bisa diregenerasi)

| Nama | Lokasi | Akibat jika hilang/berubah |
|---|---|---|
| `NYX_AT_REST_PEPPER` | `server/.env` | Blind index DB tidak cocok; data lama tidak terbaca |
| `GROUP_ISSUER_KEY_PKCS8` + versi | `server/.env` | Grup lama tidak bisa memverifikasi issuer |
| `BACKUP_KEY_SECRET` | `server/.env` | Backup R2 lama tidak bisa didekripsi |
| `NYX_OPRF_SEED` | `server/.env` | Token OPRF lama invalid |
| `PIR_MASTER_SECRET` | `server/.env` | Snapshot PIR lama invalid |
| `OHTTP_PRIVATE_KEY`, `OHTTP_NEXT_PRIVATE_KEY` | `server/.env` | Token/gateway OHTTP lama tidak cocok |
| `KT v2 log keys` | `kt/v2/etc/config.yaml` | Bukti KT lama tidak bisa diverifikasi |
| `KT v2 auditor key` | `kt/v2/etc/auditor.key` | Auditor tidak bisa melanjutkan state |
| `JWT_SECRET`, `CHAT_SECRET`, `CSRF_SECRET` | `server/.env` | Semua sesi/token logout |
| `VAPID_PRIVATE_KEY` | `server/.env` | Push subscription lama mati |
| `R2_*` | `server/.env` | Tidak bisa akses objek lama |
| `CF_TURN_*`, `TURNSTILE_SECRET_KEY` | `server/.env` | TURN/Turnstile berhenti |
| `NOWPAYMENTS_*` | `server/.env` | IPN/pembayaran berhenti |
| `DATABASE_URL`, `DIRECT_URL` | `server/.env` | Tidak bisa restore DB |

## Boleh diregenerasi

- Password admin Grafana dan `secret_key`.
- Token/topic ntfy.
- DSN postgres-exporter.
- Sertifikat sidecar WebTransport (client dev perlu hash baru).
- `VITE_*` marker (build-time; `web/.env` tetap perlu untuk rebuild).
- Cloudflare tunnel token (buat tunnel baru; update DNS).

## Rotasi

Setelah migrasi, rotasi kredensial jangka pendek (Grafana, ntfy, exporter). Jangan
rotasi item "wajib dipertahankan" tanpa prosedur khusus; `NYX_AT_REST_PEPPER` dan
kunci KT v2 khususnya tidak boleh berubah.
