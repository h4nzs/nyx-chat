# 37 — Privacy closure plan (tokens, anonymous sync, mailbox, rotation)

Status: **rencana eksekusi**, ditulis 2026-10-24 setelah audit kode + inspeksi
`~/nyx-selfhost`. Semua item di sini adalah pekerjaan yang **belum ada** atau
**setengah** di kode, kecuali yang dinyatakan sebagai pengecualian.

## 37.1 Ruang lingkup

Termasuk:

1. Token grup ber-epoch + TTL + hash-at-rest (menggantikan token 128-bit tanpa
   epoch/kedaluwarsa).
2. Anonymous sync `POST /api/groups/sync` (token di body, tanpa JWT, tanpa
   penulisan `userId`), dibungkus OHTTP.
3. Revocation: epoch bump oleh admin capability, holder-initiated revoke, tanpa
   serial di log.
4. Transport distribusi kunci yang menyembunyikan graf (`group:request_key` /
   `group:fulfilled_key` sekarang membocorkan requester→fulfiller dan
   mempersist `targetDeviceKey`).
5. PCS kasar untuk grup tanpa MLS (rotasi epoch terjadwal + redistribusi).
6. Verifikasi presentasi credential (body biner, binding ke
   `groupId+epoch+keyVersion+suite+expiry`, allowlist, fail-closed) — **tanpa
   issuer**, karena tidak ada primitif PQ blind-signature yang sudah diaudit.
7. Rotasi kunci at-rest: envelope ber-versi (`ENC2:`) + key ring + job re-seal.
8. Custody kunci: abstraksi provider + kunci ter-seal (tanpa klaim HSM).
9. KT v2: cutover **baca** + jalur reset pin + auditor proses terpisah.
10. OHTTP: relay proses terpisah, allowlist POST untuk sync, carriage token
    untuk jalur sync.
11. PIR: wiring selfhost, snapshot harian, angka host nyata (tanpa audit).
12. Cover traffic lanjutan: batched/jittered release (opt-in per grup).
13. Ops: config nginx + unit selfhost masuk repo (`ops/nginx`, `ops/selfhost`).
14. Penyelarasan dokumen yang sekarang bertentangan dengan kode.

Pengecualian eksplisit (tidak dikerjakan di sini):

- **PQ-MLS / MLS penuh** dan PCS per-pesan setara MLS.
- **Auditor eksternal / dua auditor berdampingan / review kripto eksternal**
  (`docs/36` tetap permintaan, bukan hasil).
- Angka produksi PIR + audit eksternalnya; benchmark baterai perangkat fisik.
- KMS/HSM nyata (tidak ada `/dev/tpm*`, tidak ada Vault di mesin ini).

## 37.2 Kondisi nyata hari ini (bukti kode)

> Diperbarui 2026-10-24 setelah P1–P3. Baris bertanda ✅ sudah tertutup; sisanya
> masih terbuka dan itulah pekerjaan yang tersisa.

