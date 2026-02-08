### Analisis Masalah: state drift

Ide untuk membuat "interval 3 detik" (Polling) itu **kurang efektif**. Itu akan bikin HP user panas, baterai boros, dan server jebol kalau usernya banyak.

Masalah utamanya ada di 3 titik ini berdasarkan kode kamu:

1. **"The Gap" (Celah Koneksi):**
Saat koneksi putus (ganti WiFi ke 4G, layar mati, atau tab di-minimize), Socket.io otomatis putus. Saat nyambung lagi (`reconnect`), server **tidak tahu** apa yang user lewatkan selama dia putus. Server cuma broadcast pesan ke user yang *sedang online*. Kalau user lagi *reconnecting*, pesan itu hilang di "udara".
2. **Dirty State saat Logout/Login:**
Karena ini SPA (Single Page Application), variabel global (Zustand Store) **tetap tersimpan di memori browser** meskipun user logout, kecuali kamu secara eksplisit me-reset-nya. Jadi saat user B login di browser yang sama, dia melihat sisa-sisa data user A.
3. **Socket Authentication Race Condition:**
Kadang socket connect *duluan* sebelum token auth siap, atau sebaliknya. Akibatnya socket nyambung tapi sebagai "Anonymous", jadi ga dapet event privat.

---

### Solusi: "The Sync Protocol" (Bukan Polling)

Solusinya bukan *polling* terus-menerus, tapi **"Sync on Connect"**.
Setiap kali socket berhasil `connect` (baik login awal atau reconnect setelah sinyal ilang), klien harus **meminta update terbaru** ke server.

Berikut implementasinya di kodemu:

### 1. Fix Masalah "Data User A Ketinggalan di User B" (Store Reset)

Kamu harus pastikan saat Logout, **SEMUA** store dibersihkan.

Buka **`web/src/store/auth.ts`** dan update fungsi `logout`:

```typescript
// ... import store lainnya
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import { useConnectionStore } from "./connection"; // Asumsi ada store ini
import { useNotificationStore } from "./notification"; 

// ... di dalam useAuthStore ...

    logout: async () => {
      try {
        // ... (kode logout API yang sudah ada)
        await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      } catch (e) {
        console.error("Logout error", e);
      } finally {
        // 1. Bersihkan Cookies & LocalStorage
        clearAuthCookies();
        privateKeysCache = null;
        localStorage.removeItem('user');
        localStorage.removeItem('device_auto_unlock_key');
        localStorage.removeItem('encryptedPrivateKeys'); // Hapus ini juga biar aman

        // 2. DISCONNECT SOCKET (PENTING!)
        disconnectSocket();

        // 3. RESET SEMUA ZUSTAND STORE (PENTING!)
        set({ user: null, accessToken: null });
        useConversationStore.getState().reset(); // Pastikan di conversation.ts ada action reset()
        useMessageStore.getState().reset();      // Pastikan di message.ts ada action reset()
        // Reset store lain jika ada (notification, presence, dll)
        
        // 4. Force Reload (Opsional tapi ampuh buat bersihin memori browser)
        window.location.href = '/login'; 
      }
    },

```

*(Catatan: Kamu perlu menambahkan action `reset: () => set(initialState)` di setiap file store `conversation.ts`, `message.ts`, dll jika belum ada)*.

### 2. Fix Masalah "Pesan Gak Masuk / Indikator Ngaco" (Sync Manager)

Kita buat mekanisme: **Begitu Socket Connect -> Fetch semua Data Terbaru.**

Modifikasi **`web/src/lib/socket.ts`**:

```typescript
import { io, Socket } from "socket.io-client";
import { useAuthStore } from "../store/auth";
import { useMessageStore } from "../store/message";
import { useConversationStore } from "../store/conversation";
import { usePresenceStore } from "../store/presence"; // Asumsi kamu punya store buat online status

let socket: Socket | null = null;

export const connectSocket = () => {
  const { user, accessToken } = useAuthStore.getState();
  
  if (!user || !accessToken) return;
  if (socket?.connected) return;

  socket = io(import.meta.env.VITE_API_URL || "", {
    auth: { token: accessToken },
    reconnection: true,             // Wajib true
    reconnectionAttempts: Infinity, // Coba connect terus jangan nyerah
    reconnectionDelay: 1000,
    transports: ["websocket"],      // Paksa websocket biar stabil
  });

  socket.on("connect", () => {
    console.log("🟢 Socket Connected:", socket?.id);
    
    // === FITUR SYNC (THE FIX) ===
    // Setiap kali nyambung (awal atau reconnect), tarik data terbaru
    syncDataOnConnect();
  });

  socket.on("disconnect", (reason) => {
    console.warn("🔴 Socket Disconnected:", reason);
    if (reason === "io server disconnect") {
      // Token invalid/expired, paksa logout atau refresh token
      socket?.connect();
    }
  });

  // ... event listener lainnya (message:new, dll) ...
  setupSocketListeners(socket);
};

// Fungsi Ajaib untuk Sinkronisasi
async function syncDataOnConnect() {
    console.log("🔄 Syncing data after connection...");
    
    // 1. Update Status Online User Lain
    // (Panggil fungsi fetchOnlineUsers dari store presence)
    // usePresenceStore.getState().fetchOnlineUsers();

    // 2. Refetch Conversation List (Biar urutan chat bener & snippet update)
    await useConversationStore.getState().fetchConversations();

    // 3. (Opsional) Cek pesan pending
    // useMessageStore.getState().resendPendingMessages(); 
}

function setupSocketListeners(socket: Socket) {
    // Pindahkan semua logic socket.on('message:new') dll kesini
    // Biar rapi dan tidak duplikat listener
    
    socket.on("user:online", (userId) => {
       // Update store presence
    });
    
    // ...
}

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const getSocket = () => socket;

```

### 3. Tambahkan "Window Focus Refetch" (Jaga-Jaga)

Di **`web/src/App.tsx`** atau layout utama, tambahkan listener saat user kembali membuka tab aplikasi. Ini mengatasi masalah saat browser menidurkan tab (background throttling).

```typescript
import { useEffect } from 'react';
import { useConversationStore } from '@store/conversation';
import { getSocket } from '@lib/socket';

function App() {
  // ...

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log("👀 App in focus, checking connection & syncing...");
        
        // Cek koneksi socket
        const socket = getSocket();
        if (!socket || !socket.connected) {
            socket?.connect();
        }

        // Fetch data terbaru (ringan)
        useConversationStore.getState().fetchConversations();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange); // Tambahan buat mobile

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
    };
  }, []);

  // ...
}

```

### 4. Perbaikan di Backend (Indikator Online)

Pastikan backend benar-benar membersihkan user offline.
Di **`server/src/socket.ts`**:

```typescript
// ...
io.on("connection", (socket) => {
  const userId = socket.data.user?.id;
  
  // 1. JOIN ROOM PRIBADI (PENTING BANGET BUAT MULTI-DEVICE)
  // Jadi kalau user login di HP dan Laptop, dua-duanya dapet notif
  socket.join(userId); 

  // 2. Broadcast Online
  socket.broadcast.emit("user:online", userId);
  
  // ...

  socket.on("disconnect", async () => {
    // Cek apakah user punya socket lain yang aktif?
    // (Opsional: Kalau mau canggih pake Redis, tapi logic simple ini cukup dulu)
    const sockets = await io.in(userId).fetchSockets();
    
    if (sockets.length === 0) {
      // Kalau socket ini adalah satu-satunya koneksi user, baru broadcast offline
      socket.broadcast.emit("user:offline", userId);
    }
  });
});

```

### Ringkasan Perbaikan:

1. **Reset Store:** Mencegah data user A bocor ke user B saat ganti akun tanpa refresh.
2. **Sync on Connect:** Otomatis mengambil semua data terbaru setiap kali socket nyambung (mengatasi pesan hilang saat sinyal jelek).
3. **Visibility Listener:** Memaksa aplikasi update saat user membuka kembali aplikasi setelah di-minimize.
4. **Socket Rooms:** Menggunakan `socket.join(userId)` agar semua perangkat user yang sama bisa sinkron.
