# 03 — Review Keamanan per Lapisan

Aturan: setiap temuan menyebut `file:line` dan jalur kode. Yang tidak bisa saya pastikan diberi label **UNVERIFIED**.

## 3.1 Model penyerang yang dipakai

(a) operator server/DB/Redis/R2 jahat atau dump DB bocor, (b) user terautentikasi jahat, (c) penyerang jaringan tanpa akun, (d) kontak/anggota grup jahat, (e) pencuri perangkat, (f) XSS di klien.

## 3.2 Temuan

### F-01 — `message:view_once_opened` menghapus pesan siapa pun tanpa cek pemilik/keanggotaan — **Medium / High**

`server/src/network/realtimeHandlers.ts:815-828`

```ts
const msg = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: {...} });
if (!msg || msg.conversationId !== conversationId) return;
...
await ctx.prisma.message.delete({ where: { id: messageId } }).catch(() => {});
```

`messageId` **dan** `conversationId` dua-duanya datang dari klien, jadi perbandingan `msg.conversationId !== conversationId` hanya membuktikan bahwa pengirim tahu id percakapan — bukan bahwa ia pengirim pesan atau penerima yang dituju. Bandingkan dengan `message:unsend` tepat di atasnya (`:780-800`) yang memeriksa `openedSenderId === userId` **atau** `deleteSecret` yang sah.

**Skenario:** penerima mana pun di sebuah percakapan (atau siapa pun yang pernah melihat id pesan, karena id ikut terkirim ke semua penerima) mengirim `{messageId, conversationId}` → pesan hilang dari antrean store-and-forward sebelum penerima lain mengambilnya, dan pengirim asli menerima event `message:viewed` palsu. **Dampak:** penghapusan pesan pihak lain (≤14 hari window), pemalsuan receipt "sudah dilihat", konten view-once hilang sebelum dibaca. **Perbaikan:** minta bukti salah satu — `deleteSecret` (pola unsend), atau `targetRecipient === userId` untuk penerima, dan jangan kirim event `message:viewed` bila bukti bukan penerima. **Test:** unit test `realtimeHandlers` yang mengirim event dengan user ketiga dan memastikan `message.delete` tidak dipanggil.

### F-02 — Tulis baris SYSTEM ke `conversationId` mana pun tanpa otorisasi keanggotaan — **Medium / High**

`realtimeHandlers.ts:651-705` (`group:fulfilled_key`) dan `:730-760` (`metadata:updated`).

Kedua cabang menerima `conversationId` dari payload, lalu langsung `tx.message.create({ data: { conversationId, type: 'SYSTEM', content: <dari klien> ... } })`. Tidak ada pemeriksaan bahwa pengirim adalah anggota percakapan itu (percakapan 1:1 memang tidak punya daftar anggota di server, tetapi *grup* pun tidak dicek terhadap token/epoch — berbeda dengan jalur `/api/groups/*` yang memakai `evaluateMemberToken`). `group:fulfilled_key` juga meneruskan `emitPayload` ke `requesterId` sembarang.

**Skenario:** user terautentikasi mana pun yang mengetahui satu `conversationId` dapat menyisipkan baris SYSTEM (≤60/menit, TTL 7 hari) ke riwayat percakapan orang lain, memicu `conversation:updated` ke id sembarang, dan membuat klien penerima memproses amplop `GROUP_KEY` yang tidak pernah diminta. Verifikasi tanda tangan di klien menahan *pemasangan kunci*, tetapi barisnya tetap tersimpan dan tetap direlay. **Dampak:** polusi DB/riwayat, kerja kripto di klien (amplop 2 KB per baris), permukaan DoS. **Perbaikan:** untuk grup, wajibkan token anggota/epoch yang sah di body (seperti `POST /api/groups/sync`); untuk 1:1, wajibkan `deleteSecret`/token yang mengikat ke percakapan. **Test:** kirim `group:fulfilled_key` dengan `conversationId` grup yang bukan milik pengirim → harus ditolak dan tidak menulis baris.

### F-03 — `POST /api/messages` tidak pernah menyimpan `deleteSecret`, sehingga pesan jalur REST tidak bisa di-unsend/dihapus — **Medium / High**

Skema body `server/src/routes/messages.ts:169-190` tidak memuat `deleteSecret`; `z.object` membuang key tak dikenal, dan `tx.message.create` di `:284-300` hanya mengisi `conversationId, senderId: null, content, sessionId, seq, createdAt, expiresAt, isViewOnce`. Jalur realtime menyimpannya sebagai hash (`realtimeHandlers.ts:296-305`). Akibatnya `DELETE /:id` selalu jatuh ke `:320-322` → `403 BLIND_AUTH_REQUIRED: Message cannot be deleted (no delete secret)`.

