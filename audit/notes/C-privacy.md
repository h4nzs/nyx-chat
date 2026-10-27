# C — Privasi metadata & privacy closure

Diperiksa: `server/prisma/schema.prisma`, `server/src/utils/{atRestSecrets,
routingIdentity,senderIdentity,groupMailbox,groupTokens,groupSync}.ts`,
`server/src/routes/{groups,conversations,messages}.ts`, `docs/28`, `docs/37`,
`server/tests/{schemaPrivacy,dumpAudit,routingIdentity,groupMailbox,
deliveryTokens,storyBlockPrivacy}.test.ts`.

## Yang terbukti benar

- **Token hanya sebagai hash.** `ConversationMember.tokenHash String @unique`
  (`schema.prisma:374`); token mentah tidak pernah persist, epoch + expiry
  ditegakkan di route **dan** `groupAccess`, rotasi memindahkan semua baris
  anggota dalam satu transaksi, perbandingan timing-safe
  (`credentialTokenMatches`).
- **`ENC2` key ring** (`sealedLookupCandidates`) dipakai untuk lookup yang harus
  tetap bisa dibaca setelah rotasi kunci; `sealAtRest` tunggal tidak dipakai
  untuk kolom baru. `ENC1:` tetap terbaca.
- **Mailbox** punya `kind` enum tertutup, payload ≤8 KB, ≤32 item/post, TTL 7
  hari, kursor komposit, GC di `jobs/cleanup.ts`.
- **Sync anonim**: route hanya memakai hash token (tanpa sesi/userId) —
  klaim C5 terbukti di kode.

## Temuan terkait

- **F-04** — `UserHiddenConversation.tokenHash` adalah kolom **wajib** baru tanpa
  jalur migrasi; `deploy.yml:238` menelan kegagalan `prisma db push`
  (`|| true`), jadi deploy hijau dengan skema lama.
- **F-10** — `/api/groups/sync` mengirim seluruh `encryptedMetadata` untuk
  hingga 500 token tanpa batas byte/item, padahal `docs/37` §37.3.3 menjanjikan
  ≤256 KB / ≤200 item. Endpoint tanpa sesi → amplifikasi.
- **F-02** — morgan `dev` mencatat URL penuh (`?q=<hash>`, `?token=…`) karena
  `NODE_ENV` tidak pernah `production`; ini membatalkan klaim C18.
- **D3 (pengamatan)** — tag mailbox `HMAC(memberToken)` bisa dihitung server
  saat pull; tidak membentuk graf requester→fulfiller, tetapi melemahkan klaim
  "server tidak bisa mengaitkan item ke penerima" untuk item yang sedang dipull.
- **C3** — "server tidak bisa merekonstruksi graf sosial" **terbantah untuk
  server hidup** (inviter mengirim `userIds`; `upsertMembership` menyimpan
  routing identity yang bisa dibuka server), tetap terbukti untuk dump DB.

## Batas

Tidak menjalankan `privacy-dump-audit.ts` terhadap DB nyata; `schemaPrivacy`/
`dumpAudit` adalah test statis/in-memory. Tidak mengukur kebocoran lewat
ukuran/waktu respons secara empiris.
