# packages/keytrans-wasm — verifier Key Transparency (docs/34)

Pembungkus WASM untuk crate [`libsignal-keytrans`](https://github.com/signalapp/libsignal)
(pin `docs/30` §30.2: `libsignal/rust/keytrans` `e8cc2dddd578`). Dipakai
`web/src/lib/keyTransparency.ts` untuk memverifikasi **search proof**, **monitor
proof**, dan konsistensi **distinguished tree head** dari log KT — tanpa
mempercayai server.

## Kenapa raw WASM (tanpa `wasm-bindgen`/`wasm-pack`)

- Hanya butuh `cargo` + target `wasm32-unknown-unknown`; tidak ada glue JS yang
  ikut ke bundel aplikasi.
- **Nol import**: modul tidak memanggil host function apa pun (dijaga test).
- Protobuf di-encode/decode **di dalam Rust** (prost), jadi klien tidak perlu
  parser protobuf dan tidak ada format perantara yang harus dipercaya.

## Membangun

```bash
cd packages/keytrans-wasm
./build.sh                                  # crate ter-vendor (vendor/signal/libsignal-keytrans)
KEYTRANS_PATH=~/signal/libsignal/rust/keytrans ./build.sh      # checkout lain
LIBSIGNAL_PATH=~/signal/libsignal ./build.sh                   # alias lama
# → dist/keytrans.wasm
```

Prasyarat: `rustup target add wasm32-unknown-unknown` dan `protoc`
(build-dependency `libsignal-keytrans` memakai `prost-build`). Sumber default
adalah salinan ter-vendor di `vendor/signal/libsignal-keytrans` (lihat
`vendor/README.md`), jadi clone bersih bisa membangun tanpa checkout libsignal.
`Cargo.toml` di-generate oleh `build.sh` (memuat path yang dipilih) → tidak
di-commit; `Cargo.lock` dan `dist/keytrans.wasm` di-commit.

## ABI

| Export | Arti |
|---|---|
| `kt_in_ptr()` / `kt_out_ptr()` | alamat scratch input/output |
| `kt_run(input_len)` | jalankan satu operasi; hasil ditulis ke scratch output |

Frame masukan: `u8 op | u8 mode | u32 n_auditor_keys (n×32B) | 32B sig_key | 32B vrf_key | u64 now_ms | u8 force_monitor | 4 slot (u32 len + byte)`,
frame keluaran: `u8 status | 4 slot | u32 len + pesan error`.

Operasi (`op`):

| Op | Fungsi |
|---|---|
| 1 | `verify_search` → nilai terverifikasi + `StoredTreeHead` + `StoredMonitoringData` |
| 2 | `verify_monitor` → `StoredTreeHead` + peta monitoring data |
| 3 | `verify_distinguished` → konsistensi tree head (tanpa keluaran) |
| 4 | `monitor_next` → `next_monitor`/entries/versi terbesar dari monitoring data |
| 5 | `condense_update` → `UpdateResponse` penulis log menjadi (`FullTreeHead`, `CondensedTreeSearchResponse`) siap verifikasi |
| 6 | `monitor_build` → `StoredMonitoringData` + tree head tersimpan menjadi `MonitorRequest` (protobuf) siap dikirim ke `/monitor` |

Semua kegagalan dikembalikan sebagai pesan error di frame keluaran —
**tidak ada panic/trap** (dengan `panic = "abort"` satu panic akan mematikan
instance; karena itu validasi dilakukan sebelum masuk ke crate).

## Test & fixture

Test klien ada di `web/src/lib/__tests__/keyTransparency.test.ts` (18 test,
fixture bukti nyata dari binary Go `key-transparency-server`). Regenerasi fixture:

```bash
# jalankan kt-server (test service di :8081, lihat docs/10 §10.12)
KT_SERVER_URL=http://127.0.0.1:8081 KT_CONFIG_FILE=/tmp/nyx-kt-run/test_config.yaml \
  pnpm --filter nyx-server run kt:fixtures
```

Bila `dist/keytrans.wasm` atau fixture tidak ada, suite di-skip (bukan gagal).
