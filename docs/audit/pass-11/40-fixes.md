# Pass 11 — Perbaikan

Enam temuan `20-findings.md`. Tidak ada temuan pass 1–10 yang dibuka ulang,
kecuali regresi N11-01 yang memang diperkenalkan commit `0c337be9`.

## N11-01 — dua tes arsip era braid gagal: **TERTUTUP**

**Akar masalah.** `saveSpqrState` memberi default `advanced: false`, dan
`rotateSpqrStateForNewSession` hanya mengarsipkan era yang `advanced`. Fixture
`spqrEraArchive.test.ts` menulis state era tanpa penanda, jadi arsip selalu
kosong: `expected [] to have a length of 1` dan `… of 3`.

**Perbaikan.** Default dibalik (lihat N11-02), sehingga fixture yang mewakili era
ber-lalu-lintas kembali diarsipkan tanpa melonggarkan satu pun asersi. Ditambah
satu kasus yang benar-benar mengunci perilaku baru: era baru yang **ditandai**
`advanced: false` tidak menggeser arsip, dan frame era lama tetap terbuka dari
slot 0.

**Berkas.** `web/src/lib/spqrState.ts`, `web/src/lib/__tests__/spqrState.test.ts`,
`web/src/lib/__tests__/spqrEraArchive.test.ts`.

## N11-02 — default `advanced` mengarah ke kehilangan era: **TERTUTUP**

**Akar masalah.** Kondisi N10-04 tidak bisa dicapai lewat jalur produksi (hanya
dua penulis state, keduanya `advanced: true`), tetapi default `false` membuat
pemanggil baru yang lupa menandai **diam-diam** membuang era lama — kelas bug
N5-01 tanpa suara dan tanpa tes penjaga.

**Perbaikan.** Default konservatif: state dianggap sudah maju **kecuali**
pemanggil menulis `advanced: false` eksplisit. Merge tulis yang tertunda tetap
"menempel" (`advanced: false` tidak bisa membatalkan langkah yang sudah maju).
Tidak ada penulis produksi yang menyetel `false`; dua jalur di
`utils/crypto.ts` tetap `true`.

**Tes.** `simpan tanpa penanda dianggap maju: era lama tetap diarsipkan` dan
`penanda false eksplisit menang atas default konservatif`.

## N11-03 — `docs/33` mengklaim hasil tes yang merah: **TERTUTUP**

Angka dikoreksi: dua era tanpa lalu lintas yang **ditandai** menghasilkan **nol**
slot, bukan satu; era yang maju menggeser ke `[baru, lama]`. Paragraf baru juga
menyebut nama berkas dan kasus tes, bukan ringkasan bebas, dan menjelaskan
default konservatif N11-02.

## N11-04 — peringatan start relay bertentangan dengan selfhost: **TERTUTUP**

Relay kini menghitung apakah target gateway loopback. Selfhost (gateway
`127.0.0.1`) mendapat satu baris informasi bahwa nilai kosong **benar**; hanya
profil dengan gateway non-loopback (Docker) yang diberi saran menyetel CIDR nginx.

**Berkas.** `server/src/ohttp/relay.ts`.

## N11-05 — CIDR IPv6 diabaikan diam-diam: **TERTUTUP**

`proxyMatches` sekarang mendukung alamat persis dan CIDR IPv4 **maupun** IPv6
(perbandingan 128-bit `BigInt`, dengan normalisasi `::ffff:` tetap di jalur IPv4).
Prefix di luar rentang keluarga alamat tidak pernah cocok. Entri yang tidak bisa
diparse (nama host, prefix `/129` pada IPv6, `/33` pada IPv4) dilaporkan per
entri saat start relay dan entri itu tidak dipercaya — salah-setel terlihat,
bukan berubah menjadi satu bucket bersama.

**Tes.** Tiga asersi IPv6 di `ohttp.test.ts` (CIDR cocok, CIDR beda jaringan,
prefix di luar rentang) plus tes `invalidTrustedProxyReason`.

**Dokumentasi.** `.env.example`, `ops/systemd/nyx-ohttp-relay.env.example`, dan
`docs/10` §10.18 menyebut IPv4/IPv6 serta kewajiban mengosongkannya di selfhost.

## N11-06 — interop oracle timeout saat cache Go dingin: **TERTUTUP**

Kedua tes `x3dhOracleInterop.test.ts` memakai `INTEROP_TIMEOUT_MS = 180_000`
(sebelumnya bawaan 60 dtk). Alasan dan angka cache hangat (≈ 11 dtk) dicatat di
komentar; tidak ada tes yang di-skip.

## Pengaman selfhost

- `deploy/selfhost/scripts/verify-boot.sh` §9 tetap menandai **semua** nilai
  non-loopback sebagai `bad`; komentarnya kini menyebut bahwa CIDR IPv4 dan IPv6
  sama-sama tidak sah untuk profil selfhost.
- `sync-selfhost.sh --check` tetap menjadi gerbang drift untuk unit relay dan
  site config nginx (`CF-Connecting-IP $remote_addr`, `set_real_ip_from 127.0.0.1`).

## Cek yang dijalankan

- `npx tsc --noEmit` server dan web — exit 0.
- `oxlint` pada tujuh berkas yang berubah — 0 error.
- `npx tsx --test tests/ohttp.test.ts` — lulus (termasuk asersi IPv6 baru).
- `npx vitest run src/lib/__tests__/spqrState.test.ts src/lib/__tests__/spqrEraArchive.test.ts`
  — lulus.

Tidak dijalankan: suite web penuh (butuh ~530 dtk untuk `src/lib` saja), E2E,
`cargo test`, drill DR, `go clean -cache` untuk mereproduksi N11-06 dari nol.
