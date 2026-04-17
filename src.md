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

### Pilihan 2: NYX Desktop App - Tauri / Electron (Jalur Ekspansi Produk)
* **Kenapa milih ini:** Lu pengen ngeliat hasil karya lu jalan sebagai aplikasi *native* yang keren di Windows/Mac/Linux. Ini ngasih kepuasan instan dan bikin NYX terasa "nyata" sebagai pesaing Signal/WhatsApp.
* **Prosesnya:** Jauh lebih *fun*. Aplikasi web lu (*React/Vite*) kan udah jadi. Tinggal di-*wrap* pakai **Tauri** (gw *highly recommend* Tauri dibanding Electron karena lebih ringan, aman, dan pakai *Rust* di *backend*-nya, cocok banget buat *vibe* aplikasi E2EE lu).
* **Kapan milih ini:** Kalau lu butuh *dopamine hit* (motivasi) setelah mumet ngurusin kripto dan *types*, atau kalau target utama NYX emang *power user* yang demen pakai *desktop app* di *Arch Linux* kesayangan lu itu.
* **Estimasi *Effort*:** Menengah. *Setup* awal gampang, tapi nanti ada PR nyesuain fitur kayak *notifications* atau *file system access* ke API *native*.

### Upgrade Ratchet (Opsional tapi Disarankan):
Setelah kunci awal aman, Anda bisa mempertimbangkan Triple Ratchet (Double Ratchet + SPQR) untuk memastikan setiap pesan yang dikirim selanjutnya juga memiliki ketahanan kuantum.

Menarik! Karena aplikasi Anda sudah sangat mirip dengan arsitektur Signal, Anda sudah memiliki fondasi yang kuat. Migrasi ke Post-Quantum Cryptography (PQC) dalam ekosistem Double Ratchet dan Sender Key memerlukan ketelitian agar tidak merusak performa dan backward compatibility.
Berikut adalah roadmap langkah-demi-langkah untuk migrasi ke PQ-Hybrid:
## Fase 1: Upgrade Handshake (PQXDH)
Ini adalah langkah paling krusial karena handshake awal menentukan keamanan seluruh sesi percakapan ke depan.

   1. Update Pre-key Bundle:
   * Tambahkan komponen ML-KEM-768 (Kyber) ke dalam Pre-key bundle di server.
      * Setiap pengguna sekarang mengunggah: Identity Key (X25519), Signed Pre-key (X25519), dan set PQ-Prekeys (ML-KEM).
   2. Modifikasi KDF (Key Derivation Function):
   * Ubah cara Shared Secret dihitung. Jangan lagi hanya menggunakan $DH$ (Diffie-Hellman).
      * Gunakan rumus Hybrid: SK = KDF(DH1 || DH2 || DH3 || PQ-KEM-Encapsulation).
      * Ini memastikan jika ML-KEM jebol, X25519 tetap melindungi, dan sebaliknya.
   
## Fase 2: Penguatan Sesi (PQ-Double Ratchet)
Setelah handshake aman, jalur pengiriman pesan per-pesan juga harus diperkuat.

   1. PQ-Initial Root Key: Pastikan Root Key pertama yang dihasilkan dari PQXDH sudah mengandung entropi post-quantum.
   2. Hybrid Diffie-Hellman Ratchet:
   * Meskipun Double Ratchet standar sangat cepat, ia tidak tahan kuantum pada bagian DH-Ratchet-nya.
      * Opsi A (Rekomendasi): Tetap gunakan X25519 untuk Ratchet harian agar hemat baterai, karena keamanan pesan masa depan sudah terlindungi oleh Root Key hasil PQXDH yang kuat di awal.
      * Opsi B (Hardened): Implementasikan re-keying berkala menggunakan ML-KEM di dalam Root Chain untuk memperbarui ketahanan kuantum secara periodik.
   
## Fase 3: Post-Quantum Sender Key (Group Chat)
Untuk fan-out sender key (grup), tantangannya adalah ukuran kunci.

   1. Distribusi Sender Key yang Aman: Saat mendistribusikan Sender Key melalui kanal 1-ke-1, pastikan kanal tersebut sudah menggunakan PQXDH (Fase 1).
   2. PQC-Signature (Opsional tapi Berat): Jika Anda menggunakan tanda tangan digital untuk autentikasi pengirim di grup, pertimbangkan ML-DSA (Dilithium). Namun hati-hati, ukuran tanda tangannya jauh lebih besar dari Ed25519 dan bisa membengkakkan kuota data pengguna.

