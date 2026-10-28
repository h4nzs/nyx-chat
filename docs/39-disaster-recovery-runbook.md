# 39 — Runbook pemulihan bencana

> **Status jujur (2026-10-28):** drill pemulihan log KT **otomatis tidak ada
> lagi**. Drill v1 (`scripts/kt-restore-drill.sh`, CI job `kt-recovery`) dihapus
> bersama pensiunnya log v1 (`docs/38`); setara untuk v2 belum ditulis. Yang
> masih berjalan otomatis adalah pembuatan arsip v2 **terverifikasi** oleh proses
> log (head+root dibandingkan sebelum arsip diakui) dan unggahannya ke R2 — itu
> membuktikan arsip konsisten saat dibuat, bukan bahwa arsip bisa dipulihkan.
> Drill pemulihan **Postgres** juga **belum pernah dijalankan** — dump harian ada,
> tapi belum ada bukti bahwa dump itu bisa dipulihkan menjadi database yang bisa
> dipakai. Selama kolom "bukti" di §39.6 masih kosong, pemulihan DB adalah
> asumsi, bukan prosedur.
>
> Dokumen ini sengaja pendek dan berisi perintah, bukan narasi. Yang tidak bisa
> diverifikasi (siapa memegang akses apa) ditandai `TODO(operator)`.

## 39.1 Prinsip

1. **Backup bukan pemulihan.** Hanya drill yang pernah lulus yang dihitung.
2. **Kunci yang hilang tidak bisa dipulihkan dari data.** Log KT tanpa kunci
   log-nya masih bisa dibaca, tapi tidak bisa dipercaya/ditumbuhkan; pepper
   at-rest tanpa salinan membuat identifier di DB tidak bisa dibalik.
3. **Urutan pemulihan**: rahasia → DB → layanan → KT → verifikasi klien.
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

## 39.5 Drill B — Log KT (tidak otomatis lagi; manual)

Drill v1 yang dulu otomatis (`scripts/kt-restore-drill.sh`, 9 pemeriksaan,
termasuk kontrol negatif dan pertumbuhan log tanpa percabangan) **dihapus**
2026-10-28 bersama log v1 (`docs/38` §38.2 baris 14). Tidak ada pengganti v2.

Yang masih bisa diandalkan: `nyx-kt-query-v2 -snapshot-dir` hanya mengakui arsip
setelah salinan dibuka ulang dan **tree head + root** cocok dengan pohon hidup
(docs/10 §10.13). Itu membuktikan arsip konsisten **saat dibuat**.

Yang belum dibuktikan dan harus dijalankan operator sebelum menganggap prosedur
ini benar:

1. Hentikan `nyx-kt-query-v2` (flock LevelDB — satu proses).
2. Pindahkan direktori DB hidup `/var/lib/nyx/kt-v2` (jangan dihapus).
3. Ekstrak arsip terbaru dari `/var/lib/nyx/kt-v2-snapshots/` ke lokasi baru.
4. Jalankan `nyx-kt-query-v2 -check -config /etc/nyx/kt-v2/config.yaml -db <hasil-ekstrak>`
   → tree size/root harus sama dengan `latest.json` arsip.
5. Jalankan layanan pada DB hasil pulih, `curl /healthz` dan `curl /config`
   (harus `abiVersion: 2`), lalu minta satu klien memverifikasi bukti search.
6. Tulis hasilnya di §39.6; kalau langkah 4/5 gagal, arsip itu tidak layak
disebut backup.

Yang belum dicakup: **arsip offsite kunci log** (§39.3). Tanpa itu, bencana yang
menghapus VPS sekaligus menghapus kemampuan menumbuhkan log — arsip snapshot KT
di R2 hanya membuktikan masa lalu, bukan masa depan.

## 39.6 Status drill

| Drill | Terakhir dijalankan | Bukti | Catatan |
|---|---|---|---|
| KT restore v2 (manual, §39.5) | **belum pernah** | — | drill otomatis v1 dihapus; ini regresi terbuka |
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

- **Per kuartal**: Drill A + restore klien dari `.nyxvault`, catat hasil di §39.6.
- **Setiap perubahan skema** (`prisma db push` destruktif): ambil dump manual
  sebelum deploy; `deploy.yml` memakai `db push ... || true`, jadi kegagalan
  push tidak menghentikan deploy.
- **Setiap rotasi rahasia**: perbarui §39.3 dan salinan offsite di hari yang sama.
