# 39 — Runbook pemulihan bencana

> **Status jujur (2026-10-29):** drill pemulihan log KT **v2 sudah otomatis lagi**
> — `scripts/kt-v2-restore-drill.sh` (11 langkah, CI job `kt-recovery-v2`), dan
> sudah dijalankan penuh di mesin self-host ini (§39.6). Drill v1 tetap dihapus
> bersama log v1 (`docs/38`); yang baru adalah penggantinya, bukan kebangkitannya.
> Drill pemulihan **Postgres** juga sudah dijalankan 2026-10-29 (§39.4, klaster
> `initdb` sendiri), dan sejak 2026-10-29 **pemulihan klien** (`.nyxbak`) diuji
> di atas dump yang benar-benar direstore (§39.4b). Yang **masih** belum pernah:
> pemulihan dari bundle `.age` nyata — baik Postgres maupun KT (§39.4 akhir,
> §39.5c) — karena keduanya menuntut `age-identity` yang hanya dipegang operator.
>
> Dokumen ini sengaja pendek dan berisi perintah, bukan narasi. Yang tidak bisa
> diverifikasi (siapa memegang akses apa) ditandai `TODO(operator)`.

## 39.1 Prinsip

1. **Backup bukan pemulihan.** Hanya drill yang pernah lulus yang dihitung.
2. **Kunci yang hilang tidak bisa dipulihkan dari data.** Log KT tanpa kunci
   log-nya masih bisa dibaca, tapi tidak bisa dipercaya/ditumbuhkan; pepper
   at-rest tanpa salinan membuat identifier di DB tidak bisa dibalik.
3. **Urutan pemulihan**: rahasia → DB → layanan → KT → **auditor** → verifikasi
   klien. Auditor bukan pelengkap: di mode 3 log menolak menyajikan bukti yang
   bisa diverifikasi sebelum auditor menandatangani head (§39.5d temuan 1).
   Memulihkan DB lebih dulu tanpa rahasia hanya menghasilkan data yang tidak
   bisa didekripsi klien.

## 39.2 Target

| Aspek | Target | Artinya |
|---|---|---|
| RPO (kehilangan data maksimum) | 24 jam | dump harian + snapshot KT harian |
| RTO (waktu pulih) | 4 jam | VPS tunggal, semua komponen di satu host |
| Titik tidak bisa dipulihkan | kunci log KT, `NYX_AT_REST_PEPPER`, `BACKUP_KEY_SECRET` | wajib ada salinan offsite **terenkripsi** |

## 39.3 Inventaris rahasia

| Rahasia | Lokasi produksi | Konsekuensi bila hilang | Salinan offsite |
|---|---|---|---|
| `NYX_AT_REST_PEPPER` | `/root/nyx-app/.env` | identifier at-rest tidak bisa dibalik; KT search key pengguna baru tidak bisa diturunkan | **belum ada** |
| `JWT_SECRET` | `/root/nyx-app/.env` | semua sesi mati (bisa login ulang) | tidak perlu |
| `BACKUP_KEY_SECRET` | `/root/nyx-app/.env` (fallback `JWT_SECRET`) | objek backup R2 lama **tidak ditemukan lagi** bila `JWT_SECRET` dirotasi — jangan rotasi tanpa menyalin dulu | tidak perlu, tapi jangan dirotasi sembarangan |
| Kunci log KT v2 (`signing-key` ML-DSA, `prefix-key`, `opening-key`) | `/etc/nyx/kt-v2/config.yaml` + `/etc/nyx/kt-v2/nyx-kt-query.env` | log tidak bisa ditumbuhkan/ditandatangani ulang; histori tidak bisa diverifikasi | **belum ada** |
| DB password | `/root/.nyx_db_pass` (0600) | bisa di-reset lewat `ALTER ROLE` sebagai superuser | tidak perlu |
| `TURN_STATIC_AUTH_SECRET` | `/root/nyx-app/.env` | kredensial TURN baru tidak valid; panggilan gagal | tidak perlu |
| R2 / Cloudflare / domain / GitHub | akun operator | deploy & backup awan berhenti | `TODO(operator)` |

