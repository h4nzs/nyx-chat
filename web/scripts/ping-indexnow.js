const HOST = "app.nyx-app.my.id";
const PUBLIC_HOST = "nyx-app.my.id";
// Kunci hex 32 karakter yang baru
const KEY = "nyx-live-index-5bUFU-DpfATyDQAczXwbvGVOHxx2VTHzUhfwJLhaVX3I4FtEQU2vGHaLoefa2lwI"; 

const URL_LIST = [
  `https://${PUBLIC_HOST}/`,
  `https://${HOST}/login`,
  `https://${HOST}/register`,
  `https://${PUBLIC_HOST}/privacy`,
  `https://${PUBLIC_HOST}/help`,
  `https://${HOST}/migrate-receive`,
  `https://${HOST}/migrate-send`
];

async function pingIndexNow() {
  console.log('\n🚀 [IndexNow] Mengirim ping ke mesin pencari...');
  
  // Format JSON persis sesuai Dokumentasi "Submitting set of URLs" Option 1
  const payload = {
    host: HOST,
    publicHost: PUBLIC_HOST,
    key: KEY,
    urlList: URL_LIST
  };

  try {
    // Kita bisa menembak ke api.indexnow.org (hub pusat) atau www.bing.com/indexnow
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Host": "api.indexnow.org"
      },
      body: JSON.stringify(payload)
    });

    // Menangani respons 200 (OK) dan 202 (Accepted)
    if (response.status === 200 || response.status === 202) {
      console.log(`✅ [IndexNow] Ping sukses! (Status: ${response.status}). URL diterima.`);
    } else {
      console.error(`❌ [IndexNow] Gagal. Kode HTTP: ${response.status}`);
      // Menampilkan alasan berdasarkan dokumentasi
      if (response.status === 400) console.error("Alasan: Format JSON tidak valid.");
      if (response.status === 403) console.error("Alasan: Kunci tidak valid atau file .txt tidak ditemukan di web.");
      if (response.status === 422) console.error("Alasan: URL tidak cocok dengan host.");
      if (response.status === 429) console.error("Alasan: Terlalu banyak request (Spam).");
    }
  } catch (error) {
    console.error('❌ [IndexNow] Terjadi kesalahan sistem:', error.message);
  }
  console.log('');
}

pingIndexNow();