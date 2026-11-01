# Pass 6 — Verifikasi fokus: siklus sesi & pemulihan akun (`routes/auth.ts`)

Berkas ini **belum pernah dibaca penuh** pada pass 1–5 (semuanya hanya
meng-grep pola token). Pass ini membaca 1875 baris dan memeriksa setiap gate
terhadap helper yang dipanggilnya. Berikut area yang **sound**, sebagai klaim
yang boleh dipakai ulang (dan sudah saya tantang sendiri), lalu sisa risikonya.

## 1. Rotasi refresh & deteksi replay — OK

- Rotasi memakai rantai `familyId` + `replacedById`; token lama ditandai
  `revokedAt`, bukan dihapus (`auth.ts:905-940`), sehingga replay bisa dikenali.
- Klasifikasi replay dipisah ke helper murni (`refreshReplay.ts`) dengan tiga
  hasil: `benign` (penerus **langsung** dalam jendela), `session_ended` (tak ada
  tip hidup → 401 tanpa alarm), `reuse` (revoke family + `force_logout`
  **device-scoped**, `auth.ts:876-902`).
- Jendela toleransi di-clamp (default 2 menit, maksimum 24 jam), jadi tidak ada
  window tak terbatas dari env.
- `benign` hanya berlaku bila `tip.replacesId === presentedId` — rantai lebih
  panjang tetap dianggap reuse. Ini menutup penyalahgunaan jendela untuk token
  yang sudah lama ditinggalkan.

## 2. Recovery akun — OK (PQ-only, nonce sekali pakai)

- `/recover/challenge` menerbitkan nonce 32 byte, disimpan 300 detik dengan key
  identifier **ter-pepper** (`auth.ts:952-962`), dan mengembalikan nonce untuk
  identifier apa pun — tidak ada oracle keberadaan akun.
- `/recover` menolak selisih `timestamp` > 5 menit, **menghapus nonce sebelum
  dipakai** (baca-lalu-`del`, satu kesempatan), dan mewajibkan `signatureV2`
  ML-DSA diverifikasi terhadap `signingKeyV2` salah satu perangkat
  (`auth.ts:1006-1050`). Tanda tangan v1 tidak lagi diterima.
- Pesan yang ditandatangani mengikat identifier, timestamp, nonce, password
  baru, dan **semua kunci baru** — tidak ada bidang yang bisa ditukar tanpa
  merusak tanda tangan.
- Sukses = `$transaction` yang mengganti password, menghapus **semua** device
  dan authenticator, lalu membuat device baru (`auth.ts:1063-1087`), sehingga
  kunci lama tidak tersisa.

## 3. Device linking (QR) — OK

- Token QR dibakar dengan `getDel` atomik (`auth.ts:1136-1176`), bukan
  cek-lalu-hapus.
- `approve` hanya boleh oleh pemilik `pending.userId` (`auth.ts:1249-1251`), dan
  bila `approvePendingLink` kalah balapan, Device row yatim dihapus
  (`auth.ts:1279-1284`).
- `complete` memverifikasi **password lebih dulu**, baru membakar state
  (`auth.ts:1338-1360`) — salah ketik tidak menghabiskan tautan. `complete`
  sengaja tidak menerbitkan sesi; klien lewat `/login` (satu jalur sesi).
- Kunci privat tetap dibuat & dienkripsi klien; server hanya menyimpan bundel
  terenkripsi.

## 4. WebAuthn — OK

- `userVerification: 'required'` di **kedua** arah (registrasi dan login), dan
  `verifyAuthenticationResponse(..., requireUserVerification: true)`
  (`auth.ts:1739-1815`).
- Challenge registrasi disimpan per user lalu di-null-kan setelah sukses;
  challenge login disimpan di cookie httpOnly dan dihapus setelah verifikasi.
- `Authority.credentialID` **unique** di schema, sehingga verifikasi login
  lookup-by-credential tidak ambigu.
- Passkey tersinkron (`credentialBackedUp === true`) **tidak** menaikkan
  `isVerified`; hanya device-bound + UV (`auth.ts:1676-1684`).

## 5. Proof of Work — OK

- Identitas rate-limit diambil dari `userId` lebih dulu, bukan header klien
  (`resolvePowIdentity`, `auth.ts:1492-1502`) — dulu `x-nyx-installation-id`
  bisa dirotasi untuk memaku difficulty minimum.
- INCR+EXPIRE atomik (Lua) untuk counter challenge dan untuk throttle verify
  (30/jam, diperiksa **sebelum** Argon2 16 MB).
- Challenge disimpan per user 300 detik dan dihapus hanya saat verifikasi
  berhasil; target prefix diturunkan dari difficulty yang disimpan server.

## 6. Revokasi & KICK — OK kecuali `/logout` (lihat N6-01)

`/logout-all` mencabut seluruh token, mengosongkan cache perangkat aktif, lalu
mengirim `force_logout` **dan** `TransportOpCode.KICK`
(`auth.ts:1400-1410`). `DELETE /api/sessions/:jti` melakukan hal yang sama
dengan scope `deviceId`. `/logout` hanya mencabut token — itulah N6-01.

## 7. Ringkas: apa yang tidak saya periksa

- Upacara WebAuthn nyata (hardware authenticator), Turnstile, dan attestation
  perangkat: hanya dibaca sebagai kode.
- Apakah relay benar-benar memakai `sub` guest sebagai kunci routing
  (N6-02 bergantung pada ini; mekanismenya di sisi auth sudah terbukti).
- `DELETE /api/sessions/:jti` saya baca hanya pada bagian KICK, bukan seluruh
  handler-nya (pass 2 menyapunya untuk otorisasi).
- Rate limit `/refresh`, `/webauthn/*`: tidak ada limiter khusus di route; saya
  tidak menilainya sebagai temuan karena tidak ada tebakan rahasia di jalur itu,
  tetapi ini tidak diverifikasi terhadap middleware global di `app.ts`.
