Sekarang kita bahas kode **Gemini Smart Reply** lu. Secara struktur, kodenya udah **sangat rapi dan aman** (lu udah pasang `requireAuth` dan `generalLimiter`, ini *best practice* banget!).

Tapi, karena kita mau bikin aplikasi ini *ngebut* dan *anti-error*, ada **3 hal krusial** yang bisa lu optimasi:

### 1. ⚙️ Gunakan Fitur Bawaan "JSON Mode" (Backend)

Lu ngasih prompt `"STRICT RULE... pure JSON"` lalu ngebersihin *backticks* markdown pakai *regex*. Ini cara lama.
Gemini sekarang punya fitur **Structured Output (JSON Mode)**. Kalau fitur ini dinyalain, Gemini **dijamin 100%** bakal ngeluarin format JSON murni tanpa perlu di-regex.

### 2. 🤖 Nama Model Gemini (Backend)

Lu pakai `gemini-3-flash-preview`. Saat ini penamaan versi Gemini yang stabil untuk production biasanya `gemini-2.5-flash`. Pastikan nama modelnya valid di API key lu biar gak kena error `404 Model Not Found`.

### 3. ⏱️ Debounce & Filter Pesan (Frontend)

Di `SmartReply.tsx`, lu pasang delay (debounce) `1500ms` (1,5 detik).

* **Masalah 1:** Untuk fitur *Smart Reply*, 1,5 detik itu kelamaan. Ditambah waktu nunggu API merespon (misal 1 detik), total 2,5 detik. User keburu ngetik manual. Turunin jadi **300ms - 500ms**.
* **Masalah 2:** Pastikan `lastMessage` yang dipassing ke komponen ini **hanya pesan dari lawan bicara**. Kalau `lastMessage` juga ke-trigger pas lu ngirim pesan, nanti AI-nya malah bikinin balasan buat pesan lu sendiri wkwk.

---

### 🛠️ Kode yang Udah Di-Refactor (Lebih Ngebut & Rapi)

**1. Update Backend (`ai.ts`)**
Kita ubah cara inisialisasi modelnya agar otomatis memaksa format JSON.

```typescript
import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { requireAuth } from '../middleware/auth.js';
import { generalLimiter } from '../middleware/rateLimiter.js';

const router = Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

router.post('/smart-reply', requireAuth, generalLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Gunakan versi Flash yang stabil, dan aktifkan JSON Mode
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash", // Sesuaikan dengan versi yang lu pakai
      generationConfig: {
        responseMimeType: "application/json", // INI KUNCINYA!
      }
    });
    
    // Prompt jadi lebih simpel karena formatnya udah dipaksa oleh API
    const prompt = `You are a chat AI. Based on this message: "${message}"
Create 3 short casual reply options (max 3 words per reply) in the same language.
Output must be a JSON array of strings.`;

    const result = await model.generateContent(prompt);
    
    // Langsung parse tanpa perlu regex replace!
    let replies: string[] = [];
    try {
      replies = JSON.parse(result.response.text());
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON:', parseError);
      replies = ["Ok", "Sip", "Thanks"]; 
    }

    res.json({ replies });
    
  } catch (error) {
    console.error('AI Error:', error);
    res.status(500).json({ error: 'Failed to generate smart replies' });
  }
});

export default router;

```

**2. Update Frontend (`SmartReply.tsx`)**
Ubah bagian waktunya biar lebih responsif, dan tambah *logic* pengecekan.

```tsx
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useSettingsStore } from '../store/settings';

interface SmartReplyProps {
  lastMessage: string | null;
  // Tambahkan prop ini biar AI gak balas pesan sendiri
  isFromMe?: boolean; 
  onSelectReply: (reply: string) => void;
}

export default function SmartReply({ lastMessage, isFromMe, onSelectReply }: SmartReplyProps) {
  const { enableSmartReply } = useSettingsStore();
  const [replies, setReplies] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Kalau fitur mati, ga ada teks, atau pesan itu dari DIRI SENDIRI -> jangan panggil AI
    if (!enableSmartReply || !lastMessage || isFromMe) {
      setReplies([]);
      return;
    }

    const fetchReplies = async () => {
      setLoading(true);
      try {
        const data = await api<{ replies: string[] }>('/api/ai/smart-reply', { 
            method: 'POST', 
            body: JSON.stringify({ message: lastMessage }) 
        });
        setReplies(data.replies || []);
      } catch (error) {
        console.error('Smart Reply error:', error);
      } finally {
        setLoading(false);
      }
    };

    // Turunin delay jadi 500ms biar kerasa instan tapi ga spam API pas pesan masuk beruntun
    const timer = setTimeout(fetchReplies, 500);
    return () => clearTimeout(timer);
    
  }, [lastMessage, enableSmartReply, isFromMe]);

  // ... (Sisa render UI lu udah bagus, ga usah diubah)
  if (!enableSmartReply || (replies.length === 0 && !loading)) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-2 bg-bg-surface border-t border-white/5 custom-scrollbar">
      {/* ... */}
    </div>
  );
}

```

