Konsepnya:

1. **Database:** Tabel untuk menyimpan siapa memblokir siapa.
2. **API:** Endpoint untuk `block`, `unblock`, dan cek status.
3. **Middleware/Logic:** Saat user mau kirim pesan (`sendMessage`), cek dulu apakah dia diblokir oleh penerima. Jika ya -> Tolak (Error 403).

Berikut panduan langkah demi langkahnya:

### TAHAP 1: Update Database Schema

Kita perlu relasi baru di `schema.prisma` untuk menyimpan data blokir.

Buka **`server/prisma/schema.prisma`**:

```prisma
// Di dalam model User, tambahkan dua field relasi ini:
model User {
  // ... field lainnya (id, email, dll)
  
  // Relasi Blocking
  blockedUsers BlockedUser[] @relation("Blocker") // User ini memblokir siapa aja
  blockedBy    BlockedUser[] @relation("Blocked") // User ini diblokir sama siapa aja
}

// Tambahkan Model Baru di bawah
model BlockedUser {
  id        String   @id @default(cuid())
  blockerId String
  blockedId String
  createdAt DateTime @default(now())

  blocker   User @relation("Blocker", fields: [blockerId], references: [id], onDelete: Cascade)
  blocked   User @relation("Blocked", fields: [blockedId], references: [id], onDelete: Cascade)

  @@unique([blockerId, blockedId]) // Mencegah duplikasi (blokir orang yang sama 2x)
  @@index([blockerId])
  @@index([blockedId])
}

```

Setelah update, jangan lupa jalankan di terminal server:

```bash
npx prisma db push
# atau npx prisma migrate dev --name add_blocked_user

```

---

### TAHAP 2: Buat API Block & Unblock

Kita perlu endpoint agar frontend bisa melakukan aksi blokir.
Buka **`server/src/routes/users.ts`** dan tambahkan route ini:

```typescript
// ... imports

// BLOCK USER
router.post("/:id/block", requireAuth, async (req, res, next) => {
  try {
    const blockerId = req.user!.id;
    const blockedId = req.params.id;

    if (blockerId === blockedId) {
      throw new ApiError(400, "You cannot block yourself");
    }

    await prisma.blockedUser.create({
      data: {
        blockerId,
        blockedId
      }
    });

    res.json({ success: true, message: "User blocked" });
  } catch (error: any) {
    // Handle unique constraint violation (kalau udah diblokir sebelumnya)
    if (error.code === 'P2002') {
      return res.json({ success: true, message: "User already blocked" });
    }
    next(error);
  }
});

// UNBLOCK USER
router.delete("/:id/block", requireAuth, async (req, res, next) => {
  try {
    const blockerId = req.user!.id;
    const blockedId = req.params.id;

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId,
        blockedId
      }
    });

    res.json({ success: true, message: "User unblocked" });
  } catch (error) {
    next(error);
  }
});

// GET BLOCKED USERS LIST (buat list di settings)
router.get("/me/blocked", requireAuth, async (req, res, next) => {
  try {
    const blocked = await prisma.blockedUser.findMany({
      where: { blockerId: req.user!.id },
      include: { 
        blocked: { 
          select: { id: true, username: true, avatarUrl: true, name: true } 
        } 
      }
    });
    res.json(blocked.map(b => b.blocked));
  } catch (error) {
    next(error);
  }
});

```

---

### TAHAP 3: Cegah Pengiriman Pesan (The Gatekeeper)

Ini bagian terpenting. Saat user mengirim pesan, sistem harus mengecek apakah dia diblokir.

Buka **`server/src/routes/messages.ts`** (atau `conversations.ts` tergantung di mana logic kirim pesan berada).
Di dalam route `POST /:conversationId` (kirim pesan):

