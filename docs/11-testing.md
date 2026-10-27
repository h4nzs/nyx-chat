# 11 — Testing

## 11.1 Unit tests

| Package | Runner | Command | Count |
|---|---|---|---|
| server | `node:test` via `tsx` (Jest config is dead — ignore it) | `pnpm --filter nyx-server run test` | 86 files / 677 tests (675 pass + 2 skip) |
| web | Vitest (jsdom) | `pnpm --filter nyx-web run test` | 125 files / 1018 tests |
| kt-query | `go test` lewat `build.sh test` (vendor, tanpa jaringan) | `server/kt-query/build.sh test` | 31 tests |
| sidecar | `cargo test` (Rust, murni tanpa soket); CI juga menjalankan `cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings` (job `sidecar`, sama seperti `pir-sidecar`) | `cd server/transport-sidecar && cargo test` | 2 targets / 25 tests (19 lib + 6 sertifikat) |
| everything | — | `pnpm -r --if-present run test` | 211 files (server 86 + web 125) |
| DR oracle | Go (implementasi kedua, tanpa libsodium) | `cd tools/dr-oracle && go run . -check` | vektor 9 test web + interop 4 test |

Server tests are listed explicitly in `server/package.json` (`tsx --test tests/…`). They must **not** require Postgres/Redis — Prisma clients are faked (see `tests/sessionKeys.test.ts`).

Web test files live in `src/lib/__tests__/` (biometric/auto-unlock, cover traffic, group metadata/roster/pseudonyms, pairwise key delivery, refresh lock/retry, shadow-vault delete, socket sync/listeners, transport mode/queue, burner file data, local at-rest sealing + Dexie migration on real IndexedDB, backup format/payload/transport/restore/bench, search index/bench, parser fuzz), `src/store/__tests__/` (connection, send watchdog, silent refresh, participant sync, unread count), `src/utils/__tests__/` (date, sanitize, tempId, typeGuards, url), and `src/components/__tests__/passwordPromptBiometric.test.tsx`.

Covered areas: password hashing, `safeEqualStrings`, JWT, `toRawServerMessage` (incl. a regression guard that `ciphertext` is never emitted), session-key blind relay, type guards, sanitize (XSS + secret redaction), URL helpers, date formatting.

```bash
# Single test file
cd server && pnpm exec tsx --test tests/mappers.test.ts
cd web && npx vitest run src/utils/__tests__/sanitize.test.ts
```

### Test penulisan Key Transparency itu opt-in (jangan diubah)

Dua test menulis entri **sungguhan** ke log KT (`keyTransparency.test.ts` dan
`ktIdentityLog.test.ts`). Keduanya sengaja **skip** kecuali diminta eksplisit:

```bash
cd server && NYX_KT_LIVE_WRITE=1 KT_SERVER_URL=http://127.0.0.1:18081 \
  pnpm exec tsx --test tests/ktIdentityLog.test.ts
```

Gate-nya **bukan** keberadaan `KT_SERVER_URL`, dan jangan pernah dikembalikan ke
sana: `server/.env` selalu mengisi variabel itu dan `src/config.ts` memuat dotenv,
jadi gate lama membuat `pnpm test` menulis entri uji ke log yang sedang
dikonfigurasi. Itu terjadi 2026-10-17 (dua entri orphan masuk log self-host
`127.0.0.1:8081`; log KT append-only, jadi tidak bisa dihapus). Guard-nya ada di
`ktIdentityLog.test.ts` (`guard: penulisan live hanya dengan opt-in eksplisit`).

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
- `e2e/call.spec.ts` needs a **running coturn** whose static auth secret matches the server (`TURN_URLS` + `TURN_STATIC_AUTH_SECRET`, `docs/30` §30.9 WS-E(1)). Locally (docker, loopback peers → `allow-loopback-peers` is required, coturn refuses loopback peers by default):
  ```bash
  cat > /tmp/coturn.conf <<'EOF'
  listening-ip=127.0.0.1
  relay-ip=127.0.0.1
  listening-port=3478
  min-port=49160
  max-port=49200
  use-auth-secret
  static-auth-secret=<same as server TURN_STATIC_AUTH_SECRET>
  realm=nyx.local
  fingerprint
  no-cli
  no-tls
  no-dtls
  allow-loopback-peers
  log-file=stdout
  EOF
  docker run -d --name nyx-coturn --network host \
    -v /tmp/coturn.conf:/etc/coturn/turnserver.conf:ro coturn/coturn:4.6-alpine
  ```
  CI does the same in the `e2e-chrome` job (apt coturn + `/etc/turnserver.conf` + `ss -lun | grep :3478`). Without coturn the spec **skips with a written reason** — it never passes through Cloudflare TURN instead.
