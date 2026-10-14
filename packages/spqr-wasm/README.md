# packages/spqr-wasm — pembungkus WASM ratchet SPQR (docs/33)

Pembungkus tipis untuk crate [`spqr`](https://github.com/signalapp/SparsePostQuantumRatchet)
(SparsePostQuantumRatchet, AGPL-3.0) yang dipin di `docs/30` §30.2. Artefaknya
dipakai `web/src/lib/spqrRatchet.ts` sebagai **message-key generator** jalur ratchet
v2 (PQ forward secrecy **dan** post-compromise security).

## Kenapa raw WASM (tanpa `wasm-bindgen`/`wasm-pack`)

- Toolchain yang dibutuhkan hanya `cargo` + target `wasm32-unknown-unknown` — tidak
  ada langkah `wasm-bindgen`, tidak ada dependensi NPM tambahan, tidak ada glue JS
  yang ikut masuk ke bundel dan harus diperiksa.
- ABI-nya sengaja primitif (scratch buffer + kode hasil numerik), sehingga modul
  tidak bisa "bocor" ke JS lewat binding yang tidak kita tinjau.
- **Entropi disuntik host**: `getrandom` diarahkan ke backend `custom`
  (`--cfg getrandom_backend="custom"`) dan diisi dari scratch input
  (`spqr_seed_entropy`). Di produksi byte acaknya datang dari
  `crypto.getRandomValues`; modul WASM tidak menghubungi apa pun.

## Membangun

```bash
cd packages/spqr-wasm
./build.sh                                  # crate ter-vendor (vendor/signal/spqr)
SPQR_CRATE_PATH=~/signal/SparsePostQuantumRatchet ./build.sh   # checkout lain (kejar pin)
# → dist/spqr.wasm
```

Prasyarat: `rustup target add wasm32-unknown-unknown` dan `protoc`
(build-dependency `spqr` memakai `prost-build`). Sumber default adalah salinan
ter-vendor di `vendor/signal/spqr` (lihat `vendor/README.md`); tanpa clone
Signal di luar repo pun build jalan. Build memakan waktu (LTO, `codegen-units = 1`).

`Cargo.toml` **di-generate** oleh `build.sh` dari `Cargo.toml.in` karena memuat
path crate yang dipilih, jadi ia tidak di-commit. `Cargo.lock` ikut di-commit
supaya build reprodusibel. `dist/spqr.wasm` **di-commit** (pengecualian di
`.gitignore`) sebagai artefak siap-pakai; kalau hilang, test WASM di-skip dan
kapabilitas `spqr-ratchet` kehilangan implementasinya.

## ABI

| Export | Arti |
|---|---|
| `spqr_in_ptr()` / `spqr_out_ptr()` / `spqr_out_len()` | alamat & panjang scratch buffer |
| `spqr_seed_entropy(len)` | isi buffer entropi host dari `len` byte pertama scratch input |
| `spqr_empty_state()` | state kosong (referensi) |
| `spqr_current_version(len)` | `0` = V0, `1` = V1, `100` = masih negosiasi |
| `spqr_initial_state(auth_key_len, direction, version, min_version)` | state awal |
| `spqr_send(state_len, entropy_len)` | `{state, msg, key}` ber-frame |
| `spqr_recv(state_len, msg_len)` | `{state, key}` ber-frame |

Framing output — `send`: `u32 state_len | state | u32 msg_len | msg | u8 key_present | u32 key_len | key`;
`recv`: `u32 state_len | state | u8 key_present | u32 key_len | key`.

Semua export mengembalikan `i32`: `0` sukses, `1` error crate, `3` argumen tidak
sah, `4` entropi habis/tidak disuntik. Modul punya **nol import** (dijaga test).

> ⚠️ Urutan akses memori itu bagian dari kontrak: `spqr_in_ptr()` pertama kali
> dipanggil memicu alokasi malas + `memory.grow`, dan grow **melepas** ArrayBuffer
> yang sudah dipegang. Getter memori harus dipanggil lebih dulu dan `memory.buffer`
> dibaca paling akhir (lihat komentar di `web/src/lib/spqrRatchet.ts`).

## Test & benchmark

```bash
pnpm --filter nyx-web run test -- src/lib/__tests__/spqrRatchet.test.ts
NYX_BENCH=1 pnpm --filter nyx-web run bench:spqr
```

Test memakai modul hasil build sungguhan dan mengunci 10 properti (ABI tanpa
import, negosiasi versi, kesepakatan message key, entropi host deterministik,
entropi kurang → `SpqrError(4)`, fuzz, kehilangan 1..N−1 pesan, pengiriman keluar
urutan, kehilangan dua arah). Bila `dist/spqr.wasm` tidak ada, suite di-skip
(bukan gagal).
