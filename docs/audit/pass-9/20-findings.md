# Pass 9 — Temuan baru

Temuan pass 1–8 tidak diulang; lihat `10-delta.md`. Semua temuan di bawah lahir
dari jalur yang **dibuat/diubah** oleh `0a8a2e2b` dan `09bc7d04`.

---

## N9-01 (Medium, keyakinan tinggi) — bukti KT anonim lewat OHTTP berbagi satu bucket 240/menit

**Ringkas.** Route bukti KT kini anonim:

```ts
// server/src/routes/ktQuery.ts:120
router.post('/search', ktProofLimiter, async (req, res) => {
```

`ktProofLimiter` memakai generator tag yang sama dengan limiter lain
(`server/src/middleware/rateLimiter.ts:24`, `:173-175`, `max: 240` per menit),
yaitu:

```ts
// server/src/utils/clientIp.ts:75-76
export function clientRateLimitTag(req) {
  return ohttpTokenSubjectTag(req) ?? clientIpTag(req);
}
```

Perbaikan N8-02 mengandalkan **subjek token OHTTP** (`clientIp.ts:63-71`) untuk
memberi satu bucket per akun. Tetapi klien sekarang sengaja **tidak mengirim
token** pada jalur ini:

```ts
// web/src/lib/ktBundleProof.ts:396
withToken: false,
```

Jadi `ohttpTokenSubjectTag` selalu `undefined` → `clientIpTag` → `req.ip` =
`127.0.0.1` (gateway memanggil API lewat loopback dan **membuang**
`cf-connecting-ip`/`x-forwarded-for`, `packages/shared/src/ohttp.ts:430-449`).
Hasilnya: **satu** tag, **satu** counter, untuk seluruh pengguna OHTTP.

**Aritmetika yang membuat ini bukan sekadar teori.** Relay membatasi 120
permintaan/menit per klien (`server/src/ohttp/relayApp.ts:95`), sedangkan bucket
API 240/menit. Dua klien yang memverifikasi banyak kontak (satu POST per kontak,
plus monitor 6 jam) sudah cukup menghabiskan bucket itu; satu penyerang tanpa
akun pun bisa mendekati 120/menit dan memblokir pengguna lain setelah ±2 menit.

**Dampak.** Semua pengguna OHTTP menerima `429 KT_PROOF_RATE_LIMITED`. Karena
`checkBundleAgainstKeyTransparency` memetakan kegagalan itu ke `unavailable` dan
memasang backoff, verifikasi kontak dan monitor KT berhenti untuk semua orang —
tepat kontrol anti-equivocation yang baru diperbaiki N8-01. Penyerang tidak perlu
akun: route-nya anonim, dan hash yang dicari tidak perlu valid untuk menghabiskan
bucket (400 tetap dihitung).

**Sudah didokumentasikan, tetapi kurang tajam.** `docs/34` §34.7 menyebut
"request anonim lewat OHTTP semuanya tiba dari `127.0.0.1`, jadi limiter
`ktProofLimiter` … berbagi satu bucket" — jujur, tetapi tidak menyebut bahwa
**dua klien wajar** sudah cukup untuk menghabiskan jatah itu, dan tidak ada
metrik/alert untuk kondisi tersebut. Itu sebabnya temuan ini tetap dicatat
(limit yang diketahui, konsekuensinya lebih besar daripada yang tertulis).

**Perbaikan yang disarankan.** Jangan key limiter anonim dengan IP loopback:
(a) relay menandatangani tag klien (`HMAC(pepper, alamat klien)` di header
internal) dan API memakai tag itu — IP mentah tetap tidak masuk Redis; atau
(b) bucket terpisah khusus jalur OHTTP dengan batas agregat jauh lebih besar
plus circuit-breaker bermetrik; atau (c) token anonim ber-scope `kt-proof` yang
tidak membawa `sub` tetapi punya `jti`, sehingga satu klien satu bucket tanpa
mengaitkan ke akun.

**Test yang menangkapnya.** Uji integrasi: dua request tanpa `Authorization`
lewat dispatcher loopback dengan `req.ip` sama harus mendapat **bucket berbeda**
bila tag klien ditandatangani relay; sekarang keduanya berbagi satu counter.

---

## N9-02 (Low, keyakinan sedang) — pin KT "tidak ada" dan "akun tidak diketahui" tidak dibedakan

**Ringkas.** Pin dibaca dan ditulis hanya bila `useAuthStore.getState().user?.id`
ada:

```ts
// web/src/lib/ktConfigPin.ts:151-152
const accountId = await currentKtAccountId();
if (!accountId) return undefined;
...
// web/src/lib/ktConfigPin.ts:166-167
const accountId = await currentKtAccountId();
if (!accountId) return;
```

`resolveConfig` memperlakukan `undefined` sebagai **belum pernah di-pin**, jadi
`pinChanged = true` dan konfigurasi yang disajikan server diterima
(`web/src/lib/ktBundleProof.ts:546`), lalu `commitKtConfigPin` memanggil
`saveKtConfigPin` yang — pada kondisi yang sama — **tidak menulis apa pun**.

**Kapan terjadi.** Bila `user` kosong sementara vault terbuka: verifikasi yang
sedang berjalan saat logout, atau store yang belum terhidrasi saat boot. Di
jendela itu perlindungan TOFU mati untuk sesi tersebut: `signatureKey` yang
ditukar server diterima tanpa perbandingan.

**Mengapa tidak lebih parah.** Baris pin lama **tidak** ditimpa (penulisan juga
no-op), jadi sesi berikutnya dengan `user` terisi akan membandingkan lagi dan
melaporkan `unverifiable`. Kerugiannya satu sesi verifikasi tanpa jangkar.

**Perbaikan.** Bedakan tiga keadaan: `no-account` (jangan verifikasi/commit
sama sekali — perlakukan sebagai `unavailable`), `no-pin` (TOFU), dan
`pin`. Alternatif minimal: bila `user` kosong tetapi `ktConfig` berisi baris,
kembalikan `unavailable`, bukan `undefined`.

---

## N9-03 (Low, keyakinan sedang pada mekanisme) — setiap rotasi menggeser arsip, termasuk rotasi tanpa lalu lintas v2

**Ringkas.** `rotateSpqrStateForNewSession` selalu menggeser FIFO tiga slot
(`web/src/lib/spqrState.ts:304-330`), dan dipanggil di **dua** titik kelahiran
sesi baru: pengirim (`web/src/utils/crypto.ts:2218-2226`) dan penerima
(`web/src/lib/messagePipeline.ts:426-433`). Bila sesi X3DH baru lahir berulang
kali tanpa pesan v2 di antaranya (retry handshake, kedua sisi mendirikan sesi
berdekatan, percakapan yang sering membuka sesi baru), arsip terisi state yang
nyaris identik dan **era lama yang sebenarnya terbuang** sebelum tiga slot
terpakai.

**Dampak.** Perlindungan N5-01 bisa hilang lebih cepat daripada yang
diiklankan ("tiga era terakhir") pada peer yang sering re-handshake. Bukan
kehilangan keamanan, tetapi kehilangan pesan tertunda — kelas bug yang sama
dengan N5-01, hanya pada kondisi yang lebih sempit.

**Catatan cakupan.** Seberapa sering sesi baru lahir di lapangan **tidak
diukur**; mekanismenya terbaca dari kode.

**Perbaikan.** Jangan menggeser arsip bila state aktif belum pernah maju
(hash state sama dengan arsip slot 0), atau pindahkan rotasi ke titik yang
benar-benar mendirikan sesi baru (setelah X3DH sukses, bukan setiap kali jalur
itu dieksekusi ulang).