Aturan: tidak ada satu pun item di atas yang boleh hanya ada di host yang
sama dengan datanya. Minimal: satu salinan terenkripsi (age/GPG) di penyimpanan
operator, di luar VPS dan di luar akun Cloudflare yang sama.

## 39.4 Drill A — Postgres

**Sudah dijalankan 2026-10-29** (bentuk *throwaway cluster*, tanpa sudo, tanpa
menyentuh database produksi) — bukti di §39.6. Resep di bawah adalah yang dipakai.

Kenapa klaster sendiri, bukan `createdb` di klaster produksi: di mesin self-host
role aplikasi (`nyx_user`) tidak punya `CREATEDB` dan `sudo -u postgres` butuh
kata sandi, sedangkan `initdb`/`pg_ctl` tersedia sebagai user biasa. Efeknya
lebih baik: nol kemungkinan menyentuh `nyx_app`, dan `pg_restore` berjalan sebagai
superuser klaster drill sehingga `--no-owner` tidak menabrak role yang tidak ada.

```bash
DRILL=/tmp/nyx-pg-drill
rm -rf "$DRILL" && mkdir -p "$DRILL"
initdb -D "$DRILL/data" -U drill --auth=trust --no-instructions
pg_ctl -D "$DRILL/data" -l "$DRILL/pg.log" \
  -o "-p 15432 -k $DRILL -c listen_addresses=127.0.0.1" start

# 1. Dump dengan cara yang SAMA dengan backup harian (`pg_dump -Fc`)
cd ~/nyx-chat/server && set -a && . ./.env && set +a
pg_dump "${DATABASE_URL%%\?*}" -Fc -f "$DRILL/prod.dump"

# 2. Restore ke database baru di klaster drill
createdb -h 127.0.0.1 -p 15432 -U drill nyx_restore_drill
pg_restore --no-owner --no-privileges -h 127.0.0.1 -p 15432 -U drill \
  -d nyx_restore_drill "$DRILL/prod.dump"

# 3. Verifikasi isi — bukan sekadar "restore exit 0"
DRILL_URL="postgres://drill@127.0.0.1:15432/nyx_restore_drill"
psql "$DRILL_URL" -c 'SELECT count(*) FROM information_schema.tables WHERE table_schema = $$public$$;'
psql "$DRILL_URL" -c 'SELECT (SELECT count(*) FROM "User") users, (SELECT count(*) FROM "Device") devices,
                             (SELECT count(*) FROM "Message") messages, (SELECT max("createdAt") FROM "Message") last_message;'

# 4. Buktikan APLIKASI bisa memakainya, bukan hanya psql: klien Prisma yang
#    sama dengan yang dipakai server (adapter-pg), dibaca langsung.
DATABASE_URL="$DRILL_URL" server/node_modules/.bin/tsx -e \
  "import {prisma} from './server/src/lib/prisma.js'; console.log(await prisma.user.count());"

# 5. Bersihkan (klaster berisi data produksi — jangan ditinggal)
pg_ctl -D "$DRILL/data" -m fast stop && rm -rf "$DRILL"
```

Kriteria lulus: jumlah tabel sama dengan produksi, `User`/`Device`/`Message`
sama (selisih hanya aktivitas sejak dump), `max(createdAt)` masuk akal, dan klien
Prisma aplikasi membaca barisnya — bukan hanya `psql`.

**Yang belum dicakup:** dump yang diuji adalah `pg_dump` **segar**, bukan arsip
`nyx-backup-*.tar.gz.age` di R2. Membuka arsip itu butuh `age-identity` operator,
jadi bagian "bundle terenkripsi bisa dibuka dan isinya bisa dipulihkan" tetap
belum dibuktikan (sama seperti `--bundle` di §39.5c).

## 39.4b Drill klien — `.nyxbak` di atas dump nyata

Langkah terakhir urutan §39.1: setelah DB pulih, apakah **klien** juga bisa
pulih? Sampai 2026-10-29 jawabannya tidak pernah diuji — `backupRestore.test.ts`
memakai store dan backend kripto palsu, jadi yang terbukti hanya logika pemetaan.

```bash
bash scripts/client-restore-drill.sh          # ~20 dtk, tidak menyentuh DB hidup
```

Yang dijalankan (semua langkah ❌ menggagalkan skrip):

