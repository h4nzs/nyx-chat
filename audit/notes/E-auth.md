# E — Autentikasi, sesi, perangkat

Diperiksa: `server/src/routes/{auth,sessions,backup,burner}.ts`,
`server/src/utils/{sessionUtils,jwt,deviceLinking,atRestSecrets}.ts`,
`server/src/routes/auth.ts` (webauthn/attestation), `server/tests/
{deviceLinking,refreshReplay,sessionRevocation,sessionUtils,webauthn*,
testRegistration}.test.ts`, `docs/14`.

## Yang terbukti benar

- **Cookie sesi** `httpOnly` + `sameSite` dari satu sumber
  (`authCookieOptions` di `sessionUtils.ts`), refresh token dirotasi dengan
  grace 2 menit dan deteksi replay (`refreshReplay`), sesi bisa dicabut
  (`/logout-all`, `sessionRevocation`).
- **CSRF per-instalasi**: server memakai `x-nyx-installation-id`; klien
  mengirim nilai yang sama dengan `getPersistentInstallationId()`.
- **QR device-linking** punya state machine `pending → approved → claimed` dan
  10 test (`server/tests/deviceLinking.test.ts`), termasuk migrasi perangkat
  tunggal dan penolakan token kedaluwarsa.
- **Attestation** diverifikasi sebelum akun dibuat; root kedaluwarsa
  menghasilkan alert (`attestationRootsHealth`), bukan lolos diam-diam.

## Temuan terkait

- **F-01 (Kritis/tinggi menurut dampak anti-abuse)** — `privacyPass.ts:197`
  memanggil `redis.set(key, '1', 'EX', ttl, 'NX')`; node-redis **6.2.1**
  mengabaikan argumen posisional itu (opsi harus berupa objek). Terverifikasi
  ulang di sesi ini: tidak ada `NX`, tidak ada `EX` → token bisa di-redeem
  berulang dan key `pp:spent:*` tumbuh selamanya.
- **F-02** — `secure: isProd` (`sessionUtils.ts:23`) dan `isProd` berasal dari
  `NODE_ENV`; `deploy.yml` **tidak** menyetel `NODE_ENV` (pm2 `start` tanpa
  `--update-env`/env) → cookie tanpa `Secure`, CSP/HSTS dev, morgan `dev`.
  Terverifikasi ulang: `NODE_ENV` hanya muncul di `docker-compose.yml` dan unit
  systemd relay OHTTP, bukan di jalur pm2.
- **F-11** — `consumeLinkToken` melakukan GET lalu DEL (bukan atomik); komentar
  menyatakan sebaliknya.
- **F-13** — `PP_ISSUER_PRIVATE_JWK` **wajib** bila `NODE_ENV=production`
  (`privacyPass.ts:131`) tetapi tidak ada di `.env.example`; operator yang
  menyalakan produksi + `PP_SYNC_REQUIRED=1` mendapat 500 dan grup mati.

## Batas

Tidak menjalankan alur login/registrasi nyata (tanpa Postgres/Redis di sesi
ini); tidak menguji brute-force QR secara empiris (token 256-bit); tidak
mengaudit implementasi WebAuthn library.
