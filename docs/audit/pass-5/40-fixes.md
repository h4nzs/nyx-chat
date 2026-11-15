# Pass 5 — Perbaikan

Tanggal: 2026-11-01. Basis temuan: `10-delta.md`, `20-findings.md`, `30-spqr.md`.
Tidak ada perubahan format wire, primitif, padding, atau gerbang versi.

| ID | Perbaikan | Berkas | Bukti/tes |
|---|---|---|---|
| **N5-02** | Dokumen `spqrRatchet.ts` dikoreksi: modul ini **dipakai** jalur pesan produksi (worker op `spqr_ratchet_*`), dengan tiga gerbang (kapabilitas `spqr-ratchet` di kedua relay, `ackV: 2` di dalam payload ter-seal, kill switch yang hanya menghentikan kirim/iklan). Paragraf lama (\"belum dipakai jalur pesan produksi\") adalah drift berbahaya di berkas kripto. | `web/src/lib/spqrRatchet.ts` | `tsc` web; suite SPQR 6 berkas |
| **N5-03** | Skip senyap pada suite kripto v2 dihapus sebagai jalur \"hijau\": bila `packages/spqr-wasm/dist/spqr.wasm` tidak ada, kini ada tes yang **GAGAL** (\"artefak spqr.wasm ... wajib ada\") di samping sisa suite yang tetap di-skip agar mesin tanpa artefak masih bisa menjalankan tes non-WASM. | `web/src/lib/__tests__/spqrSession.test.ts` (+ dua berkas SPQR lain) | jalankan `vitest run spqr` dengan artefak dihapus sementara → suite gagal, bukan lulus |
| **N5-04** | Komentar perbaikan N4-03 dikoreksi sesuai perilaku nyata: parser hanya membaca **frame pertama**; byte setelah payload yang dideklarasikan diabaikan (bukan ditolak). Bukan masalah keamanan — jalur uni memang satu frame per stream — tetapi komentar tidak boleh menjanjikan penolakan yang tidak ada. | `server/transport-sidecar/src/main.rs` | komentar saja; `cargo test` sidecar dijalankan untuk memastikan tetap tercompile |

## N5-01 — keputusan: (b) didokumentasikan, bukan (a) arsip per-era

Pass 5 menemukan asimetri: jalur **v1** menyelamatkan pesan lintas-era lewat tiga
slot `previous_session_states` (`FALLBACK ERA ARSIP`), sedangkan jalur **v2**
hanya menyimpan satu state braid per percakapan yang **dihapus** saat sesi baru
(`deleteSpqrState`). Pesan v2 yang tertunda melewati rotasi sesi karena itu gagal
dibuka (`error`), bukan diselamatkan.

Yang dipilih: **(b) perilaku sekarang dijadikan keputusan eksplisit dan
didokumentasikan**, bukan (a) arsip per-`sessionId`. Alasannya:

1. (a) mengubah model state (kunci per era + pemilihan era saat baca) dan
   menyentuh format penyimpanan braid — itu keputusan protokol, bukan patch, dan
   harus diuji dua sisi + E2E sebelum dirilis.
2. Braid SPQR memang dirancang untuk pesan hilang/out-of-order **di dalam satu
   sesi**; yang tidak dijanjikan adalah lintas rotasi sesi. Rotasi sesi terjadi
   saat X3DH baru (kunci sesi baru), dan pada titik itu pesan yang belum terkirim
   dari era lama memang tidak punya akar yang sama.
3. Menyimpan arsip braid menambah data rahasia di Dexie (dan di backup) tanpa
   kebutuhan yang terbukti — belum ada laporan kehilangan pesan v2 lintas-era.

Konsekuensi yang harus diketahui operator/pengguna (dicatat di `docs/33` §33.8
dan CHANGELOG): **rotasi sesi memutus pesan v2 yang belum terkirim dari era
sebelumnya**; pesan v1 pada posisi yang sama tetap diselamatkan arsip. Bila nanti
diputuskan sebaliknya, jalannya adalah menyimpan state braid per `sessionId` dan
membiarkan pembaca mencoba era yang tersedia (pola arsip v1) — perubahan itu
harus disertai tes dua-era dan E2E `spqr.spec.ts`.

## Yang masih terbuka (jujur)

| Item | Status |
|---|---|
| **F-13** `pnpm audit --prod` | Belum dijalankan (butuh jaringan); 0/5 pass menjalankannya. |
| **`style-src 'unsafe-inline'`** | Disengaja (blok `<style>` loader). |
| **Race single-active-device sidecar** | Tidak ditelusuri/diubah — butuh keputusan desain. |
| **`30-spqr.md` §7 (UNVERIFIED)** | \"Kirim gagal setelah braid maju\" belum diuji dua sisi. Belum jadi temuan karena belum dibuktikan; tesnya butuh harness dua sisi + artefak WASM. |
| **Cakupan** | `routes/auth.ts` penuh, WASM KT, `metrics.rs` rinci, eksekusi Rust/fuzz transport. |
