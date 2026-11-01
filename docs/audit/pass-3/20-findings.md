# Pass 3 — Temuan baru

Temuan pass 1 dan pass 2 tidak diulang; lihat `10-delta.md` §A–B.
Semua temuan di bawah berasal dari kode yang dibaca pada pass ini dan diberi
`berkas:baris`.

---

## N3-01 (Medium, keyakinan tinggi) — bukti "peserta percakapan" dapat ditulis klien

**Ringkas.** Perbaikan pass 2 mengganti "deklarasi klien" dengan tiga bukti
server: baris keanggotaan, receipt bertag, dan **baris `SessionKey`**.
Dua yang pertama tidak bisa ditulis tanpa hak. Yang ketiga bisa.

**Bukti.**

```ts
// server/src/routes/sessionKeys.ts:46-66
const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } })
if (!conversation) throw new ApiError(404, 'Conversation not found')
await relaySessionKeys(conversationId, sessionId, keys)   // ← tanpa cek keanggotaan
```

```ts
// server/src/utils/sessionKeys.ts:36-48
const keyRecords = keys.map(k => ({
  conversationId, sessionId,
  deviceId: k.deviceId,          // ← deviceId sembarang, tidak dicek milik siapa
  encryptedKey: Buffer.from(k.encryptedKey, 'base64url'),
  ...
}))
await db.sessionKey.createMany({ data: keyRecords })
```

`router.use(requireAuth)` hanya memastikan **ada sesi**; tidak ada pemeriksaan
bahwa pemanggil anggota percakapan itu, pembuatnya, atau pemilik `k.deviceId`.
Bandingkan dengan `GET /:conversationId/devices/:deviceId` tepat di atasnya yang
memang memverifikasi `device.userId === req.user.id` (`sessionKeys.ts:13-20`).

**Karena itu** `isConversationParticipant()` (`conversationParticipants.ts:78-104`)
memberi `true` untuk siapa pun yang sudah menulis satu baris `SessionKey` pada
percakapan itu, dan gate berikut menjadi bisa dilewati:

| Gate | Efek bila keanggotaan dipalsukan |
|---|---|
| `message:view_once_opened` (`realtimeHandlers.ts:946-957`) | `isRecipient = true`; di 1:1 baris pesan **dihapus untuk kedua pihak** (`:986-989`) → view-once orang lain hilang sebelum dibaca (denial/penghapusan data). Butuh `messageId` yang benar. |
| `typing` fan-out (`:555-570`) | Bisa mengirim indikator "mengetik" berisi `userId` pengirim ke id mana pun di percakapan itu. |
| `session:fulfill_response` (`:640-647`) | Fulfiller lolos; relay hanya ke `requesterId` yang juga harus peserta → dampak terbatas. |
| `collectPresencePeers` (`presencePeers.ts:112-119`) | Menulis baris `SessionKey` dengan `deviceId` **milik korban** membuat korban masuk daftar peer penyerang (dan sebaliknya) → penyerang dapat `presence:subscribe` ke status online korban tanpa pernah berbagi percakapan. Butuh `deviceId` korban (tersedia di bundle publik). |

**Kenapa tes tidak menangkap.** `conversationParticipants.test.ts` mem-*fake*
`sessionKey.findFirst` sebagai "bukti yang sudah ada"; tidak ada tes yang
memeriksa apakah klien boleh **menulis** baris itu. Pola yang sama dengan pass 2:
gate benar, sumber bukti tidak diperiksa kepemilikannya.

**Perbaikan minimum.** Di `POST /:conversationId/ratchet`:

1. tolak bila pemanggil bukan peserta (`isConversationParticipant`) dan bukan
   pembuat dalam jendela bootstrap — atau, lebih sederhana dan konsisten dengan
   `groupAccess.ts`: wajibkan bukti yang sama dengan `/api/groups/*`;
2. tolak `deviceId` yang bukan perangkat pemanggil **kecuali** ia peserta dan
   perangkat itu milik peserta lain yang sudah terbukti;
3. batasi `keys.length` (saat ini tak terbatas).

**Test yang menangkapnya.** Satu tes: user C (bukan peserta) `POST
/api/session-keys/<conv A-B>/ratchet` → 403; lalu `message:view_once_opened` di
conv itu → ditolak.

**Catatan penting.** Menutup N3-01 **tidak** membatalkan perbaikan REG-1/REG-2:
kedua jalur itu memakai bukti yang sama, hanya saja bukti itu menjadi Layak
dipercaya setelah endpoint di atas dijaga.

---

## N3-02 (Low, keyakinan tinggi) — OTPK tidak dikonsumsi pada jalur regenerate

