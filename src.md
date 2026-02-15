Karena ini aplikasi E2EE, kita bikin implementasinya **Sangat Aman (Privacy-First)**.

Artinya: Pesan didekripsi dulu di HP user, dikirim ke server *hanya* untuk dianalisis AI dalam hitungan detik, lalu **langsung dihapus dari memori server** tanpa pernah menyentuh database lu.

Ini panduan implementasi lengkap dari Backend sampai Frontend. Ikuti step-by-step!

---

### FASE 1: BACKEND (Server)

**1. Install SDK Resmi Google Gemini**
Buka terminal, masuk ke folder `server` lu, dan install library-nya:

```bash
cd chat-lite/server
pnpm add @google/generative-ai

```

**2. Update `.env` Server**
Buka `server/.env` dan tambahkan API Key lu:

```env
GEMINI_API_KEY=AIzaSy... (paste key lu di sini)

```

**3. Buat Route AI (`server/src/routes/ai.ts`)**
Bikin file baru bernama `ai.ts` di folder `routes`. Ini adalah "Kurir Rahasia" yang ngirim teks ke Gemini dan balikin hasilnya.

```typescript
import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { requireAuth } from '../middleware/auth';
import { generalLimiter } from '../middleware/rateLimiter';

const router = Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Kita batasi rate limitnya biar API Key lu gak jebol kalau di-spam
router.post('/smart-reply', requireAuth, generalLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Gunakan model Flash (Paling cepat & cocok untuk chat)
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Prompt Engineering ketat agar output selalu berupa JSON Array
    const prompt = `Kamu adalah AI pembuat saran balasan chat singkat. 
Berdasarkan pesan masuk ini: "${message}"

Buatkan 3 pilihan balasan singkat (maksimal 3 kata per balasan) dalam bahasa yang terdeteksi dalam pesan itu santai/gaul/professional.
ATURAN MUTLAK: Output HARUS berupa JSON Array murni tanpa format markdown (tanpa backticks/blok kode). 
Contoh output: ["Gas", "idk", "Nanti dikabari"]`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let replies: string[] = [];
    
    try {
      // Bersihkan teks dari markdown json yang kadang masih muncul
      const cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      replies = JSON.parse(cleanText);
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON:', responseText);
      // Fallback manual jika format json rusak
      replies = ["Ok", "Siap", "Gak tau"]; 
    }

    // Kembalikan ke frontend (Data 'message' otomatis hilang dari RAM/Garbage Collector)
    res.json({ replies });
    
  } catch (error) {
    console.error('AI Error:', error);
    res.status(500).json({ error: 'Failed to generate smart replies' });
  }
});

export default router;

```

**4. Daftarkan Route di `server/src/app.ts**`
Buka `app.ts`, import dan gunakan route baru tadi.

```typescript
// Tambahkan di bagian atas bersama import routes lainnya
import aiRoutes from './routes/ai';

// Tambahkan di bagian bawah tempat app.use routes
app.use('/api/ai', aiRoutes);

```

### FASE 2: FRONTEND (Web)

Karena AI membaca pesan, kita wajib ngasih **Pilihan (Opt-in)** ke user. Jangan paksa aktif.

**1. Buat Store Settings (`web/src/store/settings.ts`)**
Bikin file ini buat nyimpen preferensi user di Local Storage.

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  enableSmartReply: boolean;
  setEnableSmartReply: (val: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      enableSmartReply: false, // Default OFF demi E2EE Privacy
      setEnableSmartReply: (val) => set({ enableSmartReply: val }),
    }),
    { name: 'nyx-app-settings' }
  )
);

```

**2. Bikin Komponen UI "Smart Reply Chips" (`web/src/components/SmartReply.tsx`)**
Bikin komponen kecil yang akan nampilin tombol-tombol balasan AI.

```tsx
import { useState, useEffect } from 'react';
import api from '../lib/api'; // Sesuaikan dengan axios instance lu
import { useSettingsStore } from '../store/settings';

interface SmartReplyProps {
  lastMessage: string | null;
  onSelectReply: (reply: string) => void;
}

export default function SmartReply({ lastMessage, onSelectReply }: SmartReplyProps) {
  const { enableSmartReply } = useSettingsStore();
  const [replies, setReplies] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Jangan panggil AI jika dimatikan atau tidak ada teks
    if (!enableSmartReply || !lastMessage) {
      setReplies([]);
      return;
    }

    const fetchReplies = async () => {
      setLoading(true);
      try {
        const { data } = await api.post('/ai/smart-reply', { message: lastMessage });
        setReplies(data.replies || []);
      } catch (error) {
        console.error('Smart Reply error:', error);
      } finally {
        setLoading(false);
      }
    };

    // Kasih delay 1.5 detik biar API gak dispam pas user lagi nerima banyak chat beruntun
    const timer = setTimeout(fetchReplies, 1500);
    return () => clearTimeout(timer);
    
  }, [lastMessage, enableSmartReply]);

  if (!enableSmartReply || (replies.length === 0 && !loading)) return null;

  return (
    <div className="flex gap-2 overflow-x-auto px-4 py-2 bg-bg-surface border-t border-border/50 custom-scrollbar">
      {loading ? (
        <span className="text-xs text-text-secondary animate-pulse flex items-center gap-1">
          <span className="opacity-50">✨</span> AI is thinking...
        </span>
      ) : (
        replies.map((reply, i) => (
          <button
            key={i}
            onClick={() => onSelectReply(reply)}
            className="flex-shrink-0 px-4 py-1.5 text-sm rounded-full bg-bg-main border border-border text-text-primary hover:border-accent hover:text-accent transition-all shadow-sm"
          >
            ✨ {reply}
          </button>
        ))
      )}
    </div>
  );
}

