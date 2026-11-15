# Pass 3 — Laporan delta

Basis: `3a658719`. Laporan pass 1: `docs/audit/AUDIT_REPORT.md`.
Pass 2: `docs/audit/pass-2/`. Temuan baru: `20-findings.md`.
Verifikasi fokus kripto: `30-crypto-handshake.md`.

## Ringkasan satu paragraf

Tiga regresi/utang yang paling penting dari pass 2 **tertutup dan saya
verifikasi di kode**, bukan hanya di tes: view-once kembali berfungsi (dan kini
tidak bisa dipakai menghapus pesan biasa), typing serta pemulihan kunci sesi 1:1
memakai bukti per percakapan, dan gate tulis baris SYSTEM menolak token anggota
yang basi. Tidak ada temuan Critical maupun High yang bertahan. Namun perbaikan
itu menaikkan `SessionKey` menjadi **trust anchor**, dan satu temuan **Medium**
baru muncul dari sana: baris `SessionKey` dapat ditulis klien untuk percakapan
dan perangkat mana pun (`routes/sessionKeys.ts`), sehingga bukti "peserta" bisa
dipalsukan (N3-01). Fokus kripto (handshake X3DH v2) tidak menemukan kelemahan
autentikasi: transkrip mengikat kedua identitas + semua ciphertext, diverifikasi
sebelum decapsulation, dan tidak ada fallback v1.

## A. Diperbaiki dan terverifikasi (dengan bukti kode)

| ID | Klaim perbaikan | Bukti | Verdict |
|---|---|---|---|
| REG-1 | View-once: penerima lolos lewat bukti peserta per percakapan; event dibatasi ke `isViewOnce`; `message:viewed` hanya ke orang yang terbukti peserta | `realtimeHandlers.ts:929-1019` (`if (msg.isViewOnce !== true) return`, `isConversationParticipant`, `finalizeViewOnceIfAllOpened`); klien tidak berubah (`Lightbox.tsx:38`) | **Tertutup.** Penerima 1:1 punya baris `SessionKey` untuk perangkatnya → `isRecipient` benar → baris dihapus + `message:viewed` terkirim |
| REG-1b | View-once grup tidak lagi menghapus pesan orang lain | `realtimeHandlers.ts:986-1000` (cabang `isGroup`), `routes/messages.ts:145-172` (`content: null` hanya bagi yang sudah membuka), `viewOnceRecipients.ts:120-135` | **Tertutup.** Baris bertahan sampai pembukaan terakhir, lalu dihapus |
| REG-2 | Typing & `session:fulfill_response` memakai peserta `conversationId` payload | `realtimeHandlers.ts:555-570, 634-670`; `conversationParticipants.ts:78-130` | **Tertutup** (dengan catatan N3-01) |
| REG-2b | Presence 1:1 hidup tanpa menulis baris keanggotaan baru | `presencePeers.ts:92-140` (dua sumber: membership + `sessionKey`) | **Tertutup.** 1:1 punya session key untuk semua perangkat peserta |
| N-02 | Filter typing ter-scope ke percakapan | `realtimeHandlers.ts:556-566` | **Tertutup** |
| N-03 | Gate tulis SYSTEM menolak token basi | `routingIdentity.ts:200-222` (`requireFresh`), `groupRealtimeAuth.ts:96-101` | **Tertutup**; `evaluateMemberToken` dipakai bersama `/api/groups/*` |
| N-01 | `GET /api/users/:id` tidak anonim | `users.ts:43` (`router.use(requireAuth)`) + guard eksplisit `users.ts:687` | **Tertutup** (temuan pass 2 memang keliru; koreksi pass 2 diterima) |
| F-10 sisa | `script-src` tanpa `'unsafe-inline'` | `app.ts:101-124`; `style-src` tetap (disable blok loader) | **Tertutup** untuk script; `style-src` residual dicatat |
| F-11 | `storeReceivedSessionKey` tidak memasang kunci buta | `crypto.ts:3399-3448` — non-X3DH ditolak, cross-check `initiatorSigningKeyV2` vs bundle, `return` sebelum `storeSessionKeySecurely`; fulfiller harus peserta (`realtimeHandlers.ts:640-647`) | **Tertutup** |
| F-12 / F-13 | Variabel mati & advisory | `40-fixes.md` §Residual; `oxlint` 236→**230** warning | **Tertutup** (F-13 tidak saya verifikasi ulang — butuh jaringan) |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| F-13 | **Tidak diverifikasi** | `pnpm audit --prod` butuh jaringan. Klaim pass 2 ("no known vulnerabilities") berdiri di atas satu eksekusi yang tidak saya ulang. |
| CSP `style-src 'unsafe-inline'` | **Terbuka, disengaja** | `app.ts` masih memuatnya untuk blok loader. Bukan vektor eksekusi skrip; jangan dianggap CSP penuh. |

