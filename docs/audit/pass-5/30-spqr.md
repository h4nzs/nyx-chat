# Pass 5 — Verifikasi fokus: ratchet v2 (braid SPQR)

Jalur ini **belum pernah dibaca** pada pass 1–4 (semuanya menyatakan begitu di
`00-scope.md` masing-masing). Yang diperiksa: `spqrWire.ts` (157),
`spqrNegotiation.ts` (289), `spqrSession.ts` (131), `spqrRatchet.ts` (230),
`spqrState.ts` (265), `packages/spqr-wasm/src/lib.rs` (340), op worker
`spqr_ratchet_*`, integrasi kirim/terima di `crypto.ts`, dan inisialisasi sesi di
`messagePipeline.ts`. Yang **tidak** diperiksa: `spqrBench.ts`, eksekusi Rust
(`cargo test`), dan contoh statistik benchmark di `docs/33`.

## 1. Deklarasi versi hanya dari payload ter-seal — OK

`versionDeclaration` menulis `{ ackV: 2 }` **di dalam** `sealedPayload`
(`crypto.ts:2214`), dan pembacaannya hanya dari plaintext hasil dekripsi:

```ts
// crypto.ts:3095-3096 (v1)  dan  crypto.ts:552-553 (v2)
const peerVersion = extractVersionDeclaration(decryptedPlaintext);
```

`extractVersionDeclaration` menuntut JSON objek dengan `ackV === 2` persis;
string `"2"`, angka lain, array, atau teks legacy → `null` (`spqrWire.ts:130-139`,
dikunci `spqrWire.test.ts`). Jadi relay tidak bisa mengklaim "peer mampu v2"
tanpa memalsukan AEAD, dan tidak bisa menghapus deklarasi tanpa merusak tag.

## 2. Header v2 tidak pernah dibaca sebagai v1 — OK

`parseSpqrHeader(drHeader)` dipanggil **sebelum** skipped-key dan sebelum
`worker_dr_ratchet_decrypt` (`crypto.ts:2991-2997`). Header v2 yang tidak sah
(`b` kosong, >16 frame, frame kosong, bukan base64url, >4096 karakter) → `null`
→ diperlakukan sebagai header v1. Ini **sengaja** dan aman: header v1 yang sah
tidak punya `v`, dan `isSpqrHeader` hanya menerima `v === 2` persis
(`spqrWire.ts:67-89`). Yang tidak boleh terjadi — menerka v2 dari bentuk lain —
tidak ada.

Konsekuensi yang dicatat: karena header berada **di luar** AEAD (hanya
`ciphertext` yang disegel), relay dapat mengubah `dr` dan membuat dekripsi gagal.
Itu sama dengan v1 (header `{kemPk, ct, n, pn}` juga di luar AEAD) dan hanya
menghasilkan DoS, bukan pemalsuan — tidak dilaporkan sebagai temuan baru.

## 3. Kill switch menghentikan kirim/iklan, bukan baca — OK

- `spqrSendingEnabled()` = build-time `VITE_SPQR_FORCE_V1` **dan** kill switch
  runtime DEV, dibaca **per pengiriman** (`spqrNegotiation.ts:141-150,220-226`).
- `advertisedCapabilities(enabled)` hanya mengiklankan `spqr-ratchet` saat
  mengirim diizinkan (`:172-174`).
- `decryptSpqrMessage` **tidak** memeriksa saklar sama sekali
  (`crypto.ts:509-524` komentar eksplisit) — pesan v2 yang sudah terkirim tetap
  dibaca, sesuai docs/33 §33.8.
- Override `VITE_SPQR_FORCE_V2` hanya dihormati bila `import.meta.env.DEV`
  (`:104-112`), jadi tidak ada kenop produksi tambahan.

## 4. Transaksionalitas state braid — OK dengan satu pertanyaan (di bawah)

- `encryptSpqrMessage`: header dibangun **sebelum** `saveSpqrState`
  (`crypto.ts:463-476`), jadi frame yang tidak sah menggagalkan kirim tanpa
  menyimpan state maju.