- `call.spec.ts` needs the **chrome** project (`--project=chrome`): it drives `RTCPeerConnection` from the page, which works in any Chromium, but the spec belongs with the full-browser job and only Chrome has WebTransport next to it. It exchanges SDP **without trickle ICE**, so it must wait for `iceGatheringState === 'complete'` before `setRemoteDescription` — handing over candidate-less SDP makes ICE stall in `new` and looks exactly like "coturn is broken".
- WebTransport specs additionally need the Rust sidecar (they **auto-skip** when `WebTransport` is undefined — e.g. headless Chromium without QUIC).
  - Perhatikan: di Chromium yang **punya** `WebTransport` tapi sidecar-nya tidak jalan (mesin dev), spec burner/transport **tidak** skip — mereka gagal di `ESTABLISHING_UPLINK`. Jalankan sidecar (`cargo build --release` + `JWT_SECRET`/`REDIS_URL`/`TRANSPORT_PORT=33333`) atau pakai `--project=chrome` seperti CI.

**Important quirks:**
- `workers: 1` (serial) — the suite is flaky in parallel against one local server.
- **`pnpm --filter nyx-web run test:e2e:ohttp`** (`playwright.ohttp.config.ts`) menyalakan API di **:4100** dan Vite di **:5273**. Di selfhost yang relay OHTTP-nya sudah hidup (`nyx-ohttp-relay` juga memakai :4100), stack uji itu gagal `EADDRINUSE` — hentikan relay dulu (`systemctl --user stop nyx-ohttp-relay`) atau jalankan suite di checkout/mesin terpisah. Port itu hardcoded di config (CI tidak punya relay di host yang sama).
- `e2e/global.setup.ts` wipes the local DB + Redis (`server/scripts/reset-test-env.ts`). Never run against a valuable database. **Failure mode worth knowing (2026-10-17):** if `server/.env` has `NODE_ENV=production`, the reset script refuses (exit 1, `DANGER: Attempted to wipe database in non-local/production environment!`) and Playwright aborts before the first spec — every E2E run on such a machine is impossible, and the message looks like a setup bug. Run E2E with a test env (`NODE_ENV` not `production`), don't edit `.env` around the guard.
- Registration helpers walk the full onboarding modal chain (Proof of Trust → Recovery → Secure Phrase → Verify Sequence ×2 close → System Init). They live in `e2e/helpers/registration.ts` (WS-G(7)) — import `registerUser` (or `registerUserViaBiometric` for the Settings spec); do not copy them back into specs.
- **Quick Tour hanya ter-mount SETELAH bootstrap selesai** (`Chat.tsx` mensyaratkan `!isBootstrapping && user.hasCompletedOnboarding === false`), dan setelah registrasi `isBootstrapping` masih `true` sampai ada reload halaman. Artinya `dismissOnboardingTour(page)` di `registerUser` tidak menemukan apa pun untuk spec yang tidak pernah reload — dan sebaliknya spec yang **melakukan reload** (`page.goto`, `page.reload`) melihat tour muncul lalu: overlay `fixed inset-0`-nya menolak klik berikutnya (`subtree intercepts pointer events`). Jadi: panggil `dismissOnboardingTour(page)` SETELAH setiap navigasi penuh, bukan hanya sekali setelah registrasi. Klik `×` menandai onboarding selesai di server, jadi tour tidak kembali setelah reload berikutnya.
- **State burner host hidup HANYA di RAM** (`useBurnerStore.activeSessions`). `page.goto('/chat/<roomId>')` me-reload halaman → DR host hilang → komposer host terkunci di "Waiting for guest to establish secure connection..." (lampiran tak bisa dikirim), dan baris conversation-nya bisa belum terbaca lagi karena persistensi ke IndexedDB bersifat fire-and-forget. Buka room burner lewat **baris sidebar (navigasi in-app)**, tunggu preview pesan guest muncul (bukti `burner:receive` sudah menginisialisasi DR host), baru berinteraksi — lihat `e2e/regression.spec.ts` (`openBurnerChatOnHost`).
- **Halaman guest `/drop` tidak boleh melewati bootstrap sesi aplikasi**: guest bukan akun server (`GET /api/users/me` → 401) dan fallback 401 bootstrap **menghapus cookie `at`** milik sesi ephemeral yang baru diterbitkan `POST /api/auth/burner`. Akibatnya identitas guest berganti dan `burner:reply` (relay ke anggota `burner:room:<roomId>`) tidak pernah sampai — gejala: guest hanya melihat pesannya sendiri. Guard ada di `App.tsx` (bootstrap dilewati di `/drop`) dan `BurnerChat.tsx` (join ulang tiap transport `connect`).
- **Destroy burner asinkron, dan barrier-nya harus di IndexedDB** bukan di UI: `deleteConversation` menghapus baris dari state UI **sinkron** lalu menunggu hapus Dexie, sementara handler klik `ChatWindow` tidak menunggu rantai itu. Menunggu baris sidebar hilang saja TIDAK cukup (terbukti flaky 2026-10-15: lulus 2 dari 4 run suite, dengan snapshot kegagalan memperlihatkan baris burner `Unknown / No messages yet` kembali setelah reload). Pola yang dipakai `regression.spec`: `expect.poll` atas `db.conversations.get(roomId)` + `db.messages.where('conversationId')` harus `0/0` sebelum reload — gagal di barrier itu berarti penghapusan memang tidak pernah tertulis.
- Slow assertions use `expect.poll` / generous timeouts. Registration is **15–20 s on an idle box but 40–70 s measured while busy** (Argon2 in the worker competes with everything else on one core), so `helpers/registration.ts` waits **90 s** for the Proof-of-Trust modal and specs that register **must** raise the global timeout (`test.setTimeout(180000)`; `chat.spec` uses 480 s because it also mines PoW). The default 60 s timeout is eaten by registration alone: specs then die mid-flow and the failure message points at whatever line happened to be running — that is how `settings.spec` looked like a broken eject flow, and how the 60 s claim in this file went unnoticed.
- **Latency assertions must exclude the sender's local crypto.** `transport.spec` measures the *relay leg* (optimistic bubble visible → peer bubble readable, budget 8 s) and only logs the raw end-to-end number, because Argon2 + DR session setup on the sender measured 1.8–4.5 s on the same machine and made the total swing 7.4–17.2 s with identical code.
- **PoW waits must be as wide as the client's own PoW timeout, not wider.** `minePoW` is **Argon2id at 16 MB per attempt** (`crypto.worker.ts`) hunting a hex prefix of `floor(difficulty/2)` zeros; `chat.spec`'s verify flow reaches difficulty 6 (registration already burnt one challenge, the upgrade takes a second → `min(4 + count, 8)`), i.e. ~16³ ≈ 4096 Argon2id evaluations. A 60 s badge wait failed ~1 run in 5 with the modal still showing “Mining hash collision…” — a crypto-budget failure that reads like a broken locator. The wait is now the client's own 300 s (`crypto-worker-proxy.minePoW`) and the spec's global timeout sits **above** it (480 s), so a genuine mine failure surfaces as the badge assertion instead of a global timeout that hides the cause.
- **`e2e/spqr.spec.ts` (ratchet v2 / braid SPQR)** membuktikan jalur versi paralel dari amplop yang tersimpan **di server** (`dr.v === 2`, ada `b`, tanpa `kemPk`) sambil memastikan peer benar-benar membaca plaintext. Ia butuh jalur v2 aktif: di CI sidecar mengiklankan `spqr-ratchet`; di mesin dev tanpa sidecar jalankan `VITE_SPQR_FORCE_V2=1 pnpm --filter nyx-web dev` (override hanya dihormati di build DEV). Bila keduanya tidak ada, spec **skip dengan alasan tertulis** — bukan lulus palsu.
  - Test kedua menutup **rollback operator** dengan dua klien: satu klien dipaksa kembali ke v1 lewat kill switch runtime DEV (`localStorage['nyx_spqr_force_v1']`, konstanta `SPQR_RUNTIME_KILL_SWITCH_KEY`) karena `VITE_SPQR_FORCE_V1` bersifat build-time (= sama untuk semua klien, jadi rollback satu klien tidak bisa diuji). Yang diasersikan: klien yang di-rollback **mengirim v1 lagi di wire**, peer tetap bisa membacanya (state v1 tidak pernah ditimpa), pesan v2 dari peer **tetap terbaca** di klien yang di-rollback, dan baris state braid-nya masih ada.
  - Pembacaan amplop WAJIB menunggu pesan benar-benar tersimpan di server (`expect.poll` atas jumlah item) — pesan muncul di UI secara optimistis, jadi membaca "pesan terbaru" tanpa poll akan mengambil pesan sebelumnya.
