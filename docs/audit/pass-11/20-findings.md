# Pass 11 — Temuan baru

Temuan pass 1–10 tidak diulang; lihat `10-delta.md`. Semua bukti di bawah berasal
dari kode yang dibaca **dan** dijalankan pada pass ini.

---

## N11-01 (Low, keyakinan tinggi) — dua tes arsip era braid gagal: suite web merah

**Ringkas.** `saveSpqrState` sekarang default `advanced: false`
(`web/src/lib/spqrState.ts:167-176`), dan `rotateSpqrStateForNewSession` hanya
mengarsipkan era yang `advanced` (`:331-360`). Commit `0c337be9` memperbarui
fixture `spqrState.test.ts` (menambah `advanced: true`) tetapi **tidak**
memperbarui `spqrEraArchive.test.ts`, yang menulis state era tanpa penanda:

```ts
// web/src/lib/__tests__/spqrEraArchive.test.ts:138-140
await saveSpqrState({ sessionId: SESSION, state: era1.bob, version: 'v2' });
await flushSpqrState(SESSION);
await rotateSpqrStateForNewSession(SESSION);      // not archived: advanced === false
```

**Bukti eksekusi.** `npx vitest run src/lib/__tests__` di HEAD:

```
FAIL src/lib/__tests__/spqrEraArchive.test.ts > … > frame era lama ditolak state aktif, tetapi terbuka dari arsip era
AssertionError: expected [] to have a length of 1 but got +0
 ❯ src/lib/__tests__/spqrEraArchive.test.ts:171:22

FAIL src/lib/__tests__/spqrEraArchive.test.ts > … > arsip dibatasi FIFO: hanya tiga era terakhir, terbaru lebih dulu
AssertionError: expected [] to have a length of 3 but got +0
 ❯ src/lib/__tests__/spqrEraArchive.test.ts:193:22

Test Files  3 failed | 106 passed (109)
     Tests  4 failed | 943 passed (947)
```

(Kedua kegagalan lain bukan dari commit ini: `clientVersion` gagal juga di
`bfca57c7` — dibuktikan dengan worktree; `x3dhOracleInterop` timeout build Go
dingin dan lulus sendiri dalam 11 dtk → N11-06.)

**Dampak.** CI unit merah pada HEAD. Yang lebih penting: tes yang merah adalah
**satu-satunya penjaga end-to-end** fitur arsip era (N5-01) — bila "diperbaiki"
dengan menghapus asersi, tidak ada lagi yang membuktikan pesan v2 era lama bisa
dibaca setelah rotasi X3DH.

**Perbaikan.** Tandai state yang mewakili era ber-lalu-lintas dengan
`advanced: true` (itu yang ditulis `utils/crypto.ts` di produksi), lalu tambah
kasus yang benar-benar mengunci perilaku baru: era baru **tanpa** pesan tidak
menambah slot arsip. Jangan melonggarkan asersi panjang arsip.

**Test yang menangkapnya.** Kedua tes itu sendiri setelah diperbarui; jalankan
`pnpm --filter nyx-web test` (bukan hanya lima berkas KT/SPQR seperti pass 10 —
di situlah regresinya bersembunyi).

---

## N11-02 (Low, keyakinan sedang-tinggi) — guard `advanced` inersia di produksi, dan default-nya mengarah ke kehilangan era

**Ringkas.** N10-04 mengklaim bahwa sesi X3DH baru bisa lahir berulang tanpa
pesan v2 dan karena itu menggeser arsip. Tetapi seluruh penulis state braid di
produksi hanya dua, dan keduanya menandai kemajuan:

```ts
// web/src/utils/crypto.ts:470 (encrypt) dan :574 (decrypt)
await saveSpqrState({ sessionId, state, version: 'v2', advanced: true });
```

