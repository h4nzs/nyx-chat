# 12 — API Reference (complete catalog)

Base URL: `https://api.nyx-app.my.id/api`. All request bodies are JSON (limit 1MB; uploads 1MB). Cookies: `at` (access, 15m) and `rt` (refresh, 30d), HttpOnly. `GET /api/engine/rooms` embeds hand the page a token in the URL; the client stores it as `embed_at` — a separate, non-HttpOnly cookie whose lifetime equals the token's `exp` — and `requireAuth` accepts it as a fallback after `at` (`docs/20` §20.3). CSRF: header `CSRF-Token` for non-GET when cookies are used. Most routes require `requireAuth` (cookie or `Authorization: Bearer`).

Conventions: `:id` = CUID, keys are base64url, ciphertexts are opaque strings. Responses are JSON; errors use `{ "error": "..." }`.

**Client version header (R2, 2026-10-15).** Every REST call from the web app sends `x-nyx-client-version: <build version>`. When the operator sets `MIN_CLIENT_VERSION`, a request from an older client is rejected **before CSRF and before any route** with:

```http
426 Upgrade Required
{ "error": "CLIENT_TOO_OLD", "message": "...", "clientVersion": "3.0.0", "minimumVersion": "3.1.0" }
```

The gate is **off when `MIN_CLIENT_VERSION` is unset**, and a request **without** the header passes (clients shipped before 3.0.0 do not send it) — see `docs/10` §10.14. With `CLIENT_VERSION_REQUIRE_MUTATIONS=1` that leniency applies to reads only: a **mutation** (`POST`/`PUT`/`PATCH`/`DELETE`) with no readable version header is rejected as well:

```http
426 Upgrade Required
{ "error": "CLIENT_VERSION_REQUIRED", "message": "...", "minimumVersion": "3.1.0" }
```

`GET /health` is never gated.

---

## auth — `/api/auth`

| Method | Path | Auth | Body / Notes |
|---|---|---|---|
| POST | `/register` | public (authLimiter + Turnstile) | `{usernameHash, password, encryptedProfile, publicKey, pqPublicKey, signingKey, encryptedPrivateKeys, deviceName, turnstileToken}` + headers `X-Nyx-Fingerprint`, `X-Nyx-Installation-Id` → `{user, accessToken, deviceId}` |
| POST | `/login` | public (authLimiter) | `{usernameHash, password, publicKey?, pqPublicKey?, signingKey?, encryptedPrivateKey?, deviceName?, deviceId?}` + fingerprint/installation headers → `{user, accessToken, deviceId, encryptedPrivateKey?}` |
| POST | `/refresh` | cookie `rt` | Rotates tokens → `{accessToken}`. Replay is classified (dead family → 401 tanpa alarm; retry penerus langsung dalam `REFRESH_REPLAY_GRACE_MS` → dilanjutkan; replay asli → family di-revoke + `force_logout` ber-scope `deviceId`) |
| POST | `/logout` | cookie | Revokes the refresh family, clears cookies |
| POST | `/logout-all` | requireAuth | Revokes all sessions of the user + Redis `active_device` |
| GET | `/recover/challenge` | public | Recovery challenge for an identifier |
| POST | `/recover` | public | Recovery with signature + new password |
| GET | `/webauthn/register/options` / POST `/webauthn/register/verify` | requireAuth | Passkey registration |
| GET | `/webauthn/login/options` / POST `/webauthn/login/verify` | public | Passkey login (returns `encryptedPrivateKey` when the device is recognized) |
| POST | `/link/claim` | public (authLimiter) | Perangkat baru memindai QR: `{token, publicKey, pqPublicKey?, signingKey, encryptedPrivateKey, deviceName?}` + header fingerprint/installation **perangkat baru** → `{pendingId}`. Token sekali pakai; perangkat lama menerima `auth:linking_request` |
| GET | `/link/status/:pendingId` | public (authLimiter) | `{state: 'pending'\|'approved'\|'expired'}` — perangkat baru melakukan polling |
| POST | `/link/approve` | requireAuth | `{pendingId}` → `{ok, deviceId}`. Membuat Device row untuk kunci yang didaftarkan saat claim + entri log KT. Hanya akun pemilik pending |
| POST | `/link/deny` | requireAuth | `{pendingId}` → `{ok}`; state dihapus |
| POST | `/link/complete` | public (authLimiter) | `{pendingId, password}` → `{deviceId, usernameHash}`. Password diverifikasi **sebelum** state dibakar (salah ketik tidak menghabiskan QR). **Tidak** menerbitkan token: klien melanjutkan `POST /login` (password + kunci lokal) supaya hanya ada satu jalur sesi |
| GET | `/pow/challenge` | requireAuth | PoW challenge for trust verification |
| POST | `/pow/verify` | requireAuth | Submit PoW solution → verified tier |
| GET | `/transport-ticket` | requireAuth | Short-lived ticket for WebTransport connect |
| POST | `/burner` | public | Create a burner guest session (`burnerLimiter`: 30/jam per IP) |
| POST | `/ohttp-token` | requireAuth + CSRF | Token bearer 120 dtk, `scope=ohttp`, hanya sah untuk target allowlist OHTTP; diletakkan **di dalam amplop** (cookie `HttpOnly` tidak bisa dibaca JS). `404` bila `OHTTP_ENABLED` kosong |