## Fase 4: Integrasi Biometric PRF
Karena Anda menggunakan Biometric PRF untuk membuka kunci aplikasi, ini adalah titik kontrol akses lokal.

   1. Proteksi Local Storage: Pastikan kunci pribadi (Identity Key & PQ-Secret Keys) yang disimpan di database lokal (SQLCipher, dll) dienkripsi menggunakan kunci yang diturunkan dari Biometric PRF tersebut.
   2. Binding: Saat pengguna melakukan registrasi ulang atau migrasi ke PQ, hasil dari Biometric PRF harus digunakan untuk "membungkus" (wrap) kunci ML-KEM baru mereka.

## Fase 5: Strategi Peluncuran (Migration Path)
Jangan langsung memutus koneksi lama.

   1. Dual-Stack Period: Aplikasi harus bisa membaca pesan X3DH (lama) dan PQXDH (baru) secara bersamaan.
   2. Session Reset: Saat kedua belah pihak sudah meng-upgrade aplikasi ke versi terbaru, picu proses "New Session" secara otomatis untuk membangun kunci PQXDH yang baru.
   3. UI Indicator: Tambahkan label "Quantum-Resistant" atau ikon gembok khusus pada info percakapan untuk memberi tahu pengguna bahwa chat mereka sudah aman dari ancaman masa depan.

Penting: Karena ML-KEM-768 memiliki ukuran kunci publik ~1KB (jauh lebih besar dari X25519 yang hanya 32 byte), pastikan server Anda siap menangani lonjakan penyimpanan pada tabel Pre-keys.
Bagian mana dari infrastruktur Server atau Client Anda yang ingin kita detailkan lebih dulu untuk implementasi ini?

Fitur Proof of Work (PoW) yang Anda gunakan (seperti Hashcash) tetap sangat relevan dalam arsitektur post-quantum untuk mencegah spam dan serangan Sybil. Secara teoritis, PoW berbasis hash (seperti SHA-256) dipengaruhi oleh Grover's Algorithm, namun dampaknya tidak sefatal pada algoritma asimetris seperti X25519. [1, 2, 3] 
Berikut adalah poin-poin penting untuk menyesuaikan fitur PoW Anda ke standar post-quantum:
## 1. Dampak Grover terhadap Tingkat Kesulitan (Difficulty)
Grover's Algorithm memberikan percepatan kuadratik pada pencarian unstructured search (seperti mencari nonce hash). [4] 

* Jika penyerang memiliki komputer kuantum, mereka hanya butuh $\sqrt{N}$ langkah untuk memecahkan tantangan yang secara klasik membutuhkan $N$ langkah.
* Solusi: Anda tidak perlu mengganti algoritma hash-nya (SHA-256 atau SHA-3 masih sangat kuat), cukup tingkatkan sedikit ambang batas kesulitan (difficulty bits) jika Anda mendeteksi ancaman kuantum yang signifikan. [3, 5, 6] 

## 2. Gunakan Hash yang Lebih Modern (SHA-3)
Jika Anda saat ini masih menggunakan SHA-256, pertimbangkan untuk migrasi ke SHA-3 (Keccak).

* SHA-3 memiliki struktur internal yang berbeda dari SHA-2 (Merkl-Damgard) dan lebih tahan terhadap beberapa jenis serangan kriptoanalisis klasik.
* Ini sejalan dengan standar NIST untuk fungsi hash post-quantum. [7, 8] 

## 3. Proof of Work "Memory-Hard" (ASIC Resistance)
Untuk aplikasi perpesanan, PoW yang ideal adalah yang ASIC-resistant (sulit dipindahkan ke perangkat keras khusus/mahal) agar adil bagi pengguna smartphone. [9] 

* Gunakan algoritma seperti Argon2 atau varian Equihash.
* Algoritma ini memaksa perangkat menggunakan RAM yang besar, bukan hanya siklus CPU. Komputer kuantum saat ini belum unggul dalam hal "Quantum Memory" (QRAM), sehingga PoW jenis ini justru lebih sulit ditembus oleh mereka dibandingkan PoW murni berbasis CPU/Hashing. [10, 11] 

