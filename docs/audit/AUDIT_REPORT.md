# AUDIT_REPORT — NYX (read-only)

**Tanggal:** 2026-10-31 · **Commit:** `b320c957` · **Versi:** 3.0.0
**Sifat:** read-only. Tidak ada source/config/schema yang diubah. Satu-satunya berkas yang ditulis: `docs/audit/*`.

---

## 1. Ringkasan Eksekutif

Secara keseluruhan **fondasi keamanan NYX lebih baik daripada klaimnya di tempat-tempat yang paling sulit** — privasi at-rest (sealed sender, tag per-percakapan, hash token), CSRF per-klien, rate limit atomik, dan disiplin format kripto (padding 8 KB, envelope `ENC1:`/`ENC2:`, `deleteSecret` sebagai hash + `timingSafeEqual`) semuanya saya verifikasi di kode, bukan hanya di dokumen. Tidak ada **Critical** dan tidak ada **High** yang bisa saya buktikan.

Yang tersisa adalah **lubang di jalur realtime**: lapisan socket/WebTransport punya beberapa operasi yang mengubah atau menghapus data dengan `conversationId`/`messageId` dari klien tanpa bukti keanggotaan. Penyebabnya seragam — jalur REST sudah punya gate (token grup, admin capability, `deleteSecret`), jalur realtime tidak memakai gate yang sama.

### Lima risiko teratas

1. **`message:view_once_opened` menghapus pesan apa pun tanpa cek pemilik** (`realtimeHandlers.ts:815-828`). Penerima mana pun (atau siapa pun yang tahu id pesan) bisa menghapus pesan dari antrean dan memalsukan receipt "sudah dilihat". **F-01**
2. **Tulis baris SYSTEM ke `conversationId` mana pun tanpa otorisasi** (`group:fulfilled_key` / `metadata:updated`, `realtimeHandlers.ts:651-760`). Polusi riwayat orang lain dan kerja kripto paksa di klien. **F-02**
3. **Single-active-device fail-open saat Redis error** (`redisBridge.ts:155-161`). Kontrol keamanan (bukan sekadar anti-abuse) hilang diam-diam, dan hasil `null` di-cache 60 detik. Klaim docs/03 §3.3 tidak berlaku saat itu. **F-04**
4. **`POST /api/messages` tidak menyimpan `deleteSecret`** sehingga pesan jalur REST tidak pernah bisa di-unsend/dihapus. Rute masih ter-mount dan terdokumentasi sebagai fallback. **F-03**
5. **Presign upload menerima `urlTtl`/`fileRetention` tanpa batas** (`uploads.ts:74-90`), melemahkan asumsi "URL berumur 5 menit". **F-06**

### Opini kelayakan rilis

**Siap rilis setelah 4 perbaikan kecil (± setengah hari kerja), bukan setelah refactor.**

Perbaikan F-01, F-02, F-04, dan F-03 masing-masing lokal: satu cabang otorisasi, satu `try/catch` yang berhenti fail-open, satu field di skema Zod + satu baris di `create`. Tidak ada yang menyentuh format beku (`docs/04`), padding, atau primitif. Sisanya (F-05…F-13, U-01) bisa masuk rilis berikutnya.

Satu hal yang **harus** diputuskan manusia sebelum rilis: **F-11** — apakah klien menerima kunci sesi masuk tanpa memverifikasi pengirim. Saya tidak bisa memastikan secara statis, dan bila jawabannya "ya", itu naik menjadi High (key injection) dan menjadi perbaikan wajib.

---

## 2. Scope & Coverage

### Yang direview (dengan membaca kodenya)

| Area | Berkas utama |
|---|---|
| Konfigurasi server, CSP, CORS, CSRF, mounting order | `server/src/app.ts`, `index.ts` |
| Relay realtime + handler | `server/src/network/redisBridge.ts`, `realtimeHandlers.ts` |
| Middleware auth & rate limit | `server/src/middleware/auth.ts`, `rateLimiter.ts` |
| Rute pesan (REST) | `server/src/routes/messages.ts` |
| Rute percakapan & grup (awal) | `routes/conversations.ts`, `routes/groups.ts` |
| Upload / R2 presign | `routes/uploads.ts` |
| Prekey bundle v2 | `routes/keys.ts` (140 baris pertama) |
| Rahasia at-rest | `server/src/utils/atRestSecrets.ts` |
| Skema DB | `server/prisma/schema.prisma` |
| Klien REST + CSRF | `web/src/lib/api.ts` |
| Pipeline dekripsi | `web/src/lib/messagePipeline.ts` (window X3DH) |
| Worker kripto | `crypto.worker.ts` (inventaris op + semua titik nonce/AEAD) |
| Pengiriman/unsend klien | `web/src/store/message.ts`, `components/MessageItem.tsx` |
| Service worker → navigasi | `web/src/App.tsx` |
| CSP nginx | `ops/nginx/nyx.conf` (grep) |

