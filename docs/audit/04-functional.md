# 04 — Kebenaran Fungsional & Robustness

Fokus: jalur yang saya lacak sendiri dari kode. Yang tidak saya jalankan ditandai.

## 4.1 Kirim pesan (1:1)

Alur nyata yang terbaca: `store/message.ts` → `transportClient.sendEvent('message:send')` (`:1491`) → sidecar → `nyx:upstream:1` → `handleUpstreamMessage` → `handleChatMessage`.

- **Idempotensi retry** ada dan benar bentuknya: `reserveMessageSlot` memakai `SET NX` atomik + TTL 24 jam, duplikat mengembalikan ACK `ok:true` dengan pesan **yang sudah ada** (`realtimeHandlers.ts:170-215`). Ini menutup bug duplikat saat ACK hilang.
- **Batas penerima** dicek **sebelum** insert (`:250-260`) dengan `maxRecipientsFor` (guest lebih kecil) — paritas dengan jalur REST.
- **TTL**: jalur WT menghitung `ttlMs` dari `expiresAt` klien dan default 14 hari; komentar menyebut bug lama "pesan tanpa TTL persisten selamanya" sudah ditutup. Konsisten dengan jalur REST.
- **Seq**: `reserveMessageSeq` + `create` dalam **satu** transaksi; kegagalan tidak menulis seq 0. Baik.
- **Catatan:** `sendPushNotification` dijalankan untuk setiap target, dan `upsertMembership` di-`catch` sendiri — kegagalan membership tidak menggagalkan pengiriman (benar untuk UX, tapi berarti discovery bisa diam-diam gagal; ada log).

## 4.2 Terima pesan

- Lock per-percakapan + dedup by id (docs/05 §5.5). `addIncomingMessage` menerima event live dan sinkron REST.
- **Temuan fungsional F-07** (paginasi `seq: 0`) berdampak di sini: klien yang offline lama di grup berisi baris legacy berhenti sebelum riwayat habis.
- **`waiting_for_key`** untuk pesan sendiri yang gagal dekripsi — sesuai docs, bukan bubble error.

## 4.3 Offline

- Dokumen (docs/05 §5.1) menyatakan pesan masuk `offlineQueueDb` dan di-flush saat `connect`. Kode cocok (`message.ts:1401-1620`, `offlineQueueBusy`/`offlineQueueRerunNeeded` mencegah dua flush bersamaan).
- **Drift:** docs/05 §5.4 menyiratkan ada fallback REST saat transport mati. Tidak ada: klien tidak pernah `POST /api/messages` (hanya GET/DELETE). Jadi saat transport mati, pesan **hanya** menunggu reconnect; tidak ada jalur HTTP kedua. Ini perlu diperbaiki di dokumen, atau rute REST perlu disambungkan (dan diperbaiki dulu — F-03).

## 4.4 Unsun / delete

- Klien membuat `deleteSecret` 64 hex saat mengirim (`message.ts:804`), menyimpannya lokal (`:890`) dan mengirimnya (`:1205`), lalu memakai `X-Delete-Token` pada DELETE (`:578-580`) dan pada event `message:unsend` (`MessageItem.tsx:229`). Server menyimpannya sebagai hash dan memverifikasi timing-safe. **Jalur WT konsisten.**
- **F-03**: jalur REST tidak konsisten (tidak menyimpan apa pun).
- **F-01**: `message:view_once_opened` tidak memakai skema otorisasi yang sama.

## 4.5 Grup

- Token-first: `/api/groups/sync`, refresh, leave memakai possession token; rotasi epoch menaikkan `groupEpoch` dan mengganti `authSecret` (hash). Gate order token → admin → jumlah anggota dikunci di `tests/groupAccess.test.ts` (klaim AGENTS; tidak saya jalankan ulang test-nya secara terpisah — suite server lulus penuh).
- **F-02** adalah celah paralel: jalur *realtime* `group:fulfilled_key`/`metadata:updated` tidak melewati gate token yang sama.
- Rate limit per-token (`hashGroupToken(token)`), bukan per IP — sesuai desain anonim. `MAX_SYNC_TOKENS` membatasi jumlah token.

## 4.6 Attachment

- Presign → unggah blob terenkripsi → key di dalam pesan. Ukuran dikunci server dan ikut ditandatangani. `fileType` wajib `application/octet-stream`. `POST /presigned` mensyaratkan `isVerified`.
- **F-06**: TTL URL/retensi tidak dibatasi.
- Tidak ada pembersihan blob yatim di kode; README secara eksplisit menyuruh operator memasang lifecycle rule R2 (dokumentasi jujur, bukan bug).

## 4.7 Burner

- `burner:join/send/reply/destroy` punya rate limit, cek `burner:terminated:*`, self-heal membership, dan ACK eksplisit untuk room terminated. Ini menutup "tombol kirim diam" yang disebut komentar.
- **Catatan:** `burner:send` menerima `hostUserId` dari klien dan meneruskannya ke `sendJsonToUser(hostUserId, …)` — user mana pun dapat mengirim `burner:receive` ke id sembarang (spam terbatas rate limit). Tidak saya naikkan jadi temuan terpisah karena dampaknya sama dengan F-05 (spam event) dan room id acak.

## 4.8 Dedup & konkurensi lain

- Transaksi `reserveMessageSeq` + `create` menghindari lubang seq.
- Dedup cache `activeDeviceCache` bisa menyimpan keadaan `null` (lihat F-04) — ini juga efek fungsional: setelah Redis pulih, jawaban salah bertahan ≤60 detik.
- `applyGroupReleaseJitter` dijalankan setelah ACK, hanya menunda relay — tidak menahan pengirim.

## 4.9 Jalur kegagalan yang saya nilai sehat

| Skenario | Perilaku terbaca |
|---|---|
| Worker crash/timeout | `crypto-worker-proxy` punya timeout 120s/600s/300s; menolak, bukan menggantung. |
| Vault terkunci saat menulis | `encryptValueAtRest` **throw** dan caller wajib skip write (fail-closed, docs/04 §4.8) — kolom jadi absen, bukan plaintext. |
| Redis mati | rate limit fail-open (disengaja, terdokumentasi); **tapi** single-device juga fail-open (F-04). |
| CSRF token gagal diambil | `getCsrfToken` mengembalikan `""`; mutasi tetap dikirim tanpa header → 403 dengan pesan yang membingungkan (UX, lihat 05). |
| Klien terlalu tua | 426 + layar penuh (`ClientVersionRequiredPage`), bukan toast. |

## 4.10 Yang tidak bisa saya pastikan secara statis

- Pemulihan DRAT setelah `PROTOCOL_RESET`, out-of-order > kapasitas `skippedKeys`, dan desync setelah crash di tengah persist state (butuh runtime dua klien).
- Perilaku nyata SPQR v2/rollback (butuh sidecar + Chrome + dua tab).
- WebAuthn PRF di perangkat nyata, PWA offline, dan migrasi device lewat `/link`.