| Klaim | Kenyataan |
|---|---|
| Token punya epoch/expiry | ✅ `Conversation.groupEpoch`/`groupTokenExpiresAt`, `UserHiddenConversation.tokenHash`+`tokenEpoch`+`expiresAt`; tulis selalu hash, TTL + grace 24 jam (`utils/groupTokens.ts`) |
| Sync anonim | ✅ `POST /api/groups/sync` (token di body, tanpa cookie/JWT, dipasang sebelum CSRF); `GET /api/conversations/sync` hanya untuk id yang sudah diketahui |
| Graf kunci hilang | ✅ klien: envelope kunci ditulis ke mailbox grup (`web/src/lib/groupMailbox.ts`, tag HMAC per penerima) dengan fallback `group:fulfilled_key` hanya bila metadata/token belum tersedia; ⚠️ server masih melayani jalur legacy itu (matikan setelah semua klien baru) |
| Revocation | ✅ `POST /:id/epoch` (admin capability) + `DELETE /:id/membership`; kick merotasi epoch, leave menghapus baris |
| Credential | ✅ route verifier biner fail-closed (`POST /:id/credential/present`, tanpa issuer); ❌ spike BRaccoon ditutup tanpa implementasi (§37.9) — signature level 1 11,5 KB sudah melewati batas 8 KiB |
| PCS kasar | ✅ rotasi terjadwal (24 jam / 500 pesan, admin online) + rotasi manual yang menaikkan epoch (`lib/groupEpochRotation.ts`); ❌ bukan PCS per-pesan — kompromi satu anggota tetap membaca era berjalan sampai rotasi berikutnya |
| at-rest | ✅ envelope ber-versi `ENC2:<keyId>:…` + key ring (`NYX_AT_REST_KEYRING`/`_FILE`) + re-seal idempoten (`scripts/reseal-at-rest.ts`) + custody env/file (§37.4 P6, `docs/10` §10.17). ❌ blind index (`HMAC(pepper, nilai)`) tetap tidak bisa dirotasi dari server — HMAC satu arah, plaintext tak disimpan |
| KT baca | ✅ v2 live di selfhost (`nyx-kt-query-v2` :8089 + `nyx-kt-auditor-v2` :8088), `KT_QUERY_URL` menunjuk v2 |
| OHTTP | ✅ allowlist POST `sync` (+ batas body 64 KB di gateway) dan token scope mengikuti pasangan method+path; ❌ relay masih satu proses dengan API |
| nginx | ❌ hanya ada di `~/nyx-selfhost/nginx/`, tidak di repo (CF `set_real_ip_from` sudah benar di sana) |

## 37.3 Arsitektur target

### 37.3.1 Dua jenis token, satu sumbu epoch

- **Group token** (per grup per epoch): 256-bit opaque, server menyimpan
  `SHA-256(token)` + `conversationId` + `epoch` + `expiresAt` **saja**. Dipakai
  untuk anonymous sync dan posting ke mailbox grup. Rotasi = epoch naik + token
  baru; token lama tidak dihapus dari DB tetapi ditolak karena epoch/expiry
  (baris lama dibersihkan job).
- **Member token** (per anggota): 256-bit opaque, hash-at-rest, epoch terikat,
  expiry sendiri. Dipakai untuk pull mailbox (sync) dan routing delivery.
  Kick = epoch naik + baris target dihapus; leave = baris dihapus tanpa epoch.
  Saat epoch naik, semua baris anggota yang tersisa ikut dipindah ke epoch baru
  dalam transaksi yang sama — tanpa itu setiap rotasi membuat seluruh anggota
  `stale` dan `/token/refresh` menjawab 410.
- **TTL**: group token 24 jam; rotasi terjadwal admin (24 jam / 500 pesan)
  harus berjalan sebelum TTL habis. Bila token grup kedaluwarsa, admin tetap
  bisa `POST /:id/epoch` (capability admin, bukan token grup) dan anggota
  menarik envelope baru dengan member token; member token 7 hari dengan refresh
  saat app online. Grace eksplisit: sync menerima token yang kedaluwarsa ≤ 24
  jam **hanya** untuk pull + refresh, tidak untuk post. TTL group token
  ditegakkan juga di mutasi anggota/metadata (`utils/groupAccess.ts`), bukan
  hanya mailbox: hash cocok tapi lewat `groupTokenExpiresAt` = 403.

### 37.3.2 Mailbox grup (menyembunyikan graf)

Tabel baru:

```prisma
model GroupMailboxItem {
  id             String   @id @default(uuid())
  conversationId String
  epoch          Int
  kind           String   // KEY_REQUEST | KEY_ENVELOPE | META | COVER
  tag            String?  // HMAC-SHA256(targetMemberToken, "nyx-mailbox-v1")
  payload        String   // ciphertext (base64url), opaque bagi server
  createdAt      DateTime @default(now())
  expiresAt      DateTime
  @@index([conversationId, createdAt])
  @@index([conversationId, tag])
}
```

- **Post** (`kind=KEY_REQUEST`): siapa pun pemegang group token menulis blob
  ter-seal ke public key fulfiller; tidak ada field pengirim.
- **Fulfill** (`kind=KEY_ENVELOPE`): blob ter-seal ke public key requester,
  `tag = HMAC(memberTokenRequester, ...)` supaya hanya target yang mencoba buka.
