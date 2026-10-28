# STATUS — fakta yang diperiksa mesin

> Berkas ini **bukan** dokumen naratif. Isinya hanya fakta yang bisa dibuktikan
> dari kode, dan `node scripts/check-status.mjs` (job CI `lint`) gagal kalau ada
> yang tidak cocok. Dokumen lain merujuk ke sini alih-alih menyalin status.
>
> Kalau Anda menambah kapabilitas relay, memasang rute privasi baru, atau
> menambah saklar privasi, ubah berkas ini **dan** kodenya dalam commit yang sama.

## Versi

- app: 3.0.0

## Kapabilitas relay (SERVER_CAPABILITIES)

- hello-v1
- spqr-ratchet
- pq-v2

## Rute privasi (dipasang di server/src/app.ts)

- /api/keys/kt
- /api/keys
- /api/call-tokens
- /api/pir
- /api/ohttp

## Saklar privasi

| Flag | Default | Efek bila mati |
|---|---|---|
| `PIR_ENABLED` | mati | `/api/pir` tidak dipasang (404); klien PIR gagal terlihat |
| `OHTTP_ENABLED` | mati | relay/gateway OHTTP tidak dipasang; klien OHTTP gagal, tanpa fallback HTTP biasa |
| `KT_QUERY_URL` | kosong | `/api/keys/kt/*` 503; semua verdict KT `unavailable` (TOFU), banner muncul |
| `KT_V2_SERVER_URL` | kosong | tidak ada penulisan log KT v2; rotasi kunci tidak ter-audit |
| `KT_V2_BACKFILL_ON_LOGIN` | mati | akun pra-v2 tidak masuk log saat login |
| `VITE_OHTTP_ENABLED` | mati | pencarian user dikirim langsung ke API (IP terlihat API/edge) |
| `VITE_PIR_ENABLED` | mati | pencarian memakai jalur OPRF+basis data langsung, bukan PIR |
| `VITE_PIR_OPRF_ENABLED` | mati | identifier mentah dipakai sebagai query (bukan index OPRF) |
| `VITE_SPQR_FORCE_V1` | mati | klien tidak mengirim/mengiklankan ratchet v2 (tetap bisa membaca v2) |
| `VITE_SPQR_FORCE_V2` | mati | v2 hanya diaktifkan bila relay menegosiasikan kapabilitasnya |

## Yang sengaja TIDAK di sini

Jumlah tes, ukuran artefak, dan status "landed/belum" per fitur tidak
di-hardcode di sini — angka itu berubah setiap commit dan justru menjadi sumber
drift. Untuk angka tes, jalankan suite; untuk status fitur, lihat dokumen
masing-masing dan `docs/38` untuk jalur versi lama.
