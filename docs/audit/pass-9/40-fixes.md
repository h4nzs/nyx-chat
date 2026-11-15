# Pass 9 — Perbaikan

Tiga temuan dari `20-findings.md`. Tidak ada temuan pass 1–8 yang dibuka ulang.

## N9-01 — bukti KT anonim lewat OHTTP berbagi satu bucket: **TERTUTUP**

**Akar masalah.** Gateway memanggil API lewat loopback, jadi `req.ip` = `127.0.0.1`
untuk semua pengguna OHTTP. Perbaikan N8-02 memakai subjek token OHTTP, tetapi
jalur bukti KT sengaja tanpa token (N7-01) → `clientIpTag('127.0.0.1')` untuk
semua orang, satu counter 240/menit. Relay membatasi 120/menit per klien, jadi
dua klien wajar sudah cukup menghabiskannya, dan kegagalan itu dipetakan ke
`unavailable` + backoff — verifikasi kontak berhenti untuk semua orang.

**Perbaikan.** Relay menjadi penandatangan identitas klien, bukan penerus IP:

- `server/src/ohttp/clientTag.ts` (baru) — `relayClientTag(secret, alamat)` =
  `HMAC-SHA256(secret, 'nyx-ohttp-client-tag-v1:' + alamat)`, base64url; bentuk
  tag divalidasi (`^[A-Za-z0-9_-]{16,128}$`). Modul ini **tidak** mengimpor
  `atRestSecrets`/Prisma/sodium, karena relay proses terpisah memakainya.
- `server/src/ohttp/relayApp.ts` — bila `internalToken` ada, mengirim
  `x-nyx-ohttp-internal` + `x-nyx-ohttp-client-tag`. Header klien tetap tidak
  pernah diteruskan; alamat hanya hidup di dalam proses relay.
- `server/src/ohttp/relay.ts` — membaca `OHTTP_INTERNAL_TOKEN` (≥32 karakter),
  memperingatkan saat start bila kosong (tag mati → bucket bersama lagi).
- `server/src/routes/ohttp.ts` — `/relay` in-proses memasang pasangan header yang
  sama; `/gateway` hanya meneruskan tag bila `trustedRelayClientTag(req)` lolos
  (token internal cocok + bentuk tag sah).
- `server/src/ohttp/gateway.ts` — klaim `x-nyx-ohttp-internal` /
  `x-nyx-ohttp-client-tag` dari **dalam amplop** selalu dibuang; nilai relay
  dipasang setelah sanitasi.
- `server/src/utils/clientIp.ts` — `ohttpRelayClientTag()` lalu
  `clientRateLimitTag = tag relay ?? subjek token ?? IP`.
- `server/src/ohttp/config.ts` + `server/src/app.ts` —
  `OHTTP_INTERNAL_TOKEN` sekarang juga diresolusi pada `OHTTP_TOKEN_MODE=on`
  (eksplisit saja; relay tidak memegang `JWT_SECRET`), dan `app.ts` menyetelnya
  ke modul tag saat boot.

**Kenapa tidak bisa dipalsukan.** Tag dipercaya hanya bersama token internal yang
dibandingkan timing-safe. Tanpa itu, penyerang yang memanggil gateway langsung
cukup mengarang tag baru per request untuk bucket tanpa batas; sekarang ia jatuh
ke tag IP seperti sebelumnya.

**Tes.** `rateLimitIdentity.test.ts` (+2): dua tag relay berbeda → bucket berbeda
dan bukan tag IP; tag tanpa/bernilai salah token → fallback IP; proses tanpa token
tidak mempercayai tag apa pun. `ohttp.test.ts` (+2): tag relay diteruskan sekali
dan klaim dari amplop dibuang; tanpa `clientTag` kedua header tidak muncul.
`clientIp.ts` tidak lagi mengubah perilaku trafik non-OHTTP (tes lama tetap lulus).

