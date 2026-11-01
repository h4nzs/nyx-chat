# Pass 5 — Laporan delta

Basis: `537c432b`. Pass 1: `docs/audit/AUDIT_REPORT.md`. Pass 2: `pass-2/`.
Pass 3: `pass-3/`. Pass 4: `pass-4/`. Temuan baru: `20-findings.md`.
Verifikasi fokus SPQR: `30-spqr.md`.

## Ringkasan satu paragraf

Ketiga temuan pass 4 **tertutup di kode**: `POST /api/conversations` kini
memvalidasi `initialSession` dengan aturan guard ratchet (cap 500, base64 ≤8 KB,
pemilik perangkat harus peserta) **di dalam transaksi**, anchor kini mencakup
perangkat pembuat (`includeSelf`), dan jalur uni sidecar berhenti membaca di
`header + 32 KB + 1` lalu mem-parse dengan batas yang sama. Tidak ada temuan
Critical/High. Fokus baru — jalur braid SPQR — **tidak menemukan kelemahan
kripto**: transkrip v2 tetap X3DH yang sama, deklarasi versi hanya dibaca dari
payload yang lolos AEAD, header v2 tidak pernah dibaca sebagai v1, dan parser
header fail-closed dengan batas frame yang jelas. Yang ditemukan adalah
**asimetri pemulihan**: jalur v1 punya arsip state era lama
(`previous_session_states`), sedangkan jalur v2 tidak — pesan v2 dari era sesi
sebelumnya menjadi tidak terbaca setelah sesi baru (N5-01, Low), ditambah drift
dokumen di `spqrRatchet.ts` (N5-02) dan suite SPQR yang **diam-diam skip** bila
artefak WASM tidak ada (N5-03).

## A. Diperbaiki dan terverifikasi (dengan bukti kode)

| ID | Klaim perbaikan | Bukti | Verdict |
|---|---|---|---|
| N4-01 | `initialSession` divalidasi: cap 500, `deviceId` 1–128, base64 standar ≤8 KB, duplikat digabung, pemilik perangkat ∈ `userIds ∪ pembuat`, kosong → 400 | `sessionKeyRelayGuard.ts:180-253` (`authorizeInitialSessionKeys`), `routes/conversations.ts:204-236` (dipanggil **di dalam** `$transaction`, `ApiError` melempar → pembuatan batal), `conversationSchemas.ts:35-49` (cap zod sebelum transaksi) | **Tertutup.** `deviceId` pihak ketiga kini `403 SESSION_KEY_FOREIGN_DEVICE`; perangkat hantu `403`; tidak ada baris ditulis bila ditolak (transaksi). |
| N4-02 | Anchor mencakup pembuat | `crypto.ts:1018-1026` (`participants = unique([...userIds, myId])`, `{ includeSelf: true }`), `sealSessionKeyForParticipants` melewati perangkat sendiri hanya untuk rotasi (`:975-979`) | **Tertutup.** Pembuat 1:1 kini punya baris `issuedByServer`; klaim "belum dipanggil otomatis" sudah dikoreksi di CHANGELOG. |
| N4-03 | Jalur uni dibatasi | `main.rs:801-821` (`uni_read_limit = FRAME_HEADER_BYTES + MAX_BIDI_PAYLOAD_BYTES + 1`, baca berhenti saat penuh) dan `:832-834` (`parse_inbound_frame(&buffer, MAX_BIDI_PAYLOAD_BYTES)`) | **Tertutup** untuk memori dan untuk penerusan payload >32 KB. Satu ketidaktepatan komentar dicatat di `20-findings.md` N5-04. |
| N4-04 | Tiket setengah = tanpa tiket | `main.rs:554-560` (tidak berubah, memang fail-closed) | **Tertutup sebagai dokumentasi.** |

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| F-13 | **Tidak diverifikasi** sejak pass 1 | `pnpm audit --prod` butuh jaringan; 0/5 pass menjalankannya. |
| CSP `style-src 'unsafe-inline'` | Terbuka, disengaja | Bukan vektor eksekusi skrip. |
| Race single-active-device sidecar | **Tidak diverifikasi** | Dicatat pass 4; tidak ditelusuri, tidak diubah. |
| Cakupan | Terbuka | `routes/auth.ts`, WASM KT, `metrics.rs` rinci, eksekusi Rust/fuzz. |

