# Pass 12 — Temuan baru

Temuan pass 1–11 tidak diulang; lihat `10-delta.md`. Bukti di bawah berasal dari
kode yang dibaca **dan** dijalankan pada pass ini.

---

## N12-01 (Low, keyakinan tinggi) — validator `OHTTP_TRUSTED_PROXIES` menerima CIDR tanpa prefix sebagai `/0`

**Ringkas.** Validator yang ditambahkan untuk N11-05 memakai
`Number(bitsRaw)`; `Number('')` adalah `0`, jadi entri yang berakhiran garis
miring **tanpa angka** dianggap prefix sah `/0`:

```ts
// server/src/ohttp/clientTag.ts:182-196
const [baseRaw, bitsRaw] = entry.split('/');
...
if (bitsRaw === undefined) return null;      // alamat persis
const bits = Number(bitsRaw);                // '' → 0
if (!Number.isInteger(bits) || bits < 0 || bits > max) { ... }
return null;                                  // '10.0.0.0/' dinyatakan SAH
```

`proxyMatches` memperlakukan prefix `0` sebagai "cocok dengan semua":

```ts
// server/src/ohttp/clientTag.ts:157,173
const bits = Number(bitsRaw);
...
if (bits === 0) return true;
```

**Bukti eksekusi** (fungsi asli, `tsx`):

```
entry=10.0.0.0/       reason=null        ← dinyatakan valid
entry=fd00::/         reason=null        ← dinyatakan valid
trailing slash v4 (10.0.0.0/) -> 203.0.113.9   ← header klien DIPERCAYA
trailing slash v6 (fd00::/)   -> fd00::5       ← header klien DIPERCAYA
```

**Mengapa berbahaya.** `OHTTP_TRUSTED_PROXIES` adalah satu-satunya pembeda
antara "hop ini nginx" dan "hop ini klien". Dengan daftar yang efektif `/0`,
`socket.remoteAddress` apa pun dianggap proxy tepercaya, sehingga
`CF-Connecting-IP` kiriman klien dipakai apa adanya. Klien yang menjangkau relay
langsung (bind Docker `0.0.0.0`, atau port relay terbuka) lalu dapat memilih tag
baru di setiap request — persis lubang yang ditutup N10-03 dan alasan N10-02
memakai bucket per tag. Bagi selfhost nilainya memang wajib kosong, tetapi
profil Docker yang menulis `172.16.0.0/` (lupa angka prefix) tidak mendapat
peringatan apa pun; validator yang seharusnya menangkap salah-setel justru
meloloskannya.

**Catatan cakupan.** Perilaku `/0` ini sudah ada sebelum commit (bukan regresi
baru); yang baru adalah klaim N11-05 bahwa "entri yang tidak bisa diparse
dilaporkan per entri". Bentuk `x/` tidak bisa diparse tetapi lolos, jadi N11-05
**tertutup sebagian**. Tes `server/tests/ohttp.test.ts:735-742` tidak menguji
bentuk ini (hanya `/129`, `/33`, dan nama host).

**Perbaikan.** Tolak `bitsRaw === ''` (dan lebih dari satu `/`) di
`invalidTrustedProxyReason`, dan perlakukan prefix kosong sebagai entri tidak
sah di `proxyMatches` — jangan pernah mengembalikan `true` untuk prefix yang
tidak bisa diparse. Alternatif yang lebih aman: `proxyMatches` mengembalikan
`false` bila `bitsRaw` kosong/bukan angka, sehingga salah-setel tidak pernah
memperluas kepercayaan.

**Test yang menangkapnya.**
`invalidTrustedProxyReason('10.0.0.0/')` harus mengembalikan alasan;
`ohttpClientAddress(req('203.0.113.9'), { trustedProxies: ['10.0.0.0/'] })`
harus mengembalikan alamat soket, bukan header.

**Observed juga (Info, digabung).** Entri dengan garis miring ganda
(`10.0.0.0/8/8`) diterima dan dieksekusi sebagai `/8` karena `split('/')` hanya
mengambil dua bagian pertama — bentuk cacat lain yang tidak dilaporkan.

---

## N12-02 (Info, keyakinan tinggi) — perbaikan `clientVersion` hanya ada di working tree; HEAD masih merah

**Ringkas.** Dua berkas belum di-commit memperbaiki kegagalan pre-existing yang
dilaporkan pass 11:

- `web/src/lib/api.ts:158-171` — `getCsrfToken` melaporkan body 426 ke
  `reportClientVersionRejection` sebelum melempar;
- `web/src/lib/__tests__/clientVersion.test.ts` — mock `json()` pada respons
  error + dua tes yang membedakan jalur CSRF.

**Bukti eksekusi.**

- Dengan perubahan working tree: `vitest run` **seluruh suite 1136/1136 lulus**
  (137 berkas), termasuk `clientVersion.test.ts` 15/15.
- Tanpa perubahan itu (HEAD `666f37c5`, kode `getCsrfToken` masih
  `if (!res.ok) throw …`), 426 pada `GET /api/csrf-token` tidak pernah
  menyentuh store, `api()` berhenti sebagai `CSRF_UNAVAILABLE` status 0, dan
  tes "CLIENT_VERSION_REQUIRED dibedakan dari too-old" gagal — hasil yang
  diukur pass 11 di HEAD.

**Dampak.** CI yang berjalan pada commit, bukan pada mesin maintainer, tetap
merah pada satu tes; perilaku pengguna (klien terlalu tua tidak pernah melihat
layar "perbarui NYX") juga masih ada di commit. Perbaikannya sendiri benar dan
tidak saya temukan regresi: `res.json()` hanya dikonsumsi di jalur error,
`reportClientVersionRejection` idempoten (store mempertahankan tingkat
terketat), dan body non-JSON ditelan oleh `try/catch` di tempat yang sama.

**Perbaikan.** Commit kedua berkas itu apa adanya. Tidak ada perubahan lain yang
dibutuhkan.