| # | Langkah | Bukti yang dicetak |
|---|---|---|
| 0 | **Penjaga cakupan**: daftar tabel drill harus sama dengan `BACKUP_TABLE_ORDER`, dan setiap tabel punya minimal satu baris | `cakupan tabel lengkap: 20/20` |
| 1 | Perkakas + `server/.env` sumber | `semua perkakas tersedia` |
| 2 | `pg_dump -Fc` dari database sumber (cara yang sama dengan backup harian) | ukuran + durasi + `users\|conversations\|messages\|devices` |
| 3 | Klaster `initdb` sendiri (port 15433), **bukan** database hidup | versi Postgres + alamat |
| 4 | `pg_restore --no-owner --no-privileges` ke DB baru | durasi, exit 0 |
| 5 | Isi: jumlah tabel + jumlah baris = sumber | `tabel: 17 (sumber 17)` |
| 6 | Fixture klien diekspor dari hasil restore (id, ciphertext, kunci publik perangkat) | ukuran fixture |
| 7 | Perangkat lama → arsip → perangkat pengganti (Dexie + IndexedDB nyata, KDF argon2id, XChaCha20-Poly1305) | `header NYXB v1, N frame, M byte` |
| 8 | Isi **20 tabel** identik byte-per-byte (`Uint8Array`, `Date`, objek bersarang) + semua nilai `ENC1:` utuh + kunci publik sama dengan dump | satu baris `OK` per tabel |
| 9 | Silang-cek dengan dump: semua id pesan/percakapan ada, ciphertext sama persis | `semua N id pesan dump ada di klien` |
| 10 | Ekspor ulang dari perangkat pengganti: urutan + payload frame identik | `ekspor ulang: N frame, urutan + payload identik` |
| 11 | Kontrol negatif: phrase salah dan arsip dirusak 1 byte **ditolak**, 0 baris tertulis | dua `GAGAL` yang tidak muncul = lulus |

Baris klien **tidak dikarang**: bentuk tiap tabel disalin dari penulisnya di
kode — `keychainDb.ts` (identitas, state grup, kunci DR terlewat, pending
header, kunci story), `shadowVaultDb.ts` (`pqDrSessionsV2`, `messageKeys`),
`offlineQueueDb.ts`, `store/profile.ts` (`profileCache`), `lib/contactStore.ts`.
Termasuk yang halus: `identityKeys.key` adalah base64 kunci publik (bukan
`Uint8Array`), `groupSkippedKeys` berkunci string `key`, `pendingHeaders.header`
objek bersarang, `offlineQueue.tempId` angka.

Workspace di `NYX_CLIENT_DRILL_DIR` (default `/tmp/nyx-client-restore-drill`),
port `NYX_CLIENT_DRILL_PORT` (default 15433), dihapus oleh `trap` termasuk saat
gagal — klaster memuat data hasil dump.

**Membuktikan harness-nya tidak buta** (wajib dilakukan saat mengubah skrip):
jalankan dengan salinan TS yang sengaja dirusak, dan drill harus merah.

```bash
# Salinan sabotase harus tinggal di `web/scripts/`: file TS di /tmp tidak bisa
# me-resolve impor relatif `../src/lib/...` milik skrip drill.
d=web/scripts/.drill-blast.ts
sed 's|content: message.content,|content: (message.content ?? "") + "x",|' \
  web/scripts/client-restore-drill.ts > "$d"
NYX_CLIENT_DRILL_TS="$PWD/$d" bash scripts/client-restore-drill.sh; echo "exit=$?"
# → GAGAL ciphertext pesan berbeda dari dump ; exit=1
rm -f "$d"

# Penjaga cakupan juga harus bisa merah: buang satu tabel dari SCHEMA.
d=web/scripts/.drill-cakupan.ts
sed "/  storyKeys: 'storyId',/d" web/scripts/client-restore-drill.ts > "$d"
NYX_CLIENT_DRILL_TS="$PWD/$d" bash scripts/client-restore-drill.sh; echo "exit=$?"
# → GAGAL cakupan tabel TIDAK lengkap — drill 19 vs backup 20: kurang storyKeys ; exit=1
rm -f "$d"
```

Catatan dari kontrol itu: perbandingan baris-per-baris **tidak** menangkap
pergeseran sistematis (kedua sisi ikut bergeser), hanya silang-cek dengan dump
yang menangkapnya. Karena itu langkah 9 ada, dan jangan dihapus demi kecepatan.