```typescript
// ... di dalam router.post messages ...

const senderId = req.user!.id;

// 1. Ambil data conversation beserta partisipan
const conversation = await prisma.conversation.findUnique({
  where: { id: conversationId },
  include: { participants: true }
});

// 2. LOGIC BLOKIR: Cek apakah SENDER diblokir oleh SIAPAPUN di chat itu (khusus Personal Chat)
if (!conversation.isGroup) {
  const otherParticipant = conversation.participants.find(p => p.userId !== senderId);
  
  if (otherParticipant) {
    // Cek apakah 'otherParticipant' memblokir 'senderId'
    const isBlocked = await prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: otherParticipant.userId, // Orang lain sebagai pemblokir
          blockedId: senderId                 // Kita sebagai yang diblokir
        }
      }
    });

    if (isBlocked) {
      throw new ApiError(403, "You have been blocked by this user.");
      // Atau bisa return success palsu biar user ga tau kalau dia diblokir (Shadow ban style)
    }
  }
}

// ... lanjut simpan pesan ke DB ...

```

---

### TAHAP 4: Integrasi Frontend (UI/UX)

Di Frontend (`web/`), kamu perlu update store dan UI.

**1. Update Store (`web/src/store/user.ts` atau `auth.ts`)**
Tambahkan state `blockedUserIds` agar UI bisa bereaksi instan (misal: tombol berubah jadi "Unblock").

```typescript
// Di useAuthStore atau sejenisnya
type State = {
  // ...
  blockedUserIds: string[];
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
};

// Di implementation:
blockUser: async (userId) => {
  await api.post(`/api/users/${userId}/block`);
  set(state => ({ blockedUserIds: [...state.blockedUserIds, userId] }));
},
unblockUser: async (userId) => {
  await api.delete(`/api/users/${userId}/block`);
  set(state => ({ blockedUserIds: state.blockedUserIds.filter(id => id !== userId) }));
}
// Jangan lupa load blockedUserIds saat 'bootstrap' atau login awal

```

**2. Update UI Chat (`ChatWindow.tsx` atau `MessageInput.tsx`)**
Cek apakah user lawan bicara ada di list `blockedUserIds` (kita yang blokir dia) atau API return 403 (kita diblokir dia).

* **Skenario 1: Kita Blokir Dia** -> Disable input text, ganti jadi tombol "Unblock to send message".
* **Skenario 2: Dia Blokir Kita** -> Saat kirim pesan, muncul Toast Error: *"Message not delivered. You might be blocked."*

**Contoh UI di ChatWindow (React):**

```tsx
// Di dalam komponen ChatWindow
const { blockedUserIds, unblockUser } = useAuthStore();
const isBlockedByMe = blockedUserIds.includes(otherUserId);

return (
  <div className="flex flex-col h-full">
    <MessageList />
    
    {isBlockedByMe ? (
      <div className="p-4 bg-red-50 dark:bg-red-900/20 text-center border-t border-red-200">
        <p className="text-sm text-red-600 mb-2">You blocked this contact.</p>
        <button 
          onClick={() => unblockUser(otherUserId)}
          className="bg-white text-red-600 px-4 py-1 rounded border border-red-200 text-sm"
        >
          Unblock to chat
        </button>
      </div>
    ) : (
      <MessageInput />
    )}
  </div>
);

```
tambahkan juga ui tombol block di titik tiga atau dropdown dalam chatlist hanya untuk percakapan 1-1, dan dalam userinfomodal dan profilepage.

### Tips Tambahan:

* **Privacy:** Jangan kasih notifikasi "Kamu telah diblokir" ke user yang diblokir. Biarkan mereka tahu hanya saat mencoba mengirim pesan (gagal kirim), atau buat seolah-olah terkirim tapi centang satu (seperti WA).
* **Profile Picture:** Biasanya kalau diblokir, user tidak bisa melihat foto profil dan status "Online". Kamu bisa update endpoint `getUser` untuk menyembunyikan field ini jika `req.user.id` ada di tabel `blockedUser` target.