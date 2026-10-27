# D — Pencarian: OPRF + PIR

Diperiksa: `server/src/routes/users.ts` (§search), `server/src/utils/
searchOprf.ts`, `server/src/routes/pir.ts`, `server/src/pir/{config,snapshot}.ts`,
`server/src/jobs/pirSnapshot.ts`, `server/pir-sidecar`, `web/src/lib/
{pirClient,searchOprfClient}.ts`, `web/src/workers/pir.worker.ts`,
`packages/pir-wasm`, `scripts/check-wasm-artifacts.sh`.

## Yang terbukti benar

- **Anti-oracle:** `isSearchableIdentifier(q)` dijalankan **sebelum** DB
  (`users.ts:618`, util `atRestSecrets.ts:172`) — identifier mentah (email,
  telepon, username plaintext) ditolak, jadi endpoint tidak bisa dipakai
  menebak identifier dari bentuk terang.
- **Rate limit** pencarian punya bucket sendiri (`searchRateLimit`), diuji di
  `server/tests/searchRateLimit.test.ts`.
- **PIR adalah proxy byte**: API tidak mem-parse kueri/ respons; hanya
  meneruskan ke sidecar (`routes/pir.ts`). Tidak ada jalur JS yang membuka
  query.
- **Default mati**: OPRF dan PIR hanya hidup bila env diaktifkan; permukaan
  klien memakai `VITE_*` yang sama.
- **Artefak WASM** diperiksa `check-wasm-artifacts.sh` (lulus di baseline).

## Temuan / pengamatan

- **F-04 terkait**: `pirSnapshot` job membangun ulang indeks harian; kegagalan
  parsial tidak membuat snapshot lama dirotasi otomatis — operator harus
  memperhatikan log. Tidak saya naikkan jadi temuan karena job mencatat error
  dan tidak men-swap indeks rusak.
- **Pengamatan**: angka parameter PIR (ukuran record, jumlah item, noise)
  tidak diaudit di sini; klaim privasi PIR bergantung pada sidecar, bukan pada
  kode TS yang saya baca.

## Batas

Tidak menjalankan `bench-pir.ts`, tidak mengukur waktu/ukuran respons, tidak
menguji enumerasi dengan ruang pencarian besar, tidak mereproduksi build WASM.