**Yang tidak dibuktikan:** arsipnya **tidak** diekspor dari profil browser
sungguhan (tidak ada profil pengguna di mesin drill). Baris lokal dibentuk dari
dump dengan bentuk yang dipakai klien, jadi yang terbukti adalah round-trip
untuk ke-20 tabel + keterkaitan id/ciphertext dengan dump — bukan klik "Ekspor"
di UI. Dua hal yang secara struktural tidak bisa dibuktikan drill ini: tabel
state grup diisi pada satu percakapan yang di dump sebenarnya 1:1 (drill menguji
pemetaan frame + round-trip, bukan semantik grup), dan kunci privat tiruan di
drill bukan kunci yang benar-benar bisa mendekripsi ciphertext dari akun nyata.
Tombol UI tetap perlu dicoba sekali secara manual di browser sebelum menghitung
pemulihan klien "teruji penuh".

## 39.4c Temuan drill klien (run 2026-10-29)

1. **`server/.env` tidak boleh di-`source` mentah di skrip drill.** Berkas itu
   mendefinisikan `PORT=4000` (API yang sedang hidup); variabel drill bernama
   `PORT` tertimpa dan klaster Postgres mencoba mengikat port API →
   `could not create listen socket for "127.0.0.1"`. Sekarang skrip memakai
   `DRILL_PORT` dan membaca `DATABASE_URL` di **subshell** (`63` variabel `.env`
   tidak bocor ke proses drill). Pola yang sama berlaku untuk skrip drill lain.
2. **`createFramedBackup` default-nya mengekspor SELURUH 20 tabel.** Store yang
   tidak punya semuanya (drill, alat CLI) mati dengan
   `InvalidTableError: Table ratchetSessions does not exist`. Bukan bug produksi
   (Dexie aplikasi punya 20 tabel), tetapi jebakan API: pemanggil non-aplikasi
   **wajib** mengoper `tables`.
3. **"Ekspor ulang byte-identik" bukan properti yang sah.** Tiap frame memakai
   nonce acak, jadi dua ekspor dari data yang sama tidak pernah sama byte-nya.
   Determinisme yang benar diuji pada **urutan frame + payload** (langkah 10).
   Jangan "perbaiki" test dengan menuntut kesamaan byte.
4. **Perbandingan baris-per-baris tidak cukup.** Saat harness dirusak dengan
   menggeser ciphertext di sumber, kedua sisi ikut bergeser dan langkah 8 tetap
   hijau — yang merah hanya silang-cek dengan dump (langkah 9). Karena itu
   langkah itu wajib ada, bukan hiasan.
5. **Bentuk baris harus disalin dari penulisnya, bukan ditebak.** Versi pertama
   drill menulis `identityKeys.publicKey` sebagai `Uint8Array`; yang sebenarnya
   ditulis `keychainDb.ts:749` adalah `{ userId, key: <base64> }`. Drill tetap
   "lulus" karena arsip hanya memindahkan byte opaque — jadi drill dengan bentuk
   salah membuktikan round-trip untuk data yang tidak pernah ada di klien. Saat
   cakupan dinaikkan ke 20 tabel, tiap bentuk diambil dari pemanggil `.put()`
   yang nyata (`keychainDb.ts`, `shadowVaultDb.ts`, `offlineQueueDb.ts`,
   `store/profile.ts`, `lib/contactStore.ts`).

## 39.5 Drill B — Log KT v2

### 39.5a Drill otomatis (11 langkah)

```bash
bash scripts/kt-v2-restore-drill.sh                  # ~2 menit, tanpa layanan produksi
timeout 600 bash scripts/kt-v2-restore-drill.sh      # dipakai CI (job kt-recovery-v2)
```

Workspace sendiri (`NYX_KT_DRILL_DIR`, default `/tmp/nyx-kt-v2-restore-drill`),
port sendiri (18087 auditor gRPC, 18088 tulis, 18089 baca, 19468 metrik), kunci
acak per jalannya drill, dan binary dibangun ke `$WORK/bin` lewat
`NYX_KT_V2_{,AUDITOR_,INIT_,CHECK_}BINARY` — binary layanan hidup **tidak pernah
tertimpa**. Kunci log/auditor drill lahir di workspace dan tidak dipakai ulang.

