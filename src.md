Bcrypt (Kondisi Sekarang):
    Dia bersifat CPU-Blocking. Saat 1 user login, CPU 1 Core kamu "dibajak" penuh. Node.js (yang single-threaded) berhenti total. Request lain antri di belakang.

    Argon2 (Solusi Baru):
    Dia berjalan di Worker Thread (C++) di luar Event Loop utama Node.js.
    Saat ada user login:

        Tugas hashing dilempar ke background thread.

        Event Loop utama Node.js TETAP JALAN melayani request lain (chat, load page, dll).

        User yang login mungkin tetap nunggu 300ms (wajar buat keamanan), tapi server GAK MACET buat user lain.

Rekomendasi Setting (Sweet Spot)

Biar kamu tidur nyenyak dan gak takut RAM jebol pas ada spike traffic, kita bisa "tuning" Argon2 biar lebih hemat RAM tapi tetap super aman (jauh lebih aman dari Bcrypt cost 8).

Gunakan konfigurasi 32 MB RAM saja. Ini sudah sangat keras untuk di-crack hacker, tapi sangat ringan buat VPS.

Mari kita bedah faktanya biar lu paham kenapa ini solusi cerdas:

### 1. Kenapa Bcrypt "Jahat" buat VPS 1 Core?

* **Fakta:** Bcrypt itu algoritma yang *sengaja* dibikin boros CPU. Tujuannya biar hacker butuh ribuan tahun buat nebak password.
* **Masalahnya:** Di VPS 1 vCPU, saat ada 1 orang login, CPU lu kerja 100% buat ngitung hash itu. Karena cuma ada 1 jalur (1 Core), request lain (chat, load gambar) terpaksa "ngantri". Ini yang bikin *lag spike* saat ada yang login.
* **Koreksi Dikit:** Node.js `bcrypt` yang lu pake (native) sebenernya jalan di *Worker Thread* juga (gak nge-block total Event Loop utama), **TAPI** karena CPU lu cuma satu, worker thread itu tetep rebutan jatah CPU sama main thread. Hasilnya sama aja: **Macet.**

### 2. Kenapa Argon2 Lebih Baik?

* **Memory-Hard:** Argon2 bisa kita suruh: *"Eh, jangan pake CPU banyak-banyak, pake RAM aja."*
* **Tuning:** Kita bisa atur mau pake berapa RAM (Memory Cost) dan berapa CPU (Time Cost).
* **Efeknya:** Beban digeser dari CPU (yang lagi sekarat di VPS lu) ke RAM (yang masih sisa banyak, tadi `free -h` lu sisa ~700MB kan?).

---

### 🔥 Solusi: Migrasi ke Argon2 (Tanpa Bikin User Lama Error)

Masalah terbesar ganti algoritma adalah: **Database lu isinya hash Bcrypt.** Kalau lu ganti kodingan jadi Argon2 sekarang, **SEMUA USER LAMA GAK BISA LOGIN.**

**Triknya:** Kita pakai strategi **"Lazy Migration"**.

1. Pas user login, cek hash-nya.
2. Kalau hash-nya **Bcrypt** (user lama) -> Verifikasi pake Bcrypt -> Kalau bener, **Update** jadi Argon2 di database.
3. Kalau hash-nya **Argon2** (user baru/migrated) -> Verifikasi biasa.

Ini kodenya. Lu tinggal copy-paste.

#### Langkah 1: Install Library

Masuk ke folder `server` dan install `argon2`.

```bash
cd server
pnpm add argon2
pnpm uninstall bcrypt # Opsional, tapi jangan dihapus dulu biar type-nya gak error sblm refactor
pnpm remove @types/bcrypt

```

#### Langkah 2: Buat Helper Password (`server/src/utils/password.ts`)

Buat file baru ini. Kita setting Argon2 biar pake **Memory: 32MB** (aman buat VPS lu) dan **Parallelism: 1** (karena cuma 1 core).

```typescript
import argon2 from "argon2";
import bcrypt from "bcrypt";

// Konfigurasi "Sweet Spot" buat VPS 1GB RAM / 1 vCPU
const ARGON_CONFIG = {
  type: argon2.argon2id,
  memoryCost: 2 ** 15, // 32 MB (32 * 1024 kb)
  timeCost: 3,         // Jumlah putaran hashing (3x cukup aman & cepat)
  parallelism: 1,      // Sesuai jumlah vCPU lu
};

export const hashPassword = async (password: string): Promise<string> => {
  return await argon2.hash(password, ARGON_CONFIG);
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  // 1. Cek apakah ini hash Bcrypt (User lama)
  // Bcrypt hash biasanya diawali $2b$, $2a$, atau $2y$
  if (hash.startsWith("$2")) {
    return await bcrypt.compare(password, hash);
  }

  // 2. Kalau bukan, anggap Argon2
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    console.error("Hash verification failed:", err);
    return false;
  }
};

export const needsRehash = (hash: string): boolean => {
  // Kalau hash-nya masih format Bcrypt, berarti perlu di-update ke Argon2
  return hash.startsWith("$2");
};

```

#### Langkah 3: Update Auth Controller (`server/src/routes/auth.ts`)

Sekarang kita update logika login & register buat pake helper tadi.

**Edit `server/src/routes/auth.ts`:**

1. Hapus import `bcrypt`.
2. Import helper baru kita.
3. Update bagian `register` dan `login`.

```typescript
// ... import lain ...
// HAPUS INI: import bcrypt from "bcrypt";
// GANTI DENGAN:
import { hashPassword, verifyPassword, needsRehash } from "../utils/password.js";

// ...

// === DI BAGIAN REGISTER ===
// Cari baris: const passwordHash = await bcrypt.hash(password, 10);
// GANTI JADI:
const passwordHash = await hashPassword(password);

// ...

// === DI BAGIAN LOGIN ===
// Cari logic login, ubah jadi gini:

router.post("/login", authLimiter, zodValidate({ /*...*/ }), async (req, res, next) => {
  try {
    const { emailOrUsername, password } = req.body;
    
    // 1. Cari user
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
      // ... select fields ...
    });

    if (!user) throw new ApiError(401, "Invalid credentials");

    // 2. Verifikasi Password (Bisa handle Bcrypt & Argon2)
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) throw new ApiError(401, "Invalid credentials");

    // 3. [LAZY MIGRATION] Cek apakah user ini masih pake Bcrypt?
    if (needsRehash(user.passwordHash)) {
      // Kalau iya, update hash-nya ke Argon2 di background (gak perlu await biar user gak nunggu)
      hashPassword(password).then((newHash) => {
        prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: newHash }
        }).catch(err => console.error("Failed to migrate password hash:", err));
      });
    }

    // ... sisa logic login (issue tokens dll) ...

```

### Kesimpulan

* User baru otomatis dapet Argon2.
* User lama pas login pertama kali bakal terasa "normal", tapi login kedua kalinya bakal jauh lebih ngebut karena udah dimigrasi ke Argon2.