# Pass 12 — Verifikasi fix pass 11 (commit `666f37c5`)

## N11-01 — dua tes arsip era gagal: **TERTUTUP**

Bukan dengan melonggarkan asersi: fixture yang mewakili era ber-lalu-lintas
kembali diarsipkan karena default berubah (N11-02), dan perilaku baru dikunci
tes ketiga:

```ts
// web/src/lib/__tests__/spqrEraArchive.test.ts
it('era baru tanpa lalu lintas tidak menggeser arsip (advanced: false)', …)
```

Bukti: `vitest run spqrEraArchive spqrState clientVersion ktMonitoring` →
**49/49 lulus** (arsip era 3/3, spqrState 19/19). Pada pass 11 berkas ini merah
`expected [] to have a length of 1` dan `… of 3`.

## N11-02 — default `advanced` mengarah ke kehilangan era: **TERTUTUP**

```ts
// web/src/lib/spqrState.ts:199-202
// Menempel: satu langkah yang sudah maju tidak boleh "dibatalkan" …
advanced: input.advanced !== false || existing?.advanced === true,
```

Default kini konservatif (era diarsipkan), dan satu-satunya cara melewati arsip
adalah `advanced: false` eksplisit. Dua tes baru mengunci kedua arah, termasuk
"simpan tanpa penanda dianggap maju: era lama tetap diarsipkan"
(`spqrState.test.ts:299-328`). Tidak ada penulis produksi yang menyetel `false`
(`utils/crypto.ts` tetap `true`), jadi perilaku produksi tidak berubah dan
pemanggil baru tidak bisa diam-diam membuang era.

## N11-03 — `docs/33` mengklaim hasil tes yang merah: **TERTUTUP**

`docs/33-spqr-wasm.md:449-467` sekarang menyebut angka yang benar (**nol** slot
untuk dua era yang ditandai `advanced: false`; era yang maju menggeser ke
`[baru, lama]`), menjelaskan default konservatif, dan menamai berkas + kasus tes
(`spqrState.test.ts`, `spqrEraArchive.test.ts`) alih-alih ringkasan bebas. Angka
itu cocok dengan tes yang kini hijau.

## N11-04 — peringatan start relay bertentangan dengan selfhost: **TERTUTUP**

```ts
// server/src/ohttp/relay.ts:44-52
const gatewayHost = … new URL(gatewayTarget).hostname …
const gatewayOnLoopback = LOOPBACK_BINDS.has(gatewayHost);
// :120-129
if (trustedProxies.length === 0) {
  if (gatewayOnLoopback) console.log('… kosong: benar untuk selfhost …');
  else console.warn('… setel alamat/CIDR nginx …');
}
```

Profil selfhost (gateway `127.0.0.1`) tidak lagi diarahkan ke nilai yang ditolak
`verify-boot.sh`; peringatan hanya muncul untuk hop jaringan nyata. Sisa yang
tidak diuji: URL gateway berbentuk `http://[::1]:4000/...` — `hostname` di
`URL` mengembalikan `[::1]`, dan kode sudah melepas kurung siku, jadi masuk
`LOOPBACK_BINDS`.

## N11-05 — CIDR IPv6 diabaikan diam-diam: **TERTUTUP SEBAGIAN**

Perbandingan 128-bit benar dan probe mengonfirmasi:

```
v6 cidr fd00::/8            -> fd00::5      (header dipakai)
v6 cidr fe80::/10           -> fe80::1      (header dipakai)
fd00::/129                  -> dilaporkan "prefix /129 tidak sah untuk IPv6"
172.16.0.0/33               -> dilaporkan "… IPv4 (0–32)"
```

Tetapi validator baru punya lubang yang membuat klaim "entri tidak bisa diparse
dilaporkan" tidak sepenuhnya benar:

```
invalidTrustedProxyReason('10.0.0.0/')  -> null   (dianggap sah)
invalidTrustedProxyReason('fd00::/')    -> null   (dianggap sah)
ohttpClientAddress(..., ['10.0.0.0/'])  -> memakai CF-Connecting-IP
```

`Number('') === 0`, dan `proxyMatches` mengembalikan `true` untuk prefix `0`.
Jadi salah-setel yang tampak sah berubah menjadi "percaya semua hop" — efek
yang sama dengan N10-02/N10-03. Rinciannya: **N12-01**.

## N11-06 — interop oracle timeout saat cache Go dingin: **TERTUTUP**

`web/src/lib/__tests__/x3dhOracleInterop.test.ts:56` menetapkan
`INTEROP_TIMEOUT_MS = 180_000` dan dipakai kedua tes (`:152`, `:180`); tidak ada
tes yang di-skip. Suite web penuh lulus, jadi batas ini cukup di mesin ini.
`go run . -check` di `tools/dr-oracle` juga lulus ("vektor oracle identik dengan
hasil regenerasi").

## Lima klaim "Verified-OK" yang ditantang ulang

1. **Pengecualian CSRF hanya tanpa cookie sesi** — bertahan.
   `server/src/app.ts:430-452`: allowlist hanya `/api/pir/query` +
   `/api/keys/kt/search`, dan `hasSessionCookie` memeriksa `at`/`rt`/`embed_at`;
   bila ada cookie, `doubleCsrfProtection` tetap berjalan.
2. **State KT hanya ditulis setelah verifikasi** — bertahan, termasuk urutan
   baru: `monitorKeyTransparency` memeriksa `planKtMonitor` lalu `resolveConfig`
   sebelum `runKtMonitorOnce`, dan `saveState` hanya dipanggil setelah
   `verifyMonitor` sukses (`ktBundleProof.ts:720,863-882`). Tidak ada
   penulisan state di jalur early return.
3. **Allowlist OHTTP tetap sempit** — bertahan. `routes/ohttp.ts` memakai
   `config.allowlist` untuk dispatch, dan 24/24 tes (termasuk "target di luar
   allowlist dijawab 403 terenkripsi") lulus.
4. **Guard capability admin fail-closed** — bertahan.
   `server/src/utils/adminCapability.ts:38-46` mengembalikan `false` untuk hash
   NULL/kosong, dan `requireAdminCapability` memakai perbandingan timing-safe
   terhadap SHA-256 token (bukan token mentah).
5. **Cookie sesi dari satu sumber** — bertahan. `authCookieOptions()` dipakai
   `setAuthCookies` dan `clearAuthCookies` (`sessionUtils.ts:21-44`) dengan
   `path/httpOnly/secure/sameSite/domain` yang sama.

## Suite penuh (pertama kali hijau dalam rangkaian audit ini)

```
Test Files  137 passed (137)
     Tests  1136 passed (1136)
```

Ini **dengan** dua berkas uncommitted (`api.ts` + `clientVersion.test.ts`).
Tanpa keduanya, HEAD `666f37c5` tetap gagal satu tes
"CLIENT_VERSION_REQUIRED dibedakan dari too-old" (pass 11 mengukurnya di HEAD;
kode `getCsrfToken` di HEAD belum melaporkan 426). Lihat **N12-02**.
