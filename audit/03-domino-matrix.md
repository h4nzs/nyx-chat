# 03 — Matriks domino

Setiap perubahan kontrak besar → semua pemakai/pembaca → sudah disesuaikan? → bukti.
Kolom "Status" hanya `OK`, `DRIFT`, atau `RISIKO` (lihat temuan).

## 1. Skema Prisma

| Perubahan | Pemakai/pembaca | Status | Bukti |
|---|---|---|---|
| `UserHiddenConversation.tokenHash @unique` (wajib) menggantikan `deliveryToken` | `utils/groupTokens.ts`, `utils/groupSync.ts`, `utils/routingIdentity.upsertMembership`, `routes/groups.ts` (`/sync`, `/token/refresh`, `/pp/issue`, `/:id/mailbox/pull`, `DELETE /:id/membership`), `utils/groupAccess.ts`, `tests/deliveryTokens.test.ts` | **RISIKO** | semua pemakai memakai `tokenHash`; tidak ada sisa `deliveryToken` di `server/src` (grep). Risiko ada di **jalur migrasi DB** → F-04 |
| `Conversation.groupEpoch/groupTokenExpiresAt/epochRotatedAt` | `groupTokens.rotateGroupToken`, `routes/groups.ts`, `utils/groupAccess.ts` (TTL ditegakkan), `web/src/lib/groupEpochRotation.ts` | OK | `groupAccess` memeriksa expiry, bukan hanya hash |
| `GroupMailboxItem` (baru) | `utils/groupMailbox.ts`, `routes/groups.ts` (`/:id/mailbox[/pull]`), `jobs/cleanup.ts:227`, `web/src/lib/groupMailbox.ts` | OK | indeks `[conversationId, createdAt]`, `[conversationId, tag]`, `[expiresAt]`; GC terhubung |
| `User.oprfIndex` (baru) | `routes/users.ts` (`/search` OR `oprfIndex`), `utils/searchOprf.ts` (register/login menulis), `jobs/pirSnapshot.ts` (`where oprfIndex not null`), `pir/snapshot.ts` | OK | register/login menulis hanya bila `PIR_OPRF_ENABLED=1`; baris lama tetap dicari lewat `usernameHash` |
| `Device.signingKeyV2`, `cryptoVersion` | `routes/keys.ts` (verifikasi bundle v2), `routes/auth.ts` (`/register`, `/recover`, `/link/approve`), `utils/keyTransparency.ts` | OK | `signingKeyV2` opsional di `/register` (residual, metrik `LEGACY_V1_USAGE`) tetapi wajib di `PUT /me/keys` |
| Dexie v14 → v16 (`ktConfig`, `groupCredentials: null`) | `web/src/lib/db.ts`, `web/src/lib/groupCredentials.ts`? | **DRIFT** | kode di v16; `AGENTS.md`/`docs` masih menyebut v13 → F-14 |

## 2. Wire / protokol

| Kontrak | Pemakai | Status | Bukti |
|---|---|---|---|
| Opcode `KICK = 0x07` | `packages/shared/src/transport.ts:9`, sidecar `main.rs:385,446` (hardcode), klien `transportClient.ts:507` | OK (dengan catatan D5) | angka sama; konstruksi frame diduplikasi di dua cabang sidecar |
| Kapabilitas `spqr-ratchet` | `packages/shared/src/transport.ts` (`SERVER_CAPABILITIES`), sidecar HELLO (`protocol.rs`), gateway WSS (`utils/transportCapability.ts:25`), klien `spqrNegotiation.ts` | OK | satu sumber `SERVER_CAPABILITIES`; WSS membalas `capabilities` hanya bila klien mengiklankan |
| Rate-limit bucket chat/ACK/presence | `network/realtimeHandlers.ts:171-174` (satu sumber), gateway (tidak lagi memasang sendiri), sidecar (tanpa limiter, sengaja) | OK | komentar + kode: bucket hanya di handler agar tidak dihitung dua kali |
| Header `X-Delivery-Tokens` dihapus | `server/src/app.ts:220` masih meng-whitelist di CORS; `routes/conversations.ts` masih menerima field **body** `deliveryTokens` (jalur invite, bukan header) | **DRIFT ringan** | whitelist CORS `x-delivery-tokens` tinggal artefak; tidak berbahaya, tapi menandakan sisa hard cut |
| `/api/groups/sync` anonim | `app.ts:275` (mount sebelum CSRF), OHTTP allowlist `packages/shared/src/ohttp.ts:386`, klien `groupSync.ts`, `docs/12:240` | **DRIFT** | batas respons dokumen ≠ kode → F-10 |
| `handshake.auth.token` (WSS) | `realtime/gateway.ts:211-214`, `web/src/lib/transportClient.ts` | OK | fallback cookie tetap ada; token hanya di memori |
| Cookie `COOKIE_DOMAIN` | `config.ts`, `sessionUtils.authCookieOptions`, `app.ts` (CSRF), `docs/10` §10.20, `.env.example` | OK | satu nilai untuk set **dan** clear; CSRF ikut |

