# Pass 2 — Perbaikan yang diimplementasikan

Tanggal: 2026-11-01. Basis: `73a5d656` + laporan `20-regressions.md` /
`30-authz-sweep.md`. Tidak ada commit di sini; semua perubahan ada di worktree.

## Ringkasan

Dua regresi High (REG-1, REG-2) ditutup **tanpa perubahan kontrak klien** —
sumber bukti dipindahkan ke data yang memang dipegang server per percakapan —
dan dua temuan Low (N-02, N-03) ikut tertutup. N-01 ternyata **sudah tertutup**
oleh `router.use(requireAuth)` di `routes/users.ts` (temuan pass 2 keliru);
guard eksplisit ditambahkan sebagai jaring.

| ID | Tindakan | Berkas |
|---|---|---|
| REG-1 | Penerima `message:view_once_opened` diverifikasi dengan bukti peserta **per percakapan** (keanggotaan / receipt / session key), bukan `targetRecipient === userId`. Event dibatasi ke baris `isViewOnce` (sebelumnya peserta mana pun bisa menghapus pesan biasa). Notifikasi `message:viewed` memakai `senderId` ter-seal atau `targetRecipient`, tetapi hanya bila orang itu peserta percakapan. | `server/src/network/realtimeHandlers.ts`, `server/src/utils/conversationParticipants.ts` |
| REG-2 | `typing` dan `session:fulfill_response` memakai bukti per `conversationId` payload, bukan union peer global (`collectPresencePeers`) yang kosong di 1:1 dan untuk pembuat grup. | `server/src/network/realtimeHandlers.ts`, util baru `conversationParticipants.ts` |
| N-01 | Sudah ditutup `router.use(requireAuth)` (baris 43). Guard `if (!req.user)` eksplisit ditambahkan di `GET /:id` sebagai jaring bila rute dipindah. | `server/src/routes/users.ts` |
| N-02 | Filter typing kini ter-scope ke `conversationId` (bukan peer global). | sama dengan REG-2 |
| N-03 | Gate tulis SYSTEM memakai `findMembership(..., { requireFresh: true, groupEpoch })`: epoch harus sama dan expiry belum lewat grace (`evaluateMemberToken`), konsisten dengan `/api/groups/*`. Pembacaan "baris ada" (leave) tetap mode lama supaya anggota bertoken basi masih bisa keluar. | `server/src/utils/routingIdentity.ts`, `server/src/utils/groupRealtimeAuth.ts` |

## Bukti apa yang dipakai (dan mengapa bukan deklarasi klien)

`utils/conversationParticipants.ts` menerima tiga bukti, semuanya ter-scope ke
`conversationId`:

1. baris `UserHiddenConversation` (userId ter-seal) — anggota grup era
   token-first dan penerima pesan grup yang membawa delivery token;
2. `MessageStatus` dengan `userId = conversationScopedTag(conversationId, user)`
   — tag opaque turunan server, dicek lewat relasi `message: { conversationId }`
   (server bisa memeriksa tanpa menyimpan userId);
3. `SessionKey` milik perangkat user pada percakapan itu
   (`device: { userId }`) — ini yang membuat pemulihan kunci 1:1 bekerja walau
   penerima belum pernah mengirim receipt.

Target yang sudah dikenali lewat baris keanggotaan tidak terkena batas; sisanya
diperiksa per-kandidat maksimum `MAX_PARTICIPANT_FALLBACK_CHECKS = 8`.

## Test

Baru / diperbarui:

- `server/tests/conversationParticipants.test.ts` (baru, 8 kasus): tiap sumber
  bukti, fail-closed, scoping percakapan, dedupe/validasi input, batas fallback.
- `server/tests/realtimeAuthorization.test.ts`: payload `Lightbox.tsx` apa
  adanya (REG-1) → pesan terhapus + `message:viewed` terkirim; bukti session
  key; pesan non view-once tidak bisa dihapus; typing 1:1 tanpa baris
  keanggotaan tetap sampai (REG-2); `fulfill_response` 1:1 direlay.
- `server/tests/groupRealtimeAuth.test.ts`: fake kini mengembalikan
  `tokenEpoch`/`expiresAt`/`groupEpoch` seperti baris nyata; dua kasus N-03
  (kedaluwarsa melewati grace, epoch tidak cocok) ditolak.

## Residual — ditutup 2026-11-01

