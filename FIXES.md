### ✨ 1. Animasi *Bubble Chat* (Pop-in & Layout Shift)

Sekarang, pas chat baru masuk, *bubble*-nya muncul gitu aja (kaku). Kita bakal bikin dia nge- *pop* dari bawah dengan efek *spring* (mantul dikit) ala iMessage.

**Buka `web/src/components/MessageBubble.tsx`:**

1. Tambahkan *import* ini di paling atas:
```tsx
import { motion } from 'framer-motion';

```


2. Ubah tag `<div>` pembungkus paling luar menjadi `<motion.div>` dan tambahkan properti animasinya.

**Cari baris ini (sekitar baris 63):**

```tsx
    <div 
      className={classNames("flex items-end gap-3 group mb-3", { 
        "justify-end": isOwn, 
        "justify-start": !isOwn 
      })}
    >

```

**Ubah menjadi:**

```tsx
    <motion.div 
      layout // Bikin bubble lama otomatis geser mulus pas ada bubble baru
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ 
        type: "spring", 
        stiffness: 250, 
        damping: 20, 
        mass: 0.5 
      }}
      className={classNames("flex items-end gap-3 group mb-3 origin-bottom", { 
        "justify-end": isOwn, 
        "justify-start": !isOwn,
        "origin-bottom-right": isOwn,
        "origin-bottom-left": !isOwn
      })}
    >

```

*Gak lupa tutup tag paling bawahnya juga diubah dari `</div>` jadi `</motion.div>` ya.*

---

### 📳 2. *Sensory Feedback* (SFX Suara & Getaran)

Aplikasi chat premium selalu ngasih *feedback* ke indera pendengaran dan sentuhan *user*. Pas lu neken tombol *Send*, HP harusnya bergetar halus (*haptic*) dan bunyi "Swoosh".

**A. Bikin file Utility baru (`web/src/utils/feedback.ts`):**
Buat nanganin bunyi dan getaran tanpa bikin kodingan komponen lu berantakan.

```typescript
export const playHaptic = (pattern: number | number[] = 50) => {
  // Cek apakah browser & HP support fitur getar (Haptic Feedback)
  if (typeof window !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
};

export const playSound = (type: 'send' | 'receive' | 'delete') => {
  // Syarat: Lu harus siapin file mp3 pendek di folder public/sounds/
  const audio = new Audio(`/sounds/${type}.mp3`);
  audio.volume = 0.3; // Jangan terlalu keras biar elegan
  
  // Tangkap error kalau browser ngeblok auto-play audio
  audio.play().catch(() => {
    console.log("Audio play di-block oleh browser (butuh interaksi user dulu)");
  });
};

export const triggerSendFeedback = () => {
  playHaptic([20, 30, 20]); // Getar halus ala ketikan
  playSound('send');
};

export const triggerReceiveFeedback = () => {
  playHaptic(50); // Getar tek 1 kali
  playSound('receive');
};

```

**B. Pasang di `MessageInput.tsx`:**
Panggil fungsi getarnya pas *user* ngeklik kirim.

```tsx
import { triggerSendFeedback } from '../utils/feedback'; // Import ini

// Di dalam fungsi handleSubmit:
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasText || !isConnected) return;
    
    triggerSendFeedback(); // 🔥 Panggil di sini!
    
    onSend({ content: text });
    setText('');
    clearTypingLinkPreview();
  };

```

*(Buat suaranya, lu bisa *download* aset suara *UI chat* pendek (durasi 0.5 detik) gratis dari situs kayak Pixabay, kasih nama `send.mp3` dan `receive.mp3`, terus taruh di folder `web/public/sounds/`)*.

---

### 💀 3. *Skeleton Loading* saat Buka Chat

Saat lu pindah obrolan, kadang ada *delay* beberapa milidetik buat narik *history* chat dari *database* atau memori. Jangan tampilin layar kosong. Kita kasih *Skeleton* (kotak abu-abu berkedip) biar terkesan prosesnya cepet.

Lu bisa bikin komponen `MessageSkeleton.tsx`:

```tsx
import { motion } from 'framer-motion';

export default function MessageSkeleton() {
  return (
    <div className="w-full flex flex-col gap-4 p-4 opacity-60">
      {/* Skeleton Pesan Masuk */}
      <div className="flex items-end gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-white/5 animate-pulse"></div>
        <div className="w-48 h-12 rounded-2xl rounded-tl-none bg-white/5 animate-pulse"></div>
      </div>
      
      {/* Skeleton Pesan Keluar */}
      <div className="flex items-end gap-3 justify-end">
        <div className="w-32 h-10 rounded-2xl rounded-tr-none bg-accent/20 animate-pulse"></div>
      </div>

      {/* Skeleton Pesan Masuk Panjang */}
      <div className="flex items-end gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-white/5 animate-pulse"></div>
        <div className="w-64 h-16 rounded-2xl rounded-tl-none bg-white/5 animate-pulse"></div>
      </div>
    </div>
  );
}

```

Lalu panggil komponen ini di `ChatWindow.tsx` (atau file tempat lu ngerender kumpulan `MessageBubble`) pas status `isLoading` lagi *true*.
