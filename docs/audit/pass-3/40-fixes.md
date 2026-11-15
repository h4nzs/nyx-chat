# Pass 3 — Perbaikan

Tanggal: 2026-11-01. Basis temuan: `10-delta.md`, `20-findings.md`,
`30-crypto-handshake.md`. Tidak ada perubahan protokol/kripto wire: perbaikan
berada di otorisasi endpoint, akuntansi OTPK lokal, dan gerbang pembentukan sesi.

| ID | Perbaikan | Berkas | Bukti/tes |
|---|---|---|---|
| **N3-01** | `POST /api/session-keys/:conversationId/ratchet` kini **fail-closed**. Urutan gate: bentuk payload (cap **500** kunci, `sessionId` ≤128, `deviceId` ≤128, `encryptedKey` base64url ≤8 KB, duplikat digabung) → pemanggil harus **peserta terbukti** lewat bukti yang tidak bisa ia tulis sendiri untuk percakapan itu (baris keanggotaan bertoken, receipt bertag opaque, **atau** perangkatnya punya baris `SessionKey` bertanda `issuedByServer` dari pembuatan percakapan) → setiap `deviceId` harus perangkat nyata dan **sudah terdaftar** di percakapan itu (ratchet = rotasi, bukan pendaftaran), dan perangkat orang lain hanya boleh bila pemiliknya juga peserta terbukti. Tanpa itu **403** (`SESSION_KEY_NOT_PARTICIPANT` / `SESSION_KEY_UNKNOWN_DEVICE` / `SESSION_KEY_NOT_ENROLLED` / `SESSION_KEY_UNKNOWN_PEER`). | `server/src/utils/sessionKeyRelayGuard.ts` (baru), `server/src/routes/sessionKeys.ts`, `server/prisma/schema.prisma` (`SessionKey.issuedByServer`), `server/src/routes/conversations.ts` | `server/tests/sessionKeyRelayGuard.test.ts` (9 tes): outsider 403 tanpa menyentuh tabel `Device`; peserta boleh untuk perangkatnya; 1:1 boleh lewat receipt; perangkat korban (belum terdaftar) ditolak; perangkat terdaftar milik non-peserta tetap ditolak; bootstrap lewat baris pembuatan; perangkat sendiri tanpa bukti peserta tetap 403; `deviceId` hantu ditolak; cap/format ditolak; duplikat digabung |
| **N3-01 — ratchet dihidupkan kembali** | Endpoint ratchet dipakai lagi lewat jalur yang sah: `POST /api/conversations` menerima `initialSession` (baris ditulis server, `issuedByServer: true`) dan `startConversation` kini menyegel kunci sesi awal ke perangkat peer sebelum memanggil endpoint itu (best-effort — kegagalan sealing tidak menggagalkan pembuatan chat). `ensureAndRatchetSession` memakai penyegel yang sama (`sealSessionKeyForParticipants`), menyimpan kunci lokal **hanya setelah** server menjawab 2xx, dan mempertahankan `status` error server (403 terdiferensiasi dari bug lokal). Dua bug laten jalur pembuatan ikut diperbaiki: kolom `initiatorCiphertext` (tidak ada di schema → `createMany` melempar) dan kewajiban ciphertext X3DH yang tidak dimiliki distribusi kunci sesi biasa. | `web/src/utils/crypto.ts` (`sealSessionKeyForParticipants`, `buildInitialSessionForConversation`, `ensureAndRatchetSession`), `web/src/store/conversation.ts` (`startConversation`) | `tsc` web 0; suite handshake 17/17; perilaku server dikunci 9 tes guard |
| **N3-01 lanjutan** | Pertahanan berlapis di jalur view-once: bila pesan punya **daftar penerima** (baris baru), pembuka wajib ada di daftar itu — jadi keanggotaan yang dipalsukan sebelum gerbang di atas ada pun tidak bisa menghapus/mengosongkan view-once orang lain. Pesan lama tanpa daftar → `null` → perilaku lama. | `server/src/utils/viewOnceRecipients.ts` (`isAddressedViewOnceRecipient`), `server/src/network/realtimeHandlers.ts` | `realtimeAuthorization.test.ts`: "keanggotaan palsu tetap tidak bisa menghapus view-once orang lain" (tanpa `delete`, tanpa `message:viewed`, tanpa pencatatan pembukaan) |
| **N3-02** | Jalur regenerate OTPK kini menghapus prekey lokal **setelah derivasi berhasil**, sama dengan jalur normal. Regenerate yang gagal tidak menghapus (fallback di bawahnya memang menolak blob ber-OTPK). | `web/src/utils/crypto.ts` (`deriveSessionKeyAsRecipient`) | dicek `tsc` web; perilaku handshake tidak berubah untuk jalur sukses |
| **N3-03** | Derivasi `keyId` OTPK memakai `DataView.setUint32(…, true)` (little-endian eksplisit) di **kedua** tempat (pembuatan batch + regenerate). Di host little-endian byte-nya identik dengan perilaku lama, jadi tidak ada migrasi; yang berubah hanya platform big-endian yang sebelumnya tidak bisa meregenerasi OTPK yang sama. | `web/src/workers/crypto.worker.ts` | `tsc` web + suite handshake |
| **N3-04** | Diverifikasi: `fetchPreKeyBundle` **tidak** memanggil KT, tetapi `establishSessionFromPreKeyBundle` memanggil `observePeerIdentityKey`, yang menurunkan username (`resolvePeerUsername`) dan memeriksa log; hasilnya hanya `console.warn`. Sekarang `status === 'changed'` (TOFU change **atau** pertentangan log `mismatch` pada kontak pertama) **melempar** `IDENTITY_CHANGED` sebelum sesi dibentuk — kunci tak terverifikasi tidak dipakai untuk mengenkripsi. `unavailable` (log mati) tetap tidak memblokir, sesuai audit F-09 (banner "belum dibuktikan"). | `web/src/utils/crypto.ts` (`establishSessionFromPreKeyBundle`) | `tsc` web; kontrol negatif handshake tetap lulus (`x3dhOracleVectors`) |

