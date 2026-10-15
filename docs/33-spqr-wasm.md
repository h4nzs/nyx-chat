# 33 — SPQR WASM: ratchet PQ dengan forward secrecy **dan** post-compromise security

> **Status: SELESAI (2026-10-14).** Pembungkus WASM + test + benchmark
> (2026-10-13), prasyarat negosiasi/state (2026-10-14), dan **integrasi jalur
> pesan** — versi wire v2 + deklarasi versi in-band + state berdampingan +
> rollback + E2E Chrome — semuanya landed (§33.10). Jalur v1 tetap beku dan
> tetap default; v2 hanya dipakai setelah **peer membuktikan** bisa membacanya.

Rencana & acceptance gate: `docs/30` §30.8. Pin: crate `spqr` v1.6.0
(SparsePostQuantumRatchet, commit `06959b4708f9`, AGPL-3.0).

## 33.1 Kenapa SPQR

DR hybrid NYX sekarang punya **PQ forward secrecy** dari langkah KEM
(`KEMs`/`KEMr`/`savedCt`, header `ct` 1120 byte sampai `ackKem`) — kompromi state
hari ini tidak membuka pesan lampau. Yang belum: **post-compromise security PQ**
— setelah state bocor, ratchet tidak pernah pulih sepenuhnya karena bagian
public ratchet-nya masih berbasis DH klasik + KEM sekali pakai.

SPQR mengganti bagian itu dengan **ML-KEM Braid**: sekumpulan chunk tahan
kehilangan (erasure coding Reed–Solomon) yang dipertukarkan dua arah, sehingga
(a) state lama tidak bisa membaca pesan lampau (FS), dan (b) setelah pertukaran
braid berikutnya, penyerang yang pernah mencuri state **kehilangan** akses
(PCS). Crate `spqr` sengaja hanya mengeluarkan **message key**, bukan format
pesan — jadi chain simetris NYX (XChaCha20-Poly1305) tidak perlu berubah.

## 33.2 Artefak

| Berkas | Isi |
|---|---|
| `packages/spqr-wasm/src/lib.rs` | pembungkus Rust: ABI primitif, entropi disuntik host |
| `packages/spqr-wasm/build.sh` | build ke `wasm32-unknown-unknown` (tanpa `wasm-pack`), menyalin `Cargo.toml.in` → `Cargo.toml` |
| `vendor/signal/spqr/` | crate `spqr` **ter-vendor** (pin §30.2), sumber default `build.sh` |
| `packages/spqr-wasm/dist/spqr.wasm` | **artefak ter-commit** (±507 KiB) dari sumber ter-vendor itu — hash-nya dipin di `packages/wasm-artifacts.json`, dibangun ulang tiap push oleh CI (job `wasm`) |
| `web/src/lib/spqrRatchet.ts` | pembungkus TS: framing, kode hasil, `SpqrError`, injeksi entropi |
| `web/src/lib/spqrBench.ts` | harness benchmark (gate §30.8 poin 5) |
| `web/src/lib/__tests__/spqrRatchet.test.ts` | 10 test properti dengan modul hasil build sungguhan |
| `web/src/lib/__tests__/spqrBench.test.ts` | runner benchmark (`NYX_BENCH=1`) |

Detail build & ABI: `packages/spqr-wasm/README.md`.

## 33.3 Kontrak yang mudah salah

1. **Nol import.** Modul WASM tidak boleh menarik host function apa pun
   (tidak ada `wasm-bindgen`). Dijaga test (`WebAssembly.Module.imports` harus
   kosong) — ini yang membuat klien tidak perlu mempercayai glue JS.
2. **Entropi disuntik sesudah/before yang benar.** `spqr_seed_entropy` membaca
   scratch input yang **sama** dengan state, jadi urutannya: seed entropi →
   tulis state → panggil `spqr_send`. Salah urutan = state tertimpa.
