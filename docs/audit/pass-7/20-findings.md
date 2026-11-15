# Pass 7 — Temuan baru

Temuan pass 1–6 tidak diulang; lihat `10-delta.md` §A–B. Semua temuan di bawah
berasal dari modul KT klien yang dibaca pada pass ini.

---

## N7-01 (Medium, keyakinan tinggi) — kueri KT membocorkan kontak yang diverifikasi ke server

**Ringkas.** Setiap verifikasi kontak mengirim **search key kontak itu** ke
server NYX sendiri, sebagai parameter GET pada origin yang sama, lewat `api()`
ber-cookie — bukan lewat OHTTP/PIR:

```ts
// web/src/lib/ktBundleProof.ts:351-362
async function defaultFetchProof(query: KtProofQuery): Promise<KtProof> {
  const params = new URLSearchParams({ hash: bytesToBase64Url(query.searchKey.subarray(1)) });
  if (query.last !== undefined) params.set('last', String(query.last));
  …
  const response = await api<{ … }>(`/api/keys/kt/search?${params.toString()}`);
```

`searchKey = 0x75 || Argon2id(username)` (`ktBundleProof.ts:214-222`,
`ktSubject.ts` baris 6), jadi `hash` di URL **adalah** `usernameHash` kontak.
`/api/keys/kt/*` diteruskan server ke `KT_QUERY_URL`, tetapi permintaannya sudah
melewati server NYX lebih dulu (dan URL-nya bisa tercatat di log/proxy).

**Dampak.** Server (atau siapa pun yang membaca log akses/query) belajar, per
verifikasi: "sesi ini memeriksa kontak dengan username-hash X". Rangkaian
permintaan itu **merekonstruksi social graph** — tepat hal yang klaim privasi
NYX katakan tidak bisa dilakukan server. Server tidak perlu menyimpan pesan;
cukup mencatat pasangan `(sesi/IP, hash)` dari query KT.

**Kenapa belum tertutup.** `api()` memakai cookie sesi + CSRF, jadi permintaan
ini terautentikasi penuh dan dapat dikaitkan ke akun. OHTTP hanya dipakai jalur
grup (`VITE_OHTTP_ENABLED`), tidak untuk KT. `last` juga membocorkan ukuran
pohon yang dipegang klien.

**Perbaikan (bukan breaking untuk format wire).** Rute KT adalah kandidat alami
untuk pembungkusan yang sudah ada: kirim `GET /api/keys/kt/search` lewat relay
OHTTP dengan token scoped (seperti `POST /api/pir/query`), atau minimal pindahkan
hash ke **body POST** agar tidak masuk log URL — itu tidak menyembunyikan dari
server, tetapi menghilangkan lapisan log/proxy. Anonimitas penuh butuh OHTTP/PIR.

**Test yang menangkapnya.** Unit: `defaultFetchProof`/`fetchProof` yang disuntik
tidak boleh menghasilkan URL yang memuat hash mentah (mis. harus lewat adapter
OHTTP); atau tes kontrak route bahwa query hash hanya diterima di body.

---

## N7-02 (Medium, keyakinan tinggi) — kunci indeks `ktMonitoring` membatalkan alasan sealing

**Ringkas.** Nilai bukti di `ktMonitoring` di-seal `ENC1:`, dengan alasan eksplisit
"IndexedDB tidak boleh menyimpan tree head/monitoring data dalam bentuk terbaca,
karena keduanya mengungkap kontak mana yang dimonitor" (`db.ts:196-201`). Tetapi
**primary key-nya plaintext** dan justru berisi identitas kontak:

```ts
// web/src/lib/db.ts:199-201
 * mengungkap kontak mana yang dimonitor. `searchKeyHex` sengaja plaintext:
 * ia sudah hash 32 byte (tidak reversible), dan ia satu-satunya kunci indeks.
searchKeyHex: string; // PK (hex dari search key)
```