### Yang **tidak** direview

- `crypto.worker.ts` baris 1–664 dan sebagian besar isi op (hanya inventaris + titik nonce/AEAD yang dibaca) — **bukan** audit kriptografis penuh.
- `packages/keytrans-wasm-v2`, `packages/keytrans-v2`, `packages/spqr-wasm`, `vendor/signal/**` (WASM/Rust/Go vendored).
- `server/kt-query/**` (Go KT log/auditor), `server/transport-sidecar/src/*.rs` isi protokol.
- `web/src/workers/transport.worker.ts`, `ohttp.worker.ts`.
- Sebagian besar `routes/auth.ts` (1875 baris) — hanya pola token/refresh yang di-grep; **alur register/login/recovery/PoW/WebAuthn tidak dibaca penuh**.
- `routes/users.ts`, `stories.ts`, `burner.ts`, `subscriptions.ts`, `admin.ts`, `engine.ts`, `linkHistory.ts`, `ktQuery.ts`, `pir.ts`, `ohttp.ts`, `callTokens.ts`.
- `web/src/store/{auth,conversation,burner}.ts`, semua `components/` (kecuali `MessageItem`), `pages/`.
- `marketing/`, `ops/prometheus/**`, `ops/alertmanager/**`, `.github/workflows/**`.
- Backup `.nyxbak`, device linking (`docs/40`), KT monitor/gossip — dibaca sebagai dokumen saja.

### Yang dijalankan

`prisma generate`, build semua paket (**exit 0**), `oxlint` (**0 error**), server unit test (**711 tes, 0 gagal**), web unit test (**134 berkas / 1108 tes, 0 gagal**, 531 s), `pnpm audit --prod` (**3 advisory**), cek paritas key i18n (**1091 key, 4 locale lengkap**), grep sink XSS (**0 hasil**).

### Yang tidak bisa dijalankan

E2E Playwright (butuh stack), WebTransport E2E (butuh sidecar + Chrome), `cargo test/clippy/audit`, `kt-query/build.sh test`, drill Prometheus/load/restore, fuzz parser, DR oracle. Kedua suite unit (server & web) **selesai dan hijau**; detail angka & durasi ada di `01-baseline.md`.

---

## 3. Tabel Temuan (urut severity)

| ID | Severity | Confidence | Area | Judul | Lokasi |
|---|---|---|---|---|---|
| F-01 | **Medium** | High | Realtime authz | `message:view_once_opened` menghapus pesan tanpa cek pemilik/keanggotaan | `realtimeHandlers.ts:815-828` |
| F-02 | **Medium** | High | Realtime authz | Baris SYSTEM ditulis ke `conversationId` mana pun tanpa otorisasi | `realtimeHandlers.ts:651-705, 730-760` |
| F-03 | **Medium** | High | REST pesan | `POST /api/messages` tidak menyimpan `deleteSecret` → unsend/delete mustahil | `routes/messages.ts:169-190, 284-300, 320-325` |
| F-04 | **Medium** | High | Session/device | Single-active-device **fail-open** saat Redis error, hasil di-cache 60 s | `redisBridge.ts:155-161` |
| F-05 | Low–Medium | High | Realtime abuse | Fan-out `typing` ke target sembarang, tanpa cap & cek relasi | `realtimeHandlers.ts:506-520` |
| F-06 | Low | High | Upload | `urlTtl`/`fileRetention` presign tanpa batas atas | `routes/uploads.ts:74-90` |
| F-07 | Low | High | REST pesan | Paginasi berhenti prematur saat baris tertua ber-`seq` 0 | `routes/messages.ts:156-158` |
| F-08 | Low | High | Upload/R2 | Otorisasi hapus objek hanya segmen path terakhir; `..`/`/` dipertahankan | `routes/messages.ts:341-353` |
| F-09 | Low | High | REST input | `GET /conversations/sync?ids=` tanpa batas jumlah id & tanpa `take` | `routes/conversations.ts:50-84` |
| F-10 | Low | High | CSP | `script-src` memuat `'unsafe-inline'` + wildcard `*.cloudflare.com` | `app.ts:104-112` |
| F-11 | Low (potensi **High**) | Medium — **UNVERIFIED** | Realtime/kunci | `session:fulfill_response` merelai kunci ke `requesterId` sembarang tanpa cek keanggotaan | `realtimeHandlers.ts:600-615` |
| F-12 | Info | High | Kripto/klien | Variabel mati di jalur X3DH & worker (`ciphertext`, `getSodiumLib`, `catch(e)` kosong) | `messagePipeline.ts:350,713,715,818` |
| F-13 | Low | High | Dependensi | 3 advisory (`qs` moderate, `i18next-http-backend` 2× low) | `pnpm audit` |
| U-01 | Low | High | UX | Mutasi saat CSRF gagal → 403 tanpa pesan yang bisa ditindaklanjuti | `api.ts:190-215` |
| D-01…D-04 | Info | Medium–High | Dokumentasi | Drift dokumen (REST fallback, single-device, KT v1/v2 di README) | lihat §6 |