- **Pull**: `POST /api/groups/:id/mailbox/pull` dengan group token era berjalan
  **atau** member token era berjalan (fallback setelah rotasi: group token lama
  sudah mati, tetapi member token di baris yang sama masih sah; baris yang
  di-kick/leave sudah dihapus sehingga tetap tidak bisa pull). Post tetap wajib
  group token. Cursor adalah `createdAt|id` (batch post berbagi `createdAt`, jadi
  id menjadi tie-break; cursor ISO lama tetap diterima). Server melihat "grup G
  menerima item", bukan tepi requester→fulfiller. Klien memanggil post/pull
  lewat `api(..., { anonymous: true })`: tanpa cookie sesi, installation ID,
  atau CSRF — jadi log akses tidak bisa mengaitkan poll mailbox ke akun.
- Pesan chat tetap lewat jalur normal (bukan mailbox): yang dihilangkan adalah
  **graf distribusi kunci**, sesuai klaim `docs/26` §26.4.

### 37.3.3 Anonymous sync

`POST /api/groups/sync` (tanpa cookie, tanpa CSRF, tanpa `requireAuth`):

```
{ tokens: [base64url(32B), ...], ids?: string[], proofs?: string[] }
→ { conversations: [...], memberships: [...], unknown: number }
```

- Resolusi `sha256(token)` → row token (unique) → conversation + epoch.
  `memberships[].index` menunjuk indeks array `tokens` **asli** (token duplikat
  tetap menghasilkan entri per indeks) supaya klien me-refresh token yang benar;
  token duplikat dicari sekali dan dihitung sekali di `unknown`.
- Metadata percakapan hanya dikembalikan bila ada baris keanggotaan berstatus
  `ok`/`refresh`; token `stale` (epoch lama / lewat grace) hanya menerima status
  membership, bukan metadata grup.
- Bukti Privacy Pass divalidasi terhadap `conversationId` semua membership yang
  dikirim (termasuk `stale`): bukti adalah anti-abuse, bukan izin baca, jadi
  bukti dari grup yang barisnya sudah stale tetap boleh mengesahkan satu sync
  selama token grup lain masih sah (`PP_SYNC_REQUIRED=1`).
- **Gate ini dipertahankan** (keputusan maintainer 2026-10-27); cara aman
  menyalakannya, memverifikasi, merotasi kunci, dan rollback ada di `docs/10`
  §10.22. Klien menutup cold-start: saat sync dijawab `403 PP_PROOF_REQUIRED`
  ia menerbitkan satu bukti secara sinkron (`ensurePrivacyPassProof`) lalu
  mengulang **sekali**, dan memuat ulang issuer bila `keyId` berubah (rotasi
  kunci tidak lagi membuat klien gagal permanen sampai reload).
- **Tidak ada** penulisan `userId`/`routingIdentity` di jalur ini; log hanya
  memuat `conversationId`, `epoch`, `result` (metrik event-only).
- Rate limit per token-hash (Redis bucket) + batas **200 item per request**
  (`MAX_SYNC_TOKENS` di `server/src/utils/groupSync.ts`, dipaksakan juga oleh
  skema zod). Respons di atas itu dipotong dan dilaporkan sebagai
  `truncated: true` — tidak ada paginasi; token di luar 200 pertama tersinkron
  pada panggilan berikutnya. Batas byte 256 KB **tidak** ditegakkan terpisah:
  isi per item adalah metadata terenkripsi, dan batas 200 item yang menjaga
  biaya lookup + ukuran respons. Replay: cursor monotonik (`createdAt|id`),
  TTL item 7 hari.
- OHTTP: allowlist `POST /api/groups/sync`; OHTTP token diperluas ke POST
  **hanya path ini**, body ≤ 64 KB.

### 37.3.4 Revocation

- `POST /api/groups/:id/epoch` (admin capability, `X-Admin-Token`):
  `epoch += 1`, group token baru, distribusi token baru ke anggota lewat
  mailbox (`kind=META`, tag per anggota), item epoch lama dihapus.
- `DELETE /api/groups/:id/membership` (holder-initiated, member token):
  hapus baris member token milik pemanggil; epoch **tidak** naik.
