# 39 — Runbook pemulihan bencana

> **Status jujur (2026-10-29):** drill pemulihan log KT **v2 sudah otomatis lagi**
> — `scripts/kt-v2-restore-drill.sh` (11 langkah, CI job `kt-recovery-v2`), dan
> sudah dijalankan penuh di mesin self-host ini (§39.6). Drill v1 tetap dihapus
> bersama log v1 (`docs/38`); yang baru adalah penggantinya, bukan kebangkitannya.
> Dua hal **masih** belum pernah dijalankan dan jangan dianggap tertutup: drill
> pemulihan **Postgres** (§39.4) dan mode `--bundle` pada bundle `.age` nyata
> (§39.5c — menuntut kunci age yang hanya dipegang operator).
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

## 39.4 Drill A — Postgres (belum pernah dijalankan)

Prasyarat: dump terbaru, Postgres hidup, ruang disk ≥ 2× ukuran DB.

```bash
# 0. Identitas dump yang akan diuji
ls -lh /root/backups/ | tail -3
LATEST=$(ls -t /root/backups/*.dump /root/backups/*.sql.gz 2>/dev/null | head -1)
echo "$LATEST"

# 1. Database scratch — JANGAN menyentuh nyx_app
sudo -u postgres createdb nyx_restore_drill
# bila dump berupa custom-format (-Fc):
sudo -u postgres pg_restore --no-owner --no-privileges -d nyx_restore_drill "$LATEST"
# bila dump berupa .sql.gz:
# zcat "$LATEST" | sudo -u postgres psql -d nyx_restore_drill

# 2. Verifikasi isi — bukan sekadar "restore exit 0"
sudo -u postgres psql -d nyx_restore_drill -c "\dt" | wc -l
sudo -u postgres psql -d nyx_restore_drill -c \
  "SELECT (SELECT count(*) FROM \"User\") AS users,
          (SELECT count(*) FROM \"Message\") AS messages,
          (SELECT max(\"createdAt\") FROM \"Message\") AS last_message;"

# 3. Bandingkan dengan produksi (selisih wajar = aktivitas sejak dump)
sudo -u postgres psql -d nyx_app -c \
  "SELECT (SELECT count(*) FROM \"User\") AS users,
          (SELECT count(*) FROM \"Message\") AS messages;"

# 4. Buktikan aplikasi bisa memakainya, bukan hanya psql
DATABASE_URL="postgres://nyx:<pass>@127.0.0.1:5432/nyx_restore_drill" \
  pnpm --filter nyx-server exec npx prisma db pull --print >/dev/null && echo "schema OK"

# 5. Bersihkan
sudo -u postgres dropdb nyx_restore_drill
```

Kriteria lulus: jumlah tabel > 0, `User`/`Message` masuk akal terhadap produksi,
`max(createdAt)` pesan tidak lebih tua dari 24 jam sebelum waktu dump, dan
Prisma bisa membaca skema hasil restore.

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
| 2 | Snapshot terverifikasi; `latest.json.treeSize` **dan** `root` = pohon hidup | nama arsip + size/root |
| 3 | Bukti pra-bencana lolos `transparency.VerifySearch` (Go) + auditor head tersedia (mode 3), `/config` `abiVersion=2`, `TreeSize`/`Audit` menjawab | `OK verify-search treeSize=… anchor=…` |
| 4 | Bencana: proses drill dimatikan, DB hidup **dihapus**, arsip lain dipangkas | — |
| 5 | Pulih **hanya** dari `tar.gz` + `config.yaml`; `-check` lulus; head identik | `OK head treeSize=… root=…` |
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
4. `nyx-kt-query-v2 -check -config <config> -db <hasil-ekstrak>` → bandingkan
   `treeSize`/`root` dengan `latest.json` arsip itu. **`-check` exit 0 saja bukan
   bukti** (temuan #2): angkanya yang harus sama.
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
| Postgres restore | **belum pernah** | — | §39.4 |
| Restore klien dari `.nyxvault` | **belum pernah** diuji terhadap dump nyata | — | uji setelah Drill A |
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
- **Per kuartal**: Drill A + restore klien dari `.nyxvault`, catat hasil di §39.6.
- **Setelah setiap restore nyata** (bencana atau latihan): catat hasilnya di
  §39.6, termasuk kalau langkah 6 (auditor) terlewat — itu yang membuat klien
  melihat `unavailable`, bukan log yang hilang.
- **Setiap perubahan skema** (`prisma db push` destruktif): ambil dump manual
  sebelum deploy. `deploy.yml` kini `workflow_dispatch` dan `db push` bersifat
  fail-closed, tetapi dump tetap wajib karena perubahan skema bisa destruktif.
- **Setiap rotasi rahasia**: perbarui §39.3 dan salinan offsite di hari yang sama.
