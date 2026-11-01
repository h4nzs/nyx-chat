# Pass 4 — Perbaikan

Tanggal: 2026-11-01. Basis temuan: `10-delta.md`, `20-findings.md`,
`30-sidecar.md`. Tidak ada perubahan protokol wire (frame transport, payload
E2EE, envelope) — perbaikan ada di validasi jalur tulis, batas baca sidecar, dan
kelengkapan anchor bukti peserta.

| ID | Perbaikan | Berkas | Bukti/tes |
|---|---|---|---|
| **N4-01** | `POST /api/conversations` kini memvalidasi `initialSession` dengan aturan yang sama dengan guard ratchet lewat `authorizeInitialSessionKeys`: `sessionId` ≤128, cap **500** entri (zod `.refine` + validator), `deviceId` 1–128, `encryptedKey`/`initiatorCiphertext` **base64 standar** ≤8 KB, duplikat digabung, dan **pemilik setiap `deviceId` harus ada di `userIds ∪ pembuat`** (`SESSION_KEY_FOREIGN_DEVICE`); perangkat tak dikenal → `SESSION_KEY_UNKNOWN_DEVICE`; daftar kosong → `400 INITIAL_SESSION_EMPTY`. Penolakan terjadi **di dalam transaksi**, jadi percakapan tidak ikut dibuat dan kuota sandbox dikembalikan (jalur `catch` yang sudah ada). | `server/src/utils/sessionKeyRelayGuard.ts` (`authorizeInitialSessionKeys`), `server/src/routes/conversations.ts`, `server/src/utils/conversationSchemas.ts` | `server/tests/sessionKeyRelayGuard.test.ts` (+4 tes): perangkat pihak ketiga 403 dan tidak ada baris ditulis; perangkat peserta lolos (ciphertext opsional); device hantu/base64 salah/kosong ditolak; cap 500 ditegakkan |
| **N4-02** | Anchor bukti peserta kini **mencakup pembuat**: `buildInitialSessionForConversation` menambahkan `myId` ke daftar peserta dan memakai `includeSelf: true`, sehingga perangkat pembuat sendiri juga mendapat baris `issuedByServer` — tanpa itu pembuat 1:1 tidak punya bukti apa pun (1:1 tanpa baris keanggotaan, receipt baru ada setelah peer membaca) dan ratchet-nya sendiri akan 403. Rotasi (`ensureAndRatchetSession`) tetap melewati perangkat sendiri karena kunci disimpan lokal. Klaim "sudah dipanggil otomatis" **dikoreksi**: endpoint aman dan siap, tetapi belum ada pemanggil otomatis di UI. | `web/src/utils/crypto.ts` (`sealSessionKeyForParticipants` + `buildInitialSessionForConversation`), `CHANGELOG.md` | `tsc` web 0; suite handshake 17/17 |
| **N4-03** | Sidecar: jalur **uni** kini berhenti membaca di `FRAME_HEADER_BYTES + MAX_BIDI_PAYLOAD_BYTES + 1` byte (dulu `extend_from_slice` tanpa batas sampai stream ditutup) dan mem-parse dengan `MAX_BIDI_PAYLOAD_BYTES` (dulu `usize::MAX`), jadi payload >32 KB menjadi `TooLarge` dan tidak pernah diteruskan ke `nyx:upstream:*`. Batas memori per stream kini sama dengan jalur bidi. | `server/transport-sidecar/src/main.rs` | `cargo test` sidecar (lihat hasil di commit); jalur datagram dibiarkan memakai QUIC sebagai batas ukuran |
| **N4-04** | Info, tanpa perubahan kode: tiket URL yang hanya membawa salah satu dari `id`/`deviceId` sengaja diperlakukan seperti tanpa tiket (fail-closed). Dicatat di sini supaya operator yang menerbitkan tiket setengah tidak mengira jalur tiketnya aktif. | — | — |

## Yang masih terbuka (jujur)

| Item | Status |
|---|---|
| **F-13** `pnpm audit --prod` | Belum dijalankan (butuh jaringan); klaim pass 2 tetap belum diverifikasi ulang. |
| **`style-src 'unsafe-inline'`** | Disengaja (blok `<style>` loader). Bukan vektor eksekusi skrip. |
| **Tiket "setengah" (N4-04)** | Perilaku fail-closed dipertahankan, bukan diubah: menerima tiket tanpa `deviceId` akan membuka jalur auth yang lebih lemah. |
| **Race single-active-device di sidecar** | Dicatat pass 4 sebagai celah verifikasi (iterasi `DashMap` + `insert` tidak atomik). Tidak diubah di pass ini — butuh keputusan desain, bukan patch mekanis. |
| **Cakupan** | `routes/auth.ts` penuh, `packages/spqr-wasm`, `spqrRatchet.ts`, WASM KT, dan eksekusi fuzz transport tetap belum diaudit. |