**Tidak ada Critical. Tidak ada High yang terverifikasi.**

---

## 4. Temuan Rinci

### F-01 — `message:view_once_opened` menghapus pesan tanpa cek pemilik

**Bukti.** `server/src/network/realtimeHandlers.ts:815-828`:

```ts
const msg = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, senderId: true } });
if (!msg || msg.conversationId !== conversationId) return;
...
await ctx.prisma.message.delete({ where: { id: messageId } }).catch(() => {});
```

**Mengapa guard yang ada tidak menolong.** Kedua nilai berasal dari payload klien. `msg.conversationId !== conversationId` hanya membuktikan pengirim **tahu** id percakapan — bukan bahwa ia pengirim atau penerima yang dituju. Handler saudaranya, `message:unsend` (`:780-800`), sudah melakukan pemeriksaan yang benar (`openedSenderId === userId` **atau** `credentialTokenMatches(deleteSecret)`), jadi pola yang aman sudah ada tepat di atasnya.

**Skenario serangan.** (1) B menjadi penerima pesan di percakapan G; B mengirim `{messageId, conversationId: G}` → pesan dihapus sebelum C mengambilnya. (2) B memicu `message:viewed` palsu ke pengirim. (3) Bila penyerang mendapat id pesan lewat kebocoran/forward, tidak perlu menjadi anggota sama sekali — cukup tahu `conversationId` (yang ikut di payload pesan).

**Dampak.** Penghapusan pesan pihak lain dalam window store-and-forward (≤14 hari), pemalsuan receipt, kehilangan konten view-once sebelum dibaca. Bukan kebocoran kerahasiaan (isi tetap ciphertext), tetapi **integritas dan ketersediaan** pesan.

**Perbaikan (tidak menyentuh format beku).** Wajibkan salah satu bukti: pemegang `deleteSecret` (pola unsend), atau `targetRecipient === userId` untuk penerima. Kirim `message:viewed` hanya bila bukti terpenuhi.

**Test yang menangkap.** Unit test dua user: A mengirim, C (bukan penerima) mengirim event → `prisma.message.delete` tidak dipanggil, tidak ada emit `message:viewed`.

---

### F-02 — Baris SYSTEM ditulis ke `conversationId` mana pun

**Bukti.** `realtimeHandlers.ts:651-705` (`group:fulfilled_key`) dan `:730-760` (`metadata:updated`). Keduanya menerima `conversationId` dari payload lalu langsung `tx.message.create({ data: { conversationId, type: 'SYSTEM', content: <dari klien> } })`. Tidak ada `evaluateMemberToken`, tidak ada cek epoch, tidak ada cek bahwa `requesterId`/`targetRecipients` adalah peserta.