`grep -rn "saveSpqrState(" web/src` → hanya dua hasil itu. Tidak ada jalur yang
menyimpan "state awal era": state v2 baru dibuat setelah `encrypt`/`decrypt`
berhasil (`crypto.ts:452-459`, `:519-527`). Akibatnya, di produksi setiap baris
yang ada saat rotasi sudah `advanced`, sehingga `rotate` **selalu** mengarsipkan
— persis perilaku sebelum N9-03. Churn yang diukur pass 10 berasal dari probe/tes
yang menulis state awal secara langsung (probe itu meniru fixture, bukan
`utils/crypto.ts`).

**Dampak sekarang.** Nol: tidak ada era hilang, dan tidak ada slot terbuang.
Yang menjadi masalah adalah arah default-nya. `advanced` default `false` berarti
**pemanggil baru yang lupa menandai akan diam-diam membuang era lama**, yaitu
kelas bug N5-01 (pesan tertunda lintas rotasi menjadi tidak terbaca permanen)
kembali tanpa suara dan tanpa tes yang menangkapnya — tes arsip era justru
merah pada HEAD (N11-01).

**Perbaikan.** Balik default: `advanced` default `true` (konservatif = jangan
buang era), dan pemanggil yang menulis state yang **belum maju** memakai flag
eksplisit (mis. `fresh: true`) — satu-satunya pemanggil seperti itu saat ini
tidak ada. Alternatif: hapus penanda dan ganti dengan pemeriksaan
"era ini punya lalu lintas" yang dihitung dari data yang memang ada.

**Test.** Kasus "era tanpa lalu lintas tidak menambah slot" dan "era dengan
lalu lintas tetap menggeser" di `spqrState.test.ts`, plus satu asersi bahwa
`saveSpqrState` tanpa flag **tidak** membuat era terbuang.

---

## N11-03 (Info, keyakinan tinggi) — dokumentasi `docs/33` mengklaim hasil tes yang merah

**Ringkas.** Commit yang sama menulis:

```md
<!-- docs/33-spqr-wasm.md:448-450 -->
Tes: dua era dengan state awal berbeda dan tanpa pesan → arsip tetap **satu**
slot; era yang maju tetap menggeser ke `[baru, lama]` dan penandanya ikut
terbawa ke arsip.
```

Dengan penanda `advanced`, dua era **tanpa pesan** menghasilkan **nol** slot
(tidak ada yang diarsipkan) — dan itulah yang ditunjukkan kegagalan tes:
`expected [] to have a length of 1`. Kalimat "satu slot" hanya benar bila era
pertama sudah maju, yang bukan bunyi kalimatnya.

**Dampak.** Dokumen kripto yang menyatakan perilaku lebih longgar/lebih ketat
daripada kode adalah drift yang sudah pernah dilaporkan (N5-02) justru karena
menyesatkan reviewer. Di sini ia juga menyembunyikan bahwa tes yang dirujuk
sedang merah.

**Perbaikan.** Koreksi angka (0 slot untuk era tanpa lalu lintas; 1 slot bila
era sebelumnya maju) dan sebutkan tesnya dengan nama berkas + kasus, bukan
ringkasan bebas.

---

## N11-04 (Info, keyakinan tinggi) — peringatan start relay bertentangan dengan instruksi selfhost

**Ringkas.** Relay mencetak, setiap kali start tanpa `OHTTP_TRUSTED_PROXIES`:

```ts
// server/src/ohttp/relay.ts:94-101
if (trustedProxies.length === 0) {
  console.log(
    '[ohttp-relay] OHTTP_TRUSTED_PROXIES kosong: hanya loopback yang dipercaya sebagai proxy. ' +
      'Setel ke alamat/CIDR nginx bila relay diakses lewat jaringan container.'
  );
}
```

Sementara commit yang sama menetapkan bahwa untuk profil **selfhost** nilai itu
harus **kosong** (`deploy/selfhost/README.md`, `verify-boot.sh` §9 yang
menandai nilai non-loopback sebagai `bad`,
`ops/systemd/nyx-ohttp-relay.env.example` mengisinya kosong). Jadi operator
selfhost menerima satu baris log yang menyarankan mengubah nilai yang justru
dikunci kosong oleh verifier — dan bila ia menuruti, tag per klien hilang untuk
semua pengguna (efek yang sama dengan N10-02).

