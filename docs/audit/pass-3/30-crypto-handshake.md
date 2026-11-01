# Pass 3 — Verifikasi fokus: crypto worker & handshake

Area ini **belum pernah dibaca** pada pass 1 dan pass 2 (keduanya menyatakan
begitu di `00-scope.md` masing-masing). Yang diperiksa: handshake X3DH v2
(X-Wing + ML-DSA-65), derivasi kunci sesi, AEAD, state Double Ratchet di worker,
dan jalur distribusi kunci sesi. Bukan yang diperiksa: Rust SPQR, WASM KT, dan
implementasi primitif di `packages/shared`.

## 1. Transkrip handshake mengikat identitas dan semua ciphertext — OK

`packages/shared/src/pqHandshake.ts:154-173`:

```ts
return concatLengthPrefixed([
  initiatorSigningKeyV2, responderIdentityKey, ctId, ctSpk, ctOtpk ?? empty,
])
```

- Kedua identitas masuk transkrip, ditambah panjang tetap per field
  (`concatLengthPrefixed`) sehingga tidak ada ambiguitas penyambungan.
- Ditandatangani inisiator dengan domain `PQ_V2_DOMAINS.HANDSHAKE`
  (`crypto.worker.ts:918-925`), diverifikasi penerima **sebelum** decapsulation
  (`:950-955`, dan idem di jalur regenerate `:1000-1005`), lalu `throw`.
- Kontrol negatif sudah ada dan lulus di repo: kunci verifikasi lain ditolak,
  ciphertext diubah ditolak (`x3dhOracleVectors.test.ts` — 9 tes, lulus pada pass
  ini; two log baris "tanda tangan inisiator tidak sah" di stderr adalah kontrol
  negatif yang memang diharapkan).

**Tidak ditemukan:** handshake tanpa verifikasi tanda tangan, verifikasi setelah
decapsulation, atau transkrip tanpa kunci penerima.

## 2. Tidak ada fallback ke v1 — OK

| Jalur | Perilaku | Bukti |
|---|---|---|
| Derivasi penerima | `if (handshakeVersion !== 2) throw` | `crypto.ts:3225-3228` |
| Penyimpanan kunci sesi | payload non-JSON-X3DH ditolak dengan `return` | `crypto.ts:3560-3563` |
| Inisiasi | throw tanpa `pqIdentityKey`/`pqSignature`/`signingKeyV2` | `crypto.ts:3136-3138, 3180-3186` |
| Blob ber-OTPK tanpa kunci lokal | throw, bukan derivasi "kunci lain" | `crypto.worker.ts:966-970` — dikunci tes (`x3dhOracleVectors.test.ts`) |

Konsisten dengan klaim PQ-only di `docs/04` dan tidak ada jalur diam-diam ke
`crypto_box_seal`.

## 3. Nonce & AEAD — OK

- `xchacha_seal`/`xchacha_open` memakai envelope kanonik `nonce(24)||ct`,
  base64url, kunci `memzero` di `finally` (`crypto.worker.ts:820-842`).
- `pq_box_seal_v2` membuat nonce acak **per panggilan** (`:858`) dan
  menghapusnya setelah dipakai (`:863`).
- `dr_ratchet_encrypt` mengambil message key dari `kdfChain(CKs)` lalu nonce acak
  24 byte per pesan (`:1681-1688`); tidak ada nonce turunan counter yang bisa
  bertabrakan antar pesan.
- Padding 8 KB tetap (`padBuffer`, `:1691-1694`) → ukuran tidak membocorkan isi.

**Tidak ditemukan:** nonce statis, nonce dari `Date.now`, atau enkripsi tanpa
AEAD.

## 4. Zeroization — OK dengan satu catatan

Material kunci dihapus di `finally`: seed turunan & private key identitas
(`:728-741`), shared secret KEM (`:855-857`, `:881-887`), state ratchet
(`:1703-1713`), OTPK hasil regenerate (`:1030-1036`).

Catatan: `mlDsaSign`/`mlDsaVerify` menerima `Uint8Array` yang **disalin** dari
`signingV2.secretKey` (`:921-922`, `new Uint8Array(mySigningV2.secretKey)`) —
salinan itu tidak di-`memzero`. Jejaknya kecil (salinan sementara, GC) dan sama
untuk semua pemakaian ML-DSA di repo, jadi saya catat sebagai **Info**, bukan
temuan: menambahkan `memzero` pada salinan itu murah, tetapi bukan kebocoran
yang dapat dibuktikan.

## 5. Pengikatan `signingKeyV2` payload ke bundle peer — OK

Vektor serangan F-11 (penyerang memasang kunci verifikasi miliknya sendiri di
payload) ditutup di dua jalur, keduanya membaca bundle peer lalu membandingkan:

- jalur pesan: `messagePipeline.ts:361-367` → `initiatorV2KeyMismatch` → `throw`
  (`:395-397`);
- jalur sinkronisasi offline `session:new_key`: `crypto.ts:3515-3532` → `throw`.

Setelah itu kunci hanya dipasang bila derivasi X3DH v2 berhasil
(`crypto.ts:3419-3421` → `storeSessionKeySecurely`). Jadi
`storeReceivedSessionKey` **tidak** memasang kunci buta — klaim pass 2 benar.

## 6. Bukti peserta & view-once — mekanismenya benar, sumbernya lemah

`MessageViewOnceOpen`/`MessageViewOnceRecipient` menyimpan
`conversationScopedTag(conversationId, userId)` (HMAC ber-pepper), bukan userId
(`schema.prisma:370-407`) — dump DB tidak menyebut siapa membuka apa, dan
dokumen tidak melebih-lebihkan. Perhitungan "semua sudah membuka" memakai
`count(open) >= count(recipient)` dengan daftar penerima yang **disaring**
`filterConversationParticipants` dan pengirim dibuang
(`viewOnceRecipients.ts:78-118`), jadi klien tidak bisa memicu penghapusan dini
dengan menghilangkan anggota — relay dan daftar memakai sumber yang sama.

Yang lemah bukan mekanismenya melainkan **sumber bukti keanggotaan**: satu dari
tiga sumber (`SessionKey`) dapat ditulis klien. Itu N3-01 di `20-findings.md`;
tanpa perbaikan itu, REG-1 secara teknis berfungsi untuk pengguna sah tetapi
tidak tahan terhadap pengguna terautentikasi yang menyalahgunakan API.

## 7. Ringkas: apa yang tidak saya periksa

- `packages/spqr-wasm` (Rust) dan `spqrRatchet.ts` — braid SPQR tidak diaudit
  pada pass ini.
- Verifikasi KT di WASM dan konsistensi anchor; N3-04 menandai bagian yang
  **belum terbukti**, bukan bagian yang terbukti salah.
- Aritmetika ML-DSA/X-Wing di `packages/shared` (dipakai sebagai primitif).
- Kebocoran kunci ke thread utama lewat payload `postMessage` secara menyeluruh:
  `dr_ratchet_encrypt` mengembalikan `mk` ke pemanggil (`:1710`), yang memang
  dibutuhkan jalur pesan; saya tidak menelusuri seluruh pemanggil `mk`.