- Kick (admin) = hapus token target (member token langsung mati) + epoch bump +
  rotasi group token. Log hanya `{conversationId, epoch, reason}`; tidak ada
  serial/token di log. Metrik: `nyx_group_epoch_bumps_total{reason}`,
  `nyx_group_sync_total{result}`.

### 37.3.5 Credential presentation (verifier saja)

`POST /api/groups/credential/present` — `application/octet-stream`, skema biner:

```
magic "NYXC" (4) | suite u8 | keyVersion u16 | epoch u64 | groupIdLen u8 |
groupId | expiresAt u64 | sigLen u16 | sig
```

- Verifier membaca **binding lengkap** (`groupId+epoch+keyVersion+suite+expiry`)
  dan menolak bila salah satu tidak cocok dengan baris grup.
- `CREDENTIAL_SUITE_ALLOWLIST` (default kosong) → **fail-closed**: suite tidak
  dikenal/diizinkan = 403, tidak ada fallback RSA.
- Issuer **tidak** diimplementasikan; endpoint hanya bisa lulus bila operator
  memasang verifier module (interface `CredentialVerifier`), dan default build
  tidak punya module. Tujuannya mengunci kontrak + fail-closed + tes, bukan
  menghidupkan fitur.

### 37.3.6 PCS kasar tanpa MLS

- `Conversation.epochRotatedAt`; rotasi otomatis bila `now - epochRotatedAt >
  GROUP_EPOCH_MAX_AGE` (default 24 jam) **atau** ≥ `GROUP_EPOCH_MAX_MESSAGES`
  (default 500) saat admin sedang online.
- Rotasi = group key sender-chain baru per anggota + distribusi lewat mailbox.
- Batas jujur: ini bukan PCS per-pesan; kompromi satu anggota masih membaca era
  berjalan sampai rotasi berikutnya. Ditulis di `docs/26` §26.4.

## 37.4 Fase eksekusi (berurutan, tiap fase bisa di-deploy sendiri)

### P0 — Fondasi skema + token hash (tanpa perubahan perilaku klien)

- `prisma/schema.prisma`: `Conversation.groupEpoch`,
  `groupTokenExpiresAt`, `epochRotatedAt`; `UserHiddenConversation.tokenHash`,
  `tokenEpoch`, `expiresAt`; `GroupMailboxItem`.
- **Hard cut 2026-10-24, tanpa backfill/dual-read.** Kolom `deliveryToken`
  dihapus, bukan dimigrasikan: `prisma db push` pada tabel lama akan gagal
  (kolom wajib baru). Sejak 2026-10-26 (audit F-04) `deploy.yml` **tidak**
  menelan kegagalan: `prisma db push` yang gagal menghentikan deploy sebelum
  `pm2` restart, lalu kolom/tabel yang dipakai build ini diverifikasi langsung
  ke `information_schema` (`UserHiddenConversation.tokenHash`/`tokenEpoch`,
  `Conversation.adminSecretHash`, `GroupMailboxItem`). Reset DB **tidak**
  dilakukan otomatis — itu keputusan operator dengan backup terverifikasi.
  Klien lama tidak bisa
  discovery sampai di-update bersama server. Token grup awal memakai
  `newOpaqueToken()` (43-char base64url), bukan 64-hex.
- Tes: `tests/groupTokens.test.ts` (hash lookup, epoch, expiry, rotasi
  memindahkan semua baris anggota) + `tests/deliveryTokens.test.ts` (kontrak
  skema/token/hard cut).

### P1 — Endpoint sync + epoch + revocation

- `server/src/routes/groups.ts` (baru): `POST /sync`, `POST /token/refresh`,
  `POST /:id/epoch`, `DELETE /:id/membership`.
- `utils/groupTokens.ts`: issue/rotate/verify (timing-safe compare hash),
  rate limit per token hash, Redis bucket.
- `utils/groupAccess.ts`: kick/leave memanggil rotate/delete token.
- Web: `lib/groupTokens.ts` (simpan token per grup, rotasi, refresh), ganti
  header `X-Delivery-Tokens` → body `POST /api/groups/sync` (dual sampai P2).
- Tes: gate order (token → expiry → epoch → rate limit), revocation behavior,
  no-userId assertion (source test: route tidak memanggil `req.user`).

### P2 — Mailbox + transport kunci graph-hiding