**Mengapa guard lain tidak menolong.** Gate token grup ada di `server/src/routes/groups.ts` dan `utils/groupAccess.ts`, tetapi jalur realtime tidak melewatinya. Rate limit (60/menit) membatasi volume, bukan hak akses. Verifikasi tanda tangan klien menolak **memasang** kunci, tetapi baris SYSTEM tetap tersimpan dan tetap direlay.

**Skenario.** User terautentikasi mana pun yang mengetahui satu `conversationId` (id ikut terkirim ke semua penerima pesan) menyisipkan amplop `GROUP_KEY`/`METADATA_UPDATED` (TTL 7 hari) ke riwayat orang lain dan mengirim `conversation:updated` ke id sembarang.

**Dampak.** Polusi riwayat & DB, kerja kripto paksa di klien (amplop v4 ~2 KB per baris), permukaan DoS, dan momen "key changed" yang membingungkan pengguna.

**Perbaikan.** Untuk grup: wajibkan token anggota + epoch yang sah di body (pola `POST /api/groups/sync`, `evaluateMemberToken`). Untuk 1:1: ikat dengan token/`deleteSecret` per percakapan. Jangan menulis baris bila otorisasi gagal.

**Test.** Kirim `group:fulfilled_key` dengan `conversationId` grup yang bukan milik pengirim → 0 baris dibuat.

---

### F-03 — `POST /api/messages` tidak menyimpan `deleteSecret`

**Bukti.** Skema body `routes/messages.ts:169-190` tidak memuat `deleteSecret`; `z.object` membuang key tak dikenal, dan `tx.message.create` (`:284-300`) tidak mengisinya. `DELETE /:id` (`:314-325`) mewajibkan `message.deleteSecret`, jadi selalu `403 BLIND_AUTH_REQUIRED`. Bandingkan `realtimeHandlers.ts:296-305` yang menyimpan `hashCredentialToken(deleteSecret)`.

**Mengapa ini tetap dilaporkan meski jalur ini belum dipakai klien.** Rutenya ter-mount di `app.ts`, didokumentasikan sebagai fallback kirim (`docs/05 §5.4`), dan klien **tidak** memakainya (lihat C17) — jadi ada dua masalah sekaligus: rute yang rusak bila diaktifkan, dan dokumen yang menyatakan klien memakainya. Perbaikan kecil ini sekaligus menutup drift.

**Dampak.** Bila fallback REST dihidupkan (mis. saat transport bermasalah), semua pesan yang lewat situ tidak bisa di-unsend maupun dihapus — pengguna melihat "hapus" gagal tanpa alasan jelas.

**Perbaikan.** Tambah `deleteSecret: z.string().min(32).max(128).optional()` + `deleteSecret: deleteSecret ? await hashCredentialToken(deleteSecret) : null`, dan terima `repliedToId`/`senderPseudonym` untuk paritas dengan jalur WT.

**Test.** POST dengan `deleteSecret` → DELETE dengan header yang sama → 204; tanpa header → 403.

---

### F-04 — Single-active-device fail-open saat Redis error

**Bukti.** `redisBridge.ts:155-161`:

```ts
const active = await redisClient.get(identityKey('active_device', userId)).catch(() => null);
activeDeviceCache.set(userId, { deviceId: active ?? '', expiresAt: now + 60000 });
return !active || active === deviceId;
```

**Mengapa ini berbeda dari fail-open rate limit.** `createCheckRateLimit` fail-open adalah keputusan ketersediaan untuk anti-abuse (didokumentasikan). Ini kontrol **keamanan**: `docs/03 §3.3` menyatakan perangkat yang di-kick tidak boleh mengirim. Saat Redis tidak bisa dibaca, perangkat lama boleh meneruskan; lebih buruk, hasil `null` disimpan di cache selama 60 detik sehingga perangkat lama tetap lolos setelah Redis pulih.

**Skenario.** Penyerang yang memegang token perangkat lama (mis. perangkat hilang) menunggu/memicu gangguan Redis, lalu mengirim pesan dari perangkat non-aktif. Ia juga bisa memanfaatkan window 60 detik setelah gangguan.

**Dampak.** Pelanggaran kebijakan satu-perangkat; pesan dari perangkat yang seharusnya sudah di-revoke tetap masuk. Bukan kebocoran kunci, tetapi bertentangan dengan klaim keamanan.

