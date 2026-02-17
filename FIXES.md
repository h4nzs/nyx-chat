Ini adalah **Cetak Biru (Blueprint) Arsitektur Lengkap** untuk membuat Admin Dashboard *All-in-One* + Sistem Report Discord.

---

### 🏛️ TAHAP 1: Modifikasi Database (Prisma)

Kita butuh fondasi untuk membedakan mana *user* biasa, mana "Tuhan" (Elu sebagai Admin), dan siapa yang lagi kena hukuman.

Buka `server/prisma/schema.prisma` dan tambahkan ini di model `User`:

```prisma
model User {
  id                 String    @id @default(uuid())
  // ... kolom yang udah ada ...

  role               String    @default("USER") // Nanti lu ubah akun lu manual jadi "ADMIN" di DB
  bannedAt           DateTime? // Kalo null berarti aman, kalo ada isinya berarti dibanned
  banReason          String?   // Catatan buat nampilin pesan error pas dia mau login
}

```

*(Jangan lupa jalankan `npx prisma db push` setelah ini).*

---

### 🛡️ TAHAP 2: Kunci Pengaman Backend (Middleware)

Kita gak mau orang pintar *inspect element* nemu API *ban* dan iseng nge-klik. Bikin *middleware* baru di `server/src/middleware/auth.ts`:

```typescript
// Tambahkan di bawah fungsi requireAuth yang udah ada
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access Denied: Admins Only' });
    }
    next();
  } catch (error) {
    res.status(403).json({ error: 'Forbidden' });
  }
};

```

---

### 📡 TAHAP 3: Backend API (The Engine)

Kita akan bikin *file* *route* baru khusus admin: `server/src/routes/admin.ts`. Di sini kita kumpulkan semua utilitasnya.

#### A. Endpoint: Status Sistem (VPS, DB, R2)

Kita akan pakai *library* bawaan Node.js (`os`) untuk baca RAM/CPU VPS lu, Prisma untuk baca statistik *database*, dan AWS SDK (S3) untuk baca *storage* R2.

```typescript
import os from 'os';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { s3Client } from '../utils/r2'; // Sesuaikan dengan config R2 lu
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

const router = Router();

router.get('/system-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 1. VPS METRICS (RAM & Uptime)
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const vps = {
      ramUsage: `${(usedMem / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
      uptime: `${(os.uptime() / 3600).toFixed(1)} Hours`,
      cpuLoad: os.loadavg(), // Rata-rata beban CPU
    };

    // 2. DATABASE METRICS (Prisma)
    const db = {
      totalUsers: await prisma.user.count(),
      totalMessages: await prisma.message.count(),
      bannedUsers: await prisma.user.count({ where: { bannedAt: { not: null } } }),
      activeGroups: await prisma.conversation.count({ where: { isGroup: true } }),
    };

    // 3. CLOUDFLARE R2 STORAGE METRICS
    // Hitung total file dan ukurannya di bucket
    const command = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME });
    const r2Data = await s3Client.send(command);
    let totalSize = 0;
    r2Data.Contents?.forEach(item => { totalSize += item.Size || 0; });
    const storage = {
      totalFiles: r2Data.KeyCount || 0,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2) + ' MB'
    };

    res.json({ vps, db, storage });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system metrics' });
  }
});

```

#### B. Endpoint: Ban & Unban User

Masih di file `admin.ts` yang sama:

```typescript
import { getIo } from '../socket';

router.post('/ban', requireAuth, requireAdmin, async (req, res) => {
  const { userId, reason } = req.body;
  await prisma.user.update({
    where: { id: userId },
    data: { bannedAt: new Date(), banReason: reason }
  });

  // KICK USER DARI SOCKET (Disconnect paksa)
  const io = getIo();
  io.to(`user_${userId}`).emit('auth:banned', { reason }); // Kasih tau frontend buat logout
  io.sockets.sockets.forEach((socket) => {
    if (socket.data.userId === userId) socket.disconnect(true);
  });

  res.json({ message: 'User banned successfully' });
});

router.post('/unban', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body;
  await prisma.user.update({
    where: { id: userId },
    data: { bannedAt: null, banReason: null }
  });
  res.json({ message: 'User unbanned successfully' });
});

