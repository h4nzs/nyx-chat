Fitur **Disappearing Messages** (Pesan Hancur Sendiri) ini emang "fitur dewa" yang wajib ada di aplikasi privasi. Kalau E2EE ngebikin orang di tengah jalan (hacker/ISP) gak bisa baca, *Disappearing Messages* ngebikin jejak obrolan hilang selamanya dari *device* pengirim dan penerima.

Secara teknis, bikin fitur ini gampang-gampang susah karena lu harus ngehapus data di **dua tempat sekaligus**: di Server (Database) dan di Client (Layar HP User).

Ini rincian arsitektur dan detail eksekusinya buat aplikasi NYX lu:

---

### 🏛️ 1. Konsep Arsitektur (The Workflow)

Kita akan pakai skenario paling aman: **Waktu dihitung sejak pesan dikirim (Time after Sent)**, bukan sejak dibaca. Ini lebih konsisten dan gak bergantung sama status "Read" yang kadang nge-bug kalau jaringan jelek.

**Alurnya:**

1. Si A mau ngirim pesan rahasia. Dia milih durasi: "Hancur dalam 1 Menit".
2. Frontend ngirim *chat* terenkripsi ke Backend dengan tambahan *metadata*: `expiresIn: 60` (detik).
3. Backend nerima pesan, lalu ngitung: `expiresAt = Waktu Sekarang + 60 detik`. Data ini disimpen ke *database* Supabase.
4. Si B nerima pesan. Di layar si B (dan si A), muncul *icon* jam pasir atau *countdown* mundur.
5. Saat waktunya habis (0 detik):
* **Di Frontend:** React otomatis ngehapus pesan itu dari memori (Zustand) dan layar.
* **Di Backend:** Ada "Tukang Sapu" (Cron Job) yang jalan tiap menit buat nge-HAPUS PERMANEN pesan tersebut dari *database*.



---

### 🛠️ 2. Eksekusi Teknis (Apa Aja yang Harus Diubah?)

#### Fase A: Update Database (Prisma / Supabase)

Kita butuh satu kolom baru di tabel `messages` buat ngasih tau kapan pesan itu "kadaluarsa".

Di file `server/prisma/schema.prisma`, lu harus tambahin:

```prisma
model Message {
  id               String   @id @default(uuid())
  // ... kolom lu yang lain ...
  
  // Kolom baru: Null kalau pesan permanen, ada isinya kalau pesan bakal hancur
  expiresAt        DateTime? 
}

```

#### Fase B: Backend "The Sweeper" (Node.js)

Server lu butuh tugas latar belakang (*Background Job*) yang otomatis ngecek *database* dan ngebersihin sampah tiap menit.

Lu bisa install `node-cron` di server. Logikanya kira-kira begini:

```typescript
import cron from 'node-cron';
import { prisma } from './lib/prisma';
import { io } from './socket';

// Jalanin fungsi ini setiap 1 menit (* * * * *)
cron.schedule('* * * * *', async () => {
  const now = new Date();

  // 1. Cari pesan yang waktunya udah kelewat
  const expiredMessages = await prisma.message.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, conversationId: true }
  });

  if (expiredMessages.length > 0) {
    const messageIds = expiredMessages.map(m => m.id);

    // 2. HAPUS PERMANEN DARI DATABASE! (Gak ada ampun)
    await prisma.message.deleteMany({
      where: { id: { in: messageIds } }
    });

    // 3. (Opsional) Kasih tau Frontend lewat Socket.IO biar layar mereka update
    // "Woi client, pesan ID sekian udah hangus ya, hapus dari UI lu!"
    io.emit('messages_expired', { messageIds }); 
  }
});

```

#### Fase C: Frontend UI & Logic (React + Zustand)

Di *frontend*, lu harus ngasih tombol ke *user* buat milih durasi, dan ngasih efek visual kalau pesan itu mau hancur.

1. **Di `MessageInput.tsx`:**
Tambahin *icon* Jam. Kalau diklik, muncul *dropdown*: `Off`, `1 Menit`, `1 Jam`, `24 Jam`. Pilihan ini dikirim bareng isi pesan ke server.
2. **Di `MessageBubble.tsx`:**
Kalau pesan itu punya data `expiresAt`, lu bikin fungsi `setInterval` (atau pakai `requestAnimationFrame` biar *smooth*) buat nge-render sisa waktunya.
* *Contoh UI:* Di pojok *bubble chat* ada tulisan kecil warna merah: `⏱️ 00:45`.
* Kalau waktunya nyentuh 0, panggil fungsi dari *store* Zustand lu: `removeMessage(messageId)`, biar pesan itu bener-bener lenyap dari DOM HTML.



---

### ⚠️ 3. Edge Cases & Reality Check (Kacamata Hacker)

Sebagai *cyber enthusiast*, lu pasti mikir: *"Gimana kalau user ngakalin sistemnya?"*

Ini beberapa celah yang harus lu sadari dan terima (karena beberapa gak bisa di- *fix* dari sisi *developer*):

* **Screenshot & Screen Record Bypass:** Lu gak bisa nyegah si penerima nge-*screenshot* HP-nya sebelum pesan hancur. (Bahkan Signal & Telegram pun cuma bisa ngasih *warning*, itupun sering tembus kalau pakai Android versi *root*). Solusi: Gak usah dipusingin, ini di luar kendali *app web*.
* **Airplane Mode Bypass:** Kalau pesan udah masuk ke layar si B, terus si B nyalain *Airplane Mode* (matiin internet). Cron Job di server lu emang bakal ngehapus pesan itu dari *database*, tapi pesan itu masih nangkring di RAM HP si B. Solusi: Pastikan logika `setInterval` di `MessageBubble.tsx` tetep jalan ngehapus *bubble* dari UI walaupun internet mati.
* **Time Manipulation (Nipus Jam HP):** Kalau *user* mundurin jam di HP-nya, apakah pesannya gak jadi hancur? Solusi: Waktu `expiresAt` harus di- *generate* secara absolut dari waktu UTC Server, **BUKAN** dari waktu HP *user*.
