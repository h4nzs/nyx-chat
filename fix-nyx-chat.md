# Rencana Perbaikan Stabilisasi & Keamanan NYX Chat

## Goal
Mengimplementasikan perbaikan untuk 4 masalah kritis/tinggi yang ditemukan pada audit E2E: Failover Redis (Rust), Inkonsistensi Transaksi DB, Kelemahan Validasi Input (Zod), dan Auto-reconnect WebTransport di frontend.

## Tasks

- [ ] **Task 1: Implementasi Redis Auto-Reconnect di Rust Sidecar**
  - Edit `server/transport-sidecar/src/main.rs`.
  - Modifikasi loop `pubsub.subscribe("nyx:downstream")` agar berada di dalam `loop {}` dengan mekanisme *retry* dan jeda waktu (misal: `tokio::time::sleep`) jika koneksi putus.
  - **Verify**: Matikan server Redis sesaat ketika sidecar berjalan, pastikan sidecar tidak *crash* dan berhasil menyambung ulang ketika Redis aktif kembali.

- [ ] **Task 2: Penambahan Schema Validasi WebTransport di `shared`**
  - Edit `packages/shared/src/socket.ts` atau buat `packages/shared/src/schemas.ts`.
  - Tambahkan skema Zod `MessageSendPayloadSchema` dan skema relevan lainnya untuk memvalidasi payload masuk.
  - Export skema tersebut agar dapat digunakan di backend.
  - **Verify**: Skema dapat diimpor tanpa masalah kompilasi oleh `pnpm build` di direktori `shared`.

- [ ] **Task 3: Validasi Zod dan `$transaction` Prisma di `redisBridge.ts`**
  - Edit `server/src/network/redisBridge.ts` pada fungsi `handleChatMessage`.
  - Implementasikan validasi `MessageSendPayloadSchema.parse(payload)` sebelum logika berlanjut.
  - Ubah `prisma.message.create` menjadi `prisma.$transaction` yang menyertakan pembuatan pesan dan `prisma.conversation.update` untuk memperbarui `lastMessageAt`.
  - **Verify**: Mengirim pesan via WebTransport memperbarui waktu `lastMessageAt` pada percakapan terkait, dan payload yang cacat ditolak tanpa *crash*.

- [ ] **Task 4: Implementasi Active Auto-Reconnect di Frontend**
  - Edit `web/src/lib/transportClient.ts` dan `web/src/store/connection.ts`.
  - Pada status `disconnected`, jika aplikasi masih di *foreground* (`document.visibilityState === 'visible'`), tambahkan logika yang secara berkala memanggil `connectSocket()`.
  - Bersihkan interval ketika koneksi berhasil atau aplikasi masuk *background*.
  - **Verify**: Putuskan koneksi jaringan sementara; aplikasi harus secara otomatis mencoba menyambung ulang tanpa perlu disembunyikan/dibuka kembali.

## Done When
- [ ] Sidecar Rust tahan terhadap gangguan jaringan Redis.
- [ ] Backend aman dari injeksi *malformed* WebTransport payload.
- [ ] Urutan *Chat List* konsisten berkat pembaruan `lastMessageAt`.
- [ ] Klien frontend dapat pulih secara mulus dari pemutusan koneksi tanpa intervensi pengguna.