Jalur ini saat ini **tidak dipakai klien** (lihat C17), jadi dampaknya laten — tetapi rutenya ter-mount, terdokumentasi sebagai fallback (docs/05 §5.4), dan langsung rusak bila dipakai. **Perbaikan:** tambahkan `deleteSecret: z.string().min(32).max(128).optional()` dan `deleteSecret: deleteSecret ? hashCredentialToken(deleteSecret) : null`; sekaligus terima `repliedToId` dan `senderPseudonym` agar paritas dengan jalur WT. **Test:** POST lalu DELETE dengan token yang sama → 204.

### F-04 — Fail-open pada penegakan satu-perangkat saat Redis error — **Medium / High**

`server/src/network/redisBridge.ts:155-161`

```ts
const active = await redisClient.get(identityKey('active_device', userId)).catch(() => null);
activeDeviceCache.set(userId, { deviceId: active ?? '', expiresAt: now + 60000 });
return !active || active === deviceId;
```

Jika GET gagal, `active` menjadi `null` dan fungsi mengembalikan `true` — perangkat yang sudah di-kick boleh terus mengirim selama outage (dan hasil `null` itu **di-cache 60 detik**). `docs/03 §3.3` menyatakan penegakan berjalan server-side per-opcode; saat Redis down klaim itu tidak berlaku. Ini trade-off availability (sama seperti `createCheckRateLimit` fail-open), tetapi berbeda: yang ini adalah kontrol keamanan, bukan anti-abuse. **Perbaikan:** bedakan "tidak ada device aktif" dari "tidak bisa dibaca" — pada error, tolak opcode data (atau minimal jangan cache hasilnya). **Test:** mock Redis GET melempar → `isActiveDeviceAllowed` harus `false` untuk device non-aktif.

### F-05 — Fan-out `typing` ke `targetRecipients` sembarang, tanpa batas dan tanpa cek relasi — **Low–Medium / High**

`realtimeHandlers.ts:506-520`: `targetRecipients` diambil dari payload, tidak dibatasi jumlahnya, dan tidak dicek terhadap daftar peer (`collectPresencePeers` dipakai hanya untuk `subscribe`). Limit 30 event/menit, jadi satu klien dapat mengirim 30×N frame "typing" ke id sembarang — dan event ini membawa `userId` pengirim, sehingga bisa dipakai menampilkan nama/indikator ke orang yang tidak mengenalnya. **Perbaikan:** batasi ke peer yang sah (pola `subscribe`) dan cap jumlah target. **Test:** payload dengan 10.000 target → ditolak.

### F-06 — `urlTtl` dan `fileRetention` presign tidak dibatasi — **Low / High**

`server/src/routes/uploads.ts:74-90`: `parseInt(req.body.urlTtl, 10)` diteruskan langsung ke `getPresignedUploadUrl`, dan `fileRetention` ke `deleteAt` tanpa batas atas. `docs`/komentar menyebut "default 5 menit" tetapi klien dapat meminta TTL bertahun-tahun, melemahkan asumsi "URL upload berumur pendek". **Perbaikan:** clamp `urlTtl` ke `[60, 900]` dan `fileRetention` ke maksimum yang masuk akal (mis. 30 hari). **Test:** `urlTtl: 31536000` → 400 atau ter-clamp.

### F-07 — Paginasi berhenti prematur saat pesan tertua di halaman ber-`seq` 0 — **Low / High**

`server/src/routes/messages.ts:156-158`: `hasMore && oldestUserMessage && oldestUserMessage.seq ? String(seq) : null`. `seq` default 0 untuk baris legacy (`schema.prisma`, komentar `Message.seq`). Bila halaman terakhir yang terambil berisi baris `seq: 0`, `nextCursor` menjadi `null` walau `hasMore` true → klien berhenti dan riwayat lama tidak pernah terambil. **Perbaikan:** bandingkan `typeof seq === 'number'` (atau `seq !== null`), bukan truthiness.

### F-08 — Otorisasi hapus objek R2 hanya memeriksa segmen path terakhir — **Low / High**

`messages.ts:341-353`: sanitizer mempertahankan `/` **dan** `..`, lalu kepemilikan dicek dengan `filename.startsWith(\`${userId}-\`)` pada segmen terakhir. `deleteR2File(safeR2Key)` memakai key penuh. Untuk R2 (S3) tidak ada normalisasi path, jadi eksploitasi traversal praktis tidak terjadi, tetapi pemeriksaannya tidak benar-benar mengikat seluruh key ke pemilik. **Perbaikan:** validasi bentuk key (`^(avatars|attachments|groups|misc)/<userId>-[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$`), tolak `..`.

### F-09 — `GET /api/conversations/sync?ids=` tanpa batas jumlah/ukuran — **Low / High**

`server/src/routes/conversations.ts:50-84`: `ids.split(',')` tanpa cap, lalu `findMany({ where: { id: { in: allIds } } })` tanpa `take`. Satu request dapat mengirim puluhan ribu id (query string dibatasi ukuran server/proxy, tetapi tetap cukup besar) dan memaksa `IN` besar. **Perbaikan:** `.slice(0, 200)` + validasi bentuk id.

### F-10 — `script-src` masih memuat `'unsafe-inline'` dan wildcard Cloudflare — **Low / High**

