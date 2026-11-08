# 42 — PIR dua server + sharding (pengganti ChalametPIR)

**Status:** rencana kerja, belum ada kode. Ditulis 9 November 2026.
**Menggantikan:** jalur PIR `chalametpir-v1` (`server/pir-sidecar`, `packages/pir-wasm`).
**Rujukan silang:** `docs/37` §P7, `docs/41` §6.7, `docs/10` §10.19, `docs/03` (model ancaman).

Dokumen ini menjawab satu pertanyaan: bagaimana pencarian PIR bisa **dibuktikan
tidak berbohong** tanpa menunggu riset vPIR, dan tanpa mempertahankan satu host
tunggal. Jawabannya: ganti PIR satu server dengan **PIR dua server berbasis XOR**
(information-theoretic, tanpa proof) dan **sharding** sejak awal.

Keputusan yang mendasarinya (9 Nov 2026):

1. Semua server PIR dioperasikan NYX pada fase awal — tetapi kontrak kode tidak
   boleh mengasumsikan satu operator (kunci manifest dan URL per operator).
2. **Tidak ada pengguna, tidak ada migrasi.** Format wire dan record boleh
   berubah total; jalur lama dihapus, bukan dipelihara berdampingan.
3. **Sharding dari hari pertama**, bukan retrofit.

## 42.1 Masalah yang diselesaikan

Keadaan sekarang (`chalametpir-v1`):

| Masalah | Sebab | Akibat |
|---|---|---|
| P1 — jawaban tidak bisa diverifikasi | ChalametPIR tidak punya proof; `process_response` hanya dekripsi | "user tidak ada" dan "server berbohong" tidak terbedakan (`PIR_RECORD_MISS` untuk keduanya) |
| P2 — epoch churn | rebuild penuh tiap ≤3 menit menaikkan epoch | klien mengunduh ulang params (komentar kode: ±11 MB) tiap epoch |
| P3 — params bocor | `pirParams.ts` memakai `fetch` cookie langsung, bukan OHTTP | epoch + `entryCount` tercatat dengan IP/cookie klien |
| P4 — gejala disamarkan | record rusak/terpangkas = `PIR_RECORD_MISS` | kegagalan tampak seperti hasil pencarian sah |

Rancangan di bawah menutup keempatnya dengan **lebih sedikit kriptografi**, bukan
lebih banyak: tidak ada hint, tidak ada skema LWE baru, tidak ada proof.

## 42.2 Model ancaman dan klaim yang boleh dibuat

**Asumsi.** Dua server (`A`, `B`) menyimpan snapshot identik dan **tidak
berkolusi**. Satu di antaranya jujur.

**Dijamin:**

- **Privasi indeks** terhadap satu server (information-theoretic, bukan asumsi
  komputasi): server melihat vektor bit acak; secara informasi tidak memuat
  indeks yang dicari.
- **Deteksi jawaban palsu** dengan satu server jujur: record yang gagal
  checksum/versi ditolak sebagai `PIR_TAMPERED`, tidak pernah ditampilkan
  sebagai "tidak ditemukan". `ix` yang tidak cocok bukan tamper — itu slot milik
  kunci lain, dan klien lanjut ke kandidat berikutnya.
- **Deteksi epoch desync / split-view** antar-server: manifest kedua server harus
  identik dan bertanda tangan.

**Tidak dijamin (tulis apa adanya):**

- Jika **kedua** server berkolusi (atau keduanya milik NYX dan NYX berbohong),
  jawaban palsu tidak terdeteksi. Fase awal semua server milik NYX, jadi klaim
  ini baru menjadi jaminan nyata ketika satu server dijalankan pihak lain.
- Shard yang dipilih membocorkan `log2(shardCount)` bit tentang indeks
  (anonymity set = ukuran shard, §42.3). Ini knob, bukan kebocoran tersembunyi.
- Kebenaran "tidak ditemukan" bergantung pada kedua server mengembalikan share
  nol; satu server yang berbohong selalu terdeteksi, dua yang berkolusi tidak.

## 42.3 Skema: XOR-PIR dua server

Database shard = `S` slot, tiap slot record berukuran tetap `R` byte. Slot kosong
= `R` byte nol.

**Query.** Klien ingin slot `i`:

```
q1 ← {0,1}^S   (acak seragam)
q2  = q1 ⊕ e_i        (e_i = vektor basis)
```

**Answer.** Server `l` mengembalikan `a_l = ⊕ { record[j] : q_l[j] = 1 }`.

Wire share: `ceil(S/8)` byte, **bit `j` = LSB ke-`j`** di dalam byte
(`share[j/8] >> (j%8) & 1`). Bit di luar `S` diabaikan, jadi klien boleh
mengisi byte terakhir dengan acak.