3. **`memory.grow` melepas ArrayBuffer.** Akses pertama ke scratch Rust memicu
   alokasi malas + `memory.grow`; ArrayBuffer yang sudah dipegang jadi
   ter-`detach` (di lingkungan jsdom/V8 ini bahkan `memory.grow(0)` **tidak**
   memperbaikinya). Karena itu pembungkus memanggil getter memori
   (`spqr_in_ptr`/`spqr_out_ptr`/`spqr_out_len`) **lebih dulu** dan membaca
   `memory.buffer` paling akhir. Gejalanya dulu: `TypeError: Cannot perform
   Construct on a detached ArrayBuffer` pada instance kedua/berikutnya.
4. **`env` WASM harus kosong di sisi Rust.** Contoh "cara cepat" `wasm-pack`
   pada crate ini akan menarik `web-sys`/`rand` backend browser; kita tidak
   memakai jalur itu.

## 33.4 Test yang mengunci perilaku

`web/src/lib/__tests__/spqrRatchet.test.ts` (10 test, modul hasil build):

| # | Properti |
|---|---|
| 1 | modul tanpa import + seluruh ABI diekspor |
| 2 | state kosong vs state awal berbeda |
| 3 | negosiasi versi selesai setelah pertukaran pertama (`NEGOTIATING` → `V1`) |
| 4 | `send`/`recv`: message key sepakat, state maju, key berubah tiap pesan |
| 5 | entropi host: sumber tetap → pesan & state identik (modul tidak punya RNG sendiri) |
| 6 | entropi kurang → `SpqrError(4)`, bukan trap |
| 7 | kehilangan **1..N−1** pesan → pesan berikutnya tetap sepakat, lalu ratchet menyembuhkan (arah balik sinkron) |
| 8 | pengiriman **keluar urutan** → key tiap pesan tetap sama (skipped key) |
| 9 | kehilangan **dua arah bergantian** → state tetap sinkron |
| 10 | fuzz: puluhan input acak tidak merusak instance (error = `SpqrError(1/3)`, bukan trap/abort) |

Bila `dist/spqr.wasm` tidak ada, suite **di-skip** (bukan gagal) — sama seperti
konvensi test lain yang butuh artefak build.

### Batas cakupan yang jujur

Gate §30.8 poin 2 berbunyi "packet loss 1..N−1 **chunk** → pesan tetap dapat
direkonstruksi (erasure coding benar-benar bekerja)". Lapisan chunk/erasure ada
di `spqr::v1::chunked` yang bersifat `pub(crate)` pada crate ter-pin — jadi drop
**per chunk** tidak bisa dipicu dari ABI publik tanpa mem-fork crate (dilarang
§30.1). Yang diuji di sini adalah bentuk yang bisa diamati dari luar: **pesan
hilang** dan **pesan keluar urutan**, dan keduanya sembuh (test 7–9). Bukti
erasure coding tingkat chunk sekarang datang dari test internal crate pada pin
yang sama, dan test itu **benar-benar dijalankan** (§33.6): model crate adalah
satu langkah `send` = satu chunk di wire, jadi menjatuhkan pesan di orchestrator
test-nya = menjatuhkan chunk.

## 33.5 Benchmark (gate §30.8 poin 5)

`NYX_BENCH=1 pnpm --filter nyx-web run bench:spqr` — 500 langkah/arah, mesin dev
(2026-10-13):

| Metrik | Nilai |
|---|---|
| Ukuran modul WASM | 506,7 KiB |
| Pesan pertama (negosiasi) | msg 37 B, state 3,8 KiB |
| Pesan mapan | msg 37 B, state 3,8 KiB, key 32 B |
| `send` (langkah ratchet penuh) | p50 **0,26 ms**, p95 0,60 ms |
| `recv` | p50 **0,12 ms**, p95 0,41 ms |
| Byte per langkah | wire **38,5 B**, state **3,8 KiB** |
| Puncak heap selama benchmark | 51,4 MiB |

Interpretasi (yang menentukan desain integrasi):

- **CPU murah**: 0,1–0,3 ms per langkah di mesin dev. Di VPS 1 core kelas
  `nyx-api` ini masih orde puluhan kali lebih cepat daripada anggaran enkripsi
  per pesan, jadi ratchet PQ bukan hambatan CPU.