```ts
// web/src/lib/ktBundleProof.ts:214-222
* Search key log dari usernameHash base64url 32 byte: `0x75 || hash`.
```

`searchKeyHex` = `75` + `Argon2id(username)` dalam hex. Argon2id klien memakai
**parameter publik dan salt statis** (komentar register di `auth.ts` bagian
`usernameHash`: "parameternya publik & salt-nya statis"), sehingga "tidak
reversible" tidak sama dengan "tidak bisa dienumerasi": untuk daftar kandidat
username, penyerang menghitung Argon2id sekali per kandidat lalu membandingkan
dengan baris yang ada.

**Dampak.** Dump IndexedDB **tanpa masterSeed** (mis. profil browser yang
tersalin, backup disk, ekstensi jahat) tetap mengungkap himpunan kontak yang
diverifikasi user — persis kebocoran yang dicegah dengan menyeal tree head.
Biayanya satu Argon2id per kandidat, bukan per baris, jadi pemeriksaan bertarget
murah.

**Perbaikan.** Jadikan PK = `HMAC(kunci turunan masterSeed, searchKey)` (hex),
simpan `searchKey` hanya di dalam nilai ter-seal. Deterministik → lookup tetap
O(1), tetapi dump tanpa seed tidak bisa membandingkan apa pun. Alternatif: PK
acak + indeks pencarian di dalam nilai ter-seal (perlu baca semua baris, tidak
layak untuk ratusan kontak).

**Catatan.** Ini bukan regresi pass ini; modul KT klien baru pertama kali dibaca.

---

## N7-03 (Low, keyakinan tinggi) — dokumen `ktMonitoring` menyatakan modul belum dipakai produksi

```ts
// web/src/lib/ktMonitoring.ts:27-30
 * Batas yang jujur: modul ini belum dipanggil dari jalur bundle produksi
 * (`docs/34` §34.6 poin 1) sehingga belum ada state yang terisi di lapangan; …
```

Kenyataannya `App.tsx:409-417` mengimpor `startKtMonitorLoop` **dan**
`monitorKeyTransparency`, menjalankannya 30 detik setelah app siap lalu tiap 6
jam. `checkBundleAgainstKeyTransparency` juga menulis state lewat `saveKtState`.
Pola drift yang sama dengan N5-02 (berkas kripto menyatakan fitur mati): reviewer
berikutnya bisa melewatkan seluruh jalur ini.

**Perbaikan.** Ganti paragraf dengan status sebenarnya + rujuk `App.tsx` dan
`docs/34` §34.6 poin 2.

---

## N7-04 (UNVERIFIED) — state KT tidak ter-scope per akun; pembersihnya tidak punya pemanggil

`clearKtStates()` (`ktMonitoring.ts:274`) dan `clearKtConfigPin()`
(`ktConfigPin.ts:144`) **tidak dipanggil di mana pun** di `web/src` (grep; hanya
definisi). `nukeProtocol.executeLocalWipe` hanya memanggil `clearKtGossip`
(`nukeProtocol.ts:76-77`) lalu menghapus seluruh IndexedDB, jadi wipe penuh aman.
Yang belum saya buktikan: apakah **logout biasa** (tanpa wipe) menghapus
`NyxUnifiedDB`.

Bila tidak: `loadKtStates()` membaca **semua** baris tanpa filter akun, sehingga
akun B di perangkat yang sama akan mengirim search key kontak akun A ke layanan
KT (`runKtMonitorOnce`), dan pin konfigurasi A tetap berlaku untuk B.

**Yang akan memastikan.** Jalankan logout → login akun lain di profil browser
yang sama, lalu periksa isi tabel Dexie `ktMonitoring`/`ktConfig`. Bila baris
lama masih ada, ini menjadi temuan Medium (kebocoran lintas-akun). Bila logout
memang menghapus DB, cukup hapus dua fungsi mati itu atau panggil keduanya di
jalur logout sebagai pertahanan berlapis.
