# 11 — Testing

## 11.1 Unit tests

| Package | Runner | Command | Count |
|---|---|---|---|
| server | `node:test` via `tsx` (Jest config is dead — ignore it) | `pnpm --filter nyx-server run test` | 41 files / 352 tests |
| web | Vitest (jsdom) | `pnpm --filter nyx-web run test` | 64 files / 517 tests |
| sidecar | `cargo test` (Rust, murni tanpa soket) | `cd server/transport-sidecar && cargo test` | 2 targets / 17 tests |
| everything | — | `pnpm -r --if-present run test` | 97 files |

Server tests are listed explicitly in `server/package.json` (`tsx --test tests/…`). They must **not** require Postgres/Redis — Prisma clients are faked (see `tests/sessionKeys.test.ts`).

Web test files live in `src/lib/__tests__/` (biometric/auto-unlock, cover traffic, group metadata/roster/pseudonyms, pairwise key delivery, refresh lock/retry, shadow-vault delete, socket sync/listeners, transport mode/queue, burner file data, local at-rest sealing + Dexie migration on real IndexedDB, backup format/payload/transport/restore/bench, search index/bench, parser fuzz), `src/store/__tests__/` (connection, send watchdog, silent refresh, participant sync, unread count), `src/utils/__tests__/` (date, sanitize, tempId, typeGuards, url), and `src/components/__tests__/passwordPromptBiometric.test.tsx`.

Covered areas: password hashing, `safeEqualStrings`, JWT, `toRawServerMessage` (incl. a regression guard that `ciphertext` is never emitted), session-key blind relay, type guards, sanitize (XSS + secret redaction), URL helpers, date formatting.

```bash
# Single test file
cd server && pnpm exec tsx --test tests/mappers.test.ts
cd web && npx vitest run src/utils/__tests__/sanitize.test.ts
```

## 11.1b Backup benchmark harness (WS-C fase 5)

The framed-backup export/import path has a dedicated benchmark harness that reports
**wall time + peak memory** (implementation: `docs/31` §31.6d).

```bash
# Normal suite runs a 200-message sanity bench (always on, fast).
pnpm --filter nyx-web run test

# Full 10k-message benchmark; prints the report (time, peak heap/RSS, integrity).
pnpm --filter nyx-web run bench:backup
```

- Fixture is deterministic (LCG, no `Math.random`) and in-memory, so no IndexedDB
  or browser is required. **IndexedDB I/O time is therefore NOT included** — the numbers
  are a lower bound for crypto + serialization, not a browser profile.
- Peak memory is sampled from `process.memoryUsage()` every 10 ms during each phase.
- Gate thresholds live in `BACKUP_BENCH_BUDGET` and are deliberately loose so they
  do not flake across CI/VPS machines; the real numbers are always printed.
- Reference run (dev, Linux, Node 26, two consecutive runs, ±10 %):
  10 000 messages → 20 272 records, 4.62 MB / 79 frames; export 1.34–1.51 s,
  restore 0.62–0.77 s, peak heap ~147 MB.

## 11.1c Fuzz parsers — input tak terpercaya (WS-G(5))

Dua harness fuzz yang **deterministik** (temuan bisa direproduksi dari seed)
menutup gate `docs/30` §30.11 butir (4) "fuzz jalan ≥1 jam tanpa crash":

```bash
# Web (TS): parseTransportHello, readBackupHeader, parseBackupArchive,
# readBackupChunk, unpadBackupPayload — default cepat, perpanjang lewat env.
pnpm --filter nyx-web run fuzz:parsers             # 50k iterasi/target
NYX_FUZZ_SECONDS=3600 pnpm --filter nyx-web run fuzz:parsers:hour

# Sidecar (Rust): bingkai `[opcode][len:u32 BE][payload]` + HELLO, termasuk
# differential test melawan implementasi referensi kedua.
cd server/transport-sidecar && cargo test        # 20k iterasi (masuk CI)
NYX_FUZZ_SECONDS=3600 cargo run --release --bin fuzz-framing
```

- Parser yang diuji menerima input dari **peer/berkas pengguna**, jadi
  invariantnya bukan "tidak crash" saja: nilai yang diterima juga diperiksa
  bentuknya (mis. salt header = 16 byte, `frameCount ≥ 1`, `hello.caps` dalam
  batas), dan hanya `BackupFormatError` yang boleh dilempar.
- Harness punya **self-test**: target yang sengaja rusak harus dilaporkan sebagai
  temuan (`fuzzParsers.test.ts`), supaya "0 temuan" tidak berarti "harness mati".
- Angka referensi (dev, Linux, Node 26 / rustc 1.95): web 5 target × 100k iterasi
  = 500k input dalam ~50 s (0 temuan); sidecar 160,9 juta iterasi dalam 300 s
  (536k iterasi/detik, 0 temuan) → gate 1 jam ≈ 1,9 miliar input.
