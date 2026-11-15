# Pass 8 — Temuan baru

Temuan pass 1–7 tidak diulang; lihat `10-delta.md` §A–B. Semua temuan di bawah
berasal dari fix pass 7 yang ada di working tree dan jalur yang dipakainya.

---

## N8-01 (High, keyakinan tinggi) — fix N7-02 melempar `TypeError`; state KT tidak pernah tersimpan

**Ringkas.** `deriveKtSearchIndexKey` memanggil libsodium seolah API C (menulis ke
buffer keluaran), padahal binding JS mengembalikan `Uint8Array` dan argumen
pertamanya adalah **panjang**:

```ts
// web/src/lib/keychainDb.ts:49-53
const sodium = await import('@lib/sodiumInitializer').then((m) => m.getSodium());
const subkey = new Uint8Array(32);
sodium.crypto_kdf_derive_from_key(subkey, 1, 'nyx-kt01', masterSeed);
return subkey;
```

**Bukti (dijalankan, bukan disimpulkan).** Dengan `libsodium-wrappers@^0.8.4`
(paket yang dipakai `web/src/lib/sodiumInitializer.ts:2`, versi di
`web/package.json:52`):

```
CALL AS IN CODE THREW: TypeError: subkey_len must be an unsigned integer
CORRECT CALL -> len: 32 bytes: [ 92, 148, 214, 134 ]
```

**Jalur kegagalan.**

1. `deriveKtSearchIndexKey()` selalu reject → `ktSearchKeyRowId()`
   (`ktMonitoring.ts:116-119`) selalu reject.
2. `saveKtState()` (`ktMonitoring.ts:148`) reject **sebelum** `put`, jadi tidak
   ada baris KT yang bisa ditulis.
3. `checkBundleAgainstKeyTransparency` menunggu `saveState(...)` di dalam `try`
   (`ktBundleProof.ts:635-643`); `TypeError` bukan `KtVerificationError`, jadi
   ditangkap blok `catch` (`ktBundleProof.ts:739-750`) dan dipetakan ke
   `{ status: 'unavailable' }` + `lastUnavailableAt = now` → **setiap verifikasi
   kontak menjadi `unavailable` dan kena backoff**.
4. `runKtMonitorOnce` (`ktMonitoring.ts:309`) reject → `App.tsx:434-436` hanya
   `console.warn`; loop tetap hidup tetapi **tidak pernah menulis apa pun**, jadi
   deteksi rotasi `keyVersion` (`changed`) tidak pernah menyala.

**Kenapa tes hijau.** `ktMonitoring.test.ts:55` mem-mock fungsi yang justru rusak:

```ts
deriveKtSearchIndexKey: vi.fn(async () => new Uint8Array(32).fill(7)),
```

Tidak ada satu pun tes yang menjalankan KDF dengan libsodium sungguhan, dan
`tsc` lolos karena `getSodium()` dikembalikan sebagai tipe binding yang longgar.

**Dampak.** Kontrol anti-equivocation KT praktis mati: tidak ada anchor
monitoring yang tersimpan, tidak ada deteksi split-view/rotasi kunci, dan UI
menampilkan "tidak tersedia" untuk setiap kontak. Ini regresi fungsional yang
disebabkan fix keamanan, bukan bug lama.

**Perbaikan.** Pakai bentuk JS: `const subkey = sodium.crypto_kdf_derive_from_key(32, 1, 'nyx-kt01', masterSeed);`
(atau `crypto_generichash(32, 'nyx-kt-index-v1', masterSeed)`). Tambahkan tes
yang memanggil `deriveKtSearchIndexKey` **tanpa mock** dan memastikan 32 byte
berbeda untuk masterSeed berbeda.

**Test yang menangkapnya.** Unit test di `keychainDb`/`ktMonitoring` yang
menginisialisasi sodium asli lalu `await expect(ktSearchKeyRowId(key)).resolves.toMatch(/^[0-9a-f]{64}$/)`.

---

## N8-02 (Medium, keyakinan tinggi pada mekanisme) — trafik OHTTP berbagi satu bucket rate-limit

**Ringkas.** Gateway memanggil API lewat loopback dengan base URL tetap:

```ts
// server/src/routes/ohttp.ts:42-43
const port = process.env.PORT ?? '4000';
const dispatch = options.dispatch ?? createLoopbackDispatcher(`http://127.0.0.1:${port}`);
```

Gateway juga membuang header identitas klien (`cf-connecting-ip`,
`x-forwarded-for`, `x-real-ip`) sebelum dispatch
(`packages/shared/src/ohttp.ts:430-449`). Akibatnya `req.ip` di API adalah
`127.0.0.1`, dan `clientIpTag` (`server/src/utils/clientIp.ts:60`) menghasilkan
**tag yang sama untuk semua pengguna**.

`generalLimiter` (`server/src/middleware/rateLimiter.ts:33-41`) memakai tag itu
sebagai key dengan batas **300 request / 15 menit**, dan dipasang **sebelum**
`requireAuth` pada rute KT (`server/src/routes/ktQuery.ts:110-117`), PIR, dan
group sync.

**Dampak.** Semua klien yang memakai OHTTP berbagi satu counter. Satu klien yang
memverifikasi ratusan kontak (satu POST per kontak, ditambah monitor 6 jam) bisa
menghabiskan bucket itu dan membuat pengguna lain menerima 429 untuk group sync
dan KT. Ini juga jalur DoS murah: penyerang dengan akun sah cukup mengirim
request OHTTP sampai bucket loopback habis.

**Diperkuat, bukan diredam.** Relay proses terpisah memang punya limiter sendiri
(`server/src/ohttp/relayApp.ts:93-104`, default **120/menit per IP**), jadi satu
klien bisa mengirim sampai 120 request/menit. Karena bucket API bersama hanya
**300/15 menit**, satu klien yang terus memverifikasi kontak dapat menghabiskannya
dalam ~2,5 menit dan memblokir semua pengguna OHTTP lain — relay membatasi laju
per klien, bukan total agregat.

**Perbaikan.** Key limiter untuk jalur OHTTP berdasarkan identitas yang sudah
diverifikasi (mis. `sub` token OHTTP) atau meneruskan tag IP asli yang
ditandatangani gateway (header internal yang tidak bisa dipalsukan klien), bukan
`req.ip` loopback. Alternatif minimal: limiter terpisah per rute OHTTP dengan
bucket jauh lebih besar, dan jangan memakai `generalLimiter` bersama.

---

## N8-03 (Low, keyakinan tinggi) — logout menghapus pin TOFU KT, sehingga pin hanya berlaku satu sesi

**Ringkas.** Fix N7-04 menambahkan pembersihan state akun saat logout:

```ts
// web/src/store/auth.ts:873-878
const { clearKtStates } = await import('../lib/ktMonitoring');
const { clearKtConfigPin } = await import('../lib/ktConfigPin');
await clearKtStates().catch(() => {});
await clearKtConfigPin();
```

`clearKtConfigPin()` menghapus satu-satunya jangkar kepercayaan konfigurasi KT
(`ktConfig`), yang menurut `docs/34` mencegah server menukar kunci verifikasi.
Setelah logout, login berikutnya melakukan TOFU ulang: `commitKtConfigPin`
menulis konfigurasi apa pun yang disajikan server **setelah** bukti ditandatangani
dengan kunci itu sendiri.

**Dampak.** Jendela "server menukar `signatureKey`/`auditorKeys` saat pengguna
logout" tidak terdeteksi — bukti berikutnya sah terhadap kunci pengganti, dan
tidak ada pin lama untuk membandingkan. Perlindungan turun dari lintas-sesi
menjadi per-sesi. Untuk akun yang sering logout (mis. perangkat bersama), ini
melemahkan tepat properti yang ingin dijaga N7-02/N7-04.

**Perbaikan.** Jangan hapus pin; **scope per akun** (row id = `HMAC(userId)`
atau simpan `userId` di dalam nilai ter-seal dan tolak pin milik akun lain).
Dengan begitu isolasi lintas-akun tercapai tanpa kehilangan kontinuitas TOFU.

---

## N8-04 (Low, keyakinan sedang) — fallback OHTTP menelan error sah dan mengirim ulang kueri ke server

**Ringkas.** `defaultFetchProof` jatuh ke jalur cookie untuk **semua** respons
non-2xx dan semua kegagalan transport:

```ts
// web/src/lib/ktBundleProof.ts:369-382
if (result.status >= 200 && result.status < 300) {
  response = JSON.parse(...);
} else {
  console.warn(`[OHTTP] Search KT dijawab HTTP ${result.status}, memakai jalur langsung`);
}
...
response ??= await api<ProofResponse>('/api/keys/kt/search', { method: 'POST', body });
```

**Dampak.**

- `404 KT_NOT_FOUND` (kontak belum ada di log) adalah jawaban **sah** dari
  layanan KT, tetapi diperlakukan sebagai kegagalan OHTTP → request kedua lewat
  cookie, sehingga hash kontak tetap sampai ke server pada setiap kontak yang
  belum terdaftar, dan biaya request berlipat.
- Bila OHTTP gagal karena salah konfigurasi (pin berubah, token ditolak), klien
  **diam-diam** turun ke jalur yang membocorkan metadata; hanya `console.warn`,
  tanpa metrik/banner, sehingga operator tidak tahu perlindungan privasi mati.

**Perbaikan.** Fallback hanya untuk kegagalan transport/5xx, bukan 4xx;
laporkan degradasi lewat metrik/log terstruktur (dan pertimbangkan banner
"mode privat tidak aktif").

---

## Catatan: status N7-01 setelah fix

Fix memindahkan hash ke body POST dan menambah allowlist OHTTP
(`packages/shared/src/ohttp.ts:396-398`, `server/src/routes/ktQuery.ts:110-117`),
yang **menghilangkan kebocoran di URL/log/edge**. Tetapi server tetap menerima
`userId` (token OHTTP) + hash di body — `server/src/utils/ohttpToken.ts:17-18`
menyatakan sendiri bahwa token menyembunyikan IP, bukan "akun X mencari Y".
Jadi tujuan "server tidak bisa merekonstruksi social graph" **belum tercapai**;
yang tertutup adalah lapisan log/URL. Severity tetap Medium, status **PARTIAL**.