- `utils/groupMailbox.ts`: post/pull/GC (TTL), tag HMAC, ukuran/limit.
- Server: `group:request_key`/`group:fulfilled_key` jadi **legacy no-op**
  (ACK error) setelah klien baru; kirim/terima lewat mailbox.
- Web: `lib/pairwiseKeyDelivery.ts` dipindah ke mailbox (post request, poll
  sync, fulfill), `groupPseudonyms.ts` tag helper, `transportClient.ts` wiring.
- E2E: grup 3 anggota, rotasi kunci setelah kick tetap sampai, dan tes sumber
  bahwa jalur lama tidak menulis SYSTEM row ber-`targetDeviceKey`.

### P3 — OHTTP untuk sync + relay terpisah

- Allowlist POST `/api/groups/sync`; OHTTP token scope POST untuk path itu.
- `server/src/ohttp/relay` proses terpisah (`ops/selfhost/nyx-ohttp-relay.service`),
  `OHTTP_RELAY_TARGET` mengarah ke proses relay (bukan app yang sama).
- Web: `ohttpClient` dukung POST sync; fallback langsung (tanpa OHTTP) tetap ada,
  dicatat di metrik `nyx_ohttp_sync_total{mode}`.

### P4 — PCS kasar

- Rotasi terjadwal sesuai 37.3.6, wiring admin capability, distribusi mailbox.
- Tes waktu (`GROUP_EPOCH_MAX_AGE` di-inject), tes idempoten.

### P5 — Credential verifier skeleton

- `server/src/utils/credentialPresentation.ts` (parser biner + binding +
  allowlist + fail-closed), route `POST /api/groups/credential/present`.
- Tes: tiap field mismatch, suite tidak diizinkan, body rusak, tidak ada issuer.

### P6 — At-rest v2 + custody — **SELESAI (2026-10-25)**

- ✅ `ENC2:<keyId>:<nonce||ct>`; key ring `NYX_AT_REST_KEYRING` (JSON,
  `{active,keys}`) atau `NYX_AT_REST_KEYRING_FILE`. Format lama (tanpa prefiks)
  = kunci id 0 dari `NYX_AT_REST_PEPPER` dan selalu terbaca.
- ✅ `server/scripts/reseal-at-rest.ts`: batch 500, dry-run default (`--apply`
  untuk menulis), idempoten, progress per kolom, `unreadable` sebagai exit 2.
  Runbook: `docs/10` §10.17.
- ✅ `utils/keyCustody.ts`: provider `env` / `file` (systemd-creds
  `--with-key=host`), status di `/api/admin/system-status` (`atRest`, tanpa nilai).
- ✅ `sealedLookupCandidates` mengembalikan kandidat untuk **semua** kunci di
  ring (bukan hanya aktif + legacy), dipakai di routing, story, block, push
  subscription (subscribe & logout) — tanpa itu rotasi membuat baris yang
  disegel kunci lama tak ditemukan dan push berduplikasi.
- ✅ Tes: `atRestSecrets` (roundtrip legacy→ENC2, key ring dua slot, kandidat
  semua kunci ring, key id tak dikenal → null, key ring rusak → throw) + `keyCustody`
  (env menang atas file, file hilang, status tanpa rahasia). Server 638 tes hijau.
- ❌ **Tidak** ada re-index blind index (identifier HMAC): HMAC satu arah dan
  plaintext tidak disimpan server. Ini batas, bukan pekerjaan yang terlewat —
  jangan jadwalkan rotasi pepper dengan harapan kolom itu berganti.

### P7 — KT v2 read + auditor terpisah + PIR/OHTTP ops — **SELESAI (2026-10-25)**

- ✅ KT v2 baca sudah live di selfhost (`nyx-kt-query-v2` :8089, auditor v2
  :8088, `KT_QUERY_URL` menunjuk v2); `KT_READ_MODE` + jalur reset pin ada di
  kode dan sudah diuji di klien (`ktMonitoring`/`keyTransparency`).
