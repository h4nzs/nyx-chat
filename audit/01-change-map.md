# 01 — Peta perubahan (`a493ad7..HEAD`)

Dibangun dari git, bukan ingatan:

```
git log --reverse --format='%h %ad %s' --date=short a493ad7..HEAD   # 26 commit
git diff --stat a493ad7..HEAD                                      # 598 berkas, +78.292 / −7.037
```

Catatan: `audit.md` menyebut "157 commit sejak 2026-09-01"; jarak dari stempel
`a493ad7` (2026-10-15) ke HEAD hanya **26 commit** — sisanya berada sebelum stempel.
Skala perubahan (598 berkas) cocok dengan klaim.

Legenda risiko: **T** = tinggi (menyentuh kunci/identitas/otorisasi), **S** = sedang
(kontrak lintas modul, data pengguna), **R** = rendah (dokumen, CI, kosmetik).

| Tema | Commit | Berkas inti | Kontrak yang disentuh | Risiko |
|---|---|---|---|---|
| Lint cutover oxlint | `6eddf4c7`, `75cd5628` | `.oxlintrc.json`, semua `package.json`, `docs/*` | perintah CI (`lint`) | R |
| Attestation perangkat | `759341a1` | `server/src/utils/{webauthnAttestation,attestationRootsHealth}.ts`, `ops/attestation/`, `scripts/attestation-roots.mjs`, 26 berkas web | WebAuthn policy, `ABUSE_*` env, metrik root | T |
| Paritas transport WT↔WS | `b901bef6`, `e541f325` | `server/src/network/{realtimeHandlers,redisBridge}.ts`, `server/transport-sidecar/src/main.rs`, `packages/shared/src/{transport,socket,events}.ts`, `web/src/lib/{transportClient,socketListeners}.ts` | opcode/frame KICK, rate-limit bucket, event kontrak | T |
| QR device-linking | `070e51a5`, `f82a2993` | `server/src/utils/deviceLinking.ts`, `routes/auth.ts` (`/link/*`), `web/src/{lib/deviceLinking,pages/LinkDevicePage,pages/Login}.tsx` | state machine Redis, `/register` bundle shape | T |
| PQ Fase 1 (ML-DSA, X3DH v2, grup v4) | `ce51ff1c`, `92cd7aef` | `web/src/utils/crypto.ts`, `workers/crypto.worker.ts`, `lib/{spqr*, group*}`, `packages/shared/src/{crypto,group}*` | bundle v2, header ratchet, metadata grup multi-era | T |
| KT v2 (ML-DSA, dual-write) | `c733b83d`, `b6c4b399` | `server/kt-query/**`, `packages/keytrans-v2/**`, `keytrans-wasm-v2/**`, `server/src/utils/keyTransparency.ts`, `jobs/ktSnapshot.ts` | nilai log v2, `/api/keys/kt/*` proxy, env `KT_*` | T |
| PQ Fase 8 + cutover PQ-only | `51d3bf95`, `ae50930a` | `scripts/check-pq-only.mjs`, `pq-only-*.json`, `web/src/**` (v1 reader dihapus), `server/src/routes/keys.ts` | prekey bundle, `LEGACY_V1_USAGE`, Dexie v16 (drop `groupCredentials`) | T |
| OHTTP token-off + relay terpisah | `d87f38fd` | `server/src/ohttp/{config,relay,relayApp,gateway}.ts`, `routes/ohttp.ts`, `utils/ohttpToken.ts`, `ops/systemd/` | allowlist OHTTP, `OHTTP_TOKEN_MODE`, header internal | T |
| OPRF pencarian | `aa2ad3e1` | `packages/shared/src/searchOprf.ts`, `server/src/utils/searchOprf.ts`, `routes/users.ts` (`/search`, `/search/oprf`), `prisma` (`User.oprfIndex`) | bentuk `q` pencarian, kolom baru | T |
| PIR sidecar + snapshot | `e195da48`, `9492aa4f` | `server/pir-sidecar/**`, `packages/pir-wasm/**`, `web/src/lib/pirClient.ts`, `workers/pir.worker.ts`, `server/src/{pir,jobs/pirSnapshot,routes/pir}.ts` | `/api/pir/*`, `PIR_*` env, artefak WASM | T |
| Server-down / readiness | `9492aa4f`, `926a2d70` | `ops/cloudflare/worker/**`, `web/src/{store/systemStore,lib/serverReachability,sw.ts}`, `docs/18` | status `systemStore`, SW navigation | S |
| Privacy closure (token grup, mailbox, sync anonim) | `ab7ef8e3` | `server/src/{routes/groups,utils/groupTokens,utils/groupSync,utils/groupMailbox,utils/privacyPass}.ts`, `web/src/lib/{groupSync,groupMailbox,privacyPass,groupPseudonyms}.ts`, Prisma (`Conversation.groupEpoch`, `UserHiddenConversation.tokenHash`, `GroupMailboxItem`) | discovery tanpa JWT, epoch/token, mailbox, Privacy Pass | T |
| Residual + wire migrasi device | `25b16996` | `server/src/{config,utils/sessionUtils,routes/auth,app}.ts`, `web/src/lib/transportClient.ts` | cookie `COOKIE_DOMAIN`, `handshake.auth.token`, CSRF cookie domain | T |

## Commit yang dibaca penuh

`ce51ff1c`, `ae50930a` (cutover), `070e51a5` (device-linking), `b901bef6` (paritas),
`ab7ef8e3` (privacy closure), `25b16996` (residual), `d87f38fd` (OHTTP), `aa2ad3e1`
(OPRF). Untuk commit besar lain (`759341a1`, `c733b83d`, `9492aa4f`, `e195da48`)
dibaca jalur eksekusi yang berisiko (gate, env, batas input), bukan seluruh diff.

## Verifikasi `a493ad7` R1–R11 (klaim penutupan review eksternal)

Diperiksa di kode HEAD, bukan di dokumen:

| Item | Bukti di kode | Status |
|---|---|---|
| R2 client version gate | `app.ts:263-266` → `middleware/clientVersion.ts`; fail-open tanpa header (didokumentasikan) | tertutup sebagian (lihat F-11) |
| R5 pencarian hanya hash | `routes/users.ts` `isSearchableIdentifier(q)` sebelum DB | tertutup |
| R6 `authorizeAdminCleanup` | `utils/adminCleanupAuth.ts` + rate limit + allowlist IP, dipakai `app.ts` | tertutup |
| R11 peringatan boot | `utils/startupSignals.ts` dipanggil `index.ts` | tertutup |
| Sisanya (R1, R3, R4, R7–R10) | tersebar di `atRestSecrets` (ENC2), `routingIdentity`, `schemaPrivacy` test | lihat `notes/C-privacy.md` |
