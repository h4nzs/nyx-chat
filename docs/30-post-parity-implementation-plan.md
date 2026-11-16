# 30 — Rencana Implementasi Pasca-Paritas — **DIHAPUS 2026-11-16**

Rencana ini sudah tuntas dan isinya tidak berlaku sebagai rencana lagi, jadi
seluruh isinya dihapus. Berkas ini dipertahankan **hanya sebagai alamat** supaya
rujukan `docs/30 §30.x` di kode, `CHANGELOG.md`, dan dokumen lain tidak menjadi
tautan mati.

- Kebijakan pengganti: [`43-single-version-plan.md`](./43-single-version-plan.md)
  §43.1 (postulat) dan §43.5 (versi tunggal).
- Item yang benar-benar masih terbuka dari rencana ini diadopsi ke
  [`43-single-version-plan.md`](./43-single-version-plan.md) §43.7 — MLS/WS-J,
  klien native/WS-K, sisa WS-H, interop `cmd/kt-client`, snapshot KT.
- Sumber hidup topik-topiknya: `docs/04` (kripto), `docs/10` §10.12
  (observability), `docs/32`/`docs/34` (KT), `docs/33` (SPQR), `docs/39` §39.5
  (drill KT), `docs/41` (gate CI), `docs/42` (PIR).
- Isi lengkap (untuk jejak audit, bukan untuk dibaca sebagai rencana):
  `git show a61a7f7e:docs/30-post-parity-implementation-plan.md`.

## Padanan rujukan yang masih tersisa di dokumen lain

Banyak dokumen dan komentar kode masih menulis `docs/30 §30.x`. Isi bagian itu
sudah dihapus, jadi padanannya:

| Rujukan lama | Sumber hidup |
|---|---|
| §30.8 WS-D (SPQR) | `33-spqr-wasm.md` |
| §30.9 WS-E (calls/TURN) | `10-deployment-ops.md` §10.6, `12-api-reference.md` (`/api/keys/turn`) |
| §30.11 WS-G (engineering, fuzz ≥1 jam, oracle) | `11-testing.md`, `41-quality-ci-roadmap.md` §6.3/§9.4 |
| §30.12 WS-H (anti-abuse, `ABUSE_REGISTRATION_GUARD`) | `10-deployment-ops.md` tabel env, `docs/41` |
| §30.10 WS-F (storage lokal + pencarian) | `05-message-pipeline.md`, `42-pir-two-server-sharded.md`, `41` §6.7 |
| §30.5 WS-A (KT) | `32-key-transparency-kt.md`, `34-key-transparency-verifier.md` |
| §30.7 WS-C (backup) | `31-backup-format.md`, `39-disaster-recovery-runbook.md` |
| §30.20 progress | `41-quality-ci-roadmap.md` (satu-satunya tabel status: `STATUS.md` untuk kapabilitas) |
