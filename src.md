**MARKAS KOMANDO MENGUDARA! KITA UBAH MODE DARI PERTAHANAN KE PENYERANGAN (OFFENSIVE GOWTH)! 🚀🌍**

Lu udah punya senjata nuklir (*Double Ratchet, Zero-Knowledge, WebAuthn PRF*), pertahanan legal (*AGPL-3.0, CLA*), dan ranjau pelacak (*OSINT Watermarks*). Sekarang saatnya kita pamerin NYX ke dunia dan narik para agen intelijen (*developer & privacy enthusiasts*) buat nge-*star* dan berkontribusi di *repo* lu.

Di dunia *Open-Source*, lu nggak bisa promosi gaya *sales* panci. Lu harus promosi gaya **"Intellectual Flex" (Pamer Otak & Arsitektur)**.

Ini 4 Protokol Promosi Taktis (*Deployment Strategy*) untuk meledakkan GitHub lu:

### 📰 OPERASI 1: "THE MANIFESTO DROP" (Dev.to / Medium)

Jangan cuma bilang *"Hai, gw bikin chat app"*. Lu harus nyeritain **ALASAN (The Why)** kenapa lu bikin NYX. *Developer* suka cerita teknis tentang pemecahan masalah yang gila.

* **Taktik:** Tulis artikel dalam bahasa Inggris di Dev.to atau Hashnode.
* **Judul Menggoda:** *"I Built a Zero-Knowledge Messenger in React because WhatsApp is Lying to Us"* atau *"How I Implemented the Signal Protocol in Browser using WebAuthn PRF"*.
* **Isi Artikel:** Ceritain rasa frustrasi lu soal privasi, pamerin betapa susahnya nerapin *Double Ratchet* di JS, dan kasih *link* ke GitHub lu di akhir artikel dengan kalimat: *"I open-sourced the entire tactical engine here. Rip it apart or contribute."*

### 🕵️‍♂️ OPERASI 2: INFILTRASI SUBREDDIT (Reddit)

Reddit adalah sarang para *hacker, sysadmin*, dan *privacy freak*. Tapi mereka SANGAT BENCI orang jualan. Lu harus masuk pakai gaya "Minta *Feedback* Teknis".

* **Target Zona:** `r/selfhosted`, `r/privacy`, `r/reactjs`, `r/opensource`.
* **Taktik *Copywriting*:** Bikin *post* yang merendah tapi mematikan.
*"Hey r/selfhosted, I spent the last few months building NYX: an AGPL-3.0 tactical messenger. I managed to integrate WebAuthn PRF so the server literally has zero knowledge of the keys. It uses Libsodium for the Signal Protocol. Would love some brutal feedback from the security guys here on my architecture."*
* **Hasil:** Mereka bakal penasaran ngecek *code* lu buat nyari celah, tapi ujung-ujungnya malah kagum dan ngasih *Star* di GitHub.

### 🚀 OPERASI 3: THE "SHOW HN" STRIKE (Hacker News)

Hacker News (Y Combinator) adalah panggung paling bergengsi buat *developer* dunia. Kalau lu tembus halaman pertama di sini, GitHub lu bisa dapet 500-1000 *Stars* dalam semalam.

* **Taktik:** Bikin *post* dengan format `Show HN: NYX - Tactical Zero-Knowledge Messenger (WebAuthn + Double Ratchet)`.
* **Aturan Main:** *User* HN itu sangat kritis dan elit. Lu harus *standby* di kolom komentar buat ngejawab pertanyaan arsitektur mereka. Kalau mereka nanya *"Kenapa nggak pakai Matrix aja?"*, lu harus siapin jawaban telak (misal: *"Matrix is heavy, NYX is designed for ephemeral, lightweight tactical drops"*).

### 🎥 OPERASI 4: VISUAL RECON (Twitter / LinkedIn)

Orang malas baca kode kalau belum liat buktinya jalan. Lu harus ngasih "Visual Bukti".

* **Taktik:** Rekam layar lu (GIF atau video pendek 15 detik) yang nunjukin fitur paling "Black Ops" dari NYX.
* **Skenario Video:** Tunjukin layar pas lu *login* **TANPA PASSWORD** (cuma pakai sidik jari/FaceID lewat WebAuthn), lalu tunjukin panel *Developer Tools (IndexedDB)* lu yang isinya teks terenkripsi berantakan (bukti *Zero-Knowledge*).
* **Caption Twitter:** *"Passwordless. Zero-Knowledge. Signal Protocol in the Browser. NYX is fully open-source. Drop a ⭐ if you care about real privacy. [Link GitHub]"*

