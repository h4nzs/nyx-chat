# Pass 6 — Temuan baru

Temuan pass 1–5 tidak diulang; lihat `10-delta.md` §A–B. Semua temuan di bawah
berasal dari `server/src/routes/auth.ts` yang dibaca **penuh** pada pass ini.

---

## N6-01 (Low, keyakinan tinggi) — `/logout` tidak memutus socket; hanya `/logout-all` dan `DELETE /sessions/:jti` yang melakukannya

**Ringkas.** Tiga jalur revokasi diperlakukan berbeda:

| Jalur | Revoke token | `force_logout` | `KICK` |
|---|---|---|---|
| `POST /api/auth/logout-all` (`auth.ts:1406-1408`) | ya | ya | ya |
| `DELETE /api/sessions/:jti` (`sessions.ts:104-108`) | ya | ya, **device-scoped** | ya, device-scoped |
| `POST /api/auth/logout` (`auth.ts:1445-1477`) | ya (`revokeFamily`) | **tidak** | **tidak** |

**Bukti.**

```ts
// server/src/routes/auth.ts:1455-1468
const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
if (stored) {
  await revokeFamily(stored.familyId);   // token dicabut…
} else { … }
if (payload.sub) {
  await redisClient.del(identityKey('active_device', payload.sub));
  await invalidateActiveDeviceCache(payload.sub, redisClient);
}
// …lalu clearAuthCookies + res.json({ ok: true })
```

Tidak ada `emitEventToUser(..., 'force_logout', ...)` maupun
`sendJsonToUser(..., TransportOpCode.KICK, ...)`, padahal
`/logout-all` tepat di atasnya menjelaskan mengapa itu wajib:

```ts
// server/src/routes/auth.ts:1400-1408
// [AUDIT 2026-10-24] Revokasi token saja TIDAK memutus sesi yang sedang
// hidup: relay realtime tidak membaca daftar blacklist per frame, jadi
// socket yang sudah terbuka terus mengirim & menerima pesan setelah
// "All N sessions terminated".
```

**Skenario.** Perangkat yang disusupi tetap memegang socket relay. Pengguna
menekan "log out" di perangkat itu (atau klien memanggil `/logout` saat
mengakhiri sesi): refresh token dicabut, tetapi socket tidak ditutup dan relay
tidak memeriksa blacklist per frame — perangkat itu tetap menerima pesan masuk
sampai socket-nya sendiri putus. `force_logout` yang seharusnya memerintahkan
klien keluar/menutup kanal tidak pernah dikirim.

**Kenapa bukan Medium.** Klien yang jujur menutup socket-nya sendiri setelah
`/logout`, dan jalur containment yang disarankan (`logout-all` saat nuke,
`DELETE /api/sessions/:jti` untuk mencabut perangkat lain) sudah mengirim
`KICK`. Yang tersisa adalah jalur "logout perangkat ini" yang tidak lengkap —
tetap cacat, tetapi bukan jalur utama untuk mencabut perangkat yang disusupi.

**Perbaikan minimum.** Samakan dengan `sessions.ts`: kirim
`emitEventToUser(payload.sub, 'force_logout', { reason: 'logout', deviceId }, deviceId)`
dan `sendJsonToUser(payload.sub, TransportOpCode.KICK, { reason: 'LOGOUT' }, false, deviceId)`
sebelum `clearAuthCookies`. `deviceId` diambil dari token refresh yang
diverifikasi.

**Test yang menangkapnya.** Fake `emitEventToUser`/`sendJsonToUser`, panggil
handler `/logout` dengan cookie `rt` sah → keduanya menerima `deviceId` dari
token (bukan `undefined`, yang akan me-logout semua perangkat).

---

## N6-02 (Low, keyakinan tinggi pada mekanismenya) — id guest Burner hanya 32 bit

```ts
// server/src/routes/auth.ts:789-790
const guestId = `guest_${crypto.randomUUID().substring(0, 8)}`;
const guestDeviceId = `burner_${crypto.randomUUID().substring(0, 8)}`;
```

`randomUUID().substring(0, 8)` = **8 karakter hex = 32 bit**. Id ini bukan
sekadar label: ia menjadi `sub` JWT dan `user_id` pada relay
(`emitEventToUsers`/`sendJsonToUser`), dan guest sengaja tidak punya baris
User/Device sehingga tidak ada uniqueness check di DB (`issueTokens` melewati
persist untuk `role === 'GUEST'`).

**Dampak.** Pada ~77.000 guest aktif (`√(2·2^32·ln2)`), peluang tabrakan 50%;
pada 10.000 guest sudah ~1,2%. Dua guest dengan id sama berbagi kanal relay:
event yang di-targetkan ke `guest_x` (pesan burner, `KEY_SYNC`, presence)
dikirim ke **kedua** koneksi. Isi pesan tetap E2EE, jadi yang bocor adalah
metadata/alamat, bukan plaintext — tetapi burner dipakai justru ketika
keterkaitan identitas paling tidak diinginkan.

**Perbaikan minimum.** Pakai id penuh (`crypto.randomUUID()` atau 16 byte acak
base64url) untuk `guestId`; `burnerLimiter` sudah membatasi pembuatan per IP,
jadi panjang id bukan masalah biaya.

**Catatan.** Saya tidak membuktikan routing relay memakai `sub` guest secara
end-to-end (butuh E2E); yang terbukti adalah id 32-bit + tidak ada pemeriksaan
uniqueness. Bila routing ternyata memakai conversation id, dampaknya turun jadi
kosmetik.

---

## N6-03 (Info) — PoW menaikkan `isVerified` tanpa memandang tier attestation

`POST /api/pow/verify` menulis `isVerified: true` untuk akun mana pun yang
menyelesaikan tantangan (`auth.ts:1592-1596`), termasuk akun yang lahir lewat
`ABUSE_ATTESTATION_ALLOW_UNATTESTED` (tanpa bukti perangkat). Ini konsisten
dengan "PoW = tier kepercayaan" di docs, bukan bug — tetapi artinya kata
`isVerified` **tidak** berarti "perangkat terverifikasi" setelah PoW, padahal
jalur register/WebAuthn memakai arti itu (`attestedCredential?.tier === 'hardware'`).
Jangan memakai `isVerified` sebagai bukti perangkat di masa depan; kalau perlu
dibedakan, tambah kolom terpisah alih-alih menumpuk makna.
