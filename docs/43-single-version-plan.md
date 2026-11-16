# 43 — Rencana Versi Tunggal (greenfield, tanpa data user)

Status: **aktif** (2026-11-16). Menggantikan `docs/27`, `docs/30`, `docs/35`
sebagai sumber rencana, dan menggantikan `docs/38` sebagai kebijakan
penghapusan.

Alasan dokumen ini ada: layanan sudah dimatikan sementara dan **tidak ada data
user yang perlu dilindungi**. Semua jalur kompatibilitas data/protokol lama
kehilangan alasannya. Setiap kompatibilitas yang tersisa harus dibuktikan masih
dibutuhkan; defaultnya **hapus**.

---

## 43.1 Postulat

1. **Satu versi.** Satu versi data lokal, satu versi format protokol, satu
   format at-rest. Tidak ada pembaca format lama, tidak ada penulis ganda,
   tidak ada migrasi.
2. **Infra tidak dibatasi.** Jumlah host, spesifikasi, dan pemisahan layanan
   ditentukan kebutuhan keamanan, bukan sisa era 1 core/8 GB. Dokumen ops
   berhenti membahas tuning spesifikasi dan mulai membahas batas kepercayaan
   antar-host.
3. **Klasik-saja tidak dipertahankan.** Kriptografi harus hybrid atau PQ murni
   yang sudah teruji. Sisa klasik-saja ditutup dengan penggantian, bukan dengan
   catatan risiko permanen.
4. **"Beku" bukan alasan.** Label `format beku`, `jangan diubah`, dan
   sejenisnya dicabut. Yang dipertahankan adalah **properti**, bukan byte:
   tidak ada plaintext di server, tidak ada identitas di transport, padding
   seragam, fail-closed pada kegagalan verifikasi.
5. **Data lokal lama boleh hilang.** Termasuk vault IndexedDB, token mailbox,
   state SPQR, pin KT, dan outbox yang belum terkirim.
6. **Tes mengunci invariant, bukan kebetulan.** Saat perilaku lama dihapus,
   tesnya **ditulis ulang** ke invariant baru — tidak dilemahkan, tidak
   dihapus tanpa pengganti.

---

## 43.2 Peta dokumen

### 43.2.1 Dokumen yang dihapus (rencananya sudah selesai)

| Dok | Isi | Alasan | Sisa yang diadopsi |
|---|---|---|---|
| `27-total-upgrade-plan.md` | rencana era post-VPS-closure, tuning ≥8 GB / ≥4 core, fase 0–6 | seluruh isinya soal keterbatasan hardware yang tidak berlaku lagi | tidak ada (angka spesifikasi dihapus dari `docs/10`) |
| `30-post-parity-implementation-plan.md` | WS-A…WS-K, milestone M1–M8, inventaris `docs/29` | setiap workstream tuntas, dibatalkan, atau digated | §43.7 |
| `35-post-quantum-migration-plan.md` | rencana migrasi PQ, fase 0–N, format v2 | semua fase `implemented`; sisa penanda OPRF/PIR sudah usang (PIR kini dua server, `docs/42`) | tidak ada |

Catatan biaya: ketiga dokumen ini dirujuk **517 kali** dari dokumen lain,
`CHANGELOG.md`, dan komentar kode (`docs/27` 10, `docs/30` 351, `docs/35` 156).
Penghapusan berkas karena itu menuntut penulisan ulang rujukan, bukan sekadar
`git rm`.

### 43.2.2 Dokumen yang dipindahkan ke arsip

| Dok | Tujuan | Alasan |
|---|---|---|
| `29-signal-parity-analysis.md` | `docs/history/` | studi banding; berguna sebagai jejak, bukan sebagai rencana |
| `40-link-history-archive.md` | `docs/history/` | catatan riwayat |

### 43.2.3 Dokumen yang dipertahankan dan dirapikan

| Dok | Tindakan |
|---|---|
| `26-group-privacy-blueprint.md` | tetap; argumen privasi grup masih valid, kalimat "jangan diubah" dicabut |
| `28-db-dump-threat-model.md` | tetap; model ancaman dump DB masih berlaku |
| `37-privacy-closure-plan.md` | tetap; rencana penutupan privasi masih aktif |
| `38-legacy-retirement.md` | **ditulis ulang** menjadi kebijakan versi tunggal (§43.5) |
| `10-deployment-ops.md` | hapus semua tuning spesifikasi host; tambah topologi multi-host (§43.6) |
| `11`, `39`, `41` | drill restore & gate CI disesuaikan dengan realita "tanpa data user" |
| `01,03,04,05,07,09,14,15,16,18,32,33,34,42` | cabut kalimat pembekuan format; rujuk §43.1 |

---

## 43.3 Peta kode — yang dihapus

### 43.3.1 Data lokal (Fase B)