## Yang masih terbuka (jujur)

| Item | Status |
|---|---|
| **F-13** `pnpm audit --prod` | Belum dijalankan di pass ini/3 (butuh jaringan). Klaim pass 2 tetap belum diverifikasi ulang. |
| **`style-src 'unsafe-inline'`** | Disengaja (blok `<style>` loader). Bukan vektor eksekusi skrip; jangan disebut "CSP penuh". |
| **Regenerate OTPK gagal** | Bila regenerate gagal, prekey **tidak** dihapus dan handshake jatuh ke jalur non-regenerate yang menolak blob ber-OTPK. Konsekuensi: pesan itu tidak bisa didekripsi; prekey tetap tercatat sampai refill berikutnya. Ini perilaku lama yang tidak diperburuk. |
| **N3-03 migrasi** | Vault dari platform big-endian (tidak ada di target praktis) tidak akan meregenerasi OTPK lama; tidak ada jalur upgrade karena tidak ada deployment big-endian. |
| **Ratchet pada percakapan lama** | Percakapan yang dibuat **sebelum** perubahan ini tidak punya baris `issuedByServer`. Peserta di sana mendapat bukti lewat receipt setelah pesan pertama dibaca (jalur `mark_as_read`) atau baris keanggotaan; sampai itu ada, server menjawab 403 `SESSION_KEY_NOT_PARTICIPANT` dan klien tidak menyimpan kunci baru. |

## Checks

- `npx tsc --noEmit` (server) → exit 0.
- `npx oxlint src tests` (server) → **0 error** (46 warning `no-unused-vars` lama).
- `npx tsx --test` pada `sessionKeyRelayGuard`, `realtimeAuthorization`,
  `viewOnceRecipients`, `schemaPrivacy`, `sessionKeys` → lihat hasil di commit.
- Web: `npx tsc --noEmit` + `vitest` (pqHandshake, x3dhOracle*) setelah perubahan
  `crypto.ts`/`crypto.worker.ts`.
- Tidak dijalankan: E2E Playwright/WebTransport, `cargo test`, tes Go KT,
  `pnpm audit --prod` (butuh jaringan/toolchain).
