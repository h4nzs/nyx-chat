#!/usr/bin/env bash
# [docs/30 §30.8 WS-D] Bangun pembungkus WASM untuk crate `spqr`.
#
# Pemakaian:
#   SPQR_CRATE_PATH=~/signal/SparsePostQuantumRatchet ./build.sh
#
# Hasil: dist/spqr.wasm (raw module, tanpa wasm-bindgen/wasm-pack).
#
# Prasyarat: rustup target wasm32-unknown-unknown, protoc (build-dependency
# `spqr` memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

SPQR_CRATE_PATH="${SPQR_CRATE_PATH:-$HOME/signal/SparsePostQuantumRatchet}"
if [[ ! -f "$SPQR_CRATE_PATH/Cargo.toml" ]]; then
  echo "❌ Crate spqr tidak ditemukan di: $SPQR_CRATE_PATH" >&2
  echo "   Setel SPQR_CRATE_PATH ke checkout SparsePostQuantumRatchet (pin docs/30 §30.2)." >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__SPQR_PATH__|$SPQR_CRATE_PATH|" Cargo.toml.in > Cargo.toml

mkdir -p dist
# Backend getrandom = custom: entropi disuntik host lewat `spqr_seed_entropy`.
RUSTFLAGS='--cfg getrandom_backend="custom"' \
  cargo build --release --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_spqr_wasm.wasm dist/spqr.wasm
ls -l dist/spqr.wasm