## users — `/api/users`

| Method | Path | Notes |
|---|---|---|
| GET | `/me` | Own profile (opaque encryptedProfile) |
| PUT | `/me` | Update `{encryptedProfile?, autoDestructDays?}` → returns updated user + emits `user:updated` |
| PUT | `/me/keys` | Update device public keys (invalidates key caches). `usernameHash?` = identifier mentah Argon2id untuk entri log KT saat kunci berubah (`docs/32` §32.7) |
| POST | `/me/complete-onboarding` | Set `hasCompletedOnboarding` |
| POST | `/me/logout` | Revoke own refresh token, clear cookies |
| DELETE | `/me` | Delete account (+ R2 files `{fileKeys}`) → KICK |
| GET | `/me/devices` | List own devices |
| DELETE | `/me/devices/:deviceId` | Remove a device |
| GET | `/me/blocked` | List blocked users |
| GET | `/search?q=<hash>` | Search by usernameHash (blind index). Hanya hash yang diterima: 43-char base64url (Argon2id) atau 64-hex (index OPRF/legacy) — nilai mentah ditolak `400 INVALID_IDENTIFIER_HASH` |
| POST | `/search/oprf` | Evaluasi OPRF: `{blinded}` (32 byte base64url) → `{suite, evaluated}`. Publik + CSRF; `503 PIR_OPRF_DISABLED` bila `PIR_OPRF_ENABLED` kosong. Index akhir dihitung klien (`docs/35` Fase 4a) |
| GET | `/:id` | Public profile + latest device public keys (for safety numbers) |
| POST | `/:id/block` / DELETE `/:id/block` | Block / unblock |

## conversations — `/api/conversations`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create (1:1 or group). Group create **must** carry `adminSecretHash` (SHA-256 hex of the admin capability token) — missing → 400. Sandbox: 3/day for unverified → `SANDBOX_LIMIT` |
| GET | `/sync?ids=…` | Fetch conversations **by id** (Opaque Mailbox). Discovery token-first pindah ke `POST /api/groups/sync` (tanpa cookie/JWT, lihat bagian `groups`) |
| GET | `/:id` | Single conversation |
| PUT | `/:id/details` | Update `{encryptedMetadata}` — requires `X-Group-Token` (member blind auth) **and** `X-Admin-Token` (checked against `adminSecretHash` via `requireAdminCapability`; NULL hash = fail-closed) |
| POST | `/:id/participants` | Broadcast participant add intent (blind) |
| DELETE | `/:id/participants/:userId` | **Admin-only** (`X-Admin-Token`): removes member and atomically rotates group auth secret; returns `{ authSecret }` for encrypted metadata redistribution |
| DELETE | `/:id/leave` | Leave group (blind token) |
| POST | `/:id/pin` | Pin/unpin conversation |
| POST | `/:id/key-rotation` | Request sender-key rotation — requires `X-Admin-Token` (fail-closed when `adminSecretHash` is NULL) |
| DELETE | `/:id/group` | **Admin-only purge** (`X-Admin-Token`): deletes the conversation + messages + delivery tokens, emits `conversation:deleted`; 409 `MEMBERS_REMAIN` while non-owner delivery tokens still exist |
| DELETE | `/:id` | Delete/hide conversation |

## groups — `/api/groups` (token-first, tanpa cookie/JWT)

Router dipasang **sebelum** lapisan CSRF (`app.ts`): semua endpoint diautentikasi
possession token di body, atau capability admin (`X-Admin-Token`) di header. Tidak
ada handler yang menulis/membaca `userId` (`docs/37` §37.3).

