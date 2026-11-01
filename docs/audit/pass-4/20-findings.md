# Pass 4 — Temuan baru

Temuan pass 1–3 tidak diulang; lihat `10-delta.md` §A–B. Semua temuan di bawah
berasal dari kode yang dibaca pada pass ini dan diberi `berkas:baris`.

---

## N4-01 (Medium, keyakinan tinggi) — anchor `issuedByServer` dicetak lewat jalur tanpa validasi

**Ringkas.** Pass 3 menutup pencetakan keanggotaan lewat endpoint ratchet, lalu
memperkenalkan anchor baru: baris `SessionKey` bertanda `issuedByServer: true`
yang ditulis **server** saat percakapan dibuat. Endpoint ratchet kini ketat,
tetapi endpoint pembuatan — satu-satunya yang boleh menulis anchor itu — **tidak
memvalidasi `deviceId` sama sekali**. Anchor yang lebih kuat dijaga oleh jalur
yang lebih lemah.

**Bukti.**

```ts
// server/src/routes/conversations.ts:199-226  (dalam transaksi pembuatan)
const { sessionId, initialKeysPerDevice, initiatorCiphertextsPerDevice } = initialSession;
const keyRecords = [];
for (const deviceId in initialKeysPerDevice) {          // ← deviceId dari klien
  const encryptedKey = initialKeysPerDevice[deviceId];
  if (typeof encryptedKey !== 'string') continue;
  keyRecords.push({
    conversationId: convo.id,
    deviceId,                                          // ← tanpa cek pemilik/peserta
    sessionId,
    encryptedKey: Buffer.from(encryptedKey, 'base64'), // ← tanpa cek ukuran/bentuk
    initiatorCiphertexts: …,
    issuedByServer: true                               // ← anchor bukti peserta
  });
}
```

```ts
// server/src/utils/conversationSchemas.ts:47-53
export const initialSessionSchema = z.object({
  sessionId: z.string(),
  initialKeysPerDevice: z.record(z.string(), z.string()),      // tanpa cap jumlah,
  initiatorCiphertextsPerDevice: z.record(z.string(), z.string()), // tanpa regex, tanpa max
})
```

Bandingkan dengan guard yang baru ditulis untuk endpoint ratchet
(`sessionKeyRelayGuard.ts:70-105`: cap **500** kunci, `deviceId` ≤128,
`encryptedKey` base64url ≤**8 KB**, duplikat digabung) dan dengan pemeriksaan
perangkat di sana (`:196-219`: perangkat harus nyata **dan sudah terdaftar**).
Tidak satu pun aturan itu ada di jalur pembuatan.

**Skenario.** Pengguna terautentikasi (verifikasi sandbox hanya membatasi jumlah
chat per hari, bukan ukuran payload) mengirim:

```json
POST /api/conversations
{ "userIds": ["<dirinya>"],
  "initialSession": { "sessionId": "x",
    "initialKeysPerDevice": { "<deviceId korban>": "AAAA…" },
    "initiatorCiphertextsPerDevice": {} } }
```

- `allUserIds` = dirinya → tidak ada `conversation:new` ke korban
  (`conversations.ts:238`), tidak ada baris keanggotaan (token hanya untuk
  `userIds` yang diberi `deliveryTokens`), **tidak ada notifikasi apa pun**.
- Baris `SessionKey(conversation, device korban, issuedByServer: true)` tetap
  ditulis, karena FK hanya mensyaratkan `Device.id` ada — dan `deviceId` korban
  tersedia publik lewat prekey bundle.
