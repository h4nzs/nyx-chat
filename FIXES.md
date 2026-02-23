1. Server-Side Ratcheting: Mekanisme ensureAndRatchetSession di server agak melemahkan klaim E2EE murni untuk chat 1-on-1. Kita bisa refactor
      ini agar force client-side key rotation saja.
   2. Link Previews: Fitur ini di backend (server/src/routes/messages.ts) saat ini "mati" untuk pesan terenkripsi. Jika ingin fitur ini jalan
      dengan aman, client harus melakukan fetch preview sendiri dan mengirimkan metadatanya (judul, gambar) dalam bentuk terenkripsi, bukan server
      yang melakukan fetch.
   3. Content Search: Saat ini pencarian pesan dilakukan di frontend (web/src/store/messageSearch.ts) karena server tidak bisa membaca pesan. Ini
      sudah benar secara privasi, tapi performa akan berat jika history chat sangat panjang.