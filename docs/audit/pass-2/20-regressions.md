# Pass 2 — Regresi yang diperkenalkan oleh perbaikan

Dua-duanya berpola sama: **gate di server benar secara logika, tetapi tidak
pernah bisa dipenuhi kontrak klien / data yang ada.** Tes baru lulus karena
memakai fake yang mengembalikan hasil yang "seharusnya", bukan bentuk data
produksi.

---

## REG-1 (High, keyakinan tinggi) — view-once tidak lagi terhapus & tidak ada receipt

**Perbaikan:** F-01 — `message:view_once_opened` sekarang butuh bukti sebelum
menghapus (`server/src/network/realtimeHandlers.ts:889-905`):

- pengirim: `openSenderId(msg.senderId) === userId` **atau** `deleteSecret` cocok;
- penerima: `targetRecipient === userId` **dan** ada baris `messageStatus`
  ber-tag per-percakapan.

**Kenyataan klien** (`web/src/components/Lightbox.tsx:38`):

```ts
transportClient.sendEvent('message:view_once_opened', {
  messageId: message.id,
  conversationId: message.conversationId,
  targetRecipient: message.senderId,   // ← id PENGIRIM, bukan id diri sendiri
});
```

Tidak ada `deleteSecret` di payload. Akibatnya, untuk penerima:

- `isSender` = false (bukan pengirim, tanpa `deleteSecret`);
- `isRecipient` = false karena `targetRecipient === userId` tidak pernah benar
  (nilainya id lawan bicara; di grup nilainya pseudonym);
- handler `return` di baris 903-905 **sebelum** `message:viewed` (918) dan
  **sebelum** `prisma.message.delete` (920).

**Dampak nyata**

1. Sifat "sekali lihat" hilang: baris pesan tetap ada sampai sweeper TTL
   (14 hari / `expiresAt`), jadi penerima bisa memuat ulang riwayat dan
   mendekripsi ulang isi yang seharusnya sudah dibuka.
2. Klien sudah menandai `isViewed: true` dan membuang berkas lokal
   (`Lightbox.tsx:33`), sehingga UI menyatakan "sudah dilihat" sementara server
   masih menyimpan salinan — dua sumber kebenaran yang saling bertentangan.
3. Pengirim tidak pernah menerima `message:viewed`, jadi indikator view-once
   macet.

**Kenapa tes tidak menangkap:** `server/tests/realtimeAuthorization.test.ts`
memanggil handler dengan `targetRecipient` = id diri sendiri dan baris
`messageStatus` palsu; bentuk payload klien tidak diuji.

**Perbaikan minimum (salah satu):**

- klien mengirim `targetRecipient: <user id sendiri>` (dan, bila tersedia,
  `deleteSecret: message.deleteSecret`), atau
- server menerima bukti alternatif yang tidak bergantung klien: baris
  keanggotaan penerima pada percakapan itu (lihat REG-2 — untuk 1:1 tidak ada),
  atau receipt `DELIVERED/READ` yang memang sudah ditulis server.
- tambahkan satu tes yang memakai bentuk payload `Lightbox.tsx` apa adanya.

---

## REG-2 (High, keyakinan tinggi) — typing & `session:fulfill_response` mati di 1:1 (dan untuk pembuat grup)

**Perbaikan:** F-05 & F-11 menyaring target lewat
`collectPresencePeers(userId)` (`server/src/network/realtimeHandlers.ts:530-537`
dan `608-615`).

**Cara `collectPresencePeers` bekerja** (`server/src/utils/presencePeers.ts:77-101`):

1. ambil `userHiddenConversation` yang `userId`-nya **saya** (baris keanggotaan
   milik saya) → kumpulan `conversationId`;
2. ambil baris lain di conversation itu → itulah peer.

**Kenyataan data:**

- Baris keanggotaan hanya ditulis untuk **peserta yang dikirimi delivery token
  dan bukan pembuat** (`server/src/routes/conversations.ts:238-244`;
  `upsertMembership` di `server/src/utils/routingIdentity.ts:101-137`).
  Pembuat percakapan **tidak pernah** mendapat baris.
- Percakapan 1:1 dibuat tanpa token sama sekali
  (`web/src/store/conversation.ts:578-584` hanya mengirim
  `{ userIds, isGroup: false }`), jadi **tidak ada satu pun baris keanggotaan**
  untuk percakapan itu.

Akibatnya:

| Kasus | `collectPresencePeers` | Efek |
|---|---|---|
| 1:1 A↔B | `[]` untuk kedua pihak (kecuali mereka juga berbagi grup) | `typing:start/stop` **tidak pernah diteruskan** |
| Grup dibuat A | A tidak punya baris → typing A tidak sampai ke anggota; anggota juga tidak melihat A sebagai peer | indikator "sedang mengetik" pembuat grup mati |
| `session:fulfill_response` di 1:1 | requester tidak ada di peer set → ditolak di baris 612-615 | pemulihan kunci sesi yang hilang **tidak pernah terjadi**; klien menunggu `waiting_for_key` tanpa error |

Yang kedua lebih berbahaya daripada spam yang hendak ditutup: kegagalan bersifat
hening (hanya `console.warn` di server, tidak ada event ke klien), dan ini satu-
satunya jalur `fulfillKeyRequest` untuk 1:1 (`web/src/lib/socketListeners.ts:489-501`
→ `emitSessionKeyFulfillment`, `web/src/lib/transportClient.ts:982-984`).

**Kenapa tes tidak menangkap:** fake `userHiddenConversation.findMany` di tes
mengembalikan baris "peer" secara langsung, sehingga langkah 1 (baris milik
saya) dan bentuk data 1:1 tidak pernah diuji.

**Perbaikan minimum:**

- gate harus **per percakapan**, bukan union global:
  `filterConversationMembers(prisma, conversationId, targetRecipients)` untuk
  grup; dan
- untuk 1:1 (tanpa roster), pakai bukti yang memang dimiliki server — baris
  `messageStatus` / `Message` terbaru antara kedua pihak — **atau** tulis baris
  keanggotaan untuk pembuat percakapan saat create/`startConversation`
  mengirim token. Opsi pertama lebih kecil dan tidak mengubah skema.
- tambahkan satu tes yang meniru 1:1 nyata: `findMany` pertama (baris milik
  saya) kosong → typing tetap harus sampai ke lawan bicara yang terverifikasi.

---

## Catatan: F-11 sendiri sudah benar untuk vektor spam

`session:fulfill_response` memang tidak lagi bisa menyemprot id sembarang.
Masalahnya hanya sumber bukti "peer" yang terlalu sempit (REG-2), bukan
logika gate-nya.
