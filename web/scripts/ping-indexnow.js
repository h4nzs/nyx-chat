const KEY = "nyx-live-index-5bUFU-DpfATyDQAczXwbvGVOHxx2VTHzUhfwJLhaVX3I4FtEQU2vGHaLoefa2lwI"; 

// Pisahkan URL berdasarkan Host masing-masing
const SITES = [
  {
    host: "nyx-app.my.id",
    urls: [
      "https://nyx-app.my.id/",
      "https://nyx-app.my.id/privacy",
      "https://nyx-app.my.id/help"
    ]
  },
  {
    host: "app.nyx-app.my.id",
    urls: [
      "https://app.nyx-app.my.id/login",
      "https://app.nyx-app.my.id/register",
      "https://app.nyx-app.my.id/migrate-receive",
      "https://app.nyx-app.my.id/migrate-send"
    ]
  }
];

async function pingIndexNow() {
  console.log('\n🚀 [IndexNow] Memulai proses ping ke mesin pencari...');

  for (const site of SITES) {
    console.log(`\n📡 Mengirim ping untuk host: ${site.host}`);
    
    // Format JSON wajib sesuai standar IndexNow
    const payload = {
      host: site.host,
      key: KEY,
      urlList: site.urls
    };

    try {
      const response = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(payload)
      });

      if (response.status === 200 || response.status === 202) {
        console.log(`✅ [Sukses] URL untuk ${site.host} diterima! (HTTP ${response.status})`);
      } else {
        console.error(`❌ [Gagal] Host ${site.host} ditolak. Kode HTTP: ${response.status}`);
        
        if (response.status === 400) console.error("   Alasan: Format JSON tidak valid.");
        if (response.status === 403) console.error(`   Alasan: File ${KEY}.txt tidak ditemukan di https://${site.host}/`);
        if (response.status === 422) console.error("   Alasan: Ada URL yang tidak cocok dengan host.");
        if (response.status === 429) console.error("   Alasan: Terlalu banyak request (Spam).");
      }
    } catch (error) {
      console.error(`❌ [Error Sistem] Gagal menghubungi server saat ping ${site.host}:`, error.message);
    }
  }
  console.log('\n🏁 [IndexNow] Selesai!\n');
}

pingIndexNow();