**Recover.** `a_1 ⊕ a_2 = record[i]`.

Biaya per query (per shard, per server): query `S/8` byte, response `R` byte,
komputasi ≈ `S/2 · R` byte XOR (memory-bound). Untuk `S = 4096`, `R = 2048`:
query 512 B, response 2 KB, ±4 MB XOR — di bawah 1 ms dengan SIMD.

**Sharding.** `shard = H(oprfIndex) mod shardCount`. Klien hanya menanyakan
shard-nya sendiri; server belajar shard, tidak belajar slot. Dengan `S = 4096`,
anonymity set = 4096 pengguna. `shardCount = ceil(N / S)`, minimum 1, dan
`shardCount` dipublikasikan di manifest.

Sharding dipilih sejak awal karena murah sekarang dan mahal di-retrofit:
rebuild per shard (bukan seluruh DB), memori per host terbatas, dan penambahan
kapasitas tidak mengubah protokol klien.

**Lapisan kata kunci.** XOR-PIR bekerja pada slot, sedangkan klien memegang
`oprfIndex` 32 byte. Pemetaan indeks → slot memakai **cuckoo 3-pilihan**:
`pirRecordCandidates()` menurunkan tiga slot dari `H(oprfIndex)`; builder
menempatkan record di salah satunya (gagal menempatkan = tambah `slotCount` lalu
build ulang, bukan stash tersembunyi). Klien menanyakan **ketiga slot** dan
memilih record yang `ix`-nya cocok — jadi tidak ada filter yang perlu diunduh,
dan tidak ada tabel penempatan yang bisa bocor atau salah. Biaya: 3 query per
server, masing-masing 512 B.

## 42.4 Record v2

Padding tetap `R` byte (default 2048, sama seperti sekarang). Tata letak:

| Offset | Isi |
|---|---|
| 0 | versi (1 B) = `2` |
| 1..33 | `ix` = 32 byte pertama `SHA-256(oprfIndex)` |
| 33..35 | panjang body (u16 BE) |
| 35.. | body JSON (profil) |
| sisa | padding nol |
| `R-16..R` | `ck` = 16 byte pertama `SHA-256(record[0..R-16])` |

Klien menolak record bila `ix` ≠ indeks yang ia hitung, `ck` salah, versi tak
dikenal, atau panjang body di luar batas. Empat kegagalan itu adalah
`PIR_RECORD_INVALID` — **bukan** `PIR_RECORD_MISS`.

`ix` inilah yang membuat pemalsuan tidak mungkin bagi satu server: server tidak
tahu indeks mana yang ditanyakan, jadi ia tidak bisa memilih record yang `ix`-nya
cocok. Record pengguna lain yang dikembalikan akan langsung gagal. Saat klien
menanyakan tiga slot kandidat, `ix` sekaligus menjadi **pemilih**: slot milik
kunci lain menghasilkan record yang `ix`-nya tidak cocok dan diabaikan.

## 42.5 Manifest dan kesegaran

Per shard, ditandatangani **ML-DSA-65** (`@noble/post-quantum` 0.7.1, sudah jadi
dependensi `server` dan `web`; tidak ada algoritma klasik baru):

```json
{
  "suite": "xor-pir-v1",
  "shard": 3,
  "shardCount": 8,
  "slotCount": 4096,
  "recordBytes": 2048,
  "epoch": 41,
  "entryCount": 3187,
  "dbRoot": "<sha256 atas slot terurut>",
  "operator": "nyx-a",
  "keyId": "<sha256 kunci publik ML-DSA>"
}
```

Aturan klien:

1. Verifikasi tanda tangan A dan B dengan kunci yang di-pin saat build/konfigurasi.
2. `A.manifest == B.manifest` (semua field kecuali `operator`). Beda = `PIR_DESYNC`.
3. `epoch` tidak boleh turun dari yang terakhir dilihat klien (disimpan di
   `localStorage`, ringan) — mencegah rollback snapshot.

`dbRoot` mengikat manifest ke isi shard, jadi server tidak bisa menyajikan shard
lama dengan epoch baru (atau sebaliknya) tanpa ketahuan.

## 42.6 Alur klien

```
identifier → OPRF (tidak berubah, /api/users/search/oprf) → oprfIndex
  → shard = H(oprfIndex) mod shardCount
  → GET manifest A, B (OHTTP, terpisah) → verifikasi + bandingkan
  → slots = pirRecordCandidates(oprfIndex, slotCount)   (3 slot)
  → untuk tiap slot: q1 acak, q2 = q1 ⊕ e_slot
  → POST /query ke A dan B (dua relay OHTTP berbeda)
  → r = a1 ⊕ a2 → record dengan ix yang cocok menang
```

