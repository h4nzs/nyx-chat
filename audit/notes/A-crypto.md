# A — Kriptografi & protokol

Dibaca: `web/src/utils/crypto.ts` (jalur handshake + `deriveSessionKeyAsRecipient`,
`establishSessionFromPreKeyBundle`), `web/src/lib/messagePipeline.ts` (penerima
X3DH), `packages/shared` (domain PQ), `scripts/check-pq-only.mjs` +
`pq-only-{baseline,exceptions}.json`, `server/src/routes/keys.ts` (verifikasi
bundle v2), `web/src/lib/{spqrWire,spqrSession,spqrNegotiation}.ts` (permukaan).

## Cutover PQ-only

- Klien: `establishSessionFromPreKeyBundle` melempar bila bundle peer tanpa
  `pqIdentityKey`/`pqKey`/`pqSignature`/`signingKeyV2`; `deriveSessionKeyAsRecipient`
  melempar bila `handshakeVersion !== 2`. **Tidak ada fallback v1.**
- Penerima memverifikasi `initiatorSigningKeyV2` terhadap `signingKeyV2` bundle
  peer sebelum memakai transkrip (`messagePipeline.ts:349-355`) — mencegah
  penyerang mengirim transkrip bertanda tangan kunci lain.
- Server: `/register` dan `/keys/prekey-bundle` masih menerima material klasik
  (field opsional) dan menaikkan `LEGACY_V1_USAGE`. Ini residual yang
  didokumentasikan; dampaknya dijaga di klien, bukan di server.
- **Gate merah:** `check-pq-only` menolak `RSABSSA` baru di dua berkas
  `privacyPass.ts` (F-05). Exception manifest hanya punya dua entri
  `hybrid-v2-identity`.

## Format beku

- `ENC1:`/`ENC2:` berdampingan; pembaca mencoba ENC1 lalu ENC2
  (`server/src/utils/atRestSecrets.ts`).
- Envelope XChaCha `base64url(nonce24‖ct)` dan padding 8 KB tidak berubah
  (`crypto.worker.ts` op `xchacha_seal/open`; transport 8 KB di
  `transport.worker.ts`).
- Tidak ada perubahan `Array.from(...)` pada `ENCRYPT_DATA` yang saya temukan.

## Yang tidak diverifikasi

KAT independen (memakai `dr-oracle` yang lulus), 45 worker op per baris,
reprodusibilitas WASM, fuzz 1 jam. `docs/36` (review eksternal) tetap belum
dilakukan — audit ini bukan penggantinya.