- **Wire kecil, state besar.** Pesan braid hanya 37 B di steady state (chunk
  erasure dikirim saat dibutuhkan), tetapi **state 3,8 KiB di-rewrite setiap
  langkah**. Konsekuensi arsitektur: state wajib disimpan di keychain ter-seal
  (`ENC1:`) dengan penulisan di-debounce/koalesensi per batch pesan — bukan
  satu tulis IndexedDB per pesan.
- **Ukuran state tumbuh** kalau skipped key menumpuk (pesan hilang berturut-turut
  menahan key), jadi store v2 butuh batas retensi yang sama dengan DR sekarang.

Angka apa adanya; ambang penjaga regresi ada di `SPQR_BENCH_BUDGET`.

## 33.6 Bukti dari crate ter-pin — **LULUS (2026-10-14)**

Rencana: menjalankan test internal crate `spqr` pada crate pin
(sekarang tersedia di repo: `vendor/signal/spqr`; `scripts/vendor-signal.sh`
menyalinnya dari checkout `~/signal/SparsePostQuantumRatchet`) sebagai bukti
kedua. Sebelumnya langkah ini
tercatat "belum dijalankan" karena anggaran waktu; sekarang dijalankan dan
hasilnya dicatat apa adanya:

| Perintah | Hasil |
|---|---|
| `cargo test --release --lib` (stable 1.95.0) | **gagal kompilasi**: `error[E0658]` — `std::assert_matches` masih unstable (dipakai `src/lib.rs`) |
| `cargo +nightly test --release --lib` (nightly 1.101.0) | **57 passed; 0 failed; 0 ignored** dalam 12,5 s, exit 0 |

Checkout yang diuji adalah **pin yang sama** yang dikompilasi ke WASM untuk jalur
v2: HEAD `06959b4708f9` = v1.6.0 (pin §30.2), working tree tanpa perubahan kode
(isi itu kini disimpan utuh di `vendor/signal/spqr`, jadi `cargo +nightly test
--release --lib` bisa diulang dari repo ini).
Yang ikut lulus adalah property test proptest crate (`random_balanced`,
`random_balanced_out_of_order`, `chaos`, `onlineoffline_healing`,
`random_slow_alex_healing_auth_bidir`, `hybrid_ratchet`). Catatan jujur soal
wording gate: yang dijalankan adalah **target native**, karena test harness Rust
(`#[test]`) tidak bisa dieksekusi di `wasm32-unknown-unknown` tanpa harness pihak
ketiga; perilaku modul **hasil build WASM**-nya sendiri dikunci terpisah oleh 13
test `spqrRatchet.test.ts` + 13 test `spqrSession.test.ts` (§33.10) yang berjalan
atas `packages/spqr-wasm/dist/spqr.wasm`.

### Kehilangan per chunk (gate poin 2) — bukti dari dalam crate

Model crate adalah **satu langkah `send` = satu chunk di wire**
(`v1/chunked/states.rs`: `send_hdr_chunk`, `send_ek_chunk`, `send_ct1_chunk`,
`send_ct2_chunk`), dan orchestrator test menjatuhkan pesan satu per satu
(`orchestrator::drop_message_at`, probabilitas di `chaos`/`onlineoffline`). Jadi
drop di orchestrator = drop **per chunk**, tepat seperti bunyi gate. Yang lulus
dan relevan:

- `v1::test::chaos` — 10.000 tick: 70% keluar urutan, 10% pesan (=chunk) hilang.
- `v1::test::onlineoffline_healing_unidir` — 100.000 tick dengan 4–5% chunk hilang.
- `v1::test::balanced_healing`, `random_balanced`, `random_balanced_out_of_order`,
  `random_slow_alex_healing_auth_bidir` — healing setelah kehilangan acak.