Verbatim verdict (semua fail-closed, **tidak pernah** fallback ke
`/api/users/search`):

| Kondisi | Verdict |
|---|---|
| Ketiga kandidat nol | `PIR_RECORD_MISS` (user memang tidak ada) |
| Checksum/versi gagal di kandidat mana pun | `PIR_TAMPERED` (metrik + alert) |
| Kandidat valid tapi `ix` milik kunci lain | bukan verdict — lanjut kandidat berikutnya |
| Manifest beda | `PIR_DESYNC` |
| Satu server gagal/timeout | `PIR_UNAVAILABLE` (tidak turun ke satu server) |
| Epoch turun | `PIR_ROLLBACK` |

Tidak ada worker WASM: klien hanya butuh `crypto.getRandomValues` dan XOR dua
buffer 2 KB. `packages/pir-wasm` dan `web/src/workers/pir.worker.ts` dihapus.

## 42.7 Konfigurasi

Server (API):

- `PIR_ENABLED=1` — seperti sekarang, tanpa ini `/api/pir/*` = 404.
- `PIR_SERVERS` — JSON array `[{ "id":"a", "url":"http://127.0.0.1:9470", "relay":"/api/ohttp/relay-a" }, ...]`.
  Panjang harus ≥ 2 saat aktif; kurang dari 2 = gagal boot (bukan mode degraded).
- `PIR_MANIFEST_KEYS` — `{ "a": "<base64url ml-dsa-65 pubkey>", ... }`, dipakai
  proxy untuk memverifikasi manifest sebelum diteruskan (pertahanan berlapis;
  klien tetap memverifikasi sendiri).

Sidecar:

- `PIR_ROLE=a|b`, `PIR_SHARDS=0-3` (rentang shard yang dilayani instance ini),
  `PIR_BIND=127.0.0.1:9470`, `PIR_SNAPSHOT_DIR`, `PIR_SIGNING_KEY_FILE` (0600),
  `PIR_MAX_SLOTS`.
- Satu instance boleh melayani beberapa shard; role hanya memilih tanda tangan
  dan identitas manifest.

Klien: `VITE_PIR_ENABLED=1`, `VITE_PIR_OPRF_ENABLED=1`, `VITE_OHTTP_ENABLED=1`,
`VITE_PIR_RELAYS=[...]` (dua relay; satu relay = gagal saat build-mode ketat).
`VITE_PIR_ENABLED=0` tetap jalur lama: pencarian kembali ke blind-index dan
**bukan** ke PIR satu server.

## 42.8 Operasi

- Unit: `nyx-pir-a.service`, `nyx-pir-b.service` (user unit, template
  `ops/systemd/user/nyx-pir@.service`), masing-masing dengan `PIR_ROLE`.
- Snapshot: satu artefak bertanda tangan per shard (`snapshot-<shard>.bin` +
  `manifest-<shard>.json`) dibangun `pir:snapshot`, disalin ke kedua host dengan
  `rsync`/objek storage, lalu `/admin/rebuild` per shard. Tidak ada jalur di mana
  A dan B membangun snapshot sendiri-sendiri — itu sumber desync.
- Rebuild: penanda dirty per shard (Redis set), cron `*/3` hanya membangun shard
  yang kotor; cron `04:15` tetap jaring pengaman penuh.
- Metrik (`server/pir-sidecar`, loopback, pola exporter yang ada):
  `nyx_pir_query_total{result}`, `nyx_pir_query_seconds`, `nyx_pir_shard_epoch`,
  `nyx_pir_manifest_mismatch_total`, `nyx_pir_snapshot_build_seconds`.
- Alert: `NyxPirTampered` (setiap kenaikan), `NyxPirDesync` (timestamp manifest A
  vs B > 10 menit), `NyxPirSidecarDown`, `NyxPirRebuildStale` (epoch tertinggal >
  30 menit).
- Drill: `scripts/pir-tamper-drill.sh` — satu server dijalankan dengan injeksi
  record rusak, membuktikan klien menolak (`PIR_TAMPERED`) dan **tidak** jatuh
  ke pencarian biasa.

## 42.9 Yang dihapus

Setelah XOR-PIR hijau (tidak ada masa transisi, tidak ada pengguna):

- `packages/pir-wasm/` beserta entri `packages/wasm-artifacts.json`.
- `web/src/workers/pir.worker.ts` dan jalur `setup/query/process` di `pirClient.ts`.
- `chalametpir-*` dari `server/pir-sidecar/Cargo.toml`.
- Konsep `seed`, `hint`, `arity`, `record_bytes` dari `/params`; endpoint
  `/api/pir/params` diganti `/api/pir/manifest`.
