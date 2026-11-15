# 00 — Orientasi (Phase 0)

> Catatan kerja audit. Status: read-only, tidak ada source yang diubah.
> Tanggal: 2026-10-31. Commit: `b320c957`.

## Komponen (dari `pnpm-workspace.yaml`, `package.json`, docs/01)

| Komponen | Path | Peran | Trust boundary |
|---|---|---|---|
| Client PWA | `web/` | React 19 + Vite 8, Zustand, Dexie (IndexedDB), OPFS | **Pemegang kunci & plaintext.** Satu-satunya tempat plaintext ada. |
| Crypto worker | `web/src/workers/crypto.worker.ts` | libsodium + WASM (ML-KEM-768/X-Wing, ML-DSA-65, XChaCha20-Poly1305, secretstream) | Di dalam browser, tapi thread terpisah; hanya lewat `crypto-worker-proxy.ts`. |
| Transport worker | `web/src/workers/transport.worker.ts` | WebTransport (QUIC) client | Frame ke sidecar. |
| API | `server/src` | Express 5, Prisma 7, Redis | **Blind relay.** Tidak boleh punya plaintext/kunci privat. |
| Sidecar | `server/transport-sidecar` (Rust) | WebTransport server, frame → `nyx:upstream:<op>` | Memverifikasi JWT sendiri lalu meneruskan. |
| KT log | `server/kt-query` (Go) | LevelDB ML-DSA-65 log, satu proses | Menyimpan kunci publik + proof. |
| OHTTP relay / PIR | proses terpisah (`nyx-ohttp-relay`, `nyx-pir-sidecar`) | menyembunyikan IP/query pencarian | Loopback. |
| DB | PostgreSQL | ciphertext + metadata ter-seal/tag | Dianggap bisa di-dump penyerang. |
| Redis | pub/sub + rate limit + presence | metadata sesi | Dianggap setara dump (docs/28). |
| R2 | blob terenkripsi | attachment/backup/snapshot | Operator R2 tidak bisa membaca. |

## Yang server secara desain TIDAK boleh tahu

1. Isi pesan, lampiran, profil, story — ciphertext saja.
2. Username plaintext — hanya Argon2id client + `HMAC(pepper, hash)`.
3. Siapa bicara dengan siapa — routing eksplisit dari klien; keanggotaan disimpan sebagai tag/`sealAtRest`.
4. Kunci privat / master seed / recovery phrase.
5. IP mentah di DB/Redis — hanya `clientIpTag` (HMAC).

## Batas kepercayaan yang jujur (dari docs, untuk diverifikasi)

- Server menyajikan JS → **tidak ada** proteksi terhadap server yang menyajikan bundle jahat (docs/03 §3.7). Ini keterbatasan fundamental, bukan bug.
- `GET /api/messages/:conversationId` tanpa cek keanggotaan (docs/03 §3.7.1 D2) — trade-off eksplisit.
- Mailbox `tag` terlihat server (D3).
- Timing pesan tidak disembunyikan (docs/03 §3.1).
- Auditor KT = proses terpisah, bukan organisasi terpisah.

## Daftar fitur yang diaudit

Registrasi/login/recovery/device-link, 1:1 (DR v1 + SPQR v2), grup (sender key, epoch, mailbox), attachment, story, burner, calls (TURN token), KT v2 verify/monitor/gossip, backup `.nyxbak`, PIR/OHTTP/Privacy Pass, trust tier (PoW/WebAuthn/attestation), rate limiting, observability.

## Metode

Static review + baseline otomatis (build/tsc/lint/test/audit). E2E **tidak** dijalankan (butuh Postgres+Redis+sidecar+coturn). Lihat `01-baseline.md` untuk yang bisa/tidak bisa dijalankan.