Yang dibuktikan, berurutan (setiap langkah ❌ menggagalkan skrip):

| # | Langkah | Bukti yang dicetak |
|---|---|---|
| 1 | Tulis entri lewat **jalur penulis produksi** (`server/scripts/kt-v2-drill-entries.ts` → `publishKeyTransparencyEntry` → gRPC `Update`) | `DRILL_ENTRY … treeSize=` |
| 2 | Snapshot terverifikasi; `latest.json.treeSize` **dan** `root` = pohon hidup, dan manifes **jujur** soal auditor head (sebelum auditor menandatangani: `auditorTreeSize` kosong) | nama arsip + size/root |
| 3 | Bukti pra-bencana lolos `transparency.VerifySearch` (Go) + auditor head tersedia (mode 3), `/config` `abiVersion=2`, `TreeSize`/`Audit` menjawab | `OK verify-search treeSize=… anchor=…` |
| 4 | Bencana: proses drill dimatikan, DB hidup **dihapus**, arsip lain dipangkas | — |
| 5 | Pulih **hanya** dari `tar.gz` + `config.yaml`; `-check -expect-size -expect-root` cocok dengan manifes; head identik | `OK head treeSize=… root=…` |
| 6 | Instance pulih menyajikan bukti yang lolos verifier untuk entri lama | `OK verify-search …` |
| 7 | Tumbuh 1 entri lalu verifikasi entri lama terhadap anchor `last=<pra-bencana>` (tidak bercabang) | size lama → size baru |
| 8 | Auditor v2 menyelesaikan satu putaran — **termasuk** auditor yang kehilangan `auditor-state.json` | `OK kt-auditor once …` |
| 9 | Kontrol negatif: root palsu, nilai harapan palsu, kunci log salah, arsip dirusak 1 byte | keempatnya ditolak |
| 10 | Rollback: pulih dari snapshot **lebih lama** dari yang sudah dilihat klien/auditor, lalu catat perilakunya | `$WORK/rollback-report.txt` |
| 11 | `/metrics` instance pulih tanpa label berbentuk hash/UUID | jumlah seri `nyx_kt_query_*` |

Dua hal yang membuat "lulus" berarti: (a) skrip **sengaja dirusak** (mis.
`-expect-root` diganti root palsu) harus merah — itu dilakukan, lihat §39.6;
(b) tidak ada langkah yang dilewati diam-diam: langkah yang tidak bisa berjalan
berstatus ❌/`TIDAK DIJALANKAN` dan skrip keluar ≠ 0.

CI: job **`kt-recovery-v2`** (`.github/workflows/ci.yml`) menjalankan drill yang
sama tanpa layanan eksternal. Job `kt-recovery` v1 tetap tidak ada.

### 39.5b Prosedur manual (bila drill tidak bisa dijalankan)

Path **self-host** (mesin ini, unit systemd user, state di `~/nyx-selfhost`) dan
**VPS** (`deploy.yml`) berbeda — drift ini yang dulu membuat runbook tidak bisa
diikuti apa adanya:

| | self-host | VPS |
|---|---|---|
| kunci + config log | `~/nyx-selfhost/kt/v2/etc/config.yaml` (+ `auditor.key`) | `/etc/nyx/kt-v2/config.yaml` |
| LevelDB | `~/nyx-selfhost/kt/v2/db/tree.db` | `/var/lib/nyx/kt-v2/` |
| arsip snapshot | `~/nyx-selfhost/kt/v2/snapshots/` | `/var/lib/nyx/kt-v2-snapshots/` |
| state auditor | `~/nyx-selfhost/kt/v2/auditor-state.json` | `/var/lib/nyx/kt-auditor-v2/state.json` |
| unit | `systemctl --user … nyx-kt-query-v2` | `systemctl … nyx-kt-query-v2` |

Urutannya **wajib** begini (lihat temuan #1 di §39.5d — drill membuktikan
urutan lain gagal):