- `PIR_ARITY`, `PIR_MASTER_SECRET` (tidak ada lagi rahasia server di jalur PIR).

## 42.10 Paket kerja

| WP | Isi | Berkas | Ukuran |
|---|---|---|---|
| WP1 ✅ | Kontrak wire v2, manifest, record v2, verdict | `packages/shared/src/pir.ts` (baru) | S |
| WP2 ✅ | Snapshot per shard: penempatan cuckoo 3-kandidat, `dbRoot`, manifest bertanda tangan | `server/src/pir/{snapshot,manifest,shards}.ts` | M |
| WP3 ✅ | Core XOR-PIR: build slot array, `answer(share)`, hot-swap per shard | `server/pir-sidecar/src/{pir,shard}.rs` (baru) | M |
| WP4 ✅ | Mode ganda sidecar: role A/B, `/manifest`, `/query` | `server/pir-sidecar/src/{main,http}.rs` | M |
| WP5 ✅ | Proxy API: `PIR_SERVERS`, verifikasi manifest, dua relay | `server/src/routes/pir.ts`, `server/src/pir/{config,rebuild}.ts` | M |
| WP6 | Klien: shard + 3 kandidat, dua query OHTTP, verifikasi record, verdict | `web/src/lib/{pirClient,pirParams→pirManifest}.ts` | L |
| WP7 | Ops: unit template, metrik, alert, docs/10 §10.19 ditulis ulang | `ops/`, `docs/10` | M |
| WP8 | Uji: vektor lintas-impl, injeksi tamper, E2E dua server | `server/tests/pir*.test.ts`, `web/e2e/pir*.spec.ts` | M |
| WP9 | Hapus jalur lama (§42.9) + `STATUS.md` | — | S |

Urutan yang menjaga `main` tetap hijau: WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7
→ WP8 → WP9. Selama WP9 belum jalan, fitur tetap **default mati**, jadi setiap
langkah bisa di-merge tanpa memengaruhi pencarian pengguna.

### Gate

- Query p95 (localhost) ≤ 10 ms untuk `S = 4096`, `R = 2048`.
- Trafik per pencarian ≤ 16 KB (di luar OHTTP framing): 3 slot × 2 server × (512 B query + 2 KB response).
- Injeksi tamper 100% terdeteksi, 200/200 percobaan.
- Desync manifest terdeteksi sebelum query dikirim.
- Satu server dimatikan → `PIR_UNAVAILABLE`, 0 fallback.
- Memori sidecar ≤ 1,5× ukuran snapshot shard.

### Definition of done

1. `docs/10` §10.19 menjelaskan arsitektur baru, bukan yang lama.
2. `STATUS.md` menyebut suite `xor-pir-v1` dan rute `/api/pir/{manifest,query}`.
3. Drill tamper dan drill desync berjalan di CI (job `drills`).
4. `PIR_SERVERS` berisi <2 entri = boot gagal, ada tesnya.
5. Tidak ada lagi referensi `chalametpir` di `Cargo.toml`, `package.json`, atau docs.

## 42.11 Risiko

| Risiko | Mitigasi |
|---|---|
| Penempatan cuckoo gagal atau salah (slot salah → user "hilang") | Builder menolak build bila ada kunci tanpa slot; audit tuai 100%: untuk setiap kunci di snapshot, klien harus menemukan record yang `ix`-nya cocok |
| Kedua server di satu host/provider saat deploy pertama | Kontrak kode sudah per-operator; klaim privasi di dokumen ini tetap menyebut kolusi sebagai batas |
| Server CPU naik dengan N (XOR O(N) per query) | Sharding membatasi N per instance; metrik `nyx_pir_query_seconds` + alert |
| Okupansi slot bocor lewat `entryCount`/`dbRoot` | Keduanya memang publik sejak awal (manifest); tidak menambah informasi per-query |
| Record 2 KB × N per shard di RAM | `PIR_MAX_SLOTS` + gate memori di atas |

## 42.12 Hubungan dengan vPIR

vPIR (VeriSimplePIR, `eprint 2024/341`; vPIR state kecil, `eprint 2025/1714`)
tidak diadopsi. Alasannya bukan hanya biaya port ke WASM 32-bit: keduanya
membutuhkan proof preprocessing yang harus diulang setiap epoch berubah, yang
bertabrakan langsung dengan rebuild 3 menit. Jika suatu hari NYX butuh jaminan
terhadap **operator tunggal** yang berbohong, jalur itu dibuka lewat suite baru
(`vpir-*`) di kontrak WP1, bukan dengan mengubah XOR-PIR.