**Perbaikan.** Bedakan "tidak ada device aktif" (`!active`) dari "gagal membaca". Pada error: kembalikan `false` untuk opcode data, dan jangan menulis cache. (Pertimbangkan opsi eksplisit `ALLOW_DEVICE_CHECK_DEGRADED=1` bila operator lebih memilih availability.)

**Test.** Mock `redisClient.get` melempar → `isActiveDeviceAllowed` = `false`, cache tidak berisi entri.

---

### F-05 — Fan-out `typing` tanpa batas & tanpa cek relasi

**Bukti.** `realtimeHandlers.ts:506-520`. `targetRecipients` diambil dari payload, tidak dipotong, dan tidak dibandingkan dengan peer (`collectPresencePeers` hanya dipakai untuk `subscribe`). Limit 30 event/menit.

**Dampak.** Satu klien dapat mengirim 30×N event "typing" ke id sembarang; event membawa `userId`, sehingga bisa menampilkan indikator ke orang yang tidak mengenalnya (gangguan + sedikit kebocoran keberadaan).

**Perbaikan & test.** Batasi target ke peer sah dan cap jumlah; test dengan 10.000 target harus ditolak.

---

### F-06 — `urlTtl`/`fileRetention` tanpa batas atas

**Bukti.** `routes/uploads.ts:74-90`. `parseInt` mentah diteruskan ke `getPresignedUploadUrl`. Komentar menyebut default 5 menit, tetapi klien dapat meminta TTL jauh lebih panjang dan menetapkan retensi objek jauh ke depan.

**Dampak.** Melemahkan asumsi "URL upload berumur pendek" dan siklus hidup objek; memperpanjang jendela penyalahgunaan URL yang bocor.

**Perbaikan.** Clamp `urlTtl` ke `[60, 900]`, `fileRetention` ke maksimum wajar (mis. 30 hari), tolak nilai non-finit/negatif.

---

### F-07 — Paginasi berhenti prematur pada `seq: 0`

**Bukti.** `routes/messages.ts:156-158` memakai truthiness: `oldestUserMessage.seq ? String(seq) : null`. Schema menyatakan `seq` default 0 untuk baris legacy. Bila halaman terakhir berisi `seq: 0`, `nextCursor` = `null` padahal `hasMore` true.

**Dampak.** Klien berhenti melakukan backfill dan riwayat lama tidak pernah muncul ( khususnya grup lama / baris pra-migrasi).

**Perbaikan.** Ganti dengan `typeof oldestUserMessage.seq === 'number'`.

---

### F-08 — Otorisasi hapus objek R2 hanya pada segmen terakhir

**Bukti.** `routes/messages.ts:341-353`: sanitizer `replace(/[^a-zA-Z0-9_.\-/]/g, '')` mempertahankan `/` dan `..`; kepemilikan dicek dengan `filename.startsWith(\`${userId}-\`)` pada `parts[parts.length-1]`, lalu `deleteR2File(safeR2Key)` memakai key **penuh**.

**Mengapa dampaknya terbatas.** R2/S3 tidak menormalkan `..`, dan userId adalah UUID, jadi menebak prefix milik orang lain tidak praktis. Namun pemeriksaannya tidak mengikat seluruh key ke pemilik.

**Perbaikan.** Validasi regex penuh `^(avatars|attachments|groups|misc)/<userId>-[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$` dan tolak `..`.

---

### F-09 — `GET /api/conversations/sync?ids=` tanpa batas

**Bukti.** `routes/conversations.ts:50-84`: `ids.split(',')` tanpa cap, `findMany({ where: { id: { in: allIds } } })` tanpa `take`.

**Dampak.** `IN` berukuran sangat besar per request; bersama `generalLimiter` (300/15 mnt) masih bisa membebani DB.

**Perbaikan & test.** `.slice(0, 200)` + validasi bentuk id; test dengan 10.000 id.

---

### F-10 — `script-src` memuat `'unsafe-inline'` dan wildcard Cloudflare

**Bukti.** `app.ts:104-112`. `'unsafe-inline'` adalah trade-off yang **sudah didokumentasikan** (README; docs/03 §3.7) sehingga tidak saya hitung sebagai temuan baru. Yang lebih luas dari kebutuhan adalah `https://*.cloudflare.com` di `script-src`.

**Perbaikan.** Ganti wildcard dengan host spesifik; bila memungkinkan, pindah inline script ke hash/nonce. **Jangan** menambahkan `'unsafe-eval'` (sudah benar dihapus untuk produksi).