---

**INSTRUKSI EKSEKUSI JENDERAL:**
Jangan lakuin semuanya dalam satu hari. Ini operasi bertahap.
Saran gw: **Mulai dari Operasi 4 (bikin video GIF pendek) lalu taruh di `README.md` lu**, baru kita serang Reddit dan Dev.to.

Mau gw bantu tulisin struktur *draft* artikel Dev.to (Operasi 1) atau lu mau siapin amunisi visualnya (Operasi 4) dulu nih, Komandan? 🚀💀🔥

**Wah, lu bener-bener mau bawa NYX ke level *Enterprise* sejati nih! 🔥**

Untuk mencapai **Zero-Downtime Murni 100%** (user yang lagi ngetik *chat* nggak akan putus koneksinya pas lu *deploy* kode baru), kita butuh kombinasi 2 hal dari PM2:

1. **Cluster Mode:** PM2 bakal bikin *copy* aplikasi lu (misal 2-4 proses). Pas di-*reload*, dia bakal matiin proses ke-1, nyalain proses ke-1 dengan kode baru, tunggu sampai stabil, baru lanjut ke proses ke-2. Jadi *server* nggak pernah kosong.
2. **Dynamic CWD Resolution:** Kita pake *script* Node.js di dalam `ecosystem.config.js` buat maksa PM2 ngebaca letak *symlink* yang **baru**, bukan yang nyangkut di memori.

Ini rincian eksekusinya, gampang banget kok:

### 1. Bikin file `server/ecosystem.config.js`

Bikin file baru ini di dalam folder `server/` lu. Ini adalah file konfigurasi sakti yang bakal ngasih instruksi spesifik ke PM2.

```javascript
const fs = require('fs');

// KUNCI SAKTI: Kita paksa Node.js ngebaca lokasi asli dari symlink saat ini
// Jadi PM2 nggak bisa lagi dibohongin sama cache memori masa lalunya
const currentPath = fs.realpathSync('/root/nyx-app/server');

module.exports = {
  apps: [
    {
      name: 'nyx-api',
      script: 'dist/index.js',
      cwd: currentPath, // Selalu ngarah ke rilis terbaru (release_2026...)
      instances: 'max', // Nyalain Cluster Mode sesuai jumlah core CPU VPS lu
      exec_mode: 'cluster', // Aktifin Zero-Downtime Reload
      node_args: '--max-old-space-size=768',
      env: {
        NODE_ENV: 'production',
      },
      // Ngasih jeda biar PM2 yakin server udah siap sebelum matiin proses lama
      wait_ready: true,
      listen_timeout: 10000, 
      kill_timeout: 3000
    },
  ],
};

```

*(Jangan lupa buat masukin file `ecosystem.config.js` ini ke `deploy_package` di `deploy.yml` bagian Phase 4 lu, tambahin: `cp server/ecosystem.config.js deploy_package/server/`)*

### 2. Update `server/src/index.ts` (Biar PM2 Tau Server Udah Siap)

Karena di *ecosystem* kita pasang `wait_ready: true`, lu harus ngasih sinyal ke PM2 kalau *server* NYX lu udah beneran jalan (database udah konek, socket udah nyala) biar dia bisa matiin proses yang lama.

Cari bagian paling bawah di `server/src/index.ts` lu pas server mulai jalan (`httpServer.listen(...)`), tambahin `process.send('ready')`:

```typescript
httpServer.listen(port, () => {
  console.log(`🚀 Server ready at http://localhost:${port}`);
  
  // Sinyal ke PM2 kalau aplikasi udah siap nerima trafik (Zero-Downtime trigger)
  if (process.send) {
    process.send('ready');
  }
});

```

### 3. Update `deploy.yml` (Bagian Paling Bawah)

Sekarang, lu **nggak perlu lagi** ngebunuh PM2 pake `pm2 delete`. Kita cuma butuh merintahin PM2 buat ngebaca file *ecosystem* itu.

Ganti blok nomor 7 di `deploy.yml` lu jadi sangat elegan kayak gini:

```yaml
            # 7. RESTART PM2 (Zero Downtime Cluster Mode)
            echo "🚀 Reloading API with Ecosystem..."
            cd /root/nyx-app/server
            
            if pm2 describe nyx-api > /dev/null 2>&1; then
              # Proses udah ada? Reload file ecosystem-nya!
              # PM2 bakal ngebaca fs.realpathSync yang baru, dan ngelakuin rolling-restart
              pm2 reload ecosystem.config.js --update-env
            else
              # Proses belum ada? Start pakai ecosystem
              pm2 start ecosystem.config.js
            fi
            
            pm2 save --force

            # 8. BERSIH-BERSIH DISK (Simpan 3 rilis terakhir aja)
            echo "🧹 Cleaning up old releases..."
            cd /root/nyx-releases
            ls -dt * 2>/dev/null | tail -n +4 | xargs rm -rf || true
            
            echo "✅ Zero-Downtime Deployment Success!"