```

#### C. Endpoint: Report to Discord (`routes/reports.ts`)

Update file `server/src/routes/reports.ts` lu:

```typescript
router.post('/user', requireAuth, async (req, res) => {
  const { reportedUserId, reason } = req.body;
  const reporter = req.user;

  const reportedUser = await prisma.user.findUnique({ where: { id: reportedUserId } });

  const discordPayload = {
    embeds: [{
      title: "🚨 NEW USER REPORT",
      color: 16711680, // Merah
      fields: [
        { name: "Reporter", value: `${reporter.username} (${reporter.id})` },
        { name: "Reported User", value: `${reportedUser?.username} (${reportedUserId})` },
        { name: "Reason", value: reason },
      ],
      timestamp: new Date().toISOString(),
    }]
  };

  // Tembak ke Webhook Discord
  await fetch(process.env.DISCORD_REPORT_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(discordPayload)
  });

  res.json({ success: true });
});

```

---

### 🛑 TAHAP 4: Satpam Login (Update `routes/auth.ts`)

Pas *user* nyoba login, cek apakah dia di-banned.

```typescript
// Di dalam rute POST /login, setelah nyari user dari DB
if (user.bannedAt) {
  return res.status(403).json({ 
    error: 'ACCESS DENIED: Your account has been suspended.',
    reason: user.banReason 
  });
}

```

---

### 💻 TAHAP 5: Frontend UI (The Dashboard)

#### 1. Tombol Report di Modal Profil

Buka `web/src/components/UserInfoModal.tsx`. Tambahin tombol merah "Report Signal". Kalau diklik, munculin form `prompt` (atau modal kecil) minta alasan, lalu tembak API `POST /api/reports/user`.

#### 2. Halaman Mission Control (`AdminDashboard.tsx`)

Bikin satu rute rahasia, misal `/admin-console`. Desain pakai *grid* keren yang menampilkan metrik-metrik tadi.

```tsx
import { useEffect, useState } from 'react';
import api from '../lib/api';

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState<any>(null);
  const [searchId, setSearchId] = useState('');

  useEffect(() => {
    // Ambil data sistem pas halaman dibuka
    api.get('/admin/system-status').then(res => setMetrics(res.data));
  }, []);

  const handleBan = async () => {
    const reason = prompt("Enter ban reason:");
    if (!reason) return;
    await api.post('/admin/ban', { userId: searchId, reason });
    alert("User Banned & Kicked!");
  };

  if (!metrics) return <div>Loading System Metrics...</div>;

  return (
    <div className="p-8 text-white font-mono">
      <h1 className="text-2xl text-accent mb-6">NYX MISSION CONTROL</h1>
      
      {/* Grid Statistik */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-bg-surface p-4 rounded-xl border border-white/10">
          <h3 className="text-sm opacity-50 mb-2">VPS RAM USAGE</h3>
          <p className="text-xl font-bold">{metrics.vps.ramUsage}</p>
        </div>
        <div className="bg-bg-surface p-4 rounded-xl border border-white/10">
          <h3 className="text-sm opacity-50 mb-2">ACTIVE DB USERS</h3>
          <p className="text-xl font-bold">{metrics.db.totalUsers}</p>
        </div>
        <div className="bg-bg-surface p-4 rounded-xl border border-white/10">
          <h3 className="text-sm opacity-50 mb-2">R2 STORAGE SIZE</h3>
          <p className="text-xl font-bold text-blue-400">{metrics.storage.totalSizeMB}</p>
        </div>
      </div>

      {/* Control Panel Ban */}
      <div className="bg-bg-surface p-6 rounded-xl border border-red-500/20">
        <h2 className="text-lg text-red-500 mb-4">ENFORCEMENT SYSTEM</h2>
        <div className="flex gap-4">
          <input 
            type="text" 
            placeholder="Target User ID..." 
            className="bg-bg-main p-2 rounded text-white flex-1"
            value={searchId}
            onChange={(e) => setSearchId(e.target.value)}
          />
          <button onClick={handleBan} className="bg-red-500 px-4 py-2 rounded text-white font-bold hover:bg-red-600">
            BAN SIGNAL 🔨
          </button>
        </div>
      </div>
    </div>
  );
}

```