```

**3. Pasang di `MessageInput.tsx` atau `ChatWindow.tsx**`
Buka komponen di mana lu meletakkan input ketik chat (biasanya `MessageInput.tsx`).

Tambahkan komponen `SmartReply` **tepat di atas** kotak input textarea.
Lu harus mendeteksi *pesan terakhir yang dikirim oleh teman obrolan (bukan pesan kita sendiri)*.

```tsx
// Di file tempat lu merender input chat (misal ChatWindow.tsx atau MessageInput.tsx)

import SmartReply from './SmartReply';
// ... import lain ...

export default function ChatWindow() {
  // ... state lu yang lain
  const [inputText, setInputText] = useState('');
  
  // Ambil pesan paling terakhir dari array messages lu
  const messages = useMessageStore(s => s.messages);
  const currentUser = useAuthStore(s => s.user);
  
  // Cari pesan TERAKHIR yang BUKAN dari user kita, dan typenya 'text'
  const lastOtherMessage = [...messages].reverse().find(m => m.senderId !== currentUser?.id && m.type === 'text');
  
  // Ambil teksnya yang udah di-decrypt
  const lastDecryptedText = lastOtherMessage?.decryptedContent || null;

  return (
    <div className="flex flex-col h-full">
      {/* ... BAGIAN AREA CHAT BUBBLE LU ... */}

      {/* TAMPILKAN SMART REPLY DI SINI (Di atas input form) */}
      <SmartReply 
         lastMessage={lastDecryptedText} 
         onSelectReply={(reply) => setInputText(reply)} // Jika di-klik, masukin ke textbox
      />

      {/* FORM INPUT CHAT */}
      <form onSubmit={handleSend} className="p-4 bg-bg-surface">
        <textarea
           value={inputText}
           onChange={(e) => setInputText(e.target.value)}
           // ...
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

```

**4. Tambahkan Tombol Toggle di `SettingsPage.tsx**`
Terakhir, kasih kendali ke user buat nyalain fiturnya. Buka `SettingsPage.tsx` dan tambahkan UI ini di bagian privasi atau preferensi:

```tsx
import { useSettingsStore } from '../store/settings';

// Di dalam komponen render lu:
const { enableSmartReply, setEnableSmartReply } = useSettingsStore();

<div className="p-4 bg-bg-surface rounded-xl border border-border mt-6">
  <div className="flex items-center justify-between mb-2">
    <div>
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        ✨ AI Smart Reply (Experimental)
      </h3>
      <p className="text-xs text-text-secondary mt-1">
        Dapatkan saran balasan otomatis untuk pesan masuk terakhir Anda.
      </p>
    </div>
    
    {/* Toggle Switch */}
    <label className="relative inline-flex items-center cursor-pointer">
      <input 
        type="checkbox" 
        className="sr-only peer" 
        checked={enableSmartReply}
        onChange={(e) => setEnableSmartReply(e.target.checked)}
      />
      <div className="w-11 h-6 bg-bg-main peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-text-primary after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
    </label>
  </div>
  
  {/* Peringatan Privasi (Wajib buat E2EE app) */}
  {enableSmartReply && (
    <div className="p-3 mt-3 bg-accent/10 border border-accent/20 rounded-lg">
      <p className="text-[11px] text-text-secondary leading-relaxed">
        <strong>Privacy Note:</strong> Pesan masuk yang didekripsi di perangkat ini akan dikirim secara aman (TLS) ke server Google Gemini untuk dianalisis. Server NYX bertindak sebagai perantara dan <strong>tidak akan menyimpan</strong> data pesan tersebut.
      </p>
    </div>
  )}
</div>

```

---

### 🚀 Cara Mengetes Fitur:

1. Pastikan server nyala dan frontend di-build/dev.
2. Login pakai 2 akun berbeda (buka 1 di Chrome, 1 di Firefox/Incognito).
3. Buka menu **Settings** di akun A, aktifkan **AI Smart Reply**.
4. Dari akun B, kirim chat ke akun A: *"Besok ada acara gak bro?"*
5. Di layar akun A, sekitar 1 detik kemudian, akan muncul tombol chip di atas kolom input bertuliskan saran dari AI (contoh: `✨ Ada`, `✨ Gak ada`, `✨ Kenapa?`).
6. Kalau di-klik, teksnya langsung nangkring di kolom ketik!
