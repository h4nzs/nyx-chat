# 35 — Rencana Migrasi Pasca-Kuantum — **DIHAPUS 2026-11-16**

Semua fase rencana ini berstatus *implemented*, jadi isinya dihapus. Berkas ini
dipertahankan **hanya sebagai alamat** supaya rujukan `docs/35 §35.x` tidak
menjadi tautan mati. Tidak ada migrasi yang tersisa untuk direncanakan: tidak
ada data user dan tidak ada klien versi lama.

- Kebijakan pengganti: [`43-single-version-plan.md`](./43-single-version-plan.md)
  §43.1 (postulat) dan §43.5 (versi tunggal).
- Format PQ yang dulu direncanakan di sini sumber hidupnya: `docs/04`
  (bundle v2, KEM-X3DH, sealed box, group v4), `docs/32`/`docs/34`
  (KT value v2, verifier ABI 2), `docs/37` (privasi grup).
- Privacy Pass tidak lagi memakai Blind RSA (token acak, §43.4.1). OHTTP kini
  dual-suite: klien baru memakai X-Wing, sedangkan P-256 tetap menjadi fallback
  untuk klien lama (§43.12.4) — bukan PQ-only. Status terbaru ada di
  [`43-single-version-plan.md`](./43-single-version-plan.md) §43.4.
- Penanda OPRF/PIR di §35.7 sudah usang: PIR kini dua server XOR-PIR dengan
  sharding (`docs/42`, `docs/41` §6.7).
- Isi lengkap (jejak audit): `git show a61a7f7e:docs/35-post-quantum-migration-plan.md`.