`server/src/app.ts:104-112`: `scriptSrc` berisi `'unsafe-inline'`, `https://*.cloudflare.com`, `cloudflareinsights.com`. `'unsafe-inline'` adalah trade-off **yang sudah didokumentasikan** (README, docs/03 §3.7) sehingga tidak saya hitung sebagai temuan baru; wildcard `*.cloudflare.com` di `script-src` melampaui kebutuhan dan memperbesar permukaan bila ada subdomain Cloudflare yang bisa dikendalikan pihak lain. **Perbaikan:** ganti wildcard dengan host spesifik, dan pertimbangkan hash/nonce untuk inline script.

### F-11 — `session:fulfill_response` meneruskan material kunci ke `requesterId` sembarang — **Low / Medium, UNVERIFIED dampak**

`realtimeHandlers.ts:600-615`: hanya `requesterId` + `encryptedKey` (dari klien), lalu `emitEventToUser(requesterId, 'session:new_key', { ..., senderId: userId })`. Tidak ada cek bahwa fulfiller adalah peserta percakapan. Apakah ini berbahaya bergantung sepenuhnya pada apakah klien memasang kunci sesi masuk tanpa memverifikasi pengirim/percakapan. **Yang perlu dikonfirmasi:** baca `storeReceivedSessionKey` di `web/src/store/*` dan pastikan `encryptedKey` hanya di-unseal untuk sesi yang cocok (`conversationId` + lawan bicara) dan bahwa kegagalan AEAD tidak menimpa state. Bila klien menerimanya buta, ini naik ke **High** (key injection).

### F-12 — Variabel mati di jalur kripto (sinyal bug) — **Info / High**

`oxlint` melaporkan 190 warning `no-unused-vars` di `web/` dan 45 di `server/`, termasuk di jalur sensitif: `messagePipeline.ts:350` (`const ciphertext = payload.ciphertext;` tidak dipakai di samping `initiatorCiphertexts`), `:713` (`getSodiumLib`), `:715` (`useAuthStore`), `:818` (`catch (e)` tanpa body). Tidak ada error, tetapi variabel `ciphertext` di jalur X3DH layak dipastikan memang sengaja dibuang, bukan sisa refactor yang menghilangkan pemakaian.

### F-13 — Advisories dependensi — **Low / High**

`pnpm audit --prod`: **3** (1 moderate, 2 low). `qs` moderate (`server>express`, patched ≥6.16.1 — perlu bump Express/lockfile), `i18next-http-backend` 2× low (`web`, `marketing`, patched ≥4.0.4).

## 3.3 Yang saya periksa dan **tidak** menemukan masalah

- **CSRF & urutan mount:** `/api/groups` sengaja sebelum CSRF dan memang token-only; `/api/keys`, `/api/call-tokens`, `/api/pir` (berbasis cookie) berada **di bawah** `doubleCsrfProtection`; webhook NowPayments & `/api/engine` dikecualikan eksplisit (`app.ts:365-395`).
- **Perbandingan rahasia:** `credentialTokenMatches` memakai `timingSafeEqual` dengan cek panjang lebih dulu (`atRestSecrets.ts`), dan token disimpan sebagai SHA-256 (`hashCredentialToken`) — `Message.deleteSecret`, `Conversation.authSecret`, `adminSecretHash` semuanya hash-only.
- **Seal at-rest ber-versi:** `ENC2:<keyId>:<payload>` + `sealedLookupCandidates()` mencakup semua kunci ring, jadi rotasi tidak membuat baris "hilang" dari lookup (`atRestSecrets.ts`). Fail-closed bila `NYX_AT_REST_PEPPER` kosong di production.
- **Rate limit atomik:** Lua INCR+EXPIRE (`redisBridge.ts`, `conversations.ts:104-112`, `keys.ts` OTPK quota) — tidak ada pola incr-lalu-expire.
- **`trust proxy 2`** dan `cors` yang menolak tanpa melempar error (tidak jatuh ke 500), `helmet`, `x-powered-by` dimatikan, body limit 1 MB, morgan hanya non-produksi (menghindari query sensitif di log).
- **Schema privasi:** tidak ada `ipAddress`/`userAgent` di `RefreshToken`; `Message.senderId` nullable + ter-seal/pseudonym; `MessageStatus.userId` tag per-percakapan; tidak ada FK ke `User` untuk `BlockedUser`/`Story`/`UserHiddenConversation` (mencegah dump merekonstruksi graf).
- **Bind loopback** (`index.ts`: `HOST || '127.0.0.1'`) dan metrics loopback-only.
- **Upload:** hanya `application/octet-stream`, ukuran dikunci di presign, key ber-prefix `userId-`.
- **Tidak ada `dangerouslySetInnerHTML` / `innerHTML =` / `insertAdjacentHTML` / `document.write`** di `web/src` (grep penuh: 0 hasil). Ini menutup kelas XSS paling umum; satu-satunya `event.data` navigasi ada di `App.tsx:239-241` (pesan service worker, same-origin — risiko rendah).