**Dampak.** Kebingungan operasional; bukan bug keamanan. Nilai kosong adalah
konfigurasi yang benar untuk profil utama repo ini.

**Perbaikan.** Cetak hanya bila target gateway bukan loopback, atau ubah pesan
menjadi "kosong = benar untuk selfhost (nginx→relay loopback); isi CIDR hanya
bila nginx di jaringan container". Pakai `console.log` untuk satu baris
informasi memang tepat; yang salah isinya.

---

## N11-05 (Info, keyakinan tinggi) — CIDR IPv6 di `OHTTP_TRUSTED_PROXIES` diabaikan diam-diam

**Ringkas.** `proxyMatches` hanya mendukung alamat persis dan CIDR **IPv4**;
entri IPv6 ber-`/` selalu gagal cocok karena `ipv4ToInt` mengembalikan `null`:

```ts
// server/src/ohttp/clientTag.ts:107-119
const peerInt = ipv4ToInt(peer);
const baseInt = ipv4ToInt(normalizeAddress(base ?? ''));
if (peerInt === null || baseInt === null) return false;
```

**Bukti eksekusi (fungsi asli, `tsx`):**

```
v4 cidr 172.16/12 -> 203.0.113.9     (header dipakai)
v6 cidr fe80::/10 -> fe80::1         (header DIABAIKAN → alamat soket)
v6 exact ::1      -> 203.0.113.9     (header dipakai)
untrusted peer    -> 198.51.100.20
```

**Dampak.** Deployment yang menaruh nginx di jaringan container IPv6 dan mengisi
`OHTTP_TRUSTED_PROXIES=fd00::/8` akan mendapat alamat nginx untuk semua klien —
satu bucket bersama, tanpa error dan tanpa peringatan. `.env.example` dan
`ops/systemd/*.env.example` memang menulis "CIDR IPv4", jadi ini keterbatasan
yang terdokumentasi, bukan bug yang tersembunyi; risikonya adalah salah-setel
diam-diam pada bentuk yang tampak sah.

**Perbaikan.** Dukung CIDR IPv6 (bandingkan `BigInt` dari alamat yang
dinormalisasi), atau tolak entri IPv6 ber-`/` saat start dengan peringatan
eksplisit sehingga salah-setel terlihat.

**Test.** `ohttpClientAddress(req('fd00::5'), { trustedProxies: ['fd00::/8'] })`
harus mengembalikan nilai header; saat ini mengembalikan alamat soket.

---

## N11-06 (Info, keyakinan sedang) — interop oracle timeout saat cache Go dingin

**Ringkas.** `x3dhOracleInterop.test.ts` memanggil `go run .` per kasus
(`runOracle`, `execFileSync`). Pada mesin tanpa cache build Go, kompilasi
`tools/dr-oracle` melewati batas bawaan Vitest 60 dtk:

```
FAIL src/lib/__tests__/x3dhOracleInterop.test.ts > … > ratchet + AEAD dua arah
Error: Test timed out in 60000ms.
```

Dijalankan sendiri setelah cache hangat: **lulus dalam 10,95 dtk**.

**Dampak.** `pnpm --filter nyx-web test` merah pada clone/mesin bersih — persis
kondisi yang membuat orang menambahkan `--exclude` atau menaikkan timeout secara
global. CI utama tidak terkena karena job `dr-oracle` memisahkan langkah ini,
tetapi suite unit biasa tampak gagal tanpa sebab kode.

**Perbaikan.** Naikkan timeout khusus tes itu (mis. 180 dtk) atau pra-bangun
binary oracle (`go build -o`) sekali di `beforeAll`.

**Test.** Tes itu sendiri pada mesin dengan cache kosong (`go clean -cache`).
