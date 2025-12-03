# Panduan Arsitektur & Alur Kerja Chat Lite (Socket Real-time)

Dokumen ini merinci cara kerja fungsionalitas *real-time* di versi stabil aplikasi untuk dijadikan referensi perbaikan.

## 1. Arsitektur Umum Socket

- **Inisialisasi:** Satu instance Socket.IO klien dibuat dan dibagikan di seluruh aplikasi (pola singleton) di `web/src/lib/socket.ts`. Koneksi tidak dibuat secara otomatis (`autoConnect: false`).
- **Koneksi:** Fungsi `connectSocket()` dipanggil secara eksplisit setelah pengguna berhasil *login* atau saat aplikasi di-*bootstrap* (`web/src/store/auth.ts`).
- **Otentikasi:** Koneksi *socket* diautentikasi di *backend* melalui `socketAuthMiddleware` (`server/src/middleware/auth.ts`), yang memverifikasi token JWT dari *cookie* (`at`). Koneksi yang gagal otentikasi diperlakukan sebagai "tamu".
- **Manajemen State:** *Event* yang diterima dari server memicu *action* di *store* Zustand yang relevan (`useMessageStore`, `usePresenceStore`, dll.) untuk memperbarui UI.

## 2. Alur Event Kunci

### Alur 1: Pengiriman & Penerimaan Pesan Baru

1.  **Pengirim (Klien):**
    -   Pengguna mengetik dan menekan kirim. Fungsi `sendMessage` di `web/src/store/message.ts` dipanggil.
    -   Pesan dienkripsi secara lokal.
    -   Pesan "optimis" ditambahkan ke UI.
    -   **Poin Kunci:** Klien **tidak** melakukan `POST /api/messages`. Sebaliknya, ia memancarkan *event socket*: `socket.emit("message:send", { ... }, callback)`.

2.  **Server:**
    -   `server/src/socket.ts` menerima `socket.on("message:send", ...)`.
    -   Server menyimpan pesan ke *database*.
    -   Server menyiarkan `message:new` ke semua anggota lain di *room* percakapan: `socket.broadcast.to(conversationId).emit("message:new", ...)`.
    -   Server mengirim konfirmasi kembali ke pengirim asli melalui `callback`.

3.  **Penerima (Klien):**
    -   `web/src/lib/socket.ts` menerima `socket.on("message:new", ...)`.
    -   Pesan yang masuk didekripsi.
    -   `addIncomingMessage` dari `useMessageStore` dipanggil untuk menambahkan pesan ke *state*.
    -   Penerima kemudian memancarkan `message:ack_delivered` kembali ke server.

### Alur 2: Status Kehadiran (Online/Offline)

1.  **Koneksi (Server):**
    -   Saat `io.on("connection", ...)` berhasil (setelah otentikasi), server menambahkan `userId` ke set `online_users` di Redis.
    -   Server memancarkan `presence:init` ke klien yang baru terhubung dengan daftar lengkap semua pengguna online.
    -   Server menyiarkan `presence:user_joined` ke semua klien lain.

2.  **Koneksi (Klien):**
    -   `web/src/lib/socket.ts` mendengarkan `socket.on("presence:init", ...)` dan memanggil `setOnlineUsers` di `usePresenceStore`.
    -   Ia juga mendengarkan `socket.on("presence:user_joined", ...)` dan memanggil `userJoined`.

3.  **Diskoneksi:**
    -   Saat `socket.on("disconnect", ...)` terjadi, server menghapus `userId` dari Redis dan menyiarkan `presence:user_left`.
    -   Klien mendengarkan `socket.on("presence:user_left", ...)` dan memanggil `userLeft`.

### Alur 3: Indikator Mengetik

1.  **Pengguna Mengetik (Klien):**
    -   Saat pengguna mengetik di `MessageInput`, `handleTyping` dipanggil, yang memancarkan `socket.emit("typing:start", ...)`.
    -   Sebuah *timeout* juga diatur untuk mengirim `typing:stop`.

2.  **Server:**
    -   `server/src/socket.ts` menerima `socket.on("typing:start", ...)` atau `typing:stop`.
    -   Server langsung menyiarkan `typing:update` ke semua anggota lain di *room*: `socket.to(conversationId).emit("typing:update", ...)`.

3.  **Penerima (Klien):**
    -   `web/src/lib/socket.ts` mendengarkan `socket.on("typing:update", ...)`.
    -   Ia memanggil `addOrUpdate` di `usePresenceStore` untuk memperbarui UI.

---

**Ringkasan untuk Perbaikan:**
Versi kode terbaru harus mereplikasi alur ini. Ini berarti `web/src/lib/socket.ts` **harus** memiliki semua *event listener* (`message:new`, `presence:init`, dll.), dan `web/src/store/message.ts` **harus** menggunakan `socket.emit("message:send")`, bukan `POST /api/messages`. Selain itu, `web/src/store/presence.ts` harus ada.
