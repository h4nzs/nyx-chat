# Pass 5 — Temuan baru

Temuan pass 1–4 tidak diulang; lihat `10-delta.md` §A–B. Semua temuan di bawah
berasal dari kode yang dibaca pada pass ini dan diberi `berkas:baris`.

---

## N5-01 (Low, keyakinan tinggi) — jalur v2 tidak punya arsip era sesi; v1 punya

**Ringkas.** v1 memakai tiga slot `previous_session_states` ala libsignal: pesan
yang datang dari era DH/X3DH lama tetap dicoba dengan state arsip sebelum
dinyatakan gagal (`crypto.ts:3007-3045`, komentar "FALLBACK ERA ARSIP"). Jalur v2
**tidak** punya padanannya: ia hanya memakai state braid saat ini, dan state itu
satu baris per percakapan yang **dihapus** setiap sesi baru.

**Bukti.**

```ts
// web/src/utils/crypto.ts:509-521  (decryptSpqrMessage)
const state = await retrieveRatchetStateSecurely(input.conversationId);
if (!state) return { status: 'pending', reason: 'waiting_for_ratchet_state' };
if (!state.spqrAuthKey || !state.spqrDirection) {
  return { status: 'error', error: new Error('spqr: sesi ini tidak punya state braid (didirikan sebagai v1)') };
}
```

```ts
// web/src/utils/crypto.ts:2991-2997  (pemilihan jalur, sebelum arsip v1 dicoba)
const spqrHeader = parseSpqrHeader(drHeader);
if (spqrHeader) {
    return await decryptSpqrMessage({ … });   // ← tidak pernah menyentuh arsip
}
```

```ts
// web/src/utils/crypto.ts:2184 dan web/src/lib/messagePipeline.ts:430
await deleteSpqrState(conversationId);           // sesi baru = braid baru
```

`spqrState` menyimpan satu baris per kunci (`nyx_spqr_state_v1:<conversationId>`,
`spqrState.ts:37,75`), jadi dua era tidak bisa hidup berdampingan seperti state
DR v1.

**Skenario.** A dan B sudah memakai v2. Sebuah pesan v2 tertunda (offline,
transport putus) melewati rotasi sesi (A menginisiasi X3DH baru, atau B menerima
handshake baru dan `deleteSpqrState` berjalan). Saat pesan lama itu akhirnya
tiba: `parseSpqrHeader` mengenalinya sebagai v2, `decryptSpqrMessage` memakai
braid era **baru** → frame tidak cocok → `error`, dan jalur arsip v1 tidak
pernah dicoba karena fungsi sudah `return`. Pada posisi yang sama, pesan v1
diselamatkan arsip.

**Dampak.** Pesan v2 lintas-era hilang (terlihat sebagai error dekripsi, bukan
senyap). Tidak ada kebocoran atau pemalsuan; ini kehilangan data yang tidak
simetris dengan v1 dan tidak tercakup dokumentasi rollback (`docs/33` §33.8
hanya menjanjikan state braid dipertahankan saat rollback, bukan saat sesi baru).

**Perbaikan (bukan patch mekanis).** Pilih salah satu: (a) simpan braid state
per `sessionId` dan biarkan pembaca mencoba era yang tersedia (pola arsip v1),
atau (b) dokumentasikan bahwa rotasi sesi memutus pesan v2 yang belum terkirim,
dan pastikan pengirim menunggu konfirmasi sebelum rotasi. (b) lebih murah, tetapi
harus eksplisit — perilaku sekarang adalah (b) tanpa dokumentasi.

**Test yang menangkapnya.** Simulasi dua era: kirim v2, rotasi sesi
(`deleteSpqrState` + handshake baru), lalu terapkan pesan v2 era pertama →
harus terbaca (atau gagal dengan alasan yang terdokumentasi), bukan `error`
generik.

---

## N5-02 (Low, keyakinan tinggi) — dokumen `spqrRatchet.ts` menyatakan modul belum dipakai produksi

```ts
// web/src/lib/spqrRatchet.ts:26-28
 * Modul ini **belum dipakai jalur pesan produksi** (lihat `docs/33` §33.7):
 * format wire & state ratchet NYX saat ini beku, dan peralihan ke v2 harus
 * bergerbang kapabilitas + diuji end-to-end dulu.
```

Kenyataannya modul ini diimpor worker (`crypto.worker.ts:38`
`import { initSpqrSession, spqrRecvStep, spqrSendStep }`) dan dipakai setiap
pengiriman/terima v2 (`crypto.worker.ts:1935,1979`), dengan keputusan versi di
`crypto.ts:2226-2231`. `spqrNegotiation.ts` menyatakan integrasi **menyala**.
Ini drift dokumen yang berbahaya justru karena berada di berkas kripto: reviewer
berikutnya bisa menyimpulkan jalur v2 mati dan melewatkannya.

**Perbaikan.** Ganti paragraf itu dengan status sebenarnya (aktif di belakang
`ackV` + kapabilitas + kill switch) dan rujuk `docs/33` §33.10.

---

## N5-03 (Low) — suite kripto v2 diam-diam di-skip tanpa artefak WASM

```ts
// web/src/lib/__tests__/spqrSession.test.ts:63 (idem spqrRatchet:76, spqrMessagePath:227)
const withSkip = HAS_WASM ? describe : describe.skip;
```

Bila `packages/spqr-wasm/dist/spqr.wasm` tidak ada, seluruh tes handshake/ratchet
v2 **dilewati tanpa gagal** — output tetap "passed" dengan jumlah tes lebih
sedikit. Pola ini persis yang dulu membuat `transport.spec` membawa dua bug yang
tidak pernah terdeteksi (AGENTS.md). Di mesin ini artefaknya ada sehingga
69/69 benar-benar berjalan, tetapi CI yang lupa membangun WASM akan tampak hijau.

**Perbaikan.** `describe.skip` → `describe` dengan `expect(HAS_WASM).toBe(true)`,
atau langkah CI yang membangun artefak sebelum vitest (dan gagal bila tidak ada).

---

## N5-04 (Info) — komentar N4-03 menjanjikan penolakan yang tidak terjadi

```rust
// server/transport-sidecar/src/main.rs:801-806
// ... Sekarang baca berhenti di header + payload maksimum + 1 byte;
// kelebihan byte = frame terlalu besar (bukan dipotong diam-diam).
```

`parse_inbound_frame` hanya mem-parse **frame pertama** dari buffer; byte setelah
payload yang dideklarasikan tidak pernah dibaca (`protocol.rs:228-250`). Jadi
frame ber-`len = 32768` yang diikuti byte tambahan tetap `Forward` dan byte
tambahan itu dibuang tanpa error. Bukan masalah keamanan (jalur uni memang satu
frame per stream, dan frame kedua tidak pernah diproses — perilaku lama), tetapi
komentar perbaikan menyatakan hal yang tidak benar. Perbaiki komentar, atau
tolak buffer yang menyisakan byte (`end != buffer.len()`), sesuai maksudnya.