- Tombol tutup `×` modal onboarding **jangan** diklik lewat `locator(...).first().click()`: saat berpindah langkah, modal lama masih ber-animasi keluar sehingga Playwright menunggu "stabil" sampai timeout. Pakai `dismissModalCloseButton` dari `helpers/registration.ts` (resolve ulang + `force`).
- Kalau registrasi "berhasil" (201) tapi onboarding tak lanjut, cek apakah muncul `PasswordPromptModal`: jalur at-rest tidak boleh memanggil `getMasterSeed()` (yang memunculkan prompt) — pakai `getMasterSeedIfUnlocked()` (lihat `CHANGELOG` 2026-10-13).

## 11.3 CI matrix

| Job | Browser | Transport |
|---|---|---|
| `e2e` | Playwright chromium (headless shell) | transport specs skipped; diakhiri **drill alert terhadap exporter nyata** (`scripts/drill-alerts.sh`, metrik dari API yang baru dinyalakan) |
| `e2e-chrome` | Google Chrome via apt (`channel: 'chrome'`) | `cargo test` (protokol murni + fuzz 20k) → **sidecar built + running**, cert hash parsed from its banner → transport + chat specs run fully; **coturn diinstal + dijalankan** (`TURN_URLS`/`TURN_STATIC_AUTH_SECRET` di env job) → `call.spec` run fully |
| `alerts` | — | `promtool check config`/`check rules`/`test rules` atas 14 aturan (`SKIP_LIVE=1`) |
| `dr-oracle` | — | oracle Go: `build`/`vet`/`test` + gate drift vektor (`go run . -check`) + `x3dhOracleVectors.test.ts` + `x3dhOracleInterop.test.ts` |

