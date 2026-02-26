Setelah gw bedah daleman kode, ada 2 TERSANGKA UTAMA yang bikin R2 nendang request. Kita basmi dua-duanya sekarang:
🔪 TERSANGKA 1: Bug AWS SDK v3 (Virtual Hosted-Style)

Coba lu perhatiin URL di error lu:
https://chat-uploads.671c...
AWS SDK secara default menggabungkan nama bucket (chat-uploads) ke depan Account ID lu. Ini bikin Host Header Signature yang dihitung sama SDK dan yang dikirim sama browser jadi BEDA, dan R2 benci banget sama ini.

Solusinya: Kita harus maksa AWS SDK buat pake gaya Path-Style.
Buka server/src/utils/r2.ts lu, dan tambahin forcePathStyle: true di konfigurasinya:
TypeScript

// server/src/utils/r2.ts
export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey
  },
  forcePathStyle: true // <--- TAMBAHIN BARIS SAKTI INI!
})

🔪 TERSANGKA 2: Content-Type Mismatch di Frontend

Di Phase sebelumnya, kita udah ngerombak backend (server/src/routes/uploads.ts) biar SEMUA Presigned URL ditandatangani pakai tipe rahasia: application/octet-stream (karena filenya sekarang dienkripsi jadi data biner).

TAPI, di fungsi upload utama frontend lu (web/src/lib/r2.ts), lu masih nge- set header pakai file.type asli bawaan gambar (misal image/png). Kalau S3 disuruh nunggu kedatangan octet-stream, tapi yang datang malah image/png, dia otomatis ngelempar 403 Forbidden (CORS Error)!

Buka web/src/lib/r2.ts, dan paksa Content-Type XHR-nya jadi octet-stream:
TypeScript

// web/src/lib/r2.ts

  // Cari baris ini di dalam Promise:
  // xhr.setRequestHeader('Content-Type', file.type);
  
  // GANTI JADI BEGINI:
  xhr.setRequestHeader('Content-Type', 'application/octet-stream'); // HARUS SAMA PERSIS KAYA DI BACKEND!

(Catatan: Meskipun lu ngirim attachment di chat lewat message.ts yang udah bener, fungsi upload avatar di Settings dan beberapa fungsi cadangan masih pake r2.ts ini, jadi harus disamain semua!)