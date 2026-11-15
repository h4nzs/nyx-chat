# Pass 11 — Laporan delta

Basis: `0c337be9`. Pass 1: `AUDIT_REPORT.md`. Pass 2–10: `pass-2/`…`pass-10/`.
Temuan baru: `20-findings.md`. Verifikasi fix: `30-verify-fixes.md`.

## Ringkasan satu paragraf

Empat dari lima fix pass 10 benar-benar menutup temuannya, dan untuk pertama kali
saya bisa menutupnya dengan bukti eksekusi yang kuat: limiter gateway kini
memakai `clientRateLimitTag` yang tag-nya **hanya dipercaya bila proses API
memegang `OHTTP_INTERNAL_TOKEN` yang sama** (`app.ts:413` menyetelnya — ini
kekhawatiran utama saya: tes bisa lulus karena menyetel token sendiri, sementara
produksi lupa), relay memakai HMAC alamat klien sebagai key, dan tesnya
menjalankan router asli (140 request, dua tag) sehingga 429 di #121 tidak lagi
terjadi. `CF-Connecting-IP` sekarang hanya dibaca dari hop tepercaya, dan nginx
menimpanya di **enam** blok. Yang tidak beres ada di sisi klien: fix N10-04
membuat `spqrEraArchive.test.ts` **merah** (2 tes), dan setelah menelusuri
seluruh pemanggil `saveSpqrState` saya menemukan alasan yang lebih dalam — di
produksi hanya ada dua penulis state dan keduanya `advanced: true`, jadi kondisi
yang diklaim N10-04 ("dua era tanpa pesan memakan dua slot") **tidak bisa
dicapai lewat jalur nyata**. Guard itu benar secara mekanisme tetapi inersia di
produksi, dan default `advanced: false` mengarah ke sisi yang salah: pemanggil
baru yang lupa menandai akan **diam-diam** membuang era lama — kelas bug N5-01
kembali tanpa suara. Dokumentasi `docs/33` pada commit yang sama juga
mengklaim hasil tes yang kenyataannya merah. HEAD saat ini: server hijau, web
merah 4 tes (2 di antaranya dari commit ini, 2 lingkungan/pre-existing).

## A. Diperbaiki / diverifikasi

| ID | Bukti | Verdict |
|---|---|---|
| N10-01 (urutan monitor KT) | `planKtMonitor(states)` dipanggil sebelum `resolveConfig` (`ktBundleProof.ts:852-866`); tes `ktMonitoring` lulus; `refreshKtAnchor` yang ikut terlewat **tidak** menghilangkan jangkar karena `checkBundleAgainstKeyTransparency` sudah menyegarkannya saat jangkar kosong (`ktBundleProof.ts:733`) | **Tertutup** |
| N10-02 (dua limiter OHTTP) | Gateway: `keyGenerator: clientRateLimitTag` (`routes/ohttp.ts:71-77`) + token disetel produksi (`app.ts:413`). Relay: key `relayClientTag(token, alamat)` (`relayApp.ts:113-130`). Tes: 140 request dua tag → 0×429, satu tag → 429 di #121; relay 140 alamat → 0×429 | **Tertutup** |
| N10-03 (trust header relay) | `ohttpClientAddress` memakai alamat soket lebih dulu, header hanya bila hop ∈ `OHTTP_TRUSTED_PROXIES` (`clientTag.ts:127-152`); nginx menimpa `CF-Connecting-IP $remote_addr` di 6 blok (`ops/nginx/nyx.conf:196,214,228,364,382,396`) dan `set_real_ip_from 127.0.0.1/::1`; kedua `server` hanya `listen 127.0.0.1:3000` | **Tertutup** → N11-05 (CIDR IPv6) |
| N10-04 (arsip braid) | `advanced` disimpan di baris ter-seal (`spqrState.ts:104-150`), rotasi hanya bila `current.advanced` (`:331-360`), penulis nyata menandai `true` (`crypto.ts:470,574`) | **Sesuai desain, tetapi inersia di produksi** → N11-01/02/03 |
| N10-05 (suite server merah) | `ipKey.test.ts:77-79` menegaskan `clientRateLimitTag(req)`; `pnpm --filter nyx-server run test` **exit 0** | **Tertutup** |
| N9-01, N9-02, N9-03, N8-xx | Tidak berubah sejak pass 10 selain yang di atas; tes terkait lulus | Tetap tertutup |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| N11-01 | **Baru (Low, keyakinan tinggi)** | `spqrEraArchive.test.ts` 2 tes gagal → suite web merah, CI unit merah |
| N11-02 | **Baru (Low)** | Guard `advanced` inersia di produksi; default `false` mengarah ke kehilangan era tanpa suara |
| N11-03 | **Baru (Info)** | `docs/33` mengklaim "dua era tanpa pesan → arsip tetap satu slot"; implementasi menghasilkan **0** slot |
| N11-04 | **Baru (Info)** | Relay mencetak saran menyetel `OHTTP_TRUSTED_PROXIES` setiap boot, padahal selfhost **wajib** mengosongkannya |
| N11-05 | **Baru (Info)** | `OHTTP_TRUSTED_PROXIES` mengabaikan CIDR IPv6 tanpa peringatan (terbukti lewat probe) |
| N11-06 | **Baru (Info)** | `x3dhOracleInterop` melewati batas 60 dtk saat cache Go dingin → suite merah pada mesin bersih |
| `clientVersion.test.ts` | **Pre-existing** | Gagal juga di `bfca57c7` (bisect); bukan regresi commit ini |
| F-13 | Tidak diverifikasi | `pnpm audit --prod` butuh jaringan |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip |
| Cakupan | Terbuka | E2E, fuzz, Go KT, drill, DR oracle `-check`, suite web di luar `src/lib` |

