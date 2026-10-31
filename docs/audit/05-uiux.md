# 05 — UI/UX, i18n, Aksesibilitas

**Cakupan terbatas.** Saya tidak menjalankan aplikasi di browser (butuh Postgres + Redis + dua dev server; E2E tidak dijalankan). Temuan di sini berasal dari membaca kode dan dari pemeriksaan otomatis yang bisa dijalankan.

## 5.1 Yang diperiksa otomatis

- **i18n key parity:** dijalankan pada `web/public/locales/{en,es,id,pt-BR}` — **1091 key, lengkap di keempat bahasa, 0 key hilang**. Klaim CONTRIBUTING ("setiap key harus ada di 4 locale") terpenuhi saat ini.
- **Sink XSS:** tidak ada `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML`, atau `document.write` di `web/src` (grep penuh, 0 hasil).
- **Lint:** 0 error; 190 warning (`no-unused-vars`) — tidak memengaruhi UI langsung.

## 5.2 Temuan UX dari kode

### U-01 — Mutasi tanpa CSRF gagal dengan pesan yang tidak bisa ditindaklanjuti — **Low**
`api.ts:190-215`: bila `GET /api/csrf-token` gagal (offline sesaat, 5xx), `getCsrfToken()` menelan error dan mengembalikan `""`; request mutasi tetap dikirim tanpa header → `403 Invalid CSRF token`. Pesan itu tidak memberi tahu pengguna bahwa masalahnya sementara dan bisa dicoba lagi, dan cache token tidak diinvalidasi kecuali teks error memuat "csrf" (yang memang terjadi, jadi retry berikutnya berhasil — tetapi pengguna melihat satu kegagalan acak lebih dulu). Pertimbangkan menolak lebih awal dengan pesan "jaringan bermasalah, coba lagi".

### U-02 — Tindakan destruktif: hapus device/akun dan logout
Berdasarkan kode, `nukeProtocol.executeLocalWipe` memanggil `/api/auth/logout-all` lebih dulu (benar, karena cookie HttpOnly tidak bisa dihapus klien). Tidak ada temuan. **Perlu diuji manual:** konfirmasi backup sebelum wipe (apakah UI memaksa pengguna menyimpan `.nyxbak` lebih dulu).

### U-03 — Status "waiting for key"
Pesan yang belum bisa didekripsi ditandai `waiting_for_key` dan **bukan** error bubble (sesuai desain). Risiko UX: bila kunci grup tidak pernah datang, pengguna melihat placeholder tanpa aksi. Klien punya `reDecryptPendingMessages` + banner KT; tidak ada tombol "minta kunci ulang" yang terlihat di `messagePipeline`. **Perlu diuji manual** (bukan temuan pasti).

### U-04 — Layar penuh untuk klien terlalu tua
`pages/ClientVersionRequiredPage.tsx` dirender saat 426 dengan build & minimum version; hanya bisa reload. Ini pola yang benar untuk kegagalan permanen.

## 5.3 Aksesibilitas (tidak diuji runtime)

Tidak dijalankan: keyboard navigation, focus trap pada modal (`RecoveryModal`, `SecurePhraseModal`), ARIA live region untuk pesan masuk, kontras, touch target, `prefers-reduced-motion`, dan layout RTL.

**Yang bisa dikatakan dari kode:** modal global di `App.tsx` di-`React.lazy` dan render-on-demand — ini membatasi biaya, tetapi tidak menjamin focus trap. Tidak ada bukti otomatis bahwa Escape menutup modal atau bahwa fokus kembali ke pemicu. **Rekomendasi:** satu Playwright spec a11y (axe) untuk Login, Register, dan Chat, plus cek focus trap manual — masuk daftar uji manual, bukan temuan.

## 5.4 State yang perlu dilihat manusia

Loading / empty / error / offline / permission-denied / session-expired pada: daftar chat, pencarian user, modal attachment, story viewer, call overlay, dan settings. Saya hanya bisa memastikan keberadaan komponen, bukan kualitas state-nya.

## 5.5 Kesimpulan lapisan ini

Tidak ada temuan UX tingkat tinggi yang bisa dibuktikan dari kode. Satu temuan Low (U-01) dan dua area yang wajib diuji manual (U-02, U-03) plus aksesibilitas.
