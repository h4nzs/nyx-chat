# 06 — Analisis Gap Tes & Dokumentasi

## 6.1 Baseline tes (dijalankan)

| Suite | Perintah | Hasil |
|---|---|---|
| Server (`node:test` via `tsx`) | `cd server && pnpm run test` | **711 tes, 709 lulus, 2 skip, 0 gagal**, ~119 s |
| Web (`vitest`) | `cd web && pnpm run test` | lihat `01-baseline.md` (dijalankan ulang penuh; run pertama terpotong timeout alat, bukan kegagalan tes) |
| E2E Playwright | tidak dijalankan | butuh Postgres + Redis + API + Vite + sidecar (+ coturn untuk `call.spec`) |
| Rust sidecar | tidak dijalankan | toolchain ada (`cargo 1.95.0`), `cargo test` tidak dieksekusi dalam audit ini |
| Go KT | tidak dijalankan | `go1.27.1` ada, `build.sh test` tidak dieksekusi |
| `pnpm audit --prod` | dijalankan | 3 advisory (1 moderate, 2 low) |

## 6.2 Area kritis **tanpa** tes yang menutup temuan di laporan ini

| Prioritas | Tes yang harus ditambahkan | Menutup |
|---|---|---|
| 1 | `realtimeHandlers`: `message:view_once_opened` oleh user ketiga → `message.delete` **tidak** dipanggil, event `message:viewed` tidak terkirim | F-01 |
| 2 | `realtimeHandlers`: `group:fulfilled_key` / `metadata:updated` dengan `conversationId` grup yang bukan milik pengirim → ditolak, tidak ada baris SYSTEM | F-02 |
| 3 | `redisBridge`: `isActiveDeviceAllowed` saat Redis GET error → `false`, dan hasil error tidak di-cache | F-04 |
| 4 | `messages.ts`: POST REST menyimpan hash `deleteSecret`; DELETE dengan token yang sama → 204; tanpa token → 403 | F-03 |
| 5 | `messages.ts`: paginasi dengan baris `seq: 0` tetap mengembalikan `nextCursor` selama `hasMore` | F-07 |
| 6 | `uploads.ts`: `urlTtl` di luar batas → 400/ter-clamp; `fileRetention` negatif/raksasa ditolak | F-06 |
| 7 | `handlePresence`: `typing` dengan target di luar peer → tidak terkirim; target > cap → ditolak | F-05 |
| 8 | `session:fulfill_response` + `storeReceivedSessionKey`: kunci untuk percakapan lain / dari bukan peserta tidak pernah menimpa state | F-11 (setelah dampak dipastikan) |

Tes invarian kripto yang **sudah ada** dan patut dipertahankan: `cryptoKnownAnswer.test.ts`, `drProtocol.test.ts` (19 tes), `groupMetadata.test.ts`, `pqBundle.test.ts`, `mlDsa.test.ts`, `atRestSecrets.test.ts`, `schemaPrivacy.test.ts`, `dumpAudit.test.ts`, `senderIdentity.test.ts`, `tier2Residual.test.ts`, `clientVersion.test.ts`, `refreshReplay.test.ts`, `groupAccess.test.ts`, `realtimeHandlers.test.ts`, `gatewayParity.test.ts`.

## 6.3 Gap dokumen ↔ kode

| # | Dokumen | Klaim | Kenyataan | Tingkat |
|---|---|---|---|---|
| D-01 | `docs/05-message-pipeline.md` §5.4 | "REST message send exists (`POST /api/messages`) but the client uses WebTransport when connected" | Klien **tidak pernah** memakai `POST /api/messages`; offline = antrean IndexedDB, bukan fallback REST. Rute itu juga tidak menyimpan `deleteSecret` (F-03). | Menyesatkan |
| D-02 | `docs/03-security-model.md` §3.3 | "Single active device: enforced server-side per-opcode" | Benar saat Redis sehat; **fail-open** saat Redis error dan hasilnya di-cache 60 s (F-04). | Perlu kualifikasi |
| D-03 | `docs/05` §5.1 | "Sidecar publishes `nyx:upstream:1`" | Kode `pSubscribe('nyx:upstream:*')` lalu mem-parse opcode dari nama channel — lebih umum dari yang ditulis, bukan salah. | Info |
| D-04 | `README.md` §KT | "An ML-DSA-65 log v2 runs alongside as dual-write; verification and reads still use v1" | Menurut `AGENTS.md` dan docs/38 v1 sudah **dipensiunkan** 2026-10-28 dan klien hanya menerima ABI 2. README tampak tertinggal dari `STATUS.md`/docs/38. **Perlu dikonfirmasi** ke pemilik repo sebelum diperbaiki (bisa jadi README sengaja konservatif). | Menyesatkan (likely stale) |
| D-05 | `README.md` §Crypto | "Double Ratchet (hybrid PQ) · SPQR ML-KEM Braid (v2)" | Akurat terhadap kode. Wording "Signal Protocol" (bila ada di deskripsi repo) akan over-state: tidak ada X3DH klasik Signal. | Akurat |
| D-06 | `docs/04` §4.4 | "`pqSignature` tidak diverifikasi di jalur v2" | Sesuai kode — keputusan terdokumentasi, bukan bug. | Akurat |

## 6.4 Rekomendasi urutan perbaikan tes

1. Semua tes otorisasi realtime (F-01, F-02, F-05) — murah, dan mengunci perilaku yang sekarang salah.
2. Tes fail-open Redis (F-04) — satu unit test dengan mock yang melempar.
3. Tes kontrak REST message (F-03, F-07) — menutup drift dokumen D-01 sekaligus.
4. Tes batas input presign (F-06) dan sync ids (F-09).
5. Setelah F-11 dipastikan: tes injeksi kunci sesi (paling berharga bila ternyata klien menerima buta).