## C. Regresi baru

1. **Arsip era braid (2 tes merah).** `spqrEraArchive.test.ts:138,187` menulis
   state era dengan `saveSpqrState(...)` **tanpa** `advanced`; karena default
   sekarang `false`, `rotateSpqrStateForNewSession` tidak mengarsipkan apa pun:
   `expected [] to have a length of 1` dan `expected [] to have a length of 3`.
   Commit yang sama memperbarui `spqrState.test.ts` (menambahkan
   `advanced: true` pada fixture-nya) tetapi **tidak** memperbarui tes arsip era
   yang justru penjaga fitur itu.
2. **Klaim dokumentasi yang tidak lagi benar.** `docs/33-spqr-wasm.md:448-450`
   menyatakan "dua era dengan state awal berbeda dan tanpa pesan → arsip tetap
   **satu** slot"; dengan penanda `advanced`, dua era tanpa lalu lintas
   menghasilkan **nol** slot. Angka "satu slot" yang tertulis adalah hasil tes
   yang sekarang merah.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N11-01 | Low (High) | 2 tes arsip era gagal → `pnpm --filter nyx-web test` merah, CI unit merah |
| N11-02 | Low (Medium-High) | Kondisi N10-04 tidak bisa dicapai lewat `saveSpqrState` produksi; default `advanced: false` membahayakan pemanggil baru |
| N11-03 | Info (High) | `docs/33` mengklaim hasil tes yang kenyataannya merah |
| N11-04 | Info (High) | Peringatan start relay bertentangan dengan instruksi selfhost (kosongkan) |
| N11-05 | Info (High) | CIDR IPv6 di `OHTTP_TRUSTED_PROXIES` diabaikan diam-diam (probe) |
| N11-06 | Info (Medium) | Interop oracle timeout 60 dtk saat cache Go dingin |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **0**, web **0**.
- `pnpm --filter nyx-server run test`: **exit 0**.
- `vitest run` 109 berkas `src/lib/__tests__`: **943/947**; gagal: 2 arsip era,
  1 `clientVersion` (pre-existing, terbisect), 1 interop oracle (timeout, lulus
  saat dijalankan sendiri 11 dtk).
- Probe `ohttpClientAddress`: IPv4 CIDR cocok, IPv6 CIDR tidak, peer tak
  tepercaya memakai soket.
- Tidak dijalankan: E2E, fuzz, Go KT, drill, DR oracle `-check`, `cargo test`,
  suite web di luar `src/lib`.

## F. Rekomendasi urutan tindak lanjut

1. **N11-01** — perbarui dua tes arsip era: state yang mewakili era ber-lalu
   lintas harus `advanced: true`; tambahkan satu kasus "era tanpa lalu lintas"
   yang mengharapkan arsip **tetap** (bukan bertambah) supaya perilaku baru
   terkunci di tes yang benar.
2. **N11-02** — balik default: `advanced` default `true`, dan pemanggil yang
   menulis state awal era (belum ada) memakai flag eksplisit `fresh: true`.
   Dengan begitu pemanggil baru tidak bisa diam-diam menghapus era lama.
3. **N11-03** — koreksi kalimat `docs/33` (0 slot, bukan 1) dan hentikan
   merujuk tes yang merah.
4. **N11-04** — turunkan pesan start relay menjadi satu baris informasional yang
   menyebut kedua profil (selfhost: kosong; Docker: CIDR nginx), atau cetak
   hanya bila target gateway bukan loopback.
5. **N11-05** — dukung CIDR IPv6 (atau tolak dengan peringatan start) supaya
   salah-setel tidak berubah menjadi satu bucket bersama tanpa gejala.
6. **N11-06** — naikkan timeout tes interop atau pra-bangun oracle di CI.