```

### 🧠 Apa yang Terjadi Pas Lu Push Nanti?

1. GitHub naruh rilis baru di `/root/nyx-releases/release_BARU`.
2. *Symlink* diubah ngarah ke `release_BARU`.
3. Skrip jalanin `pm2 reload ecosystem.config.js`.
4. PM2 ngebuka file itu, dia ngejalanin `fs.realpathSync`, dan sadar *"Oh, direktori nyx-app sekarang aslinya ada di release_BARU!"*.
5. PM2 ngebiarin proses *API* lama tetep hidup ngelayanin *user* yang lagi *chat*.
6. Di *background*, PM2 nyalain proses *API* baru di `release_BARU`.
7. Begitu *script* lu nembak `process.send('ready')`, PM2 langsung ngebunuh proses yang lama dengan mulus tanpa ada *request* yang gagal/putus.

### Tapi kalau tangan lu udah gatel pengen ngoding lagi, gw ada beberapa ide ekspansi buat NYX yang sejajar sama visi privasi lu:

### 1. NYX Desktop App (Tauri / Electron)

Aplikasi lu kan sekarang *web/PWA-based*. Gimana kalau kita bungkus jadi aplikasi *desktop native* yang super ringan? Buat lu yang sehari-hari *daily driver*-nya pakai Arch Linux, punya klien *chat* E2EE yang terintegrasi mulus di OS lu itu sebuah kepuasan tersendiri. Kita bisa pakai **Tauri** (berbasis Rust) biar RAM-nya super hemat, beda sama klien *chat* lain yang rakus memori.

### 2. Read-Triggered Disappearing Messages

Gw liat di tipe `Message` lu udah ada variabel `expiresAt` dan lu udah bikin fondasi *messageSweeper*. Gimana kalau kita matengin fitur *Self-Destruct* ini? Bedanya sama *Story*, pesan ini baru mulai nge-hitung mundur **setelah dibaca** sama penerimanya. Jadi pesannya bakal meledak dan hilang dari database lokal `shadowVaultDb` 5 menit setelah mata temen lu ngelihat pesannya.

# Kompresi video di browser memang dilematis karena standar API bawaan seperti Canvas atau WebCodecs tidak sekuat library eksternal (seperti FFmpeg.wasm yang ukurannya mencapai 20-30MB).

Berikut adalah 3 strategi untuk menangani kompresi video tanpa membuat user menunggu unduhan library yang sangat besar:
1. Gunakan Native WebCodecs API (Paling Ringan)
Browser modern sudah memiliki WebCodecs API. Ini adalah fitur bawaan (0 byte download) yang memungkinkan Anda mengakses hardware encoder perangkat user secara langsung.

* Kelebihan: Sangat cepat dan tanpa library tambahan.
* Kekurangan: Implementasinya cukup teknis (perlu mengatur VideoEncoder) dan dukungan browser belum 100% merata (terutama di browser lama).
* Rekomendasi: Gunakan library pembungkus yang sangat kecil seperti mp4box.js (sekitar 100KB) untuk membantu proses muxing (menggabungkan audio dan video).

2. Strategi Cloud-side Transcoding (Paling Cepat untuk User)
Jika aplikasi Anda adalah E2EE, mengompresi di server biasanya dilarang karena server tidak boleh melihat isi video. Namun, Anda bisa melakukan ini:

   1. User mengirim video asli (mungkin besar).
   2. Video dienkripsi secara lokal (E2EE tetap terjaga).
   3. Server menerima file terenkripsi.


* Masalah: Kuota user boros dan upload lama.
* Solusi: Berikan opsi kepada user: "Kirim Kualitas Tinggi (Lama)" atau "Kirim Cepat (Kompresi Lokal)".

3. Progressive Loading untuk FFmpeg.wasm (Hybrid)
Jika Anda tetap butuh FFmpeg karena fitur-fiturnya (seperti mengubah resolusi/bitrate secara presisi), lakukan optimasi berikut:

* Pre-fetch saat Idle: Jangan unduh FFmpeg saat user klik "Kirim Video". Gunakan service worker atau unduh di latar belakang segera setelah user login atau saat aplikasi dalam kondisi idle.
* Caching: Pastikan header Cache-Control pada file WASM diatur dengan benar agar user hanya perlu mengunduh 30MB itu satu kali saja selamanya (disimpan di disk browser).
* Gunakan Multi-thread Version: Pastikan menggunakan versi ffmpeg-shared yang mendukung multi-threading agar proses kompresi tidak membekukan browser.

4. Batasan Sederhana (The "Low-Tech" Way)
Terkadang, cara terbaik adalah membatasi input daripada memprosesnya:

* Gunakan atribut capture pada input file untuk memaksa kamera merekam dengan resolusi rendah.
* Cek ukuran file sebelum enkripsi. Jika > 50MB, peringatkan user atau sarankan untuk memotong durasinya (trimming) menggunakan API bawaan browser yang lebih ringan.

Rekomendasi Saya:
Mulailah riset tentang WebCodecs API. Ini adalah masa depan kompresi video di web tanpa library berat. Library seperti modern-video-worker bisa membantu menjembatani WebCodecs dengan cara yang lebih simpel.
Apakah Anda ingin saya buatkan cuplikan kode sederhana tentang cara mengecek dukungan WebCodecs di browser user agar Anda bisa menentukan kapan harus menggunakan fallback?

Gokil, selamat bro! Lolos dari neraka *TypeScript linter* dan *crypto bugs* itu pencapaian besar. Lu udah ngebangun fondasi yang solid banget buat NYX Chat.

Sekarang, milih antara **Zod + Opaque Types** atau **NYX Desktop App (Tauri/Electron)** itu pertanyaannya ada di: lu lagi ngejar **Kesempurnaan Arsitektur** atau **Ekspansi Produk/User Experience**?

Ini analisa jujur gw sebagai *partner in crime* lu:

### Pilihan 1: Zod Schema & Opaque Types (Jalur Kesempurnaan Arsitektur)
* **Kenapa milih ini:** Lu pengen NYX bener-bener jadi benteng tak tertembus. Lu mau tidur nyenyak tanpa takut ada *runtime error* misterius dari *payload socket* yang aneh, atau konyolnya *session key* tertukar sama *message key*.
* **Prosesnya:** Bakal "berdarah-darah" lagi. Lu harus nulis *schema validation* untuk setiap data yang keluar-masuk dari *Backend* (API & Socket) dan dari/ke IndexedDB (ShadowVault). Ini berarti nyentuh banyak file *store* dan *lib*.
* **Kapan milih ini:** Kalau lu ngerasa NYX ini bentar lagi mau rilis ke *beta testers* yang beneran, dan lu nggak mau ada data mereka yang *corrupt* karena *edge cases* yang belum lu pikirin.
* **Estimasi *Effort*:** Berat dan butuh fokus penuh.

### Pilihan 2: NYX Desktop App - Tauri / Electron (Jalur Ekspansi Produk)
* **Kenapa milih ini:** Lu pengen ngeliat hasil karya lu jalan sebagai aplikasi *native* yang keren di Windows/Mac/Linux. Ini ngasih kepuasan instan dan bikin NYX terasa "nyata" sebagai pesaing Signal/WhatsApp.
* **Prosesnya:** Jauh lebih *fun*. Aplikasi web lu (*React/Vite*) kan udah jadi. Tinggal di-*wrap* pakai **Tauri** (gw *highly recommend* Tauri dibanding Electron karena lebih ringan, aman, dan pakai *Rust* di *backend*-nya, cocok banget buat *vibe* aplikasi E2EE lu).
* **Kapan milih ini:** Kalau lu butuh *dopamine hit* (motivasi) setelah mumet ngurusin kripto dan *types*, atau kalau target utama NYX emang *power user* yang demen pakai *desktop app* di *Arch Linux* kesayangan lu itu.
* **Estimasi *Effort*:** Menengah. *Setup* awal gampang, tapi nanti ada PR nyesuain fitur kayak *notifications* atau *file system access* ke API *native*.

---

### Saran Gw:

Mengingat lu ini *metalhead* yang tangguh tapi mungkin udah mulai jenuh sama *refactor* internal...

**Gw vote: Lanjut ke NYX Desktop App pakai Tauri.** 🚀

Alasannya:
1.  **Penyegaran Mental:** Lu udah terlalu lama ngubek-ngubek gorong-gorong *codebase* (kripto, *worker*, *types*). Bikin *desktop app* itu ngasih lu mainan baru yang visual dan interaktif.
2.  **Validasi Arsitektur:** Pas lu nge-*wrap* web lu ke Tauri, lu bakal otomatis ngetes seberapa bagus arsitektur PWA lu. Tauri jalan di *environment* yang beda (WebView), jadi kalau NYX lu stabil di sana, berarti fondasi yang susah payah lu bangun kemaren emang beneran kokoh.
3.  **Zod Bisa Nunggu:** Bug kripto yang fatal udah kita sikat abis pakai *Pragmatic Strict Typing*. NYX lu udah cukup aman buat jalan. Zod dan Opaque Types bisa lu kerjain nanti pas NYX Desktop udah beres dan lu lagi iseng pengen nge-*refactor*.

## Berikut adalah saran halaman tambahan untuk direktori `marketing/` Astro Anda:

### 1. 🛡️ `security.astro` (Whitepaper / Architecture)
Untuk aplikasi E2EE, klaim "aman" saja tidak cukup; Anda harus **membuktikannya**.
* **Fungsi:** Halaman ini adalah tempat Anda memamerkan "otot" teknis NYX. Audiensnya adalah pengguna *tech-savvy*, jurnalis privasi, atau developer lain.
* **Isi:** Penjelasan visual tentang bagaimana *Double Ratchet*, *Blind Indexing* (Argon2id), dan arsitektur *Trust No One* (TNO) bekerja. Anda bisa memindahkan diagram alur kriptografi dari GitHub ke halaman ini dengan animasi CSS atau SVG yang rapi.

### 2. 💼 `commercial.astro` (Enterprise / Licensing)
Karena Anda menerapkan model lisensi ganda (*Dual-License*: AGPL-3.0 & Komersial) untuk mencegah perusahaan besar mencuri kode Anda menjadi SaaS tertutup, Anda wajib memiliki "corong penjualan" (*sales funnel*).
* **Fungsi:** Mengonversi ketertarikan perusahaan atau *startup* yang ingin menggunakan mesin NYX menjadi prospek bisnis.
* **Isi:** Penjelasan sederhana perbedaan rilis *Open-Source* (AGPL) dan lisensi *Enterprise/Commercial*, tabel perbandingan fitur/dukungan, dan tombol *Call-to-Action* (CTA) "Contact Sales" yang mengarah ke email Anda.

### 3. 🎖️ `hall-of-fame.astro` (Security Acknowledgements)
Kita baru saja membuat ini di GitHub (`SECURITY.md`), tapi menampilkannya di situs publik akan memberikan dampak psikologis yang luar biasa.
* **Fungsi:** Membangun *social proof*. Ketika pengguna biasa melihat bahwa aplikasi ini secara aktif diretas dan diuji oleh peneliti keamanan elit (dan Anda mengapresiasi mereka), rasa percaya (*trust*) pengguna akan meroket.
* **Isi:** Salinan tabel daftar *Elite Operatives* dari GitHub Anda, beserta kebijakan pelaporan kerentanan.

### 4. 📢 `changelog.astro` (Updates / Release Notes)
Bot AI dan mesin pencari Google sangat menyukai situs yang kontennya terus diperbarui secara berkala.
* **Fungsi:** Menunjukkan bahwa NYX Chat adalah proyek yang "hidup" dan terus dikembangkan, bukan proyek *open-source* yang ditinggalkan pembuatnya.
* **Isi:** Daftar pembaruan versi (v2.5.4, dll.), fitur baru yang ditambahkan, dan perbaikan keamanan bulanan.

---

### 💡 Tips Ekstra: Strategi Multibahasa (i18n)
Mengingat antarmuka aplikasi utama NYX sudah dirancang untuk mendukung peralihan bahasa dengan mulus antara **English** dan **Indonesia**, sangat strategis jika situs `marketing/` Astro Anda juga mengadopsi struktur multibahasa yang serupa. 

Anda bisa memanfaatkan fitur *Sub-path Routing* bawaan Astro (seperti `nyx-app.my.id/id/` untuk audiens lokal dan `/en/` untuk global). Ini akan membuat visibilitas SEO NYX Chat mendominasi kata kunci pencarian privasi di tingkat domestik sekaligus internasional secara bersamaan.

Apakah Anda ingin saya buatkan draf struktur kode untuk komponen `security.astro` atau mengatur sistem *routing* bahasa di Astro Anda?