(`v1::test::*` memakai `v1::chunked::states::States` — jalur chunked, bukan
unchunked.) Sisa batasnya karena itu bukan lagi "tidak ada bukti", melainkan
**granularitas pengamatan**: test-test itu membuktikan ratchet **healing** (key
epoch berikutnya sepakat setelah chunk hilang), bukan pernyataan terpisah
"pesan X direkonstruksi dari N−1 dari N chunk-nya", sebab
`chunked::states::recv` mengembalikan secret epoch, bukan payload pesan.

## 33.7 Integrasi jalur pesan (landed 2026-10-14 — lihat §33.10)

Rencana §30.8 poin 2–3 menuntut langkah `KEMs/KEMr` di
`web/src/workers/crypto.worker.ts` diganti dengan braid SPQR, **dipilih lewat
kapabilitas** `spqr-ratchet` (sudah dideklarasikan di
`packages/shared/src/transport.ts`, sengaja **belum** diiklankan klien), dengan
peer lama tetap jalur v1 dan state v1 tetap `ENC1:` di keychain.

**Sisa yang dulu tercatat** — poin 1 (versi wire baru di header DR + ack) dan
poin 4 (gate E2E) — **sudah dikerjakan** (§33.10): header v2 `{v:2,b:[…]}`,
deklarasi `ackV` di payload ter-seal, dan spec E2E `web/e2e/spqr.spec.ts` yang
membuktikan amplop di server benar-benar `dr.v === 2`.

Yang membuat itu bukan sekadar pemanggilan API (semua sudah ditangani, dirinci
di §33.10):

1. **Format wire ikut berubah.** Header DR sekarang membawa `ct` (1120 byte)
   sampai `ackKem`; mengganti penghasil `KEMs/KEMr` mengubah isi header dan
   karena itu **protokol beku** `docs/04` — butuh versi baru, bukan tambalan.
2. **State kedua jalur harus hidup berdampingan.** Negotiasi versi SPQR
   (`NEGOTIATING` → `V1`) adalah state *protokol*, bukan flag; perpindahan harus
   idempoten dan bisa dibatalkan (rollback) tanpa kehilangan kemampuan membaca
   pesan lama.
3. **Anti-downgrade.** Jalur v2 hanya boleh aktif bila **kedua** klien
   mengiklankan kapabilitas; server tidak pernah menentukan primitif. Ini
   memerlukan perubahan handshake (`transport hello`/capability) yang harus
   diuji end-to-end.
4. **Gerbang verifikasi.** Tanpa E2E (klien↔klien nyata lewat sidecar + Redis),
   perubahan header tidak bisa dibuktikan tidak regresi — dan `docs/30` §30.1
   melarang menyentuh jalur kripto beku tanpa itu. Lingkungan mesin ini juga
   tidak punya Postgres/Redis untuk menjalankan E2E.

Titik-titik di atas dulu membuat WS-D berhenti di batas yang bisa diverifikasi
statis + unit test. Semuanya kini tertutup (§33.10) dengan versi wire baru,
bukan tambalan pada jalur beku.

## 33.9 Prasyarat integrasi yang sudah landed (2026-10-14)

Dua hal yang §33.7 sebut sebagai penahan integrasi sudah dikerjakan **di luar**
jalur kripto beku, jadi bisa diuji tanpa E2E:

### `web/src/lib/spqrNegotiation.ts` — keputusan versi (murni, 9 test)

Aturan yang dikodekan, semuanya konsekuensi dari kesalahan transisi yang mahal:

1. **Kapabilitas hanya dibaca saat sesi DIDIRIKAN.** Sesi yang sudah berjalan
   mempertahankan versinya (`reason: 'established'`) walau kabar kapabilitas
   berikutnya berbeda — mencocokkan ulang di tengah sesi adalah cara termudah
   kehilangan riwayat pesan. Kapabilitas sah datang dari **handshake transport
   yang terautentikasi**, bukan dari payload pesan.
2. **Anti-downgrade:** v2 hanya bila KEDUA sisi mengiklankan `spqr-ratchet`.
   Peer legacy → v1, bukan "coba v2 dan berharap".
