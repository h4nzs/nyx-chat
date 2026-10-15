#!/usr/bin/env bash
# [docs/30 §30.8 WS-D] Bangun pembungkus WASM untuk crate `spqr`.
#
# Sumber default = crate ter-vendor di repo ini (`vendor/signal/spqr`), jadi
# clone bersih bisa membangun tanpa checkout Signal di luar. Override ke
# checkout lain (mis. saat mengejar pin baru sebelum re-vendor):
#
#   SPQR_CRATE_PATH=~/signal/SparsePostQuantumRatchet ./build.sh
#
# Hasil: dist/spqr.wasm (raw module, tanpa wasm-bindgen/wasm-pack).
#
# ---------------------------------------------------------------------------
# REPRODUSIBEL (R1, 2026-10-15). Sebelum ini hash artefak bergantung pada
# **path absolut mesin** yang membangun: rustc menyematkan path sumber ke dalam
# modul (nama file pada lokalisasi panic + metadata crate). Konsekuensinya:
#   - hash `packages/spqr-wasm/dist/spqr.wasm` bergeser hanya karena repo
#     di-clone di direktori lain (terbukti: build dari /tmp menghasilkan
#     69c8d9f2… sedangkan build dari repo menghasilkan 62a72c14…);
#   - CI tidak bisa membuktikan bahwa biner yang dikirim ke browser berasal
#     dari `vendor/signal/spqr` yang tertinjau.
# Karena itu semua path absolut di-remap ke prefix tetap (`/nyx`, `/cargo`,
# `/rustup`) dan toolchain dipin (`rust-toolchain.toml`). Artefak + hash-nya
# dicatat di `packages/wasm-artifacts.json`; `scripts/check-wasm-artifacts.sh`
# memverifikasi hash itu, dan job CI `wasm` membangun ULANG dari vendor lalu
# membandingkannya.
#
# Kalau artefak sengaja diperbarui: jalankan build ini, lalu
# `node scripts/wasm-manifest.mjs --update` (atau perbarui manual) dan commit
# `.wasm` + manifest dalam satu commit.
# ---------------------------------------------------------------------------
#
# Prasyarat: rustup (toolchain dipin `rust-toolchain.toml`), protoc
# (build-dependency `spqr` memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
SPQR_CRATE_PATH="${SPQR_CRATE_PATH:-$REPO_ROOT/vendor/signal/spqr}"

# Peringatan jujur: hash artefak hanya cocok manifest bila build dijalankan di
# root kanonik (`scripts/wasm-repro-build.sh`). Remap path TIDAK cukup — unit
# hash cargo (→ disambiguator simbol Rust) ikut memuat path absolut paket, jadi
# simbol termangled dan urutan link berbeda walau kode-nya identik. Lihat
# komentar panjang di `scripts/wasm-repro-build.sh`.
if [[ "$REPO_ROOT" != "${NYX_WASM_REPRO_ROOT:-/tmp/nyx-wasm-repro}" ]]; then
  echo "⚠️  Membangun di $REPO_ROOT, bukan root kanonik untuk verifikasi CI." >&2
  echo "    Artefak ini TIDAK akan cocok dengan packages/wasm-artifacts.json (CI merah)." >&2
  echo "    Untuk artefak yang diverifikasi: bash scripts/wasm-repro-build.sh --update" >&2
fi
if [[ ! -f "$SPQR_CRATE_PATH/Cargo.toml" ]]; then
  echo "❌ Crate spqr tidak ditemukan di: $SPQR_CRATE_PATH" >&2
  echo "   Jalankan scripts/vendor-signal.sh (atau set SPQR_CRATE_PATH ke checkout SparsePostQuantumRatchet, pin docs/30 §30.2)." >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__SPQR_PATH__|$SPQR_CRATE_PATH|" Cargo.toml.in > Cargo.toml

# Remap path absolut → prefix tetap. Urutan penting: prefix paling spesifik
# dulu (crate vendor di luar repo), lalu akar repo, lalu direktori toolchain.
# Tanpa daftar ini, hash berubah antar-mesin/CI.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
RUSTFLAGS_REPRO="--remap-path-prefix=$SPQR_CRATE_PATH=/nyx-vendor/spqr"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$REPO_ROOT=/nyx"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$CARGO_HOME_DIR=/cargo"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"

mkdir -p dist
# Backend getrandom = custom: entropi disuntik host lewat `spqr_seed_entropy`.
RUSTFLAGS="--cfg getrandom_backend=\"custom\" $RUSTFLAGS_REPRO" \
  cargo build --release --locked --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_spqr_wasm.wasm dist/spqr.wasm
echo "rustc: $(rustc --version)"
ls -l dist/spqr.wasm
sha256sum dist/spqr.wasm