- Efek berantai, semuanya memakai bukti yang sama:
  | Jalur | Akibat |
  |---|---|
  | `presencePeers.ts:88-140` | `mySessions` (sessionKey milik perangkat) dan `sessionPeers` (sessionKey percakapan itu) membuat **penyerang dan korban saling muncul sebagai peer presence** — tanpa pernah berbagi percakapan yang disetujui korban. |
  | `conversationParticipants.ts:93-100` | Korban dianggap peserta percakapan itu → `typing` dari penyerang lolos filter dan terkirim ke korban. |
  | `sessionKeyRelayGuard.ts:120-134` | Korban menjadi "peserta terbukti" lewat `issuedByServer`, sehingga penyerang boleh menulis baris ratchet untuk perangkat korban di percakapan itu. |
  | `viewOnceRecipients.ts:78-95` | Daftar penerima view-once untuk percakapan itu bisa mencakup korban (bila penyerang mengirim pesan ke sana). |

- Tanpa cap, satu request juga bisa menulis puluhan ribu baris (body 1 MB,
  `app.ts:271`) dalam satu transaksi — pembengkakan DB/`SessionKey` yang tidak
  pernah dibersihkan kecuali oleh sweeper `expiresAt` (kolom itu NULL di jalur
  ini).

**Kenapa tes tidak menangkap.** `sessionKeyRelayGuard.test.ts` menguji endpoint
ratchet; `conversationCreateSchema.test.ts` mengunci key yang selamat dari zod,
bukan nilainya. Tidak ada tes yang mengirim `deviceId` milik pengguna lain ke
`POST /api/conversations`.

**Perbaikan minimum.** Pakai ulang validator guard untuk jalur ini:

1. cap jumlah kunci (500) dan panjang `deviceId`/`encryptedKey` (base64url, 8 KB);
2. `deviceId` harus milik `userIds` **atau** pemanggil — satu query
   `device.findMany({ id: { in } , select: { id, userId } })` lalu tolak
   perangkat yang pemiliknya tidak ada di `allUserIds`;
3. tolak bila tidak ada satu pun perangkat sah (jangan menulis baris kosong).

**Test yang menangkapnya.** `POST /api/conversations` dengan
`initialKeysPerDevice` berisi `deviceId` milik user ketiga → **400/403**, dan
tidak ada baris `SessionKey` yang ditulis; lalu `collectPresencePeers(korban)`
tidak memuat penyerang.

**Catatan.** Ini tidak membatalkan REG-1/REG-2/N3-01: mekanismenya benar, hanya
sumber anchor-nya perlu validasi yang sama.

---

## N4-02 (Low, keyakinan tinggi) — "ratchet hidup lagi" belum benar; anchor hanya membuktikan penerima

**Bukti 1 — tidak ada pemanggil.**

```
$ grep -rn "ensureAndRatchetSession" web/src server/src
web/src/utils/crypto.ts:1042:export async function ensureAndRatchetSession(...)
```

Tidak ada satu pun pemanggil di klien (bukan store, bukan `messagePipeline`,
bukan UI). `CHANGELOG.md` (bagian 2026-11-01) menulis "`ensureAndRatchetSession`
hidup lagi memakai penyegel yang sama", dan `docs/audit/pass-3/40-fixes.md`
menyebut "endpoint ratchet dipakai lagi lewat jalur yang sah". Yang benar:
endpoint-nya **aman** dan **bisa** dipakai, tetapi belum dipakai.

**Bukti 2 — anchor membuktikan penerima, bukan pembuat.** Penyegel melewati
perangkat pemanggil sendiri:

```ts
// web/src/utils/crypto.ts:975-977
if (uId === myId && bundle.identityKey === myIdentityKeyB64) continue;
```

dan jalur pembuatan hanya mengirim `userIds` peer:

```ts
// web/src/store/conversation.ts:592
const built = await buildInitialSessionForConversation([peerId]);
```

Akibatnya, untuk 1:1 yang baru dibuat: **peer punya** baris `issuedByServer`
(bukti sah), sedangkan **pembuat tidak punya** baris apa pun — tidak ada
keanggotaan bertoken untuk 1:1, dan receipt baru ada setelah penerima menandai
sudah dibaca. Bila `ensureAndRatchetSession` dipanggil hari ini, pencipta chat
akan menerima `403 SESSION_KEY_NOT_PARTICIPANT` dari guard-nya sendiri
(`sessionKeyRelayGuard.ts:157-161`), sementara pihak yang diundang lolos.