3. **Saklar tunggal `SPQR_INTEGRATION_ENABLED = false`** menentukan apakah klien
   mengiklankan kapabilitas (`advertisedCapabilities()`). Tetap `false` sampai
   jalur v2 benar-benar bisa memproses pesan: kapabilitas tanpa implementasi
   membuat peer memilih versi yang tidak bisa kita baca.
4. **Rollback eksplisit:** `planRatchetRollback('v2')` → `{ version: 'v1',
   preservedVersion: 'v2' }`. Pemanggil WAJIB mempertahankan state v2 (jendela
   baca pesan lama); modul ini tidak menghapus apa pun.

Nama kapabilitas diambil dari `CLIENT_CAPABILITIES.SPQR_RATCHET` (`@nyx/shared`),
berlaku paritas yang sama dengan sidecar Rust (`transportCapabilities.test.ts`).

### `web/src/lib/spqrState.ts` — state braid per sesi (9 test)

Benchmark §33.5 memberi dua angka yang menentukan desain: langkah ratchet murah
(p50 0,26 ms) tetapi **state 3,8 KiB ditulis ulang setiap langkah**. Jadi modul
ini bukan sekadar pembungkus IndexedDB:

- **Ter-seal `ENC1:`** (masterSeed), sama seperti state DR v1 — state braid memuat
  chunk ML-KEM yang belum dipertukarkan, dan membocorkannya = kehilangan PCS.
- **Koalesensi tulis** 250 ms (`SPQR_STATE_WRITE_DEBOUNCE_MS`): burst pesan → satu
  tulis. `flushSpqrState()` memaksa tulis (tab disembunyikan/keluar), `
  discardPendingSpqrState()` membuang antrean tanpa menulis (wipe).
- **Batas 64 KiB** (`SPQR_MAX_STATE_BYTES`, ~16× state mapan) diperiksa **sebelum**
  masuk antrean — state yang membengkak karena skipped key menumpuk ditolak
  dengan terlihat, bukan menulis 8 KiB setiap langkah.
- **Fail-closed saat dibaca:** cipher yang tidak bisa dibuka (vault terkunci, baris
  rusak) menghasilkan `undefined` — pemanggil harus memulai sesi baru, bukan
  memakai state kosong yang memutus rantai tanpa suara.
- **Byte opaque:** format state tetap milik modul WASM (`spqrRatchet.ts`); modul
  ini tidak tahu isinya.

## 33.10 Integrasi jalur pesan — yang benar-benar landed (2026-10-14)

### Wire: versi baru, bukan tambalan

| | v1 (beku) | v2 (braid SPQR) |
|---|---|---|
| Header | `{kemPk, ct, n, pn}` | `{v: 2, b: [frame…]}` |
| Material ratchet | `ct` KEM 1120 B (+ `ackKem` untuk omit-ct) | frame braid 37 B mapan |
| Message key | langkah DH + X-Wing | `spqr_send`/`spqr_recv` (ML-KEM Braid) |
| Sisa jalur | pad 8 KB + nonce 24 B + XChaCha20-Poly1305 | **sama** (ciphertext identik bentuk) |
| Deklarasi | `ackKem` | `ackV: 2` (versi yang bisa dibuka) |

- `web/src/lib/spqrWire.ts` — bentuk header v2 + parse fail-closed (batas frame,
  panjang, base64url) + `ackV` (tulis/baca dari payload ter-seal).
- `web/src/lib/spqrSession.ts` — orkestrasi langkah: **satu pesan pengguna = satu pesan wire** walau crate melewati keadaan tanpa key (frame dikumpulkan),
  dan `SpqrSessionError` bila key tak pernah ada (fail-closed, tidak menulis
  pesan yang tak bisa dibuka).
- Op worker `spqr_ratchet_init` / `spqr_ratchet_encrypt` / `spqr_ratchet_decrypt`
  memuat WASM **malas** (URL aset di-fetch saat v2 pertama dipakai) dan memakai
  padding/AEAD yang sama dengan v1.

### Siapa yang memutuskan v2 (anti-downgrade berlapis)