---

### F-11 — `session:fulfill_response` merelai kunci tanpa cek keanggotaan — **UNVERIFIED dampak**

**Bukti.** `realtimeHandlers.ts:600-615`: hanya `requesterId` + `encryptedKey` (dari klien), lalu `emitEventToUser(requesterId, 'session:new_key', { …, senderId: userId })`. Tidak ada cek bahwa fulfiller adalah peserta `conversationId`.

**Mengapa ini belum saya sebut High.** Bahaya bergantung sepenuhnya pada klien: bila `storeReceivedSessionKey` hanya menerima kunci untuk sesi yang cocok (percakapan + lawan bicara) dan gagal AEAD tidak menimpa state, ini hanya spam Low. Bila klien memasangnya buta, penyerang dapat menyegel kunci sesi yang ia ketahui ke public key perangkat korban (public key tersedia lewat prekey bundle) → **key injection, potensi MITM / DoS percakapan**.

**Yang akan mengonfirmasi.** Baca `storeReceivedSessionKey` di `web/src/store/*` dan `insertSessionKey`/`deriveSessionKeyAsInitiator`; pastikan ada ikatan `conversationId` + identitas peer + verifikasi bahwa pengirim adalah peserta, dan bahwa kegagalan dekripsi tidak menulis state.

**Perbaikan (bila terkonfirmasi).** Verifikasi di server bahwa fulfiller adalah peserta, **dan** verifikasi di klien bahwa kunci berasal dari peer yang diharapkan untuk percakapan itu.

---

### F-12 — Variabel mati di jalur kripto

**Bukti.** `oxlint`: `messagePipeline.ts:350` (`const ciphertext = payload.ciphertext;` tidak dipakai), `:713` (`getSodiumLib`), `:715` (`useAuthStore`), `:818` (`catch (e)` tanpa body). 190 warning web + 45 server, 0 error.

**Dampak.** Tidak ada dampak runtime; nilainya sebagai sinyal: variabel `ciphertext` di jalur X3DH layak dipastikan memang sengaja tidak dipakai (bukan sisa refactor yang menghilangkan pemakaian).

---

### F-13 — Advisories dependensi

`qs` moderate lewat Express (patched ≥6.16.1) dan dua advisory low `i18next-http-backend`. CI menjalankan `pnpm audit --prod`, jadi baseline ini kemungkinan membuat job tersebut merah kecuali ada allowlist.

---

### U-01 — Mutasi saat CSRF gagal

`api.ts:190-215`: `getCsrfToken()` menelan error dan mengembalikan `""`; mutasi tetap dikirim → `403 Invalid CSRF token`. Cache direset hanya bila teks error memuat "csrf" (terjadi, jadi retry berikutnya berhasil), tetapi pengguna melihat satu kegagalan yang tidak bisa ditindaklanjuti. Pertimbangkan menolak lebih awal dengan pesan "jaringan bermasalah, coba lagi".

---

## 5. Audit Klaim (ringkas)

Tabel lengkap: `docs/audit/02-claims.md` (23 klaim). Ringkasan:

| Status | Klaim |
|---|---|
| **VERIFIED** | C1 plaintext tidak ke server · C2 Argon2id client + HMAC pepper · C3 tidak ada email/phone/IP/userAgent · C4 profil terenkripsi · C6 X-Wing · C7 autentikasi handshake · C9 padding 8 KB · C13 CSRF per-klien · C14 Lua atomik · C15 trust proxy 2 · C16 TTL 14 hari · C18 `.nyxvault` hilang · C19 secretstream · C20 upload hanya octet-stream + ukuran dikunci · C23 dua relay satu sumber kapabilitas |
| **PARTIAL** | C5 PQ wajib (klien ya, server masih menerima bundle v1) · C10 SPQR v2 (kode ada, runtime tidak diuji) · C11 KT verify (server hanya proxy — sesuai; WASM tidak diaudit) · C12 single-device (fail-open, F-04) |
| **FALSE** | C17 REST `POST /api/messages` sebagai fallback yang dipakai klien (klien tidak pernah POST) |
| **CANNOT VERIFY** | C22 penamaan "Signal Protocol SPQR" (deskripsi repo tidak ada di tree; isi kode = DR hybrid + braid opsional) |

