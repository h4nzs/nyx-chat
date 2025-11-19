# Laporan Analisis Komprehensif: Chat-Lite

Dokumen ini merangkum hasil analisis menyeluruh terhadap proyek Chat-Lite, sesuai dengan instruksi pada `@prompt-analis.md` dan `@prompt-analis-2.md`. Tujuannya adalah untuk memetakan arsitektur, alur data, dan kondisi aplikasi saat ini.

---

## 1. Ringkasan & Arsitektur Umum

Chat-Lite adalah aplikasi pesan instan modern yang mengutamakan keamanan melalui enkripsi ujung-ke-ujung (E2EE). Aplikasi ini dibangun dengan arsitektur monorepo yang terdiri dari:

-   **Backend (`server/`):** Node.js, Express, Prisma (PostgreSQL), dan Socket.IO. Bertanggung jawab atas otentikasi, persistensi data terenkripsi, dan komunikasi real-time.
-   **Frontend (`web/`):** React, Vite, TypeScript, Zustand, dan Tailwind CSS. Menyediakan antarmuka pengguna yang reaktif dan modern.

Komunikasi antara klien dan server menggunakan pendekatan hybrid:
-   **API REST:** Untuk operasi CRUD stateful seperti otentikasi, pengambilan riwayat chat, dan manajemen sesi.
-   **WebSockets (Socket.IO):** Untuk semua komunikasi real-time seperti pengiriman pesan, status online, notifikasi pengetikan, dan sinkronisasi kunci enkripsi.

---

## 2. Peta Alur Data & Fitur Utama

Berikut adalah pemetaan alur data untuk fitur-fitur inti aplikasi:

| Fitur | Alur Proses |
| :--- | :--- |
| **👤 Otentikasi (Login)** | `AuthForm` → `useAuthStore.login()` → `POST /api/auth/login` → `jwt.sign()` → `HTTP-only cookie` → `useAuthStore.setUser()` → Navigasi ke `/chat` |
| **📨 Pengiriman Pesan** | `MessageInput` → `useConversation.sendMessage()` → `encryptMessage()` → `socket.emit('message:send', payload)` → **Server:** `on('message:send')` → Simpan ke DB → `io.to(roomId).emit('message:new', data)` → **Klien:** `on('message:new')` → `decryptMessage()` → Update `useConversation` store → UI re-render |
| **👥 Pembuatan Grup** | `CreateGroupChat` → `POST /api/conversations` → **Server:** Buat grup & partisipan → `io.to(userIds).emit('conversation:new', data)` → **Klien:** `on('conversation:new')` → `useConversationStore.addOrUpdateConversation()` |
| **✍️ Indikator Pengetikan** | `MessageInput.onChange` → `socket.emit('typing:start', { convId })` → **Server:** `io.to(roomId).emit('typing:started', { userId })` → **Klien:** `usePresenceStore.addTypingUser()` → `TypingIndicator` re-render |
| **🟢 Status Online** | `socket.on('connect')` → `socket.emit('presence:update', { online: true })` → **Server:** `redis.sadd('online_users')` → `io.emit('presence:updated', { userId, online: true })` → **Klien:** `usePresenceStore.setPresence()` |
| **📎 Lampiran File** | `MessageInput.onFileChange` → `useConversation.uploadFile()` → `POST /api/uploads` (multipart/form-data) → Simpan file di `server/uploads` → `sendMessage` dengan `fileUrl` |
| **🔄 Sinkronisasi Kunci E2EE** | `App.tsx` → `syncSessionKeys()` → `emitSessionKeyRequest()` → **Server:** `on('session:request_key')` → `io.to(otherDeviceId).emit('session:fulfill_request')` → **Perangkat Lain:** `on('session:fulfill_request')` → `fulfillKeyRequest()` → `emitSessionKeyFulfillment()` → **Server:** `on('session:fulfill_response')` → `io.to(requesterId).emit('session:new_key')` → **Perangkat Peminta:** `on('session:new_key')` → `storeReceivedSessionKey()` → `useKeychainStore.keysUpdated()` |

---

## 3. Peta Event Socket.IO

Event Socket.IO adalah tulang punggung komunikasi real-time di Chat-Lite.

#### Client → Server
-   `presence:update`: Mengirim status online/offline pengguna saat terhubung/terputus.
-   `conversation:join`: Bergabung ke "room" sebuah percakapan untuk menerima pesan.
-   `message:send`: Mengirim pesan baru yang sudah terenkripsi ke sebuah percakapan.
-   `typing:start` / `typing:stop`: Memberi tahu server bahwa pengguna sedang mengetik atau berhenti.
-   `session:request_key`: Meminta kunci sesi dari perangkat lain milik pengguna yang sama.
-   `session:fulfill_response`: Mengirimkan kunci sesi yang diminta (terenkripsi) sebagai respons.
-   `linking:send_payload`: Mengirim payload untuk menautkan perangkat baru.

#### Server → Client
-   `presence:updated`: Memberi tahu semua klien tentang perubahan status online/offline seorang pengguna.
-   `conversation:new`: Memberi tahu pengguna bahwa mereka telah ditambahkan ke percakapan baru.
-   `message:new`: Meneruskan pesan baru yang terenkripsi ke semua anggota percakapan.
-   `message:updated`: Mengirim pembaruan untuk sebuah pesan (misalnya, reaksi atau penghapusan).
-   `typing:started` / `typing:stopped`: Meneruskan status pengetikan ke anggota percakapan.
-   `session:fulfill_request`: Meneruskan permintaan kunci sesi ke perangkat lain milik pengguna.
-   `session:new_key`: Mengirim kunci sesi yang baru diterima ke perangkat yang memintanya.
-   `force_logout`: Memaksa klien untuk logout (misalnya, jika sesi dicabut dari perangkat lain).