| Method | Path | Notes |
|---|---|---|
| POST | `/sync` | Discovery anonim: `{tokens[], ids?, proofs?}` → `{conversations, memberships, unknown}`. `proofs` = token Privacy Pass (satu token = satu sync, terikat `conversationId`). `PP_SYNC_REQUIRED=1` → 403 `PP_PROOF_REQUIRED` tanpa bukti sah. Allowlist OHTTP: `POST` (body ≤ 64 KB) |
| POST | `/token/refresh` | `{token}` (member token) → `{expiresAt, epoch}`; 410 `TOKEN_STALE` bila era sudah lewat |
| POST | `/:id/mailbox` | `{token, items[{kind,tag?,payload}]}` — ≤32 item, payload base64url ≤8 KB, kind ∈ `KEY_REQUEST\|KEY_ENVELOPE\|META\|COVER` → 201 `{written, epoch}` |
| POST | `/:id/mailbox/pull` | `{token, cursor?, limit?}` → `{epoch, items, nextCursor, truncated}` (filter era + TTL 7 hari, ≤200 item) |
| GET | `/:id/epoch` | Admin capability → `{epoch, rotatedAt, createdAt, messageSeq}` — dasar keputusan rotasi PCS di klien (`docs/37` §37.3.6) |
| POST | `/:id/epoch` | Admin capability → rotasi group token `{token, epoch, expiresAt}`; token mentah hanya dikembalikan ke pemegang capability |
| DELETE | `/:id/membership` | Revoke oleh pemegang token: hapus barisnya sendiri (epoch **tidak** naik) |
| GET | `/pp/issuer` | `{suite, keyId, publicJwk}` — kunci verifikasi Privacy Pass |
| POST | `/pp/issue` | `{groupToken, memberToken, blinded[]}` → `{signatures, suite, keyId}`; issuer menandatangani pesan ter-blind (tidak melihat isinya) |
| POST | `/pp/redeem` | `{conversationId, tokens[]}` → `{accepted, spent, invalid}`; 403 bila tidak ada yang diterima |
| POST | `/:id/credential/present` | Body biner (`application/octet-stream`); verifier fail-closed — build ini tanpa issuer, jadi selalu 403 |

## messages — `/api/messages`

| Method | Path | Notes |
|---|---|---|
| GET | `/:conversationId?limit=250` | Pending store-and-forward messages (last 14 days) |
| POST | `/` | Send (blind relay): `{conversationId, content, sessionId?, tempId?, expiresIn?, isViewOnce?, targetRecipients? (≤500; ≤2 untuk GUEST)}`. Conversation tak dikenal → **404** (dulu 500) |
| DELETE | `/:id` | Blind delete — header `X-Delete-Token` must match `deleteSecret` (constant-time); `?r2Key=` cleans the R2 blob |

## keys — `/api/keys`

| Method | Path | Notes |
|---|---|---|
| POST | `/prekey-bundle` | Upload own bundle (identity/pq/signing + signed prekeys + OTPK) — also carries `encryptedPrivateKeys?` to keep the server's device copy in sync ([temuan #2]) and `usernameHash?` (identifier mentah) so a key rotation is written to the KT log (`docs/30` §30.5 WS-A) |
| GET | `/prekey-bundle/:userId` | Fetch a user's bundle (Redis-cached 1h) |
| POST | `/prekey-bundles` | Batch fetch (≤50 users) |
| POST | `/public-keys` | Batch public keys (≤50 users) |
| POST | `/upload-otpk` | Refill one-time prekeys |
| GET | `/count-otpk` | Remaining OTPK count |
| DELETE | `/otpk` | Reset OTPKs |
| GET | `/initial-session/:conversationId/:sessionId` | Initial session key for a conversation |
| GET | `/turn` | Cloudflare TURN credentials (WebRTC) |

## sessionKeys — `/api/session-keys`

| Method | Path | Notes |
|---|---|---|
| GET | `/:conversationId/devices/:deviceId` | Fetch relayed session keys |
| POST | `/:conversationId/ratchet` | Distribute ratchet key material (blind) |

## sessions — `/api/sessions`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List active sessions (UA-parsed) |
| DELETE | `/:jti` | Revoke a session — revokes the whole token family + Redis blacklist |

## stories — `/api/stories`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create story (encrypted payload, expiresAt) |
| GET | `/:id` | Fetch story |
| GET | `/user/:userId` | List a user's active stories |
| DELETE | `/:id` | Delete story |