1. **Saklar integrasi** (`SPQR_INTEGRATION_ENABLED`, kill switch
   `VITE_SPQR_FORCE_V1=1`, plus kill switch **runtime** `localStorage['nyx_spqr_force_v1']`
   yang hanya aktif di build DEV) — operator memaksa semua pengiriman & iklan ke
   v1; state braid tidak dihapus dan **jalur baca v2 tetap hidup**, sehingga pesan
   v2 yang sudah terkirim tidak berubah jadi tak terbaca. Saklar dibaca **per
   pengiriman** (`spqrSendingEnabled()`), jadi rollback berlaku tanpa reload;
   keputusan lama yang membaca konstanta build-time (mis. gerbang baca) sengaja
   tidak ikut mematikan dekripsi.
2. **Kapabilitas transport** `spqr-ratchet` (client ∩ sidecar). Sidecar kini
   mengiklankannya (`SERVER_CAPABILITIES`) sebagai saklar **deployment**; tanpa
   itu klien tetap di v1 walau sama-sama baru.
3. **Deklarasi peer** `ackV: 2` di payload ter-seal — satu-satunya bukti yang
   dianggap sah. **Tanpa itu tidak pernah ada pesan v2 dikirim.** Konsekuensinya:
   klien lama tidak pernah menerima header yang tak bisa dibacanya.

Keputusan ada di `spqrNegotiation.resolveOutboundRatchetVersion` (murni,
idempoten, 6 test): v2 hanya bila ketiganya terpenuhi; sesi yang sudah v2
**sticky** (kapabilitas yang hilang saat reconnect tidak menurunkan versi),
dan rollback mengembalikan `preservedVersion: 'v2'` supaya pemanggil tidak
menghapus state braid.

### State berdampingan & rollback

- State DR v1 tetap di baris lamanya (tidak pernah ditimpa) — jalur rollback
  selalu tersedia.
- State braid disimpan per sesi di `kvStore` (`nyx_spqr_state_v1:<conv>`, ter-seal
  `ENC1:`), tulis di-koalesensi 250 ms, dibaca dari antrean pending bila belum
  ter-flush (koreksi penting: tanpa itu langkah berikutnya membaca state lama),
  di-flush saat tab disembunyikan, dan dibuang saat wipe (`nukeProtocol`).
- Akar braid = rahasia X3DH `sk` (sama di kedua sisi); peran braid `A2B`
  (inisiator) / `B2A` (penerima). Keduanya menumpang di baris state DR
  (`spqrAuthKey`/`spqrDirection`) supaya state braid tetap **lahir malas**.
- Pesan v2 yang datang untuk sesi lama (didirikan sebelum v2 ada) → error
  terlihat, bukan percobaan jalur v1.

### Bukti yang dijalankan (bukan klaim)

- `web/src/lib/__tests__/spqrSession.test.ts` (13 test, modul WASM sungguhan +
  ratchet palsu yang diskrip): kesepakatan key lewat API langkah, urutan nyata
  "B2A mengirim v2 pertama", pesan hilang/keluar urutan, entropi host, duplikat
  ditolak crate (→ MK cache wajib dicek lebih dulu), loop tanpa key →
  `SpqrSessionError`.
- `web/src/lib/__tests__/spqrWire.test.ts` (8 test): round-trip header, header v1
  tidak pernah dianggap v2, batas parse, `ackV`.
- `spqrNegotiation.test.ts` (18 test) + update `transportCapabilities.test.ts`:
  aturan v2 lengkap + paritas sidecar Rust.
- `cargo test` sidecar: `server_advertises_spqr_ratchet_as_deployment_switch`.
- **E2E** `web/e2e/spqr.spec.ts` (Chrome nyata, server + 2 klien): pesan v1 lebih
  dulu → peer menyatakan mampu → pesan berikutnya v2 → **peer membaca plaintext**
  → amplop di server diperiksa: ada `dr.v === 2` dengan `b` dan tanpa `kemPk`.
  Jalankan lokal tanpa sidecar:
  `VITE_SPQR_FORCE_V2=1 pnpm --filter nyx-web dev` lalu
  `npx playwright test --project=chrome e2e/spqr.spec.ts` (skip dengan alasan
  tertulis bila jalur v2 memang tidak aktif di lingkungan itu).
