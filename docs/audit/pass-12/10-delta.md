# Pass 12 — Laporan delta

Basis: `666f37c5` + dua berkas working tree yang belum di-commit
(`web/src/lib/api.ts`, `web/src/lib/__tests__/clientVersion.test.ts`).
Pass 1: `AUDIT_REPORT.md`. Pass 2–11: `pass-2/`…`pass-11/`.
Temuan baru: `20-findings.md`. Verifikasi fix: `30-verify-fixes.md`.

## Ringkasan satu paragraf

Lima temuan pass 11 yang diperbaiki di commit ini **benar-benar tertutup**, dan
untuk pertama kali seluruh gerbang yang selalu dicatat "tidak dijalankan" pada
pass 1–11 dijalankan pada satu pass: suite web penuh (137 berkas, **1136/1136
lulus** dengan perubahan working tree), `cargo test` sidecar, suite Go KT, DR
oracle `-check`, dan fuzz parser 50 000 iterasi — semuanya hijau. Fix N11-02
(default `advanced` konservatif) dan N11-01 (dua tes arsip era) saling menutup
tanpa melonggarkan asersi; N11-04 (pesan relay) kini membedakan selfhost dari
Docker; N11-06 (timeout 180 dtk) terbukti cukup karena tes interop lulus di
dalam suite penuh. Satu fix **tertutup sebagian**: validator `OHTTP_TRUSTED_PROXIES`
yang baru (N11-05) meloloskan entri berakhiran garis miring tanpa angka
(`10.0.0.0/`, `fd00::/`) sebagai prefix `/0`, dan `/0` berarti "percaya semua
hop" — jadi salah-setel yang seharusnya ditangkap justru memperluas permukaan
`CF-Connecting-IP`. Terakhir, perbaikan `clientVersion` yang membuat suite hijau
masih **uncommitted**; pada HEAD `666f37c5` satu tes itu tetap merah dan
pengguna klien-terlalu-tua tetap tidak melihat layar pembaruan.

## A. Diperbaiki / diverifikasi

| ID | Bukti | Verdict |
|---|---|---|
| N11-01 (2 tes arsip era merah) | `spqrEraArchive.test.ts` **3/3 lulus**; fixture era ber-lalu-lintas memakai default konservatif, dan kasus baru `advanced: false` mengunci perilaku "tidak menggeser arsip" tanpa melonggarkan asersi | **Tertutup** |
| N11-02 (default `advanced`) | `spqrState.ts:202` → `advanced: input.advanced !== false \|\| existing?.advanced === true`; dua tes baru ("simpan tanpa penanda dianggap maju", "penanda false eksplisit") lulus di `spqrState.test.ts` 19/19 | **Tertutup** |
| N11-03 (docs/33 salah angka) | `docs/33-spqr-wasm.md:449-467` kini menyebut **nol** slot untuk era `advanced: false`, satu slot hanya bila era lama maju, dan menamai berkas + kasus tes | **Tertutup** |
| N11-04 (pesan relay menyesatkan) | `server/src/ohttp/relay.ts:44-52,120-129` menghitung `gatewayOnLoopback`: selfhost mendapat baris "kosong = benar", hanya gateway non-loopback yang disarankan mengisi CIDR | **Tertutup** |
| N11-05 (CIDR IPv6 diabaikan) | `clientTag.ts:160-175` membandingkan `BigInt` 128-bit; probe: `fd00::/8` mencocokkan `fd00::5`, `fd00::/129` dilaporkan; 24/24 tes OHTTP lulus | **Tertutup sebagian** → **N12-01** |
| N11-06 (timeout oracle) | `x3dhOracleInterop.test.ts:56` → `INTEROP_TIMEOUT_MS = 180_000` (dua tes); lulus di suite penuh | **Tertutup** |
| N9-01…N10-05 | Tidak berubah selain di atas; seluruh tes terkait lulus | Tetap tertutup |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N12-01 | **Baru (Low, keyakinan tinggi)** | `OHTTP_TRUSTED_PROXIES=10.0.0.0/` atau `fd00::/` diterima dan berlaku sebagai `/0` → semua hop tepercaya, `CF-Connecting-IP` bisa dikarang (probe fungsi asli) |
| N12-02 | **Baru (Info, keyakinan tinggi)** | Fix `clientVersion` hanya di working tree; HEAD tetap merah pada satu tes dan layar versi tidak muncul untuk klien terlalu tua |
| F-13 | Tidak diverifikasi | `pnpm audit --prod` butuh jaringan |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip |
| E2E / drill / beban | Terbuka | E2E, drill DR & KT, drill alert, uji beban relay tidak dijalankan pass ini |

## C. Regresi baru

Tidak ada. Seluruh berkas yang diubah commit `666f37c5` diperiksa untuk efek
samping:

1. **Arsip braid** — default konservatif tidak mengubah perilaku produksi (dua
   penulis `utils/crypto.ts` tetap `advanced: true`), dan merge tulis tertunda
   tidak bisa menurunkan penanda yang sudah maju.
2. **Relay** — percabangan pesan hanya mengubah teks log; `trustedProxies`
   tetap diteruskan ke app dengan bentuk yang sama.
3. **Validator** — entri tak sah tetap tidak dipercaya; yang berubah hanya
   pelaporan. Satu bentuk cacat lolos (N12-01), bukan regresi.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N12-01 | Low (High) | CIDR tanpa prefix (`10.0.0.0/`) dianggap `/0` → trust semua hop, tanpa peringatan |
| N12-02 | Info (High) | Perbaikan `clientVersion` uncommitted; HEAD masih gagal satu tes |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **0**, web **0**; `oxlint` 4 berkas **0 error**.
- `npx tsx --test tests/ohttp.test.ts` **24/24**.
- `vitest run` 4 berkas fokus **49/49**.
- `vitest run` **penuh**: 137 berkas, **1136/1136 lulus**, exit 0.
- `cargo test` sidecar lulus; `server/kt-query/build.sh test` exit 0
  (`go vet` + `go test ./...`, 4 paket `ok`, 0 `FAIL`).
- `tools/dr-oracle -check` → "vektor oracle identik dengan hasil regenerasi".
- `fuzz:parsers` 50 000 iterasi → 0 temuan, deterministik.
- Probe `ohttpClientAddress`/`invalidTrustedProxyReason` → N12-01.

## F. Rekomendasi urutan tindak lanjut

1. **N12-01** — tolak prefix kosong dan garis miring ganda di validator; buat
   `proxyMatches` fail-closed untuk prefix yang tidak bisa diparse; tambah dua
   asersi (alasan + alamat soket).
2. **N12-02** — commit `web/src/lib/api.ts` + tesnya; tidak ada perubahan kode
   tambahan yang diperlukan.
3. Jalankan E2E `--project=chrome` (butuh sidecar + coturn) minimal sekali
   sebelum rilis, karena itu satu-satunya area besar yang belum pernah
   dieksekusi pada rangkaian audit ini.
4. Pertimbangkan menjalankan tiga drill (`client-restore`, `kt-v2-restore`,
   `drill-alerts`) di CI terjadwal, bukan hanya manual.