## uploads — `/api/uploads`

| Method | Path | Notes |
|---|---|---|
| POST | `/presigned` | R2 presigned upload URL (`uploadLimiter`). `fileSize` (byte) **wajib**: angka itu dipakai sebagai `ContentLength` yang ikut ditandatangani (`X-Amz-SignedHeaders`), jadi R2 menolak body yang lebih besar/kecil — batas 5 MB avatar/grup, 100/500 MB lampiran (FREE/SUBSCRIBER) |
| POST | `/burner-presigned` | Presigned upload untuk guest burner (tanpa akun); batas 50 MB, `fileSize` juga dikunci di tanda tangan |

## backup — `/api/backup`

Backup ber-frame terenkripsi (`.nyxbak`) — lihat `docs/31`. Server hanya melihat blob opaque; kunci objek diturunkan HMAC dari `(BACKUP_KEY_SECRET, userId)` tanpa userId di kunci, dan tidak ada tabel DB baru (satu objek per akun, unggah menimpa).

| Method | Path | Notes |
|---|---|---|
| POST | `/presign` | Presigned PUT URL (`uploadLimiter`); body `{ size, urlTtl? }`; kuota FREE 100 MB / SUBSCRIBER 500 MB; butuh akun terverifikasi |
| POST | `/download-url` | Presigned GET URL (`generalLimiter`); body `{ urlTtl? }` — dipakai tombol "Ambil dari awan" di modal restore (404 = belum ada backup) |
| DELETE | `/` | Hapus objek backup akun (`generalLimiter`) — dipanggil `executeLocalWipe` SEBELUM `/api/auth/logout-all`, karena endpoint ini butuh sesi hidup |

Objek backup juga dihapus saat akun dihapus (`DELETE /api/users/me`, langkah 1b): kuncinya tidak memuat userId, sehingga filter lampiran berbasis prefix `${userId}-` tidak pernah mencakupnya.

Batasan yang jujur: `size` yang dikirim klien dipakai sebagai `ContentLength` yang **ikut ditandatangani**, sehingga satu PUT tidak bisa melebihi ukuran yang disetujui (R2 menolak body dengan panjang berbeda) — sama seperti `/api/uploads/presigned`. Pemakaian kumulatif per akun tetap tidak dihitung server (unggahan berikutnya menimpa objek yang sama); kuota total tetap urusan kebijakan bucket/lifecycle R2. Rotasi `BACKUP_KEY_SECRET`/`JWT_SECRET` membuat backup awan lama tidak bisa ditemukan lagi.

## burner — `/api/burner`

Status room Burner Chat (`/drop`). Hanya berisi satu bit informasi per room — tidak ada isi pesan, kunci, atau daftar anggota.

| Method | Path | Notes |
|---|---|---|
| GET | `/:roomId/status` | requireAuth (`generalLimiter`) → `{ roomId, terminated }`. `:roomId` wajib berbentuk `burner_[A-Za-z0-9]{1,64}` (400 bila tidak) supaya endpoint ini tidak bisa dipakai membaca key Redis lain |

Kenapa ada: destroy hanya disiarkan sebagai event realtime `burner:terminated` ke anggota room yang sedang terhubung. Guest yang offline, belum sempat `burner:join`, atau sudah berganti identitas setelah reload tidak akan pernah menerimanya — dulu halaman `/drop` bahkan tidak punya cara bertanya, sehingga room yang sudah mati tetap bisa dibuka (bahkan setelah refresh). Klien memanggil endpoint ini di `initializeFromHash` dan menolak render bila `terminated: true` (plus menulis penanda lokal `burned_<roomId>`).

Event realtime terkait (KEY_SYNC): `burner:join` (ACK `{ok, terminated}`), `burner:send` (ACK `{ok}` / `{ok:false, error:'ROOM_TERMINATED'}`), `burner:reply` (ACK `{ok, notified}`), `burner:destroy` (ACK `{ok, notified}`; menyimpan `burner:terminated:<roomId>` TTL 24 jam sebelum menyiarkan `burner:terminated` ke anggota lalu menghapus set room). Ketiga event kirim dibatasi 30/menit per pengirim, dan guest hanya boleh menyebut ≤2 `targetRecipients` (identitas guest bisa dibuat berulang — lihat `utils/guestPolicy.ts`).

## previews — `/api/previews`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Link preview metadata |
| GET | `/image` | Proxied image preview |