Fuzz panjang (≥1 jam) dan k6 **tidak** jalan per-PR: keduanya dijalankan
nightly / sebelum rilis besar (`docs/30` §30.20 sisa WS-G). Terakhir dijalankan
(2026-10-14): fuzz sidecar 160,9 juta iterasi/300 s (0 temuan) dan k6 beban penuh
(`scripts/load/run-relay-load.sh`, 500 VU — send p95 74,4 ms / fetch p95 68,8 ms,
0% error). Drill alert + vektor oracle **sudah** jalan per-PR (tabel di atas).

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

- WebRTC calls have a browser-level relay test (`e2e/call.spec.ts`, coturn, chrome project) but **no full in-app call flow** (UI `call:*` signaling → `webrtc.ts` → relay): the spec drives `RTCPeerConnection` directly with the server-issued credentials. Two-browser call setup still has no E2E.
- DR/sender-key vectors are **partial** (`docs/30` WS-G(6)): primitif di bawah
  ratchet (X25519, Ed25519→X25519, X-Wing, BLAKE2b keyed, XChaCha20-Poly1305,
  urutan/panjang rahasia X3DH) dibandingkan dua arah dengan oracle **Go tanpa
  libsodium** (`tools/dr-oracle`, job CI `dr-oracle`), tapi **bukan** terhadap
  libsignal: sender-key chain, skipped key, dan `SessionRecord` tidak punya
  oracle eksternal — hanya diuji internal (`spqrRatchet.test.ts`, crate SPQR).
- No fuzz target for the KT proof verifier. WS-A **sudah ada** (verifier + penulis +
  jalur baca `server/kt-query`), jadi blokirnya bukan lagi "belum diimplementasikan"
  melainkan bentuk masukannya: `verify_search`/`verify_monitor` menerima protobuf
  dari jaringan dan hash input (byte bukti) tidak bisa dibuat bermakna dengan
  mutasi acak — yang dibutuhkan vektor bukti nyata yang dimutasi terarah
  (`vrf_proof`/`opening`/`tree_size` diubah). Sebagian sudah ada sebagai test
  penolakan di `keyTransparency.test.ts`; fuzzing proporsional masih TODO.
- Key Transparency: penulis log **diverifikasi** (11 test di
  `server/tests/keyTransparency.test.ts` + **8 test** di
  `server/tests/ktIdentityLog.test.ts` untuk jalur rotasi, plus satu penulisan
  nyata ke binary Go `key-transparency-server`). Yang **belum** ada test perilaku
  end-to-end: handler route rotasi (`/keys/prekey-bundle`, `/users/me/keys`,
  `/login`) tidak dijalankan dengan Prisma/Redis — yang diuji adalah modul penulis
  + guard sumber bahwa ketiga jalur memanggilnya (`docs/32` §32.7 poin 2), dan
  sisi klien (penyimpanan identifier ter-seal + pelampirannya di body bundle)
  lewat `web/src/lib/__tests__/ktIdentifierStorage.test.ts`.
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