| Residual | Tindakan | Berkas |
|---|---|---|
| **F-12** variabel mati jalur kripto | `ciphertext` (bayangan variabel X3DH), `getSodiumLib`, `useAuthStore` (blok `PROTOCOL_RESET`), `captureAndLog`, dan `catch (e)` tanpa body dibuang/disamarkan. `oxlint web/src/lib/messagePipeline.ts` → 0 warning. | `web/src/lib/messagePipeline.ts` |
| **F-13** advisory dependensi | `pnpm audit --prod` → **No known vulnerabilities found**. | — |
| **View-once di grup** | Tabel baru `MessageViewOnceOpen` mencatat pembukaan **per penerima** dengan `conversationScopedTag(conversationId, userId)` (bukan userId). Untuk percakapan grup baris pesan **tidak lagi dihapus** oleh pembuka pertama; jalur baca mengembalikan `content: null` hanya bagi yang sudah membuka. 1:1 tetap menghapus baris. **[Tindak lanjut 2026-11-01]** Residual "semua sudah membuka tidak bisa dihitung" ditutup: `MessageViewOnceRecipient` menyimpan tujuan pesan (`recipientTag` = `conversationScopedTag`, hanya id yang lolos bukti peserta server, minus pengirim) dan `message:view_once_opened` menghapus baris pada pembukaan **terakhir** — bukan menunggu `expiresAt`. 1:1 tidak berubah; pesan lama tanpa daftar penerima tetap TTL-only. | `server/prisma/schema.prisma`, `server/src/utils/viewOnceRecipients.ts`, `server/src/network/realtimeHandlers.ts`, `server/src/routes/messages.ts`, `server/tests/realtimeAuthorization.test.ts`, `server/tests/viewOnceRecipients.test.ts` |
| **Presence 1:1 / pembuat grup** | Peer diturunkan dari **dua** sumber: baris keanggotaan (dipakai) dan `SessionKey` perangkat (baru). Percakapan 1:1 dan grup buatan sendiri punya session key untuk semua perangkat peserta, jadi presence-nya hidup **tanpa menulis baris keanggotaan baru** (graf dump tidak bertambah). | `server/src/utils/presencePeers.ts`, `server/tests/presencePeers.test.ts` |
| **CSP `'unsafe-inline'` (F-10)** | `'unsafe-inline'` dibuang dari `script-src` di `app.ts` **dan** nginx sudah tidak memuatnya; wildcard `https://*.cloudflare.com` juga dibuang dari `$app_csp`. Prasyaratnya diperiksa tes: `web/index.html` tidak punya `<script>` inline (PWA memakai `registerSW.js` eksternal). `style-src` tetap `'unsafe-inline'` untuk blok loader. | `server/src/app.ts`, `ops/nginx/nyx.conf`, `docs/03`, `README.md`, `server/tests/cspPolicy.test.ts` |
| **F-11 (klien)** | Diverifikasi: `storeReceivedSessionKey` **tidak** memasang kunci buta. Jalur `SESSION_KEY` hanya menerima payload X3DH v2, menurunkan kunci dengan `deriveSessionKeyAsRecipient`, dan (handshake v2) mencocokkan `initiatorSigningKeyV2` dengan bundle peer (KT). Kegagalan derivasi `return` sebelum `storeSessionKeySecurely`. Ditambah penguatan server: **fulfiller** `session:fulfill_response` kini juga harus peserta percakapan (sebelumnya hanya requester). | `web/src/utils/crypto.ts`, `server/src/network/realtimeHandlers.ts` |
| **U-01 csrf tidak tersedia** | Mutasi tidak lagi dikirim tanpa token: satu percobaan ulang, lalu berhenti dengan kode `CSRF_UNAVAILABLE` → `api_csrf_unavailable` (4 bahasa) berbunyi "tidak ada yang terkirim". | `web/src/lib/api.ts`, `web/src/lib/apiErrorText.ts`, 4 locale `errors.json` |

### Residual yang memang tersisa (bukan utang gate)

- **View-once grup, batas jujur:** skema tidak menyimpan daftar penerima per
  pesan, jadi server tidak bisa menghitung "semua sudah membuka". Baris bertahan
  sampai `expiresAt`/unsend, dan isinya hanya dikosongkan bagi yang sudah
  membuka. Mitigasi penuh butuh target per-pesan di protokol.
- **F-12 sisa `no-unused-vars` global** (236 warning) tidak dikejar: AGENTS
  melarang menaikkan rule ke `error` sebelum angkanya 0, dan ini kosmetik.
