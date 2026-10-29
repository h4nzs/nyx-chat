# packages/keytrans-wasm-v2 — verifier Key Transparency v2 (docs/34, docs/35 §35.7)

Pembungkus WASM untuk crate `libsignal-keytrans-v2` (`packages/keytrans-v2`):
**fork NYX yang dimodifikasi** dari `libsignal/rust/keytrans` Signal (AGPL-3.0-only;
asal-usul, pin, dan daftar modifikasi ada di `NOTICE` §2) — tree head
ber-ML-DSA-65 dan indeks `SHA-256("nyx-kt-v2-index" || searchKey)`, tanpa ECVRF.
Dipakai `web/src/lib/keyTransparencyV2.ts` / `ktBundleProof.ts` untuk memverifikasi
**search proof**, **monitor proof**, dan konsistensi **distinguished tree head**
dari log KT — tanpa mempercayai server. Verifier v1 (ABI 1) sudah dihapus
(`docs/38`); frame ABI 1 ditolak.

## Kenapa raw WASM (tanpa `wasm-bindgen`/`wasm-pack`)

- Hanya butuh `cargo` + target `wasm32-unknown-unknown`; tidak ada glue JS yang
  ikut ke bundel aplikasi.
- **Nol import**: modul tidak memanggil host function apa pun.
- Protobuf di-encode/decode **di dalam Rust** (prost), jadi klien tidak perlu
  parser protobuf dan tidak ada format perantara yang harus dipercaya.

## Membangun

```bash
cd packages/keytrans-wasm-v2
./build.sh                                   # sumber default: packages/keytrans-v2 (di repo ini)
KEYTRANS_V2_PATH=/path/lain ./build.sh       # crate libsignal-keytrans-v2 di lokasi lain
# → dist/keytrans-v2.wasm
```

Prasyarat: `rustup` (toolchain dipin `rust-toolchain.toml`), target
`wasm32-unknown-unknown`, dan `protoc` (build-dependency crate memakai
`prost-build`). `Cargo.toml` di-generate `build.sh` dari `Cargo.toml.in` → tidak
di-commit; `Cargo.lock` dan `dist/keytrans-v2.wasm` di-commit dan dijaga
`scripts/check-wasm-artifacts.sh` serta `scripts/wasm-repro-build.sh --verify`.

## ABI

Sumber kebenaran: dokumentasi di `src/lib.rs` (bagian "Framing v2"). Ringkasan:

| Export | Arti |
|---|---|
| `kt_in_ptr()` / `kt_out_ptr()` | alamat scratch input/output |
| `kt_run(input_len)` | jalankan satu operasi; hasil ditulis ke scratch output |

Frame masukan (big-endian): `u8 op | u8 abi_version (WAJIB 2) | u8 mode |
u32 n_auditor_keys (n × (u32 len + kunci publik ML-DSA-65)) | u32 len + signature_key |
u64 now_ms | u8 force_monitor | payload_a..d (u32 len + isi)`. **Tidak ada field VRF key.**
Frame keluaran: `u8 status | out_a..d | u32 len + pesan error`.

Operasi (`op`): 1 `verify_search`, 2 `verify_monitor`, 3 `verify_distinguished`,
4 `monitor_next`, 5 `condense_update`, 6 `monitor_build`.

Semua kegagalan dikembalikan sebagai status/pesan error — **tidak ada panic/trap**
(dengan `panic = "abort"` satu panic mematikan instance WASM, jadi input divalidasi
sebelum masuk ke crate).

## Test & fixture

- Test klien: `web/src/lib/__tests__/keyTransparencyV2.test.ts` dan
  `ktBundleProofV2.test.ts`; test crate Rust: `packages/keytrans-v2/tests`.
- Fixture (`testdata/`) dihasilkan **log v2 yang sebenarnya** secara deterministik
  (timestamp tree head dipin supaya tidak kedaluwarsa); regenerasi dari `server/kt-query`:

```bash
go run ./cmd/kt-v2-fixtures -out ../../packages/keytrans-wasm-v2/testdata
```