- `decryptSpqrMessage`: `saveSpqrState` hanya setelah `worker_spqr_ratchet_decrypt`
  berhasil (`crypto.ts:533-546`); worker melempar pada AEAD gagal **sebelum**
  mengembalikan state (`crypto.worker.ts:1979-2003`), jadi ciphertext yang
  dirusak relay tidak memajukan braid.
- `spqrSendStep`/`spqrRecvStep` mengembalikan state baru hanya bila seluruh
  rangkaian selesai; batas langkah = batas frame (16), dan kegagalan → throw
  (`spqrSession.ts:74-111`).
- State >64 KiB ditolak **sebelum** dijadwalkan (`spqrState.ts:131-140`), dan
  `loadSpqrState` mengembalikan state yang masih menunggu debounce (paling baru),
  bukan yang lama dari disk (`:170-181`).

## 5. Batas wire frame braid — OK

`SPQR_MAX_FRAMES_PER_MESSAGE = 16`, `SPQR_MAX_FRAME_B64_CHARS = 4096`,
non-kosong, `[A-Za-z0-9_-]+`; `buildSpqrHeader` melempar bila dilanggar
(`spqrWire.ts:43-52,91-105`). `spqrRecvStep` juga menolak >16 frame
(`spqrSession.ts:118-120`) — pertahanan berlapis terhadap header jaringan.

## 6. ABI WASM & entropi — OK

- Modul tanpa import (`WebAssembly.Module.imports` diperiksa dan ditolak bila
  ada), memory diambil sebelum `memory.buffer` (grow melepas ArrayBuffer) —
  `spqrRatchet.ts:196-224`.
- Entropi disuntik host lewat `getrandom` custom backend; `spqr_seed_entropy`
  membatasi 1..4096 byte dan **wajib** sebelum `send` (`lib.rs:157-172,268-277`).
  `spqrSend` mengembalikan `ERR_ENTROPY` bila host lupa menyuntik.
- Scratch 256 KiB dengan `write_output`/`read_input` yang menolak panjang
  melebihi buffer; framing output dibaca ketat (`readFramed` melempar bila
  melebihi buffer) — `lib.rs:113-121`, `spqrRatchet.ts:130-148`.

## 7. Pertanyaan yang perlu jawaban maintainer (UNVERIFIED)

**Kirim gagal setelah state braid maju.** `encryptSpqrMessage` menyimpan state
braid (`saveSpqrState`, `crypto.ts:469-473`) **sebelum** pemanggil mengirim
payload ke transport. Bila pengiriman kemudian gagal (transport putus, tab
ditutup, quota IndexedDB), braid sudah maju satu langkah sementara peer tidak
menerima frame-nya. Untuk v1, kehilangan satu pesan aman karena message key
berikutnya diturunkan dari rantai dan peer bisa skip (MAX_SKIP 1000). Untuk
braid, saya **tidak menemukan bukti** bahwa satu langkah yang hilang selalu bisa
diselamatkan — SPQR memang dirancang untuk pesan hilang/out-of-order, tetapi
klaim itu tidak saya uji, dan `docs/33` tidak menyatakannya untuk kasus "frame
tidak pernah terkirim".

Yang akan memastikan: satu tes dua sisi di mana A `spqrSendStep` lalu **tidak**
mengirim frame-nya, kemudian A mengirim pesan berikutnya dan B harus tetap bisa
membaca. Bila gagal, ini menjadi temuan Medium (kehilangan pesan setelah
gangguan jaringan) — bukan sekarang, karena saya belum membuktikannya.

## 8. Ringkas: apa yang tidak saya periksa

- `cargo test` untuk `spqr-wasm` dan sidecar; tidak ada klaim kompilasi.
- `spqrBench.ts` dan angka benchmark `docs/33` (p50 0,26 ms) tidak diverifikasi.
- E2E `spqr.spec.ts` (dua klien nyata + rollback) tidak dijalankan.
- `packages/spqr-wasm/dist/spqr.wasm` tidak di-hash ulang terhadap manifest
  (`scripts/check-wasm-artifacts.sh` tidak dijalankan).