**Dampak.** Tidak ada pada runtime sekarang (fungsi tidak dipanggil), tetapi:
klaim CHANGELOG menyesatkan, dan siapa pun yang menghidupkan fungsi itu akan
menemukan kegagalan yang tampak seperti bug jaringan.

**Perbaikan.** Pilih satu: (a) hapus fungsi + klaimnya, atau (b) sertakan
perangkat pembuat (dan perangkat lain miliknya) dalam `userIds` saat sealing,
supaya baris `issuedByServer` juga ada untuk pembuat — perlu keputusan karena
menyegel ke perangkat sendiri berarti server menyimpan kunci untuk perangkat
pengirim.

---

## N4-03 (Low, keyakinan tinggi) — batas 32 KB hanya di jalur bidi; uni membaca tanpa cap

**Bukti.**

```rust
// server/transport-sidecar/src/main.rs:697-720  (bidi: cap SEBELUM alokasi)
let header_kind = classify_inbound(op_code, length, MAX_BIDI_PAYLOAD_BYTES);
match header_kind {
    InboundHeader::TooLarge => { metrics_stream.rejected(RejectReason::TooLarge); return; }
    ...
}
let mut payload = vec![0u8; length];
```

```rust
// server/transport-sidecar/src/main.rs:795-806  (uni: baca SEMUA dulu)
let mut buffer = Vec::new();
let mut chunk = [0u8; 4096];
while let Ok(Some(n)) = stream.read(&mut chunk).await {
    buffer.extend_from_slice(&chunk[..n]);
}
// server/transport-sidecar/src/main.rs:866
match parse_inbound_frame(&buffer, usize::MAX) {   // ← tanpa batas
```

`ServerConfig` tidak menyetel batas transport sama sekali:

```rust
// server/transport-sidecar/src/main.rs:229-232
let config = ServerConfig::builder()
    .with_bind_address(bind_addr)
    .with_identity(identity)
    .build();
```

**Mengapa ini nyata, bukan teoretis.**

- Klien **memang** memakai uni stream (`web/src/workers/transport.worker.ts:76-84`,
  `createUnidirectionalStream` + frame 5-byte header), jadi jalur ini hidup.
- Payload >32 KB pada jalur uni **diteruskan** ke `nyx:upstream:<opcode>` sebagai
  base64 (+33% ukuran) — melanggar kontrak "batas keras 32 KB" yang
  didokumentasikan di `protocol.rs:56` dan diuji hanya untuk bidi
  (`classify_orders_chaff_before_size_and_hello`).
- Memori: satu klien terautentikasi dapat membuka banyak stream uni dan menahan
  `Vec` per stream sampai stream ditutup; sidecar adalah proses tunggal yang
  melayani **semua** pengguna, dan VPS-nya 8 GB (docs/26 §26.9).

**Perbaikan minimum.** Pada jalur uni, baca maksimum
`FRAME_HEADER_BYTES + MAX_BIDI_PAYLOAD_BYTES` byte; bila stream masih
mengirim setelah itu, tandai `TooLarge` dan berhenti membaca (jangan
`extend_from_slice` tanpa batas). Alternatif setara: `.take(limit)` pada stream.

---

## N4-04 (Info) — tiket URL "setengah" diperlakukan seperti tanpa tiket

```rust
// server/transport-sidecar/src/main.rs:554-560
let (user_id, device_id, auth_method) = if let (Some(uid), Some(did)) =
    (ticket_user_id, ticket_device_id)
{ … } else {
    // fallback ke stream auth bidi
```

Tiket yang valid tetapi tanpa klaim `deviceId` (atau sebaliknya) tidak dipakai;
klien lalu harus melakukan auth bidi. Ini fail-closed dan bukan bug, tetapi
perilakunya tidak terdokumentasi: operator yang menerbitkan tiket tanpa
`deviceId` akan melihat semua koneksi memakai jalur BWH, bukan jalur tiket.
