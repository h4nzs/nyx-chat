# Pass 8 — Verifikasi fix pass 7 (working tree, belum di-commit)

Berkas yang berubah: `packages/shared/src/ohttp.ts`, `server/src/app.ts`,
`server/src/routes/ktQuery.ts`, `server/src/utils/ohttpToken.ts`,
`server/tests/ohttp.test.ts`, `web/src/lib/{db,keychainDb,ktBundleProof,ktMonitoring}.ts`,
`web/src/store/auth.ts`, `web/src/lib/__tests__/ktMonitoring.test.ts`, `docs/34`.

## N7-01 — hash kontak keluar dari URL: **PARTIAL**

Yang benar:

- Rute POST baru (`ktQuery.ts:110-117`) memakai `searchInputFromQuery` yang sama
  (validasi base64url 32 byte, `last`/`distinguished` bilangan bulat > 0) —
  tidak ada jalur input tak tervalidasi.
- Allowlist OHTTP menambah `POST /api/keys/kt/search` saja; GET tetap ditolak
  (`ohttp.test.ts:160-167`, 18/18 lulus).
- Batas body 4 KB ditegakkan gateway dan diuji (`ohttp.test.ts:188-205`).
- Pengecualian CSRF aman: hanya bila **tidak ada** cookie sesi
  (`app.ts:427-444`), dan `embed_at` ikut dihitung sebagai cookie sesi.
- Token OHTTP tetap dibatasi allowlist di `requireAuth`
  (`middleware/auth.ts:32-36`), jadi token bocor tidak bisa dipakai ke rute lain.
- Gateway meneruskan `content-type` (tidak ada di daftar terlarang), jadi
  `express.json()` tetap mem-parse body.

Yang belum:

- Server tetap tahu **akun mana** mencari **hash apa** (token OHTTP membawa
  `id`), dan OHTTP default **mati** (`VITE_OHTTP_ENABLED`). Jadi social-graph
  reconstruction oleh server belum tertutup — hanya log/URL/edge. Lihat
  `20-findings.md` catatan N7-01.

## N7-02 — PK `ktMonitoring` jadi HMAC: **REGRESI (N8-01)**

Desainnya benar (PK = `crypto_generichash(32, searchKey, subkeyMasterSeed)`,
search key asli disegel), migrasi legacy malas juga rapi (baris legacy dibaca,
dipindah ke PK HMAC, lalu dihapus; vault terkunci → dibiarkan apa adanya).
Tetapi **KDF-nya melempar `TypeError`**, sehingga tidak ada baris baru yang bisa
ditulis dan seluruh jalur verifikasi menjadi `unavailable`. Tes hijau karena
`deriveKtSearchIndexKey` di-mock. Detail + bukti: N8-01.

## N7-03 — dokumen "belum dipakai produksi": **TERTUTUP**

`ktMonitoring.ts:26-32` kini menyatakan loop dipasang di `App.tsx`
(delay 30 s, interval 6 jam), dan `docs/34` §34.6 menambahkan catatan N7-02/N7-04.
Sesuai kode (`App.tsx:407-437`).

## N7-04 — state KT lintas akun: **TERTUTUP, dengan efek samping N8-03**

`logout` memanggil `clearKtStates()` (dibungkus `.catch`) dan
`clearKtConfigPin()` (fungsi itu sendiri menelan error, `ktConfigPin.ts:139-148`),
jadi tidak ada risiko logout menggantung karena pembersihan ini. `ktGossip`
sengaja tidak dibersihkan; jangkar `(treeSize, root)` milik log global, bukan
akun, dan baris per-percakapan memakai `conversationId` acak — tidak bocor
lintas akun. Namun menghapus pin TOFU melemahkan kontinuitas kepercayaan
(N8-03).

## Lima klaim "Verified-OK" yang ditantang ulang

1. **Token OHTTP hanya untuk allowlist** — bertahan. `isOhttpScopeRequestAllowed`
   memakai pasangan method+path, `originalUrl` di-split pada `?`, dan 18 tes
   `ohttp.test.ts` lulus (termasuk penolakan GET search dan path turunan).
2. **CSRF hanya dilewati tanpa cookie sesi** — bertahan. `hasSessionCookie`
   mencakup `at`, `rt`, `embed_at`; cookie apa pun mengembalikan jalur CSRF.
   Form lintas situs tidak bisa memasang header `authorization`, jadi jalur
   OHTTP tanpa cookie tidak punya ambient authority.
3. **Gateway membuang header identitas** — bertahan, dan justru menjadi sebab
   N8-02: `cf-connecting-ip`/`x-forwarded-for`/`x-real-ip` dibuang, `content-type`
   dipertahankan.
4. **State KT fail-closed** — secara logika bertahan (`saveKtState` hanya
   dipanggil setelah verifikasi; tes "Rows should be unchanged" masih ada),
   tetapi sekarang **tidak ada tulis yang berhasil sama sekali** (N8-01), jadi
   properti ini tidak bisa dipakai sampai fix berikutnya.
5. **Migrasi Dexie aman** — bertahan. `searchKey` adalah field non-indexed, jadi
   tidak perlu versi Dexie baru; `dexieMigration.test.ts` 17/17 lulus dan
   `ktMonitoring.test.ts` menguji baris legacy → PK HMAC.