**Soal terminologi (C22):** yang diimplementasikan adalah **Double Ratchet hibrid dengan PQ forward secrecy dari langkah KEM**, ditambah **SPQR braid opsional (v2)** untuk post-compromise security. Ini **bukan** Double Ratchet Signal sepenuhnya (tidak ada X3DH klasik), dan `pqdr` hanya nama konsep untuk burner (`docs/04 §4.7`). Wording README saat ini akurat; menyebutnya "Signal Protocol" tanpa kualifikasi akan **over-state**.

---

## 6. Verified-OK (tidak perlu perhatian)

1. **CSRF & urutan mount:** `/api/groups` sebelum CSRF dan memang token-only; `/api/keys`, `/api/call-tokens`, `/api/pir` (cookie) di bawah `doubleCsrfProtection`; webhook & engine dikecualikan eksplisit.
2. **Perbandingan rahasia:** `credentialTokenMatches` = SHA-256 + `timingSafeEqual` dengan cek panjang; `deleteSecret`, `authSecret`, `adminSecretHash` hash-only.
3. **At-rest ber-versi:** `ENC2:<keyId>:<payload>` + `sealedLookupCandidates()` mencakup seluruh key ring (rotasi tidak menghilangkan baris); `NYX_AT_REST_PEPPER` wajib di production (throw, bukan fallback diam).
4. **Rate limit atomik** (Lua INCR+EXPIRE) di bridge, sandbox newchat, OTPK quota.
5. **Privasi skema:** tidak ada `ipAddress`/`userAgent`; `senderId` nullable/ter-seal/pseudonym; `MessageStatus.userId` tag per-percakapan; `BlockedUser`/`Story`/`UserHiddenConversation` tanpa FK ke `User`.
6. **Transport & bind:** `trust proxy 2`, CORS menolak tanpa throw, helmet, body 1 MB, morgan non-produksi, API bind loopback, metrics loopback.
7. **Upload:** mime dipaksa `application/octet-stream`, ukuran dikunci di presign (ditandatangani), key ber-prefix `userId-`, syarat `isVerified`.
8. **XSS:** tidak ada `dangerouslySetInnerHTML`/`innerHTML`/`insertAdjacentHTML`/`document.write` di seluruh `web/src`.
9. **i18n:** 1091 key lengkap di 4 locale (diverifikasi skrip).
10. **Idempotensi kirim:** `SET NX` + nilai id pesan; duplikat mengembalikan ACK sukses dengan pesan yang sama.
11. **Build, lint, tes:** semua paket build exit 0; 0 error lint; **711 tes server + 1108 tes web** lulus tanpa kegagalan.

---

## 7. Checklist Uji Manual (yang tidak bisa dipastikan statis)

Urut prioritas; ❑ = belum dijalankan.

**Keamanan**
1. ❑ Dua perangkat: login di B saat A aktif → A di-kick; **matikan Redis** → apakah A masih bisa mengirim? (F-04)
2. ❑ Kirim pesan view-once, lalu dari akun ketiga kirim `message:view_once_opened` dengan id asli → apakah pesan hilang? (F-01)
3. ❑ Kirim `group:fulfilled_key` dengan `conversationId` grup orang lain → apakah baris SYSTEM muncul di riwayat? (F-02)
4. ❑ `storeReceivedSessionKey`: kirim `session:new_key` dari akun asing, pastikan percakapan tidak rusak (F-11).
5. ❑ Presign dengan `urlTtl: 31536000` → apakah URL benar-benar berumur setahun? (F-06)
6. ❑ Restore `.nyxbak` di perangkat baru + verifikasi phrase salah dan 1-byte tamper ditolak.
7. ❑ WebAuthn PRF di Chrome Android/iOS: buka kunci biometrik, lalu cek isi `localStorage` (apakah hanya ciphertext).

**Realtime**
8. ❑ Dua tab: kirim bersamaan, cek tidak ada duplikat (dedupe tempId) dan urutan `seq` benar.
9. ❑ Putus jaringan di tengah kirim → reconnect → tidak ada pesan hilang/ganda.
10. ❑ SPQR: dua klien naik ke v2, lalu nyalakan kill switch satu klien → pesan v2 lama tetap terbaca (`web/e2e/spqr.spec.ts`).
11. ❑ WebTransport di jaringan nyata (bukan localhost) + cert pinning; fallback WSS saat sidecar mati.