- ✅ Auditor v2 proses terpisah (`ops/systemd/nyx-kt-auditor-v2.service`).
- ✅ PIR: `bench:pir` dijalankan ulang di mesin ini dan angkanya cocok dengan
  catatan 2026-10-24 (`docs/35` §35.7) — N=1000 startup 20,6 s, hint 9,39 MB,
  query ~138 ms / 5,5 KB. Angka ini **bukan** angka produksi dan belum diaudit.
- ✅ OHTTP relay proses terpisah: `server/src/ohttp/{relay,relayApp}.ts`,
  script `pnpm --filter nyx-server run relay`, unit
  `ops/systemd/nyx-ohttp-relay.service`, `OHTTP_RELAY_EXTERNAL=1` membuat API
  berhenti memasang `/relay`. Ditegakkan saat boot: target non-loopback ditolak
  (bukan open proxy), `OHTTP_TOKEN_MODE=off` ditolak (relay tanpa sesi/DB),
  header klien dibuang (cookie/authorization/x-forwarded-for/UA). Tes:
  `tests/ohttpRelay.test.ts` (6 kasus) + relay nyata dijalankan & di-curl.
- ❌ Yang tetap terbuka: relay dan API masih satu host pada konfigurasi default,
  jadi pemisahan jaringan belum ada; PIR tetap default mati sampai ada audit dan
  angka host produksi (lihat `docs/35` §35.11 #3).

### P8 — Cover traffic lanjutan + ops repo — **SELESAI (2026-10-25)**

- ✅ Jitter rilis grup: `utils/releaseJitter.ts` + histogram
  `nyx_group_release_delay_ms`; opt-in `GROUP_RELEASE_JITTER_MS` (default mati,
  clip 2000 ms), hanya grup, dijalankan **setelah ACK** di kedua jalur kirim
  (WT `realtimeHandlers` dan REST `routes/messages.ts`). Padding 8 KB / envelope /
  header tidak berubah. Tes: `tests/releaseJitter.test.ts` (7 kasus).
  **Bukan batching** — jitter menyebar satu pesan, tidak menyembunyikan volume.
- ✅ Ops masuk repo: `ops/nginx/nyx.conf` (+ `README.md`; master `nginx.conf` tetap lokal), `location =
  /api/ohttp/relay` untuk relay terpisah, unit systemd (termasuk
  `nyx-ohttp-relay` + unit user `ops/systemd/user/`), `scripts/sync-selfhost.sh`
  (profil `selfhost`/`docker`, dry-run default, `--apply`, `--check` exit 1 saat
  drift; transformasi path selfhost eksplisit di skrip). `deploy.yml` memasang unit relay bila sudah
  `enabled` + menjalankan `--check` selfhost sebagai peringatan non-blocking.
- ✅ Penyelarasan dokumen: `docs/26` §26.8.4 (status implementasi),
  `docs/28` R4 (ENC2 + batas rotasi blind index), `docs/34` header (cutover KT
  v2 = operasional, bukan flag kode), `docs/35` §35.11 (BRaccoon no-go + angka
  PIR ulang), `docs/10` §10.17–§10.18.
- ❌ Tidak dikerjakan (batas yang disadari): sharding/epoch inkremental PIR,
  pemisahan jaringan relay↔API (masih satu host pada default), dan batching
  pesan yang benar-benar menyembunyikan volume.

## 37.5 Dampak ke format frozen

- `ENC1:` **tidak diubah**; `ENC2:` ditambahkan sebagai format baru. Semua
  pembaca mencoba ENC1 → ENC2. Tidak ada perubahan padding 8 KB, envelope
  XChaCha, atau skema `tempId`.
- Group token/member token menggantikan `deliveryToken` **di kolom baru**
  dengan hard cut: tidak ada dual-accept, `deliveryToken` dihapus, dan klien
  lama kehilangan discovery sampai di-update bersama server.
- Header `X-Delivery-Tokens` dihapus; sync anonim memakai body
  `POST /api/groups/sync`.

## 37.6 Wiring selfhost (target akhir)

| Proses | Port | Perubahan |
|---|---|---|
| nyx-api | 4000 | route groups baru, mailbox, credential verifier, ENC2 |
| nyx-ohttp-relay | 4100 (loopback) | **baru**, terpisah dari API |
| nyx-kt-query-v2 | 8089 baca / 8087 tulis | **baru**, setelah backfill |
| nyx-kt-auditor-v2 | — | **baru**, proses terpisah |
| nyx-pir-sidecar | 9470 (loopback) | **baru**, `PIR_ENABLED=1`, unit user `ops/systemd/user/nyx-pir-sidecar.service` (docs/10 §10.19) |
| existing | 3000/33333/9464-9469/9090/3001 | tidak berubah |

Verifikasi per fase: `systemctl --user status`, `curl` loopback untuk sync
(tanpa cookie), `psql` untuk memastikan tidak ada `userId` baru di jalur sync,
`/metrics` untuk metrik baru, lalu E2E grup (chrome + sidecar) untuk P2.

## 37.7 Risiko & rollback

- **Hard cut token**: tidak ada dual-accept; rollback berarti deploy build
  lama **dan** memulihkan skema/DB (kolom `deliveryToken` sudah dihapus).
  Deploy web + server bersamaan.
- **Mailbox**: bila klien lama masih memakai `group:request_key`, server
  menolak dengan ACK eksplisit (bukan hening) → klien lama harus di-update
  sebelum server mematikan jalur itu (urutan deploy: web dulu, server kemudian).
- **ENC2/re-seal**: tidak ada penghapusan key lama sampai job re-seal selesai +
  verifikasi sampel; key id tertinggal = gagal-baca terlihat, bukan silent.
- **KT v2**: cutover hanya setelah backfill; rollback = `KT_READ_MODE=v1` +
  reset pin klien.

## 37.8 Keputusan yang menunggu jawaban

Lihat pertanyaan yang menyertai dokumen ini (5 keputusan: PCS, anti-abuse sync,
custody, credential, rollout).

## 37.9 Spike BRaccoon (P5) — hasil dan keputusan

Status: **selesai dijalankan 2026-10-25**, keputusan **tidak diimplementasikan**.
Spike berarti evaluasi terbatas + keputusan, bukan kode produksi; tidak ada
satu baris kripto baru yang ditambahkan karena alasan di §37.9.3.

### 37.9.1 Yang dievaluasi

- **BRaccoon** (Hanzlik, Manulis, Mula, Pulval-Dady, Silde, Slamanig —
  ePrint [2026/1084](https://eprint.iacr.org/2026/1084), rev. 2026-09-25):
  blind signature lattice pertama yang **concurrently secure** dan menghasilkan
  signature dengan **format serta relasi verifikasi Raccoon** — jadi signature
  blind dan non-blind bisa hidup di infrastruktur yang sama (persis pola
  "blind signatures from a signature assumption").
- Konstruksi: blinding di tahap komitmen, hubungan challenge/response dipaksa
  benar lewat *linearly homomorphic encryption* + NIZK (ZK-LaBRADOR),
  SHA3-256/SHAKE256. Analisis one-more unforgeability lewat varian
  `Raccoon*`; protokol yang dipakai tetap memakai rounding.
- Alternatif yang disebut di `docs/35` Fase 5/6 (blind UOV) tidak dievaluasi
  lebih dalam: blind UOV belum punya konstruksi concurrently secure yang
  menghasilkan signature "format biasa", jadi ia bukan pengganti satu-ke-satu.

### 37.9.2 Angka yang relevan

Raccoon (skema dasar, implementasi referensi, Intel i7-12700 @2.1 GHz, tanpa
masking `d=1`) — angka dari halaman resmi Raccoon:

| Level | vk | sk | **signature** | keygen | sign | verify |
|---|---|---|---|---|---|---|
| 1 | 2.256 kB | 14.800 kB | **11.524 kB** | 1.0 ms | 2.3 ms | 0.8 ms |
| 3 | 3.160 kB | 18.840 kB | **14.544 kB** | 1.5 ms | 3.2 ms | 1.3 ms |
| 5 | 4.064 kB | 26.016 kB | **20.330 kB** | 2.5 ms | 4.8 ms | 2.2 ms |

BRaccoon: penulis mengestimasi **total komunikasi ≈862 KB** untuk protokol
issuance dengan hingga 2^32 kueri tanda tangan. Belum ada implementasi publik,
belum ada test vector yang bisa dijalankan, dan belum ada audit — jadi angka itu
estimasi penulis, bukan hasil pengukuran kami.

### 37.9.3 Kenapa belum layak di NYX sekarang

1. **Tidak muat di batas yang sudah frozen.** `CREDENTIAL_MAX_BYTES` = 8 KiB
   (`server/src/utils/credentialPresentation.ts`), envelope cover-traffic 8 KB,
   item mailbox ≤8 KB, body OHTTP ≤64 KB. Satu signature Raccoon level 1 saja
   11,5 KB — sudah melewati tiga dari empat batas itu sebelum ada proof apa pun.
   Menaikkan batas berarti mengubah format frozen + padding, yang justru dilarang.
2. **Issuance tidak muat satu request.** 862 KB butuh ≥14 request 64 KB, atau
   jalur non-OHTTP yang membocorkan IP **dan** isi ke gateway — persis yang
   ingin dihindari OHTTP. Multi-putaran juga membuat state issuance harus
   disimpan di klien, menambah permukaan baru.
3. **Tidak ada implementasi.** NIZK proving (LaBRADOR) di WASM belum ada; biaya
   proving di perangkat kelas menengah tidak bisa diklaim tanpa pengukuran.
   Menulis lattice/NIZK sendiri dilarang oleh aturan repo, dan menyalin kode
   riset tanpa audit hanya memindahkan risiko ke pengguna.
4. **Kompleksitasnya tidak dibayar oleh ancaman yang tersisa.** Setelah P1–P4,
   grup sudah memakai token ber-epoch + rotasi terjadwal; credential PQ akan
   menambah unlinkability issuance, bukan menutup kebocoran yang masih terbuka
   (relay OHTTP masih satu proses, at-rest masih `ENC1:`).

### 37.9.4 Keputusan dan konsekuensinya

- **Tidak implementasi BRaccoon/blind UOV sekarang.** Verifier tetap seperti
  sekarang: kontrak biner, binding lengkap, allowlist suite **kosong** =
  fail-closed (`POST /api/groups/:id/credential/present` selalu menolak sampai
  operator memasang module verifier yang tidak ada di build ini).
- **Wire format credential tidak diubah.** `sigLen` tetap u16 dan batas 8 KiB,
  jadi suite PQ kelak bisa masuk tanpa migrasi format bila signature-nya muat.
- **Yang tidak boleh diklaim:** token grup ber-epoch bukan credential PQ; token
  Privacy Pass (blind RSA, RFC 9474) hanya bukti anti-abuse untuk sync anonim —
  **bukan** unforgeability pasca-kuantum, dan unlinkability-nya bergantung pada
  OHTTP yang belum terpisah prosesnya.
- **Privacy Pass dipakai (bukan dihapus)**: anti-replay `SET {EX,NX}` (F-01),
  issuer key wajib di produksi, gate `PP_SYNC_REQUIRED=1` opsional dengan alert
  `NyxPrivacyPassDenied`. Exception PQ-nya tetap di
  `scripts/pq-only-exceptions.json` (tier B, gate BRaccoon §37.9.5).

### 37.9.5 Gate untuk membuka kembali (semua wajib)

1. Implementasi referensi yang lolos test vector paper, dipakai sebagai
   dependensi (bukan ditulis ulang di repo).
2. Parameter level ≥1 dengan **signature + proof ≤8 KiB**, atau keputusan
   eksplisit menaikkan `CREDENTIAL_MAX_BYTES` + versi envelope baru (bukan
   menumpang di `ENC1`/padding 8 KB).
3. Total komunikasi issuance ≤64 KB (satu body OHTTP) atau jalur multi-putaran
   dengan state yang teruji dan tetap lewat relay terpisah.
4. Proving terukur di WASM: issuance p95 ≤2 s pada perangkat kelas menengah,
   angka dicatat di dokumen ini (bukan "cukup cepat").
5. Audit eksternal tercakup di paket `docs/36` (bukan hanya paper).
6. Dual-verify + kill switch (suite lama tetap bisa diverifikasi selama migrasi).

Sampai keenam gate itu terpenuhi, baris `docs/35` Fase 5 "BRaccoon/blind UOV +
dual verify/kill switch" tetap berstatus **riset**, dan tidak ada kode yang
mengklaim credential PQ.