Tidak ada temuan pass 1/pass 2 bertingkat High yang masih terbuka.

## C. Regresi baru

Tidak ada regresi fungsional dari `3a658719`: klien tidak berubah untuk view-once
maupun typing, dan ketiga sumber bukti peserta ada pada data produksi (baris
keanggotaan, receipt bertag, session key perangkat). Yang muncul adalah
**pelemahan jaminan**: bukti peserta dapat dipalsukan (N3-01, `20-findings.md`).

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N3-01 | **Medium** (High confidence) | `POST /api/session-keys/:conversationId/ratchet` hanya memeriksa percakapan **ada**, lalu menulis `SessionKey` untuk `deviceId` apa pun. Karena pass 2 memakai `SessionKey` sebagai bukti peserta, keanggotaan menjadi **forgeable**: hapus view-once 1:1 orang lain, typing ke id sembarang, dan presence victim tanpa pernah berinteraksi. |
| N3-02 | Low | Jalur regenerate OTPK `return` sebelum `deleteOneTimePreKey` → OTPK lokal tidak pernah dikonsumsi (asimetris dengan jalur normal). |
| N3-03 | Info | OTPK diturunkan deterministik dari `masterSeed` + `keyId` lewat `Uint32Array` **host-endian**; "one-time" tidak memberi proteksi pasca-kompromi di luar masterSeed, dan derivasi bergantung endianness platform. |
| N3-04 | UNVERIFIED | `pqSignature` bundle tidak pernah diverifikasi; autentikasi bertumpu pada KEM ke `pqIdentityKey` + KT. Apakah `fetchPreKeyBundle` menegakkan KT **belum saya baca** — bila tidak, MITM oleh server saat kontak pertama tidak terdeteksi (pin baru belum ada). |

## E. Tes & checks pass ini

- `npx tsc --noEmit` (server): **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning (turun 6 dari pass 2).
- `pnpm --filter nyx-server run test`: **764 tes, 762 lulus, 0 gagal, 2 skip**
  (79 s). Naik 25 tes dari pass 2 — cocok dengan tes baru
  (`conversationParticipants`, `viewOnceRecipients`, `cspPolicy`, kasus view-once
  grup). Kali ini tes **menguji bentuk data nyata** (payload `Lightbox` apa
  adanya, 1:1 tanpa baris keanggotaan), jadi kegagalan REG-1/REG-2 sebelumnya
  akan tertangkap.
- `vitest run` (pqHandshake, x3dhOracleVectors, x3dhOracleInterop): **3 berkas,
  17 tes, 17 lulus** (10,9 s). Ini mencakup kontrol negatif handshake (kunci
  verifikasi lain ditolak, ciphertext diubah ditolak, blob ber-OTPK tanpa kunci
  lokal gagal keras) dan interop oracle DR. Web suite penuh tidak dijalankan
  (531 s); berkas `web/src` yang berubah di `3a658719` (`api.ts`, `crypto.ts`,
  `messagePipeline.ts`) tercakup tes di atas kecuali jalur CSRF `api.ts`.

## F. Rekomendasi urutan tindak lanjut

1. **N3-01** — tutup tulis `SessionKey` untuk percakapan yang bukan milik
   pemanggil (gate keanggotaan, dan tolak `deviceId` yang bukan perangkat
   pemanggil/peserta). Ini mengembalikan kredibilitas gate REG-1/REG-2.
2. **N3-04** — pastikan `fetchPreKeyBundle` menegakkan KT; bila tidak, jadikan
   penolakan (bukan peringatan) untuk handshake dengan `signingKeyV2` tak
   terverifikasi.
3. **N3-02** — panggil `deleteOneTimePreKey` juga pada jalur regenerate.
4. F-13: jalankan `pnpm audit --prod` sebelum rilis.