## 3. Env var baru

| Var | Kode | `.env.example` | `deploy.yml` | Docs | Status |
|---|---|---|---|---|---|
| `COOKIE_DOMAIN` | ✅ | ✅ | — (prod secrets di VPS) | ✅ `docs/10` | OK |
| `PIR_OPRF_ENABLED`, `NYX_OPRF_SEED` | ✅ | ✅ | — | ✅ `docs/35` | OK |
| `PP_SYNC_REQUIRED` | ✅ | ✅ | — | ✅ `docs/37` | OK |
| `PP_ISSUER_PRIVATE_JWK` | ✅ (wajib di prod) | ❌ | — | ❌ | **DRIFT** F-13 |
| `CREDENTIAL_SUITE_ALLOWLIST` | ✅ | ❌ | — | ✅ `docs/37` | DRIFT |
| `OHTTP_TOKEN_MODE`, `OHTTP_RELAY_TARGET`, `OHTTP_ENABLED`, `OHTTP_*_KEY` | ✅ | ✅ | — | ✅ | OK |
| `OHTTP_RELAY_{PORT,HOST,MAX_BODY,RATE_LIMIT,ALLOW_PUBLIC_BIND}`, `OHTTP_GATEWAY_TARGET`, `OHTTP_GATEWAY_TRUSTED_HOSTS` | ✅ | ⚠ hanya di `ops/systemd/nyx-ohttp-relay.env.example` | — | sebagian | DRIFT F-13 |
| `GROUP_RELEASE_JITTER_MS`, `GROUP_EPOCH_MAX_*` | ✅ | ✅ | — | ✅ | OK |

## 4. Metrik ↔ alert ↔ dashboard

| Metrik baru | Dideklarasikan | Dirujuk alert | Kasus drill | Status |
|---|---|---|---|---|
| `nyx_group_sync_total`, `nyx_privacy_pass_total`, `nyx_credential_present_total` | `utils/metrics.ts` | dicari `ops/prometheus/*` | `scripts/drill-alerts.sh` mencakup aturan baru (coverage gate) | **tidak diverifikasi** (drill tidak dijalankan; lihat `06`) |
| `nyx_ohttp_ops_total`, `nyx_legacy_v1_usage_total` | ✅ | ✅ (dokumentasi alert boot) | idem | tidak diverifikasi |
| `nyx_wss_capability_total` | ✅ `metrics.ts` | ❌ tidak ada alert (wajar: metrik diagnostik) | — | OK |
| `nyx_group_release_delay_ms` | ✅ | ❌ | — | OK |

Catatan: karena exporter hanya hidup di satu worker cluster (F-07), angka metrik
yang benar-benar di-scrape **bukan** total trafik. Ini memengaruhi semua aturan
alert, bukan hanya metrik baru.

## 5. Klien i18n

| Perubahan | 4 bahasa | Status |
|---|---|---|
| Kunci baru device-linking, PP, KT, server-down | en/es/id/pt-BR | **OK** — 0 kunci hilang, 0 yatim (skrip flatten, 7 namespace) |

## 6. Kontrak kripto beku

| Format | Perubahan | Status |
|---|---|---|
| `ENC1:` envelope | tidak berubah; `ENC2:<keyId>:…` ditambahkan, pembaca mencoba ENC1→ENC2 | OK |
| Envelope XChaCha `base64url(nonce24‖ct)` | tidak berubah (`xchacha_seal/open`) | OK (spot check) |
| Padding 8 KB | tidak berubah | OK (spot check) |
| Header ratchet v2 `{v:2,b:[frames]}` | tidak berubah; v1 tetap `{…}` dan kill switch hanya menghentikan kirim | OK |
| `ENCRYPT_DATA` `Array.from(...)` | tidak berubah | OK |