- Yang **belum** di-fuzz: verifier proof key-transparency (belum ada kodenya —
  WS-A) dan parser framing bidi sisi sidecar yang membaca dari soket (hanya
  keputusan murninya yang diuji).

## 11.2 E2E (Playwright)

```bash
cd web
pnpm exec playwright test --project=chromium
pnpm exec playwright test e2e/auth.spec.ts --project=chromium   # single spec
```

**Prerequisites (local):**
- Postgres + Redis running.
- API dev: `pnpm --filter nyx-server dev`.
- Web dev: `pnpm --filter nyx-web dev`.
- WebTransport specs additionally need the Rust sidecar (they **auto-skip** when `WebTransport` is undefined — e.g. headless Chromium without QUIC).
  - Perhatikan: di Chromium yang **punya** `WebTransport` tapi sidecar-nya tidak jalan (mesin dev), spec burner/transport **tidak** skip — mereka gagal di `ESTABLISHING_UPLINK`. Jalankan sidecar (`cargo build --release` + `JWT_SECRET`/`REDIS_URL`/`TRANSPORT_PORT=33333`) atau pakai `--project=chrome` seperti CI.

**Important quirks:**
- `workers: 1` (serial) — the suite is flaky in parallel against one local server.
- `e2e/global.setup.ts` wipes the local DB + Redis (`server/scripts/reset-test-env.ts`). Never run against a valuable database.
- Registration helpers walk the full onboarding modal chain (Proof of Trust → Recovery → Secure Phrase → Verify Sequence ×2 close → System Init). They live in `e2e/helpers/registration.ts` (WS-G(7)) — import `registerUser` (or `registerUserViaBiometric` for the Settings spec); do not copy them back into specs.
- **Quick Tour hanya ter-mount SETELAH bootstrap selesai** (`Chat.tsx` mensyaratkan `!isBootstrapping && user.hasCompletedOnboarding === false`), dan setelah registrasi `isBootstrapping` masih `true` sampai ada reload halaman. Artinya `dismissOnboardingTour(page)` di `registerUser` tidak menemukan apa pun untuk spec yang tidak pernah reload — dan sebaliknya spec yang **melakukan reload** (`page.goto`, `page.reload`) melihat tour muncul lalu: overlay `fixed inset-0`-nya menolak klik berikutnya (`subtree intercepts pointer events`). Jadi: panggil `dismissOnboardingTour(page)` SETELAH setiap navigasi penuh, bukan hanya sekali setelah registrasi. Klik `×` menandai onboarding selesai di server, jadi tour tidak kembali setelah reload berikutnya.
- **State burner host hidup HANYA di RAM** (`useBurnerStore.activeSessions`). `page.goto('/chat/<roomId>')` me-reload halaman → DR host hilang → komposer host terkunci di "Waiting for guest to establish secure connection..." (lampiran tak bisa dikirim), dan baris conversation-nya bisa belum terbaca lagi karena persistensi ke IndexedDB bersifat fire-and-forget. Buka room burner lewat **baris sidebar (navigasi in-app)**, tunggu preview pesan guest muncul (bukti `burner:receive` sudah menginisialisasi DR host), baru berinteraksi — lihat `e2e/regression.spec.ts` (`openBurnerChatOnHost`).
- **Halaman guest `/drop` tidak boleh melewati bootstrap sesi aplikasi**: guest bukan akun server (`GET /api/users/me` → 401) dan fallback 401 bootstrap **menghapus cookie `at`** milik sesi ephemeral yang baru diterbitkan `POST /api/auth/burner`. Akibatnya identitas guest berganti dan `burner:reply` (relay ke anggota `burner:room:<roomId>`) tidak pernah sampai — gejala: guest hanya melihat pesannya sendiri. Guard ada di `App.tsx` (bootstrap dilewati di `/drop`) dan `BurnerChat.tsx` (join ulang tiap transport `connect`).
- **Destroy burner asinkron**: hapus baris conversation dari IndexedDB butuh beberapa ratus ms. Reload tepat setelah klik Destroy membatalkan penghapusan itu → room tampak "kembali". Tunggu baris sidebar benar-benar hilang (`expect(...).toHaveCount(0)`) sebelum reload.
- Slow assertions use `expect.poll` / generous timeouts (crypto registration takes 15–60s).
- **`e2e/spqr.spec.ts` (ratchet v2 / braid SPQR)** membuktikan jalur versi paralel dari amplop yang tersimpan **di server** (`dr.v === 2`, ada `b`, tanpa `kemPk`) sambil memastikan peer benar-benar membaca plaintext. Ia butuh jalur v2 aktif: di CI sidecar mengiklankan `spqr-ratchet`; di mesin dev tanpa sidecar jalankan `VITE_SPQR_FORCE_V2=1 pnpm --filter nyx-web dev` (override hanya dihormati di build DEV). Bila keduanya tidak ada, spec **skip dengan alasan tertulis** — bukan lulus palsu.
  - Test kedua menutup **rollback operator** dengan dua klien: satu klien dipaksa kembali ke v1 lewat kill switch runtime DEV (`localStorage['nyx_spqr_force_v1']`, konstanta `SPQR_RUNTIME_KILL_SWITCH_KEY`) karena `VITE_SPQR_FORCE_V1` bersifat build-time (= sama untuk semua klien, jadi rollback satu klien tidak bisa diuji). Yang diasersikan: klien yang di-rollback **mengirim v1 lagi di wire**, peer tetap bisa membacanya (state v1 tidak pernah ditimpa), pesan v2 dari peer **tetap terbaca** di klien yang di-rollback, dan baris state braid-nya masih ada.
  - Pembacaan amplop WAJIB menunggu pesan benar-benar tersimpan di server (`expect.poll` atas jumlah item) — pesan muncul di UI secara optimistis, jadi membaca "pesan terbaru" tanpa poll akan mengambil pesan sebelumnya.
