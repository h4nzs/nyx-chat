# 38 — Kebijakan Versi Tunggal

Status: **aktif** (2026-11-16). Menggantikan kebijakan konservasi lama ("apa yang
boleh dihapus") dengan kebijakan kebalikannya: **satu versi, tidak ada
kompatibilitas tanpa alasan yang bisa diverifikasi hari ini**.

Latar: layanan dimatikan sementara dan tidak ada data user. Rencana lengkapnya di
[`43-single-version-plan.md`](./43-single-version-plan.md).

## 38.1 Aturan

1. Setiap jalur pembaca format lama **dihapus**, kecuali ada alasan tertulis yang
   bisa dibuktikan sekarang — bukan "mungkin nanti ada perangkat lama".
2. Setiap jalur penulis ganda **dihapus**; hanya satu format yang ditulis.
3. Setiap label `format beku`, `jangan diubah`, atau `pertahankan mutlak`
   dicabut. Yang dipertahankan adalah **properti** (tidak ada plaintext di
   server, tidak ada identitas di transport, padding seragam, fail-closed),
   bukan byte.
4. Data lokal lama boleh hilang: vault IndexedDB, token mailbox, state SPQR, pin
   KT, outbox yang belum terkirim.
5. Tes yang mengunci perilaku lama **ditulis ulang** ke invariant baru. Tidak
   ada tes yang dihapus tanpa pengganti, dan tidak ada tes yang dilemahkan.
6. Dokumen rencana yang sudah tuntas **dihapus isinya**, bukan disimpan sebagai
   "referensi" (lihat `docs/27`, `docs/30`, `docs/35`).

## 38.2 Inventaris yang dihapus (per fase)

Rincian berkas dan barisnya ada di `docs/43` §43.3. Ringkasnya:

| Fase | Cakupan | Contoh titik |
|---|---|---|
| B — data lokal | rantai Dexie v1–v15, migrasi `nyx_bio_vault`, prefiks `verified_conversation_`, fallback keychain/keyStorage/contact/message | `web/src/lib/db.ts:305-442`, `biometricUnlock.ts:154,198,250` |
| C — protokol | pin ABI-1, `ktValue-1`, envelope grup v2/v3, jalur tulis non-PQ saat `signingKeyV2` absen, header SPQR v1 + kill switch, `KT_SERVER_URL` | `ktConfigPin.ts`, `ktValue.ts`, `groupEnvelope.ts`, `crypto.ts:1304` |
| D — at-rest | format bare base64url (kunci id `0`), `sealedLookupCandidates()`, `scripts/reseal-at-rest.ts` | `server/src/utils/atRestSecrets.ts` |
| E — kripto | Blind RSA di `web/src/lib/privacyPass.ts`, KEM X25519 pada OHTTP | `privacyPass.ts` |

## 38.3 Yang dipertahankan sebagai properti

- Sealing at-rest: kunci tidak pernah tersimpan dalam bentuk terang di disk.
- Padding trafik 8 KB.
- Backup `.nyxbak` terenkripsi (formatnya boleh berubah, propertinya tidak).
- `SERVER_CAPABILITIES` sebagai satu sumber negosiasi dua relay.
- KT monitor fail-closed, verdict per peer disimpan.
- LevelDB single-writer untuk log KT.
- Metrics exporter loopback-only dan event-only.

## 38.4 Rujukan

- Rencana induk: [`43-single-version-plan.md`](./43-single-version-plan.md).
- Rencana yang sudah dihapus isinya: `docs/27`, `docs/30`, `docs/35`.