## C. Regresi baru

Tidak ada regresi yang bisa saya buktikan. Perubahan validasi hanya menolak input
yang sebelumnya menulis baris tanpa hak; klien yang sah mengirim
`encryptedKeyBase64` (base64 standar) sehingga lolos regex, dan
`initialKeysPerDevice` kosong hanya terjadi bila client gagal menyegel — pada
kasus itu `startConversation` memang tidak mengirim `initialSession` sama sekali
(`store/conversation.ts:594-602`), jadi jalur 400 `INITIAL_SESSION_EMPTY` tidak
tersentuh klien normal.

## D. Temuan baru

| ID | Tingkat | Ringkas |
|---|---|---|
| N5-01 | Low (High confidence) | **Jalur v2 tidak punya arsip era sesi.** v1 mencoba 3 slot `getArchivedRatchetSessions` saat pesan datang dari era lama; jalur v2 langsung `error` bila state braid/authKey tidak cocok dengan era itu, dan state braid hanya satu baris per percakapan yang dihapus saat sesi baru. Pesan v2 yang tertunda melewati rotasi sesi menjadi tidak terbaca, padahal v1 pada posisi yang sama diselamatkan arsip. |
| N5-02 | Low (High confidence) | `spqrRatchet.ts:26-28` masih menyatakan "modul ini **belum dipakai jalur pesan produksi**", padahal ia diimpor `crypto.worker.ts:38` dan dipakai setiap pengiriman v2. Bertentangan dengan `spqrNegotiation` (integrasi menyala) dan CHANGELOG. |
| N5-03 | Low | Suite SPQR memakai `const withSkip = HAS_WASM ? describe : describe.skip` (`spqrSession`, `spqrRatchet`, `spqrMessagePath`). Di mesin tanpa `packages/spqr-wasm/dist/spqr.wasm` seluruh tes kripto jalur v2 **dilewati tanpa suara** — hijau yang menyesatkan, pola yang sama dengan `transport.spec` sebelum pass 1. |
| N5-04 | Info | Komentar perbaikan N4-03 menyatakan "kelebihan byte = frame terlalu besar (bukan dipotong diam-diam)", tetapi `parse_inbound_frame` hanya membaca frame pertama; byte setelah payload yang dideklarasikan diabaikan tanpa error. Bukan masalah keamanan (frame kedua memang tidak pernah diproses di jalur uni), tetapi komentarnya menjanjikan perilaku yang tidak ada. |

## E. Tes & checks pass ini

- `npx tsc --noEmit` server **exit 0**; web **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 230 warning.
- `pnpm --filter nyx-server run test`: **779 tes, 777 lulus, 0 gagal, 2 skip**
  (naik 4 dari pass 4 — tes baru `authorizeInitialSessionKeys`).
- `vitest run` 6 berkas SPQR: **69/69 lulus** (wire 8, session 6+9, ratchet,
  state 9, negotiation 21, messagePath 8 — semuanya berjalan, bukan skip, karena
  artefak WASM ada di mesin ini).
- Tidak dijalankan: `cargo test` (spqr-wasm/sidecar), E2E `spqr.spec.ts`,
  `pnpm audit --prod`.

## F. Rekomendasi urutan tindak lanjut

1. **N5-01** — putuskan apakah pesan v2 lintas-era perlu diselamatkan: simpan
   braid state per `sessionId` (bukan per percakapan) dan biarkan pembaca
   memilih era, atau dokumentasikan bahwa rotasi sesi memutus pesan v2 yang
   belum terkirim. Ini keputusan protokol, bukan patch.
2. **N5-03** — ubah skip senyap menjadi kegagalan eksplisit (atau gate CI yang
   memastikan `dist/spqr.wasm` ada sebelum vitest), supaya suite kripto tidak
   pernah hijau karena tidak berjalan.
3. **N5-02/N5-04** — koreksi komentar agar tidak menjanjikan perilaku yang tidak
   ada.
4. F-13: jalankan `pnpm audit --prod` sebelum rilis.