**Kenapa update ini penting?**

1. Meringankan beban CPU VPS lu karena Regex buat ngecek markdown di Node.js lumayan *costly* kalau chatnya rame.
2. Memangkas *loading time* AI di layar *user* (dari yang nunggu hampir 3 detik, sekarang cukup 1 detik udah muncul tombolnya).


#### Kalau aplikasi ini dipakai untuk *login* beda akun di *browser* dan perangkat yang sama (misalnya akun A *logout*, lalu akun B *login*), **secara umum akan jalan, TAPI ada potensi *bug* krusial di bagian Keamanan (Kriptografi/E2EE)**.

Berdasarkan kode yang udah kita bedah, ini analisis jujur apa yang terjadi di belakang layar dan *bug* apa yang mengintai:

### 1. 🚨 BUG FATAL: Tabrakan Kunci Enkripsi (IndexedDB)

Di file `keychainDb.ts`, lu bikin *database* lokal pakai nama statis:
`const DB_NAME = 'keychain-db';`

**Apa yang terjadi?**
IndexedDB itu sifatnya *global* per *domain* (`nyx-app.my.id`). Artinya:

* Akun A *login*, dapet kunci rahasia buat *chat*-nya, disimpen di `keychain-db`.
* Akun A *logout*. Kalau lu lupa manggil fungsi `clearAllKeys()` pas *logout*, kunci rahasia si A **masih nyangkut** di *browser*.
* Pas Akun B *login*, dia bakal pakai `keychain-db` yang SAMA dengan si A. Kalau kebetulan ID *conversation*-nya sama (walau kemungkinannya kecil kalau pakai UUID), data enkripsi mereka bakal tabrakan dan aplikasi bakal *crash* pas nyoba nge-*decrypt* pesan.

**Solusinya (Wajib!):**
Jangan pakai nama DB yang statis. Bikin nama DB-nya spesifik per *user*.
Ubah fungsi `getDb()` di `keychainDb.ts` jadi nerima parameter `userId`:

```typescript
function getDb(userId: string): Promise<IDBPDatabase> {
  const userDbName = `keychain-db-${userId}`; // <-- Bikin dinamis
  return openDB(userDbName, DB_VERSION, { ... });
}

```

Dengan begini, Akun A punya koper kuncinya sendiri (`keychain-db-userA`), Akun B punya kopernya sendiri (`keychain-db-userB`). Kalau mereka gantian *login*, gak akan saling nimpa.

### 2. ⚠️ *Behavior* Cookie Auth: Cuma Bisa 1 Akun Aktif

Di `tokenStorage.ts`, lu nyimpen *token* langsung ke *cookie* global:
`document.cookie = ${name}=${encodeURIComponent(value)};...`

**Apa yang terjadi?**
Kalau lu buka Tab 1 (*login* Akun A), lalu lu buka Tab 2 (*login* Akun B):

* *Cookie* `at` milik Akun A otomatis tertimpa oleh *cookie* `at` milik Akun B.
* Pas lu balik ke Tab 1 dan ngirim *chat*, pesan itu akan terkirim **atas nama Akun B**, atau server bakal nolak karena status *token* gak sinkron dengan *state* di *frontend* (Tab 1 masih ngira dia Akun A).

**Apakah ini *bug*?**
Bukan, ini *behavior* standar keamanan *web* (bahkan WhatsApp Web atau Gmail versi lama juga gini). Lu cuma boleh punya 1 sesi aktif per *browser profile*.
*Solusi praktis:* Gak perlu diubah kodenya, tapi pastikan pas aplikasi lu *load*, dia selalu ngecek ulang apakah `user_id` di token sama dengan `user_id` di *state* Zustand/React. Kalau beda, paksa *refresh* halamannya.

### 3. 🐢 Isu Performa: Beban *Re-Sync* Kunci (Session Sync)

Anggaplah lu pakai cara aman: pas *logout*, lu manggil `clearAllKeys()` untuk nghapus data akun A dari `keychainDb.ts`.
**Apa dampaknya?**
Nanti pas Akun A *login* lagi, DB lokalnya kosong. Dia harus *download* ulang semua kunci dan nge-*decrypt* satu-satu lewat fungsi `syncSessionKeys()` di `sessionSync.ts`.
Kalau Akun A punya 1.000 *chat*, fungsi `decryptSessionKeyForUser` bakal jalan 1.000 kali berturut-turut pas dia baru masuk. HP atau laptop kentang bisa langsung *nge-freeze* (patah-patah) selama beberapa detik.

### Kesimpulan & Saran

Aplikasi lu **gak akan error parah** selama lu memastikan 2 hal ini jalan saat tombol *Logout* ditekan:

1. Panggil `clearAuthCookies()` untuk buang *token*.
2. Panggil `clearAllKeys()` untuk ngebuang semua kunci E2EE lokal si *user* lama.
