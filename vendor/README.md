# `vendor/signal` — kode Signal yang dipakai apa adanya

Dihasilkan `scripts/vendor-signal.sh` (jangan disunting tangan). Lisensi,
atribusi, dan daftar artefak yang dikirim ada di [`NOTICE`](../../NOTICE).

| Direktori | Upstream | Commit | Catatan |
|---|---|---|---|
| `spqr/` | https://github.com/signalapp/SparsePostQuantumRatchet | `06959b4708f9b7b1e94d0f8cc835f3958c077e94` | crate `spqr` v1.6.0 disalin utuh (`src`, `benches`, `proofs`, `build.rs`, `Cargo.lock` upstream apa adanya) |
| `libsignal-keytrans/` | https://github.com/signalapp/libsignal (`rust/keytrans`) | `e8cc2dddd578859b4a029c9c94670b24ce2b616a` | `Cargo.toml` dimaterialisasi (semua `workspace = true` → versi eksplisit) karena crate ini berdiri sendiri di sini |
| `../../server/kt-query/vendor/` | https://github.com/signalapp/key-transparency-server | `30b7a2a40604fbe04545d47f26e4c5a35f5d3161` | dihasilkan `go mod vendor`, bukan oleh skrip ini |

Keduanya dipakai **tanpa patch**: perubahan perilaku harus datang dari naiknya
pin, bukan suntingan di sini (jangan jalankan `cargo` di dalam direktori
vendor — itu menulis ulang `Cargo.lock`/`target/`; gunakan salinan lain bila
perlu). Rebuild artefak WASM:

```bash
(cd packages/spqr-wasm && ./build.sh)          # SPQR_CRATE_PATH=... untuk checkout lain
(cd packages/keytrans-wasm && ./build.sh)      # KEYTRANS_PATH=... untuk checkout lain
```

Setelah pin naik: jalankan `scripts/vendor-signal.sh`, rebuild artefak, lalu
commit `vendor/`, `dist/*.wasm`, dan pembaruan `NOTICE` + `docs/30` §30.2
dalam satu perubahan.