- Tombol tutup `×` modal onboarding **jangan** diklik lewat `locator(...).first().click()`: saat berpindah langkah, modal lama masih ber-animasi keluar sehingga Playwright menunggu "stabil" sampai timeout. Pakai `dismissModalCloseButton` dari `helpers/registration.ts` (resolve ulang + `force`).
- Kalau registrasi "berhasil" (201) tapi onboarding tak lanjut, cek apakah muncul `PasswordPromptModal`: jalur at-rest tidak boleh memanggil `getMasterSeed()` (yang memunculkan prompt) — pakai `getMasterSeedIfUnlocked()` (lihat `CHANGELOG` 2026-10-13).

## 11.3 CI matrix

| Job | Browser | Transport |
|---|---|---|
| `e2e` | Playwright chromium (headless shell) | transport specs skipped |
| `e2e-chrome` | Google Chrome via apt (`channel: 'chrome'`) | `cargo test` (protokol murni + fuzz 20k) → **sidecar built + running**, cert hash parsed from its banner → transport + chat specs run fully |

Fuzz panjang (≥1 jam) dan k6 **tidak** jalan per-PR: keduanya dijalankan
nightly / sebelum rilis besar (`docs/30` §30.20 sisa WS-G).

**Test internal crate `spqr` (gate `docs/30` §30.8 poin 1) — manual, bukan per-PR:**
butuh toolchain nightly + dev-dependency besar (proptest, criterion, libcrux).
Jalankan pada sumber ter-vendor (pin `06959b4708f9`, v1.6.0) — tidak perlu
checkout di luar repo:

```bash
cd vendor/signal/spqr
cargo +nightly test --release --lib   # 57 passed; exit 0 (~12 s saat target/ hangat)
```

`cargo test` di toolchain **stable** tidak bisa: test crate memakai `std::assert_matches`
yang masih unstable (`error[E0658]`).

## 11.4 What is NOT covered (known gaps)

- No browser-level test for WebRTC calls.
- No cross-implementation DR/sender-key vectors against a libsignal oracle
  (`docs/30` WS-G(6)) — needs a Rust harness built from the pinned libsignal
  checkout; not part of the repo build.
- No fuzz target for the KT proof verifier (blocked: WS-A not implemented).
- No test for the biometric (WebAuthn) login path (needs a real authenticator).
- Payment webhooks are only unit-tested indirectly (HMAC compare helper).
- Crypto worker internals are exercised through E2E flows, not unit tests (worker is monolithic by design).

## 11.5 Writing new E2E specs

1. Import the shared helpers from `./helpers/registration` instead of copying the
   onboarding chain (`registerUser`, `registerUserViaBiometric`).
2. Add the `WebTransport` guard at test start if the flow needs realtime — dan
   SELALU pakai `navigateToAppOrigin: true`:

```ts
import { supportsWebTransport } from './helpers/registration';

test.skip(
  !(await supportsWebTransport(page, { navigateToAppOrigin: true })),
  'WebTransport tidak tersedia di environment ini'
);
```

   Di `about:blank` (halaman awal Playwright) `window.isSecureContext` bisa
   `false`, sehingga `WebTransport` terlihat tidak didukung padahal Chrome penuh
   mendukungnya → spec skip SENYAP, termasuk di CI `e2e-chrome` yang justru
   dibangun untuk menjalankannya. Probe tanpa navigasi hanya untuk pemanggil yang
   sudah berada di origin app.

3. For the "search peer → open chat → send → peer receives" flow, use
   `openDirectChatWith`, `sendChatMessage`, and `expectPeerReceivesMessage`
   instead of copying the locator blocks.

3. Keep selectors role/text-based (repo convention) and avoid `waitForTimeout` except where unavoidable.