**Fungsional**
12. ❑ Grup: tambah anggota saat 3 anggota lain mengirim bersamaan; rotasi epoch; hapus anggota → kunci lama tidak bisa baca.
13. ❑ Attachment 50 MB, lalu hapus pesan → objek R2 benar-benar hilang.
14. ❑ Pesan kedaluwarsa (TTL pendek) hilang di klien **dan** server.
15. ❑ Cari user via PIR/OHTTP; matikan `PIR_ENABLED`/`OHTTP_ENABLED` → fallback terlihat jelas.

**PWA/UX/A11y**
16. ❑ Install PWA, offline, kirim pesan → antrean flush saat online.
17. ❑ Keyboard-only: login → register → chat; focus trap modal; Escape.
18. ❑ Layar 320 px & teks panjang `pt-BR`/`id`; target sentuh ≥44 px.
19. ❑ Konfirmasi wipe/panic: apakah pengguna dipaksa backup sebelum data hilang?
20. ❑ Load: `scripts/load/run-relay-load.sh` (jangan ke prod).

---

## 8. Urutan Perbaikan yang Disarankan

### Batch A — wajib sebelum rilis publik (≈ setengah hari)

| # | Perbaikan | Bergantung pada |
|---|---|---|
| 1 | **F-01** otorisasi `message:view_once_opened` (pakai pola `message:unsend`) | — |
| 2 | **F-04** fail-closed (atau opt-in eksplisit) untuk `isActiveDeviceAllowed` + jangan cache error | — |
| 3 | **F-02** otorisasi `group:fulfilled_key` & `metadata:updated` (token/epoch) | — |
| 4 | **F-03** simpan `deleteSecret` di `POST /api/messages` (atau hapus rutenya + perbaiki docs/05) | keputusan produk |
| 5 | **F-11** verifikasi klien `storeReceivedSessionKey`; bila menerima buta → naikkan ke High dan perbaiki | investigasi 1 jam |

Semuanya lokal; tidak ada yang menyentuh format beku, padding, primitif, atau skema DB.

### Batch B — sebelum/bersamaan rilis (cepat)

6. **F-07** `typeof seq === 'number'` (satu baris, memperbaiki backfill riwayat).
7. **F-06** clamp `urlTtl`/`fileRetention`.
8. **F-09** cap `ids` + validasi.
9. **F-05** cap + cek peer untuk `typing`.
10. **F-08** regex key R2 penuh.
11. **F-13** bump `qs`/`i18next-http-backend` (atau allowlist CI dengan alasan tertulis).

### Batch C — nice to have

12. **F-10** persempit `script-src` (hash/nonce, buang wildcard).
13. **F-12** bersihkan variabel mati di jalur kripto (pastikan `ciphertext` memang tak dipakai).
14. **U-01** pesan CSRF yang bisa ditindaklanjuti.
15. **D-01…D-04** sinkronkan dokumen (REST fallback, kualifikasi single-device, status KT v1/v2 di README).

### Batch D — utang yang tidak memblokir

16. Uji a11y otomatis (axe) + focus trap.
17. Shard/cache suite web (531 s untuk 134 berkas) agar CI tetap cepat setelah tes Batch A ditambahkan.
18. Putuskan apakah `POST /api/messages` dipertahankan (dan diperbaiki) atau dihapus agar tidak ada jalur kedua dengan jaminan berbeda.

---

## 9. Pertanyaan untuk Maintainer

1. **F-11:** apakah klien menerima `session:new_key` dari pengirim mana pun? (Menentukan severity.)
2. **C5:** apakah server memang sengaja masih menerima bundle tanpa `signingKeyV2` (kompatibilitas), atau itu sisa migrasi yang harus ditutup?
3. **F-03/D-01:** apakah `POST /api/messages` akan diaktifkan kembali? Bila tidak, sebaiknya dihapus.
4. **D-04:** README masih menyebut KT v1 untuk verifikasi; `AGENTS.md`/docs/38 menyatakan v1 pensiun. Mana yang benar untuk rilis publik?

---

**Akhir laporan.** Saya berhenti di sini dan tidak memperbaiki apa pun sampai Anda memilih temuan yang ingin dikerjakan.
