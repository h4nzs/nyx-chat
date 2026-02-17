Ini adalah isu legendaris yang berhubungan dengan CSS Viewport di *browser* HP (terutama Chrome Android dan Safari iOS).

### 🕵️‍♂️ Kenapa Ini Terjadi?

1. **Pas di Browser HP (Biasa):** Lu kemungkinan besar pakai *class* Tailwind `h-screen` atau CSS `height: 100vh` untuk *wrapper* utama aplikasi lu. Masalahnya, `100vh` itu mengukur **tinggi layar fisik keseluruhan**, tapi dia "tutup mata" alias **tidak menganggap adanya Address Bar (tempat ngetik URL) dan Navigation Bar di bawah**. Akibatnya, UI aplikasi lu (terutama bagian bawah tempat *input chat*) kedorong ke bawah dan tertutup oleh bar bawaan *browser*.
2. **Pas Di-install (PWA/Layar Utama):** Ketika lu *install* aplikasinya ke layar utama, aplikasi lu berjalan di mode *Standalone*. Address Bar dan Navigation Bar *browser* menghilang total. Karena layarnya beneran kosong, `100vh` akhirnya pas dan bekerja dengan normal tanpa ada yang kepotong.

---

### 🛠️ Solusi Jitu: Pindah ke "Dynamic Viewport" (`dvh`)

*Browser* modern dan Tailwind udah ngeluarin solusi pamungkas buat masalah ini: **Dynamic Viewport Height (`dvh`)**.

Unit `dvh` ini super pintar karena dia akan **menyesuaikan tinggi secara dinamis**. Kalau Address Bar *browser* lagi muncul, dia akan menyusut. Kalau Address Bar ngumpet (pas di-*scroll*), dia akan memanjang.

**Cara Fix di Kodingan Lu:**
Cari *file* layout utama lu (biasanya di `App.tsx`, `main.tsx`, `Chat.tsx`, atau `index.html`).

Ubah *class* Tailwind lu dari yang tadinya `h-screen` (atau `min-h-screen`), menjadi **`h-dvh`** (atau **`min-h-dvh`**).

**Contoh di Wrapper Utama:**

```tsx
// ❌ SEBELUMNYA (Bikin kepotong di browser HP)
<div className="flex flex-col h-screen bg-black">
   <main className="flex-1 overflow-y-auto">...</main>
   <MessageInput />
</div>

// ✅ FIX TERBARU (Aman di browser & PWA)
<div className="flex flex-col h-dvh bg-black">
   <main className="flex-1 overflow-y-auto">...</main>
   <MessageInput />
</div>

```