```ts
// web/src/utils/crypto.ts:3237-3252
if (otpkId !== undefined) {
  try {
    const { worker_x3dh_v2_recipient_regenerate } = await getWorkerProxy()
    return await worker_x3dh_v2_recipient_regenerate({ ... })   // ← return lebih awal
  } catch (e) { console.error('[X3DH v2] Gagal regenerate OTPK:', otpkId, e) }
}
...
if (otpkId !== undefined) {
  await deleteOneTimePreKey(otpkId)    // ← hanya tercapai di jalur non-regenerate
}
```

Jalur normal menghapus prekey lokal setelah derivasi berhasil; jalur
regenerate — yang justru dipakai setiap kali `otpkId` ada — tidak pernah
mencapainya. Akibatnya `db.preKeys` menyimpan baris yang sudah dikonsumsi server
(`DELETE ... RETURNING` di `keys.ts:406-416`), dan handshake yang sama dapat
diderivasi ulang kapan pun payload-nya diputar kembali.

Dampak terbatas karena OTPK PQ **memang bisa diregenerasi dari `masterSeed`
(lihat N3-03)** dan `messagePipeline.ts:347-350` tidak memproses ulang X3DH bila
state ratchet sudah ada. Tetap cacat: akuntansi "sekali pakai" tidak tercermin di
penyimpanan, dan perilakunya berbeda dari jalur normal tanpa alasan.

**Perbaikan.** Pindahkan `deleteOneTimePreKey(otpkId)` ke `finally` (atau panggil
sebelum `return`).

---

## N3-03 (Info/Low, keyakinan tinggi) — OTPK deterministik & endian-dependent

```ts
// web/src/workers/crypto.worker.ts:1536-1551 (pembuatan)
const idBytes = new Uint8Array(new Uint32Array([keyId]).buffer)   // host-endian
seedInput.set(new TextEncoder().encode("OTPK"), masterSeedBytes.length)
...
pqSeedInput.set(new TextEncoder().encode("pq-otpk"), masterSeedBytes.length)
pqSeedInput.set(idBytes, masterSeedBytes.length + 7)
```

OTPK (klasik maupun PQ) tidak acak: seluruhnya turunan `masterSeed` + `keyId`.
Saya membandingkan pembuatan (`:1536-1551`) dengan regenerasi
(`:981-987`) dan **keduanya konsisten** — jadi ini bukan bug fungsional.

Yang perlu dicatat sebagai konsekuensi, bukan bug:

1. "one-time prekey" tidak memberi properti pasca-kompromi di luar `masterSeed`:
   siapa pun yang memegang seed dapat menurunkan ulang seluruh OTPK. Ini
   konsisten dengan desain NYX (identity key juga turunan seed), tetapi berarti
   klaim forward secrecy X3DH bergantung penuh pada kerahasiaan seed + kunci
   sesi di memori.
2. `new Uint32Array([keyId]).buffer` mengikuti endianness host. Seluruh target
   praktis little-endian, tetapi vault yang diekspor dari platform big-endian
   tidak akan meregenerasi OTPK yang sama — kegagalan handshake tanpa pesan yang
   jelas. Pakai `DataView.setUint32(0, keyId, true)` bila ingin deterministik
   lintas platform.

---

## N3-04 (UNVERIFIED) — `pqSignature` bundle tidak dipakai; apakah KT ditegakkan?

`establishSessionFromPreKeyBundle` mewajibkan `signedPreKey.pqSignature` **ada**
(`crypto.ts:3136-3138`) tetapi tidak pernah memverifikasinya; komentar
`:3176-3179` menyatakan "autentikasi signed prekey v2 ada di dalam ML-DSA
handshake". Itu benar untuk handshake: transkrip mengikat `ctSpk` dan
`signingKeyV2` inisiator, dan KEM ke `pqIdentityKey` mengikat identitas penerima
— sehingga penukaran SPK saja tidak menghasilkan shared secret.

Yang **belum saya buktikan**: apakah `fetchPreKeyBundle` menolak bundle yang
`signingKeyV2`-nya tidak cocok dengan log KT. Bila hanya memperingatkan (jalur
`observePeerIdentityKey` mengembalikan `changed` → `console.warn` + toast, bukan
penolakan, `crypto.ts:3151-3154`), maka pada **kontak pertama** — saat pin belum
ada — server yang jahat dapat menyajikan bundle pengganti dan membaca plaintext
pesan pertama tanpa peringatan.

**Yang akan memastikan:** baca `fetchPreKeyBundle` → apakah ia memanggil
`verifyKtBundle` dan apakah hasil `unavailable`/`unverifiable` menghentikan
handshake; lalu satu tes end-to-end dengan bundle yang `signingKeyV2`-nya
berbeda dari log.