| Berkas | Isi | Tindakan |
|---|---|---|
| `web/src/lib/db.ts:305-442` | rantai Dexie v1–v15 (16 blok `this.version`) | satu `this.version(1)` dengan skema final |
| `web/src/lib/__tests__/dexieMigration.test.ts` | tes rantai migrasi | diganti tes bentuk skema (semua tabel/indeks ada) |
| `web/src/lib/biometricUnlock.ts:154,198,250` | migrasi `localStorage['nyx_bio_vault']` | hapus; vault biometrik hanya format sekarang |
| `web/src/store/verification.ts:39,118-125` | prefiks `verified_conversation_` | hapus; satu prefiks |
| `web/src/lib/keychainDb.ts:299,449,465,639` | fallback id senderId-keyed, format tanpa keyId, pesan tanpa `senderDeviceKey` | hapus |
| `web/src/lib/keyStorage.ts:338` | legacy global fallback | hapus |
| `web/src/lib/contactStore.ts:65,188` | record lama tanpa `firstSeenAt`/`lastSeenAt` | hapus |
| `web/src/store/message.ts:1136,2229,2232` | schema legacy, `devices` kosong | hapus |
| `web/src/utils/safetyNumber.ts:54` | jalur legacy | hapus |

### 43.3.2 Protokol (Fase C)

| Berkas | Isi | Tindakan |
|---|---|---|
| `web/src/lib/ktConfigPin.ts` | inferensi pin ABI-1 | hanya ABI 2 |
| `packages/shared/src/ktValue.ts` | jalur baca `ktValue-1` | hanya `nyx-kt-value-v2` |
| `packages/shared/src/groupEnvelope.ts` | v2/v3 + `GROUP_ENVELOPE_V4` | hanya v4 |
| `web/src/utils/crypto.ts:1304` | jalur tulis v2 saat `signingKeyV2` absen | wajib PQ; tidak ada penulis non-PQ |
| `web/src/lib/spqrWire.ts`, `spqrSession.ts` | header v1, gate `ackV`, kill switch | hanya header v2 |
| `web/src/utils/crypto.ts:2499,2512,2954` | prefix CK pra-v2, grup v2/v3 | hapus |
| `server/src` `KT_SERVER_URL` | jalur v1 yang diabaikan dengan warning | hapus env + warning |

### 43.3.3 At-rest (Fase D)

`server/src/utils/atRestSecrets.ts` sekarang menerima **dua** format: bare
base64url (kunci id `0` dari `NYX_AT_REST_PEPPER`) dan `ENC2:<keyId>:<payload>`.
Fase D menyisakan **satu** format ber-key-id dengan AAD, menghapus
`sealedLookupCandidates()` beserta seluruh pemanggilnya (11 tempat di 5 berkas),
dan menghapus `scripts/reseal-at-rest.ts`.

---

## 43.4 Audit kripto

Sudah PQ atau hybrid: X-Wing (X25519 + ML-KEM-768) untuk KEM, ML-DSA-65 untuk
tanda tangan dan log KT, SPQR braid untuk ratchet, XChaCha20-Poly1305,
AES-GCM, BLAKE2b, HMAC-SHA256.

Sisa klasik-saja:

| Titik | Primitive | Keputusan |
|---|---|---|
| `web/src/lib/privacyPass.ts` | Blind RSA (RFC 9474) | **diganti** — lihat §43.4.1 |
| OHTTP/HPKE `VITE_OHTTP_*` | KEM X25519 | hybrid X25519 + ML-KEM-768 |

### 43.4.1 Pengganti Blind RSA

Tujuan aslinya: satu token anonim yang tidak bisa dikaitkan ke user, tapi hanya
bisa dipakai sekali per sinkronisasi. Blind signature PQ yang matang belum ada,
jadi mekanismenya diganti — bukan primitifnya:

1. **Token buta tanpa tanda tangan buta**: server menerbitkan N token acak
   256-bit per akun per 24 jam, disimpan sebagai HMAC(pepper) saja (tanpa
   plaintext), dan klien menyimpannya ter-seal (`ENC1:`) seperti sekarang.
2. **Anonimitas dari transport**, bukan dari buta kriptografis: token dikirim
   di dalam badan OHTTP (sudah ada), sehingga server tidak melihat IP/identitas
   saat memakai token.
3. **Anti-replay + anti-linkability**: satu token = satu `POST /api/groups/sync`,
   diikat ke `conversationId` lewat HMAC lokal (sudah ada di
   `privacyPass.ts`); server menandai token terpakai di Redis dengan TTL 24 jam.
4. **Batas**: server tetap bisa menghitung "berapa token dipakai per akun per
   hari" (itu memang fitur rate-limit), tetapi tidak bisa mengaitkan token ke
   percobaan sinkronisasi tertentu karena pemakaian terjadi di dalam OHTTP.