1. `systemctl stop nyx-kt-query-v2 nyx-kt-auditor-v2` (LevelDB `flock`: satu proses).
2. Pindahkan direktori DB hidup **utuh** ke `<db>.pra-restore-<detik>` (jangan dihapus).
3. Ekstrak `kt-snapshot-<waktu>Z.tar.gz` terbaru ke direktori kosong baru.
4. `nyx-kt-query-v2 -check -config <config> -db <hasil-ekstrak> \
   -expect-size <treeSize> -expect-root <root>` (angka dari `latest.json`). Ini
   exit ≠ 0 bila head tidak cocok. **`-check` tanpa harapan head bukan bukti**
   (temuan #2): exit 0 hanya berarti LevelDB bisa dibuka — dan LevelDB pulih
   sendiri dari salinan sebagian.
5. `systemctl start nyx-kt-query-v2`, lalu `curl 127.0.0.1:8089/healthz` harus
   melaporkan angka yang sama.
6. **Jalankan auditor** (`systemctl start nyx-kt-auditor-v2`, atau
   `nyx-kt-auditor-v2 … -once`). Tanpa langkah ini, mode 3 menolak menyajikan
   bukti (`auditor tree head not provided even though auditing is required`).
7. Baru minta klien memverifikasi bukti search; `curl /config` harus
   `abiVersion: 2`.

### 39.5c Mode bundle nyata (dijalankan operator, bukan CI)

```bash
NYX_AGE_IDENTITY=~/.config/nyx-backup/age-identity \
  bash scripts/kt-v2-restore-drill.sh \
    --bundle ~/nyx-backups/nyx-backup-YYYYMMDDTHHMMSSZ.tar.gz.age
```

⚠️ Mode ini **membuka kunci log**: ia mendekripsi bundle (age), mengekstrak
`kt/kt-v2.tgz` (`db`, `snapshots`, `config.yaml`, `auditor.key`,
`auditor-state.json`), menyalin DB ke `/tmp`, menjalankan langkah 5–8, lalu
**menghapus** salinan (`shred` bila tersedia). Kunci yang dibuka = identitas log;
jangan jalankan di mesin yang tidak Anda percaya, dan jangan bagikan keluarannya
(berisi nama arsip + tree size, bukan isi kunci).

Isi bundle diperiksa sebelum dipakai: tanpa `v2/etc/config.yaml`,
`v2/etc/auditor.key`, `v2/db`, atau `auditor-state.json` skrip berhenti dengan
pesan eksplisit — itu sendiri **temuan** (berarti `backup.sh` tidak memuat
sesuatu yang dibutuhkan langkah 5). Per 2026-10-29 `backup.sh` memuat semuanya
(`kt/kt-v2.tgz` = seluruh `~/nyx-selfhost/kt/v2`), tetapi **belum pernah
dijalankan** terhadap bundle sungguhan.

### 39.5d Temuan drill (run 2026-10-29, commit `8b83369f`)

1. **Arsip yang dibuat sebelum auditor menandatangani head tidak memuat
   auditor head.** Instance hasil pulih menjawab `auditor tree head not provided
   even though auditing is required` sampai auditor berjalan lagi. Karena itu
   pemulihan = DB → layanan → **auditor** → verifikasi klien, dan snapshot
   produksi (harian) hampir selalu sudah memuat head auditor (menandatangani tiap
   jam) — tetapi jangan mengandalkannya: jalankan auditor setelah restore.

   Sifat itu sekarang **terlihat sebelum bencana**: manifes `latest.json`
   mencatat `auditorName`/`auditorTreeSize`/`auditorTimestamp`, dan proses log
   menulis peringatan saat snapshot dibuat tanpa auditor head (mode 3).
   `deploy/selfhost/scripts/restore.sh` juga sudah menjalankan auditor setelah
   log siap, jadi langkah 6 di §39.5b bukan lagi tugas manual yang bisa terlupa.
2. **`-check` bukan gerbang integritas arsip.** Arsip yang dirusak 1 byte gagal
   diekstrak (`tar` exit ≠ 0), tetapi LevelDB **memulihkan diri** dari sisa
   berkasnya dan `-check` exit 0 dengan `treeSize` lebih kecil. Yang mendeteksi
   korupsi adalah perbandingan `treeSize`/`root` terhadap `latest.json` — bukan
   exit code.
3. **Rollback ditolak oleh log itu sendiri, bukan oleh klien.** Dengan anchor
   `last=6` dan log yang dipulihkan pada `size=4`, `/search` menjawab **400
   `INVALID_ARGUMENT: last observed non-distinguished tree size is greater than
   current tree size`**, dan auditor dengan state `treeSize=6` gagal di
   `Audit(start=6): OutOfRange: querying past end of log`. Tidak ada penerimaan
   diam-diam pada kedua jalur — tetapi **konsekuensinya**: entri yang ditulis
   setelah snapshot hilang, dan klien yang anchor-nya lebih baru tidak bisa
   memakai log pulih sampai log itu tumbuh melewati ukuran anchor lama.

   Opsi untuk maintainer (ini keputusan pemilik, bukan drill):
   - **(a) terima**: restore = kehilangan entri pasca-snapshot; klien yang
     anchor-nya lebih baru mendapat `unavailable` sampai log menyusul. Sederhana,
     tetapi pengguna melihat kegagalan verifikasi tanpa penjelasan.
   - **(b) wajibkan drill-before-open**: setelah restore, jalankan auditor dan
     bandingkan `treeSize`/`root` dengan objek R2 terbaru **sebelum** membuka
     trafik; kalau R2 lebih baru, pakai arsip R2 itu. Menambah satu langkah,
     menghilangkan kejutan di sisi klien.
   - **(c) snapshot sebelum tindakan destruktif**: setiap operasi berisiko
     (migrasi, `prune`, pemindahan disk) memicu snapshot manual lebih dulu,
     sehingga rollback selalu berasal dari arsip yang ≥ keadaan terakhir klien.

### 39.5e Yang tidak dibuktikan drill

- **Kunci log offsite.** Drill memakai config di mesin yang sama; arsip snapshot
  tidak memuat kunci (yang memuatnya adalah bundle backup `--bundle`, dan mode itu
  belum pernah dijalankan). Bencana yang menghapus host tetap menghapus
  kemampuan menumbuhkan log.
- **Jalur unggah R2.** Drill memakai snapshot lokal; `ktSnapshot.ts` (03:30, R2)
  tidak diuji di sini.
- **Independensi auditor.** Auditor berjalan di host yang sama dengan API.
- **Verifikasi silang WASM di dalam drill.** Bukti dinamis diverifikasi oleh
  verifier Go (`transparency.VerifySearch`), bukan oleh `keytrans-wasm-v2`:
  modul WASM dimuat lewat aset Vite + glue wasm-bindgen, jadi memakainya dari
  skrip bash butuh loader tersendiri. Kesepakatan dua implementasi tetap diuji di
  CI lewat fixture statis (`cmd/kt-v2-fixtures` → test Rust/WASM di job `build`).

## 39.6 Status drill

| Drill | Terakhir dijalankan | Bukti | Catatan |
|---|---|---|---|
| **KT restore v2 (otomatis, §39.5a)** | 2026-10-29 | commit `8b83369f` + `ee1de40b`: **dua run berturut-turut 11/11 ✅** (size 6 → 7, anchor pra-bencana tetap lolos), 4 kontrol negatif merah, rollback tercatat `klien DITOLAK / auditor DITOLAK` | run mesin self-host; CI job `kt-recovery-v2` |
| Uji skrip drill itu sendiri | 2026-10-29 | salinan skrip dengan `-expect-root` dipalsukan: `❌ root=0e2dbf10…, ingin 0000…` → berhenti di langkah 5 (exit 1) | bukti "lulus" tidak berasal dari harness buta |
| Drill menemukan bug di dirinya sendiri | 2026-10-29 | run ke-4 gagal di langkah 9: `cp: cannot stat …kt-snapshot-…` karena `-snapshot-keep 3` memangkas arsip pra-bencana | diperbaiki `ee1de40b` (arsip disalin keluar direktori snapshot) |
| KT restore v2 dari bundle `.age` (§39.5c) | **belum pernah** | — | butuh `age-identity` operator |
| **Postgres restore (otomatis-panduan, §39.4)** | 2026-10-29 | klaster `initdb` di `/tmp` (Postgres 18.6, port 15432), `pg_dump -Fc` 393 KB dari DB 12 MB → `pg_restore` 0,44 s tanpa error; **17/17 tabel**, `User` 4/4, `Device` 4/4, `Message` 1/1, `max(createdAt)` identik `2026-10-28T09:15:00Z`, kolom `Device.signingKeyV2` ada, klien Prisma **aplikasi** membaca `users=4 devices=4 signingKeyV2=null:1` | klaster dihapus setelah drill; arsip `.age` belum diuji |
| Postgres restore **dari bundle `.age`** | **belum pernah** | — | butuh `age-identity` operator (§39.4 akhir) |
| **Restore klien dari `.nyxbak` (§39.4b)** | 2026-10-29 | `pg_dump` 396 KB dari DB sumber `4\|1\|1\|4` → klaster `initdb` (Postgres 18.6, :15433) → `pg_restore` 442 ms, **17/17 tabel** + jumlah baris identik; fixture dari hasil restore = 1 percakapan + 1 pesan + 4 perangkat → **51 baris di 20/20 tabel** → arsip **20 frame / 51 188 byte** → restore **51 catatan di 20 tabel**, `progress 20/20`; setiap tabel identik byte-per-byte, **45 nilai `ENC1:` utuh**, kunci publik perangkat identik, semua id pesan/percakapan + ciphertext cocok dengan dump, ekspor ulang **20 frame urutan + payload identik**; kontrol negatif phrase salah & 1 byte rusak **ditolak, 0 baris**; total **39 pemeriksaan OK**, exit 0 | belum dari profil browser sungguhan (§39.4b) |
| Uji harness drill klien itu sendiri | 2026-10-29 | dua sabotase: ciphertext digeser 1 karakter → `GAGAL ciphertext pesan berbeda dari dump`; tabel `storyKeys` dibuang dari `SCHEMA` → `GAGAL cakupan tabel TIDAK lengkap — drill 19 vs backup 20: kurang storyKeys`; keduanya exit 1 | penjaga cakupan ikut terbukti, bukan hanya komentar |
| Restore klien **dari UI** (tombol Ekspor di profil nyata) | **belum pernah** | — | butuh sesi browser dengan akun nyata |
| Rotasi `JWT_SECRET` tanpa kehilangan backup R2 | **belum pernah** | — | §39.3 |

## 39.7 Jika maintainer hilang

`TODO(operator)` — isi dengan: siapa yang memegang (a) akses VPS/SSH, (b) akun
Cloudflare + R2, (c) registrar domain, (d) organisasi GitHub dan secret CI,
(e) lokasi salinan terenkripsi kunci KT + pepper, (f) kode pemulihan 2FA.
Tanpa daftar ini, "bus factor 1" berarti proyek berhenti pada bencana pertama,
berapa pun rapi kodenya.

## 39.8 Irama

- **Setiap PR**: drill v2 berjalan otomatis (job CI `kt-recovery-v2`). Jalankan
  juga lokal (`bash scripts/kt-v2-restore-drill.sh`) bila menyentuh config/kunci,
  snapshot, atau jalur tulis log — CI memakai config yang dibutuhkan drill sendiri,
  bukan config instance Anda.
- **Per kuartal**: Drill A (§39.4) + Drill klien (§39.4b), catat hasil di §39.6.
  Drill A butuh ~2 menit, drill klien ~20 detik, dan keduanya tidak menyentuh
  produksi (klaster `initdb` sendiri, dihapus di akhir) — tidak ada alasan
  melewatinya.
- **Setiap perubahan format `.nyxbak`** (`backupFormat`/`backupPayload`/
  `backupRestore`): jalankan §39.4b sebelum merge. Arsip lama harus tetap
  terbuka — format ini satu-satunya jalan pulih klien tanpa perangkat lama.
- **Setelah setiap restore nyata** (bencana atau latihan): catat hasilnya di
  §39.6, termasuk kalau langkah 6 (auditor) terlewat — itu yang membuat klien
  melihat `unavailable`, bukan log yang hilang.
- **Setiap perubahan skema** (`prisma db push` destruktif): ambil dump manual
  sebelum deploy. `deploy.yml` kini `workflow_dispatch` dan `db push` bersifat
  fail-closed, tetapi dump tetap wajib karena perubahan skema bisa destruktif.
- **Setiap rotasi rahasia**: perbarui §39.3 dan salinan offsite di hari yang sama.
