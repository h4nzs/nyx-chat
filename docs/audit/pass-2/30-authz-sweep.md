# Pass 2 — Sapuan otorisasi endpoint (fokus khusus)

Berkas yang di pass 1 belum dibaca penuh: `sessions.ts`, `backup.ts`,
`previews.ts`, `callTokens.ts`, `stories.ts`, dan sisa `users.ts`.

## Hasil: tidak ada IDOR baru yang terverifikasi

| Endpoint | Gate | Verdict |
|---|---|---|
| `GET /api/sessions` | `requireAuth`; daftar hanya `refreshToken` milik device milik `req.user.id` | OK |
| `DELETE /api/sessions/:jti` | `requireAuth` + `revokeSessionFamily(prisma, {jti, userId})` (util teruji, cek kepemilikan sebelum revoke) | OK |
| `POST /api/backup/presign` | `requireAuth` + `isVerified` + ukuran/URL TTL di-clamp + `deriveBackupObjectKey(secret, userId)` (tanpa userId di kunci) | OK |
| `POST /api/backup/download-url` | `requireAuth` + kunci diturunkan dari **userId pemanggil** (tidak ada parameter kunci) | OK |
| `DELETE /api/backup` | idem, hanya objek sendiri | OK |
| `POST /api/previews` / `GET /api/previews/image` | `requireAuth`; `validateRedirectChain` + `redirect: 'manual'` + cap 5 MB + wajib `image/*` | OK |
| `POST /api/call-tokens` | `requireAuth`; kredensial TURN di-scope ke user/panggilan | OK |
| `GET /api/stories/user/:userId` | `requireAuth`; blocklist + rate limit atomik per (requester,target) | OK |
| `GET /api/stories/:id` | `requireAuth`; blocklist dicek lewat `authorTag`→`resolveRoutingUser` | OK |
| `DELETE /api/stories/:id` | kepemilikan = `tagCandidates(userId).includes(story.authorTag)` | OK |
| `POST|DELETE /api/users/:id/block` | cek `req.user` manual (bukan middleware, tapi efektif) | OK |

Detail yang dipuji (bukan temuan): `UserHiddenConversation` tanpa FK dan tanpa
`userId` plaintext, `blockedUser` berbasis tag ter-seal dengan `tagCandidates()`
(kandidat kunci lama+baru), dan `isOwnedObjectKey` untuk hapus objek R2
(`server/src/routes/messages.ts:369`) menutup F-08.

## Temuan baru (rendah)

### N-01 (Low) — `GET /api/users/:id` terbuka tanpa autentikasi — **KOREKSI: sudah tertutup**

> **Koreksi 2026-11-01.** Temuan ini keliru: `server/src/routes/users.ts:43`
> memasang `router.use(requireAuth)` untuk **seluruh** router (jauh di atas rute
> `/:id`), jadi pemanggil anonim sudah mendapat 401 sebelum handler berjalan.
> Guard `if (!req.user)` eksplisit tetap ditambahkan sebagai jaring bila rute
> dipindah. Lihat `40-fixes.md`.


`server/src/routes/users.ts:685` tidak memakai `requireAuth` dan tidak memeriksa
`req.user`; `app.ts:504` memasang `usersRouter` tanpa middleware auth global.
Respons memuat `encryptedProfile`, `isVerified`, `hasCompletedOnboarding`, dan
kunci publik device.

- Isi profil terenkripsi & kunci publik memang publik demi desain, tetapi
  endpoint ini juga memberi **oracle keberadaan akun** dan metadata onboarding
  ke pemanggil tanpa sesi. Id acak 128-bit membatasi enumerasi praktis, jadi
  dampaknya kecil — namun klaim "server sesedikit mungkin tahu" lebih baik
  ditegakkan dengan `requireAuth` (klien selalu sudah login saat membuka profil)
  atau membatasi field yang dikembalikan untuk pemanggil anonim.
- Perbaikan: tambahkan `requireAuth` (satu kata) — tidak ada pemanggil anonim
  yang terverifikasi di `web/src` (`grep` menemukan pemakaian hanya di alur
  ber-login).

### N-02 (Low) — filter typing tidak di-scope ke `conversationId`

`server/src/network/realtimeHandlers.ts:514-537` menyaring target ke peer
**global**, bukan anggota percakapan yang disebut di payload. Penyerang yang
berbagi satu grup dengan korban masih bisa mengirim `typing` dengan
`conversationId` percakapan lain (korban mengabaikannya karena filter lokal,
jadi ini hanya noise — bukan kebocoran). Perbaikan sejalan dengan REG-2:
gunakan `filterConversationMembers(..., conversationId, ...)`.

### N-03 (Low) — gate F-02 tidak memeriksa `expiresAt`/`tokenEpoch`

`findMembership` (`server/src/utils/routingIdentity.ts:196-200`) hanya memeriksa
**keberadaan** baris. Baris anggota yang tokennya sudah kedaluwarsa tetapi belum
di-GC masih dianggap anggota untuk menulis baris SYSTEM
(`group:fulfilled_key`/`metadata:updated`). Dampak terbatas (anggota lama yang
sudah di-kick barisnya dihapus, `groups.ts:527`), tetapi konsisten dengan gate
lain: tambahkan `expiresAt: { gt: new Date() }` dan cocokkan `tokenEpoch` dengan
`conversation.groupEpoch`.

## Residual yang perlu keputusan produk

- **CSP `'unsafe-inline'` di `scriptSrc`** (`server/src/app.ts:100-124`): wildcard
  `*.cloudflare.com` sudah dibuang (F-10 beres), tetapi `'unsafe-inline'` tetap
  demi inline script di `index.html`. Selama itu ada, CSP bukan mitigasi XSS
  yang kuat; jalur yang benar adalah nonce/hash, bukan menambah wildcard kembali.
- **`userHiddenConversation` untuk pembuat percakapan**: lihat REG-2. Menulis
  baris untuk pembuat juga akan membuat presence per-kontak bekerja di grup yang
  ia buat (sekarang kosong), jadi perbaikan ini punya efek samping positif.