Risiko yang harus ditutup: tanpa blind signature, issuer bisa mengeluarkan token
yang dapat dikenali. Mitigasi: token adalah byte acak yang dihasilkan **klien**
lalu dikirim ke issuer yang hanya menyimpan HMAC-nya; issuer tidak pernah
melihat nilai token, sehingga tidak bisa menandainya.

---

## 43.5 Kebijakan versi tunggal (pengganti `docs/38`)

`docs/38` selama ini berisi daftar "apa yang boleh dihapus" dengan tiga syarat
konservasi. Di era tanpa data user, urutannya dibalik:

1. Setiap jalur pembaca format lama **dihapus** kecuali ada alasan tertulis yang
   bisa diverifikasi hari ini (bukan "mungkin nanti ada perangkat lama").
2. Setiap jalur penulis ganda **dihapus**; hanya satu format yang ditulis.
3. Setiap label `format beku` dicabut dan diganti pernyataan properti.
4. Setiap dokumen rencana yang sudah tuntas **dihapus**, bukan disimpan sebagai
   "referensi".
5. Tes yang mengunci perilaku lama ditulis ulang, tidak dilemahkan.

---

## 43.6 Infra multi-host

Satu peran per host, batas kepercayaan eksplisit:

| Host | Peran | Data sensitif yang terlihat |
|---|---|---|
| A | API + Postgres | metadata percakapan terenkripsi, blind index |
| B | relay WSS (socket.io gateway) | routing, tanpa isi pesan |
| C | sidecar WebTransport | frame terenkripsi, tanpa identitas |
| D | OHTTP relay | envelope buta, tanpa identitas |
| E, F | PIR server A dan B | shard, saling jujur-sedikit |
| G | KT log | komitmen kunci, tanpa isi |
| H | KT auditor | salinan log, kunci auditor sendiri |
| I | Prometheus/Alertmanager | metrik event-only |

`docs/10` berhenti membahas `vm.swappiness`, `shared_buffers`, atau jumlah core;
yang dibahas adalah batas kepercayaan antar-host, port loopback per exporter, dan
prosedur fail-closed saat satu host mati.

---

## 43.7 Item terbuka yang diadopsi dari `docs/27`/`30`/`35`

| Item | Status | Sumber hidup |
|---|---|---|
| MLS (WS-J) | gate 2027+, belum dimulai | §43.7 (dokumen ini) |
| Klien native push/background (WS-K) | proyek terpisah | — |
| Observability (alert, dashboard, exporter) | selesai sebagian | `docs/10` §10.12, `docs/41` |
| WS-H sisa: false-positive ASN/NAT, kunci TPM/SE, root vendor | butuh data lapangan | `docs/41` |
| KT `cmd/kt-client` interop + dua auditor berdampingan | belum | `docs/34` §34.6 |
| Snapshot KT di VPS + bukti restore | tercakup drill | `docs/39` §39.5 |
| PIR dua server + sharding | selesai | `docs/42`, `docs/41` §6.7 |

---

## 43.8 Urutan fase dan gate

| Fase | Isi | Gate |
|---|---|---|
| **A** | dokumen: `docs/43` (ini), `docs/38` ditulis ulang, `27/30/35` dihapus, `29/40` diarsipkan, `AGENTS.md` jadi invariant | `pnpm run check:status`, oxlint, CI hijau |
| **B** | data lokal: Dexie satu versi, bio vault, prefiks verifikasi, fallback keychain/keyStorage/contact/message | unit web, E2E auth + chat + group + backup |
| **C** | protokol: pin ABI-1, `ktValue-1`, envelope v2/v3, `signingKeyV2` opsional, SPQR v1 + kill switch, `KT_SERVER_URL` | unit + E2E KT live + SPQR + group era |
| **D** | at-rest satu format ber-AAD, hapus `sealedLookupCandidates` + `scripts/reseal-at-rest.ts` | unit server, drill backup/restore |
| **E** | kripto: HPKE hybrid, pengganti Blind RSA (§43.4.1) | unit + E2E sync anonim |
| **F** | infra: `docs/10` multi-host, unit systemd per peran, contoh topologi | drill, `scripts/drill-alerts.sh` |

Setiap fase berakhir dengan `pnpm -r run build`, unit test, oxlint, dan CI 12/12.
Fase B dan C menyentuh jalur kripto yang dipakai E2E kritis, jadi masing-masing
butuh dua putaran E2E penuh sebelum dinyatakan selesai.

---

## 43.9 Yang tetap dipertahankan

- Sealing at-rest (`ENC1:`) sebagai **properti** (kunci tidak pernah di disk
  dalam bentuk terang), bukan sebagai format beku.
- Padding trafik 8 KB.
- Backup `.nyxbak` terenkripsi (format boleh berubah, properti tidak).
- `SERVER_CAPABILITIES` sebagai satu sumber negosiasi dua relay.
- KT monitor fail-closed dan verdict per peer.
- LevelDB single-writer untuk log KT.
- Metrics exporter loopback-only, event-only.