- **E2E rollback (§33.8) — dua klien nyata, lulus 2026-10-14:** setelah sesi v2
  berdiri di kedua arah, satu klien dipaksa kembali ke v1 lewat kill switch
  **runtime** DEV (karena `VITE_SPQR_FORCE_V1` build-time tidak bisa membedakan
  dua klien dari satu dev server). Dari amplop nyata di server:
  klien yang di-rollback **mengirim v1 lagi** (`kemPk`, tanpa `v`), peer (sesi v2)
  tetap membacanya (state v1 tidak pernah ditimpa), dan pesan v2 dari peer **tetap
  terbaca** di klien yang di-rollback. State braid setelah rollback masih ada
  (`loadSpqrState` → `version: 'v2'`) — rollback tidak menghapus apa pun.

### Batas yang jujur

- Gate §30.8 poin 1 **tertutup pada pin yang sama** (§33.6): 57 test internal
  crate lulus (`cargo +nightly test --release --lib`, HEAD `06959b4708f9`,
  exit 0); stable tidak bisa mengompilasinya (`assert_matches` unstable).
- Gate poin 2 (loss per chunk) kini bersandar pada test chunked di dalam crate
  (§33.6); batas yang tersisa hanya granularitas pengamatan dari ABI publik
  (§33.4).
- ~~Modul WASM tidak di-precache~~ **Sudah di-precache (2026-10-14):**
  `injectManifest.globPatterns` di `web/vite.config.ts` kini memuat `**/*.wasm`,
  jadi `spqr-*.wasm` **dan** `keytrans-*.wasm` ikut manifest (terverifikasi di
  `dist/sw.js`). Biaya terukur: install PWA bertambah **818.678 byte ± 0,8 MB**
  tak terkompresi (spqr 518.832 B + keytrans 299.846 B) — sengaja diterima supaya
  jalur v2 tersedia offline sejak install, bukan bergantung cache HTTP yang bisa
  di-revalidate. Bila modulnya tetap tidak bisa dimuat, pengiriman jatuh ke v1
  (aman, peer bisa membaca).

## 33.8 Rollback

Dua jalur, keduanya **tidak menghapus** state apa pun:

1. **Peer berhenti menyatakan v2** (`ackV` hilang) → pengiriman kembali ke v1.
2. **Kill switch operator** — `VITE_SPQR_FORCE_V1=1` (build-time, berlaku untuk
   seluruh deployment) atau `localStorage['nyx_spqr_force_v1'] = '1'`
   (runtime, **hanya build DEV**; dipakai E2E untuk mem-rollback satu klien saja).
   Efeknya: kirim v1, berhenti mengiklankan kapabilitas, berhenti menulis
   `ackV: 2`. **Jalur baca v2 tidak dimatikan** — lihat §33.10.

Yang dibuktikan E2E (§33.10) dan tidak bisa dibuktikan unit test: pada sesi v2
nyata, klien yang di-rollback benar-benar mengirim header v1 lagi, peer-nya tetap
bisa membaca pesan itu, dan pesan v2 yang datang tetap terbaca di klien yang
di-rollback.

- Kapabilitas `spqr-ratchet` tidak diiklankan → tetap tidak ada klien v2 di
  produksi; menghapus modul ini tidak mengubah perilaku klien mana pun.
- Artefak WASM tidak diimpor dari `main.tsx`/bundel aplikasi (tidak ada biaya
  parse/eval saat boot): ia di-fetch malas saat v2 pertama dipakai. **Yang
  berubah 2026-10-14:** ia kini ikut **precache SW** (`**/*.wasm`), jadi biaya
  satu-satunya adalah ukuran install PWA (±0,8 MB untuk spqr + keytrans).
- Bila jalur v2 nanti diaktifkan lalu dibatalkan: kapabilitas di-off →
  negosiasi jatuh ke v1 dan state v1 (yang tidak pernah ditimpa) langsung
  dipakai kembali.