## subscriptions — `/api/subscriptions`

| Method | Path | Notes |
|---|---|---|
| POST | `/create-crypto-transaction` | NOWPayments transaction (requireAuth) |
| POST | `/nowpayments-webhook` | NOWPayments IPN (HMAC, constant-time). Idempoten per `payment_id`; 503 `WEBHOOK_NOT_CONFIGURED` bila `NOWPAYMENTS_IPN_SECRET` kosong |

## engine — `/api/engine` (B2B, tenant auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/rooms` | Create an embeddable room (`requireTenantAuth`); returns room URL |

## admin — `/api/admin`

| Method | Path | Notes |
|---|---|---|
| GET | `/system-status` | VPS metrics (RAM/CPU/uptime) — `requireAuth` + `requireAdmin` |
| GET | `/banned-users` | List banned users |
| POST | `/ban` | Ban user (invalidates ban cache, KICKs) |
| POST | `/unban` | Unban (invalidates ban cache) |
| GET | `/tenants` | List tenants |
| POST | `/tenants` | Create tenant (apiKey) |
| PATCH | `/tenants/:id/toggle` | Toggle tenant active state |

## reports — `/api/reports`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Report a bug → Discord webhook |
| POST | `/user` | Report a user → Discord webhook |

## system — `/api/system`

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | System status + banner (public; reads Redis `nyx:system:status`) |

## wellKnown — `/.well-known`

| Method | Path | Notes |
|---|---|---|
| GET | `/api-catalog` | RFC 9727 linkset (API discovery) |
| GET | `/openid-configuration` | OIDC discovery doc |
| GET | `/oauth-authorization-server` | OAuth server metadata |
| GET | `/oauth-protected-resource` | Protected-resource metadata |
| GET | `/mcp/server-card.json` | MCP server card |
| GET | `/agent-skills/index.json` | AI-agent skill index |

## ohttp — `/api/ohttp` (docs/35 Fase 3, docs/10 §10.18)

Router hanya dipasang bila `OHTTP_ENABLED=1` (tanpa itu semuanya 404). Body adalah biner opaque (`message/ohttp-req`), maksimal 8 MB; tidak pernah di-parse JSON.

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | `application/ohttp-keys`: seluruh slot rotasi (key id 1 aktif, id 2 bila `OHTTP_NEXT_*` diisi). Publik |
| POST | `/relay` | Amplop → gateway. **404 `OHTTP_RELAY_EXTERNAL`** bila relay dijalankan proses terpisah (`OHTTP_RELAY_EXTERNAL=1`, nginx → `:4100/relay`) |
| POST | `/gateway` | Buka amplop, tolak target di luar allowlist (`403 OHTTP_TARGET_NOT_ALLOWED` di dalam amplop), sanitasi header jaringan, teruskan ke loopback. Key id tak dikenal / amplop rusak → `400 OHTTP_INVALID_REQUEST` |

Rate limit 120/menit per IP. Allowlist default: `GET /api/users/search`, `GET /api/keys/prekey-bundle/:id`, `POST /api/pir/query`, `POST /api/groups/sync` (batas body 64 KB).

## pir — `/api/pir` (docs/35 Fase 4b, docs/10 §10.19)

Router hanya dipasang bila `PIR_ENABLED=1`; server hanya mem-proxy byte ke sidecar ChalametPIR loopback (`PIR_SERVICE_URL`), tidak ada kripto PIR di Node.

| Method | Path | Notes |
|---|---|---|
| GET | `/params` | requireAuth. `{epoch, recordBytes, entryCount, suite, arity, seed, hint, filter}` (~11 MB pada index kecil) + `ETag`; `304` bila `If-None-Match` cocok |
| POST | `/query` | requireAuth + biner opaque (`application/octet-stream`, 8 MB). Dikirim **lewat OHTTP** dengan token ber-scope di amplop; CSRF dilewati hanya bila request tidak membawa cookie sesi. `503 PIR_UNAVAILABLE` bila sidecar mati |

Tidak ada `PIR_SERVICE_URL` valid / sidecar tanpa index = `503`; snapshot kosong tidak bisa dibangun (`pir:snapshot` menolak 0 user ber-`oprfIndex`).

## Misc

| Method | Path | Notes |
|---|---|---|
| GET | `/api/csrf-token` | Returns CSRF token (public) |
| GET | `/health` | `{"status":"ok bang"}` — no DB dependency |
