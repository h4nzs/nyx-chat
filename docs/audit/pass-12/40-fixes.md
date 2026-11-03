# Pass 12 — Perbaikan

Dua temuan pass 12 (`20-findings.md`), keduanya ditutup di sini. Tidak ada temuan
pass 1–11 yang dibuka kembali.

## N12-01 — CIDR tanpa prefix diperlakukan sebagai `/0`: TERTUTUP

**Yang salah.** `invalidTrustedProxyReason` memakai `Number(bitsRaw)`; `Number('')`
adalah `0`, jadi `10.0.0.0/` dan `fd00::/` dinyatakan sah dan berlaku sebagai
prefix `/0`. `proxyMatches` mengembalikan `true` untuk prefix `0`, sehingga
entri itu berarti "percaya semua hop": `CF-Connecting-IP` kiriman klien dipakai
untuk alamat apa pun — membatalkan N10-02/N10-03 pada salah-setel yang justru
terlihat sah. Bentuk `10.0.0.0/8/8` juga lolos (dan dieksekusi sebagai `/8`)
karena `split('/')` hanya mengambil dua bagian pertama.

**Yang berubah** (`server/src/ohttp/clientTag.ts`):

1. Helper baru `parseProxyEntry` — satu tempat yang memutuskan bentuk entri.
   `null` untuk lebih dari satu `/`, basis kosong, dan prefix yang bukan 1–3
   digit desimal. `proxyMatches` **fail-closed**: entri `null` tidak pernah
   cocok, tidak ada jalur yang mengembalikan `true` untuk prefix tak terbaca.
2. `invalidTrustedProxyReason` melaporkan bentuk-bentuk itu per entri
   (`prefix kosong setelah garis miring`, `prefix /eight bukan angka`,
   `lebih dari satu tanda garis miring`), sehingga relay mencetaknya saat start
   alih-alih menganggapnya sah.
3. `/0` **eksplisit** (`0.0.0.0/0`, `::/0`) tetap berlaku: itu keputusan
   operator yang tertulis, bukan salah-setel tanpa gejala. Yang dihapus adalah
   `/0` yang lahir dari string kosong.

**Tes** (`server/tests/ohttp.test.ts`):

- `addressOf('203.0.113.9', { trustedProxies: ['10.0.0.0/'] })` → alamat soket
  (bukan header); sama untuk `fd00::/` dengan peer `fd00::5`.
- `addressOf('172.18.0.5', { trustedProxies: ['172.16.0.0/8/8'] })` → alamat soket.
- `addressOf('172.18.0.5', { trustedProxies: ['0.0.0.0/0'] })` → header (kontrol:
  `/0` eksplisit masih dihormati).
- `invalidTrustedProxyReason` memberi alasan untuk `10.0.0.0/`, `fd00::/`,
  `10.0.0.0/8/8`, `10.0.0.0/eight`; `0.0.0.0/0` tetap `null`.

**Dokumentasi.** `docs/10` §10.18 menyebut bentuk yang kini ditolak dan alasan
`/0`; `docs/34` mengoreksi klaim "CIDR IPv4 didukung" menjadi IPv4/IPv6 +
fail-closed; `CHANGELOG.md` menambah entri pass 12.

**Dampak.** Profil Docker yang lupa menulis angka prefix sekarang mendapat
peringatan start dan entri itu tidak mencocokkan apa pun (hop tidak dipercaya →
klien jatuh ke alamat soket/nginx, bukan tag pilihan klien). Profil selfhost
tidak berubah: `OHTTP_TRUSTED_PROXIES` kosong, default loopback.

## N12-02 — perbaikan `clientVersion` hanya di working tree: TERTUTUP

Dua berkas yang pass 11 ukur sebagai perbaikan tetapi belum di-commit
(`web/src/lib/api.ts`, `web/src/lib/__tests__/clientVersion.test.ts`) masuk
commit pass 12 apa adanya. Ringkasnya: `getCsrfToken` melaporkan body `426`
(`CLIENT_TOO_OLD`/`CLIENT_VERSION_REQUIRED`) ke `clientVersionGate` sebelum
melempar, sehingga klien terlalu tua melihat layar pembaruan meski permintaan
token CSRF itu sendiri yang ditolak; tes membedakan respons CSRF (200 + token)
dari respons mutasi (426) dan menambah kasus "426 pada `GET /api/csrf-token`
tetap menyalakan layar terlalu-tua".

Dengan commit ini, `git status` bersih pada kedua berkas dan suite yang diukur
pass 12 (137 berkas, 1136 tes) adalah suite pada commit, bukan pada working tree.

## Cek yang dijalankan

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | exit 0 |
| `npx oxlint src/ohttp/clientTag.ts tests/ohttp.test.ts` | 0 error |
| `npx tsx --test tests/ohttp.test.ts` | lulus semua |
| `vitest run` `clientVersion.test.ts` + `csrfTokenSingleFlight.test.ts` | 20/20 lulus |
| `npx tsc --noEmit` (web) | exit 0 |

Tidak dijalankan ulang pada pass ini: suite web penuh, `cargo test`, suite Go
KT, DR oracle, fuzz, dan E2E/drill — tidak ada berkas di area itu yang berubah
selain dua berkas web di atas, yang cakupannya sudah diuji langsung.