---

## 4. Arsitektur Frontend (React & Zustand)

#### Hierarki Komponen Utama (`pages/Chat.tsx`)
```
<Chat>
 ├── <ConnectionStatusBanner />
 ├── <ChatList> (Sidebar Kiri)
 │    ├── <ChatItem />
 │    └── <StartNewChat />
 ├── <ChatWindow> (Konten Utama)
 │    ├── <ChatHeader />
 │    ├── <Virtuoso> (Message List)
 │    │    └── <MessageItem />
 │    └── <MessageInput />
 └── <GroupInfoPanel> / <UserInfoPanel> (Sidebar Kanan)
```

#### State Management (Zustand)
State global dibagi menjadi beberapa *store* yang logis, yang merupakan praktik yang baik untuk dikelola.
-   `useAuthStore`: Mengelola state otentikasi pengguna, token, dan data pengguna.
-   `useConversationStore`: Mengelola daftar percakapan, percakapan aktif, dan operasi terkait (memuat, membuka, membuat).
-   `useMessageStore` (di dalam hook `useConversation`): Mengelola pesan untuk percakapan yang sedang aktif.
-   `usePresenceStore`: Melacak status online pengguna dan siapa yang sedang mengetik di setiap percakapan.
-   `useKeychainStore`: Mengelola status kunci enkripsi yang tersedia di perangkat.
-   `useModalStore`, `useCommandPaletteStore`, dll: Mengelola state UI spesifik.

Interaksi antar komponen sebagian besar terjadi melalui *store* Zustand ini. Komponen mengirim *action*, dan *store* berkomunikasi dengan backend. Ketika data baru diterima (terutama melalui socket), *store* diperbarui, dan semua komponen yang berlangganan akan me-render ulang secara otomatis.

---

## 5. Integrasi API Backend

Backend menyediakan API REST untuk operasi yang tidak memerlukan real-time.

-   `/api/auth/*`: Mengelola registrasi, login, logout, dan manajemen sesi (misalnya, `POST /api/auth/login`).
-   `/api/conversations`:
    -   `GET /`: Mengambil semua percakapan pengguna.
    -   `POST /`: Membuat percakapan baru.
    -   `POST /:id/read`: Menandai percakapan sebagai telah dibaca.
-   `/api/messages/:conversationId`: Mengambil riwayat pesan untuk sebuah percakapan (dengan paginasi).
-   `/api/users/*`: Mencari pengguna.
-   `/api/uploads`: Mengunggah lampiran file.
-   `/api/keys/*`: Mengelola kunci publik dan kunci sesi terenkripsi.

Semua rute yang memerlukan otentikasi dilindungi oleh middleware yang memverifikasi token JWT dari *cookie*.

---

## 6. Temuan & Status Fitur

| Fitur | Status | Catatan |
| :--- | :--- | :--- |
| **Otentikasi & Sesi** | ✅ **Berfungsi** | Alur login, registrasi, dan manajemen sesi sudah solid. |
| **Pesan Pribadi & Grup** | ✅ **Berfungsi** | Pengiriman dan penerimaan pesan berfungsi secara real-time. |
| **Enkripsi E2E** | ✅ **Berfungsi** | Alur enkripsi, dekripsi, dan sinkronisasi kunci antar perangkat sudah terimplementasi. |
| **Indikator Pengetikan** | ✅ **Berfungsi** | Tampil secara real-time. |
| **Status Online** | ✅ **Berfungsi** | Status online/offline pengguna ditampilkan dengan benar. |
| **Manajemen Grup** | ✅ **Berfungsi** | Membuat grup dan menambahkan anggota sudah berfungsi. |
| **Lampiran File** | ✅ **Berfungsi** | Pengguna dapat mengunggah dan melihat lampiran. |
| **Pencarian Pesan** | ✅ **Berfungsi** | Fungsionalitas pencarian di dalam percakapan sudah ada. |
| **UI Responsif** |  **berfungsi** | Tata letak utama sudah responsif, tetapi beberapa modal dan panel mungkin memerlukan penyesuaian lebih lanjut untuk layar yang sangat kecil atau sangat besar. |
| **Stabilitas Socket** |  **berfungsi** | Logika *reconnect* sudah ada, tetapi perlu diuji dalam kondisi jaringan yang tidak stabil untuk memastikan tidak ada *race condition* atau kehilangan state. |

### Rekomendasi & Area Risiko
1.  **Kompleksitas E2EE:** Logika sinkronisasi kunci (`session:request_key`, `session:fulfill_request`, dll.) sangat penting dan rumit. Kesalahan implementasi di sisi klien dapat membahayakan keamanan atau menyebabkan pengguna tidak dapat mendekripsi pesan. Area ini harus diuji secara menyeluruh.
2.  **Manajemen State:** Meskipun Zustand membantu, ada banyak *store* yang saling bergantung. Perubahan pada satu *store* dapat memicu pembaruan berantai. Ini perlu diperhatikan saat menambahkan fitur baru agar tidak menimbulkan *re-render loop*.
3.  **Optimasi Performa:** Penggunaan `react-virtuoso` untuk daftar pesan adalah pilihan yang sangat baik untuk performa. Namun, pemuatan awal `loadConversations` yang mendekripsi setiap pesan terakhir bisa menjadi lambat jika jumlah percakapan sangat banyak. Ini bisa dioptimalkan di masa depan.
4.  **Penanganan Error:** Penanganan error di beberapa alur socket bisa ditingkatkan. Saat ini, banyak error hanya dicatat di konsol (`console.error`). Menampilkan umpan balik yang lebih jelas kepada pengguna (misalnya, melalui *toast*) akan meningkatkan UX.