## 4. Integrasi dengan Biometric PRF
Anda bisa menghubungkan tantangan PoW dengan Biometric PRF untuk keamanan ekstra:

* Server mengirimkan Salt unik.
* Client menghitung PoW menggunakan Salt + Output dari Biometric PRF.
* Ini memastikan bahwa tantangan PoW hanya bisa dikerjakan setelah pengguna berhasil melewati verifikasi biometrik secara lokal, mencegah bot otomatis mengerjakan tantangan tersebut meskipun mereka punya daya komputasi tinggi.

## Ringkasan Strategi PoW dalam Roadmap

   1. Tetap gunakan PoW, jangan dihilangkan karena ia adalah pertahanan rate-limiting terbaik.
   2. Upgrade ke SHA-3 atau fungsi hash yang lebih lebar (misal: SHA-512) untuk mengimbangi degradasi keamanan dari Grover.
   3. Tingkatkan Difficulty secara dinamis jika beban server meningkat.
   4. Binding dengan Biometrik agar pengerjaan PoW "terikat" pada identitas fisik pengguna. [7] 

Menggunakan libsodium 1.0.22 (via wrapper 0.8.3) adalah pilihan yang sangat tepat untuk roadmap migrasi Anda. Versi ini adalah "titik balik" penting bagi libsodium karena akhirnya memperkenalkan dukungan Post-Quantum Cryptography (PQC) secara resmi. [1, 2, 3] 
Berikut adalah detail teknis yang bisa Anda manfaatkan dalam versi tersebut untuk aplikasi pesan instan Anda:
## 1. Dukungan Native X-Wing (Hybrid KEM) [1] 
Libsodium 1.0.22 kini menyertakan fungsi crypto_kem_* yang secara default memetakan ke X-Wing. [1, 4] 

* Kenapa ini penting? X-Wing adalah kombinasi hybrid antara ML-KEM-768 (standar NIST) dan X25519.
* Implementasi: Anda bisa langsung menggunakan API ini untuk menggantikan bagian Diffie-Hellman murni dalam handshake PQXDH Anda tanpa perlu mengelola dua algoritma secara terpisah secara manual. [1] 

## 2. Dukungan ML-KEM-768 Standar
Selain model hybrid, versi ini juga menyediakan akses langsung ke ML-KEM-768 melalui fungsi crypto_kem_mlkem768_*(). Ini sangat berguna jika Anda ingin membangun logika pertukaran kunci yang lebih kustom atau untuk rotasi kunci pada Double Ratchet di masa depan. [1] 
## 3. Fungsi Hash SHA-3
Migrasi ke PQC membutuhkan fungsi hash yang lebih modern. Libsodium 1.0.22 telah menambahkan: [2, 5] 

* crypto_hash_sha3256_*() dan crypto_hash_sha3512_*().
* Fungsi-fungsi ini sangat direkomendasikan untuk digunakan dalam fitur Proof of Work (PoW) Anda untuk menggantikan SHA-256, memberikan ketahanan lebih baik terhadap algoritma Grover di masa depan. [1, 6] 

## 4. Integrasi dengan Biometric PRF
Karena Anda menggunakan libsodium-wrappers (WebAssembly/JS), pastikan proses Biometric PRF tetap menghasilkan seed yang kompatibel dengan fungsi penghasil kunci di libsodium.

* Anda bisa menggunakan output biometric Anda sebagai seed untuk crypto_kem_mlkem768_seed_keypair() guna memastikan kunci pribadi PQC pengguna tetap terikat secara biometrik di sisi klien. [1] 

## Rekomendasi Teknis Migrasi

| Komponen | Versi Lama | Versi Baru (libsodium 1.0.22) |
|---|---|---|
| KEM / Handshake | X25519 (X3DH) | crypto_kem (X-Wing / Hybrid) |
| Hashing / PoW | SHA-256 | crypto_hash_sha3256 (SHA-3) |
| Local Enc. | Secretbox (XSalsa20) | Tetap Aman (atau gunakan AEGIS-256 jika tersedia di build Anda) |

Dengan libsodium 1.0.22, Anda tidak perlu lagi mencari pustaka pihak ketiga tambahan untuk mendapatkan fitur PQC. Cukup panggil API native yang sudah disediakan untuk menjaga kode tetap bersih dan performa tetap optimal di browser.