**Observabilitas.** `nyx_ohttp_client_tag_total{status}` (`utils/metrics.ts`)
dihitung per request gateway: `tagged`, `untagged`, `untrusted`, `no-token`.
`no-token` adalah tanda `OHTTP_INTERNAL_TOKEN` kosong di proses API (atau relay);
sebelumnya keadaan itu hanya terlihat sebagai `unavailable` + backoff di klien.
Label hanya enum, tanpa alamat/nilai tag/id akun. Dikunci tes di
`rateLimitIdentity.test.ts` (klasifikasi + eksposisi Prometheus). Alert
`NyxOhttpClientTagMissing` (warning, `for: 10m`) menyala bila >50% request
gateway berstatus `no-token|untagged|untrusted` — rasio, supaya satu probe atau
panggilan langsung ke gateway tidak membunyikan alarm. Drill: satu kasus firing
+ dua kasus tidak menyala di `ops/prometheus/tests.yml`; `SKIP_LIVE=1
scripts/drill-alerts.sh` lulus (44 aturan, 44 ber-drill).

**Batas yang tetap ada.** Tag adalah identitas per **alamat**, bukan per akun —
beberapa akun di satu IP berbagi bucket. Operasi tanpa `OHTTP_INTERNAL_TOKEN` di
kedua proses kembali ke bucket bersama (diperingatkan relay, didokumentasikan di
`docs/10` §10.18 dan `docs/34` §34.7).

## N9-02 — pin "tidak ada" dan "akun tidak diketahui" tidak dibedakan: **TERTUTUP**

**Perbaikan.** `web/src/lib/ktConfigPin.ts` menambah `resolveKtConfigPin()` dengan
empat keadaan: `pin`, `empty` (TOFU), `unknown-account`, `unreadable` (baris ada
tetapi tidak bisa dibuka/di-parse). `loadKtConfigPin()` tetap ada sebagai bentuk
lama (`pin` atau `undefined`).

`resolveConfig` (`web/src/lib/ktBundleProof.ts`) hanya menerima `pin`/`empty`;
`unknown-account` dan `unreadable` melempar error polos sehingga verdict menjadi
`unavailable` dan dicoba lagi nanti — bukan diterima tanpa perbandingan, dan bukan
`unverifiable` (tidak ada bukti penyerangan).

**Tes.** `ktConfigPinScope.test.ts` (+1): `empty` → `pin` → `unknown-account`
setelah logout → `unreadable` untuk JSON rusak dan untuk pin ABI 2 berbentuk tidak
sah. Tes N8-03 yang ada tetap lulus tanpa perubahan.

**Batas.** Pin tetap TOFU lokal: penyerang yang menguasai IndexedDB dan
`masterSeed` saat vault terbuka masih bisa menulis pin. Itu batas yang sudah
dinyatakan di header modul, bukan yang ditutup pass ini.

## N9-03 — setiap rotasi menggeser arsip era: **TERTUTUP**

**Perbaikan.** `rotateSpqrStateForNewSession` (`web/src/lib/spqrState.ts`)
membandingkan state aktif dengan slot arsip 0 (versi + byte) sebelum menggeser.
Bila identik — era belum pernah maju karena sesi X3DH lahir ulang tanpa pesan v2 —
arsip **tidak** digeser dan tidak ditulis ulang; baris aktif tetap dihapus seperti
biasa. Rotasi setelah state maju berperilaku persis seperti sebelumnya.

**Tes.** `spqrState.test.ts` (+2): rotasi tanpa kemajuan tidak menambah slot kedua
dan tetap mengosongkan baris aktif; rotasi setelah state maju menghasilkan
`[terbaru, sebelumnya]`.

**Batas.** Perbandingan byte berarti state yang berubah lalu kembali ke bentuk
semula tetap dianggap maju (tidak berbahaya: hanya menambah satu slot). Seberapa
sering sesi baru lahir di lapangan tetap tidak diukur — perbaikan ini menutup
kerugiannya, bukan mengukur frekuensinya.

## Cek yang dijalankan

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint server/src server/tests web/src/lib` | **0 error**, 66 warning |
| `tsx --test` ohttp + rateLimitIdentity + envExample + ktQuery | **42/42 lulus** |
| `vitest run` spqrState + ktConfigPinScope + ktBundleProofV2 + spqrEraArchive + spqrMessagePath | **39/39 lulus** |
| `npx oxlint` berkas tes yang diubah | **0 warning, 0 error** |

Tidak dijalankan: E2E Playwright, fuzz, 58 tes Go KT, drill DR/restore KT, DR
oracle, suite vitest web penuh, uji beban OHTTP nyata (dampak N9-01 dihitung dari
kode, dan sekarang dibuktikan di tingkat unit).
