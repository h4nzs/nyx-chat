#!/usr/bin/env bash
# [docs/30 §30.5 WS-A / docs/34] Bangun verifier KT (pembungkus `libsignal-keytrans`).
#
# Pemakaian:
#   LIBSIGNAL_PATH=~/signal/libsignal ./build.sh
#
# Hasil: dist/keytrans.wasm (raw module, tanpa wasm-bindgen/wasm-pack).
#
# Prasyarat: rustup target wasm32-unknown-unknown, protoc (build-dependency
# `libsignal-keytrans` memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

LIBSIGNAL_PATH="${LIBSIGNAL_PATH:-$HOME/signal/libsignal}"
if [[ ! -f "$LIBSIGNAL_PATH/rust/keytrans/Cargo.toml" ]]; then
  echo "❌ Checkout libsignal tidak ditemukan di: $LIBSIGNAL_PATH" >&2
  echo "   Setel LIBSIGNAL_PATH ke checkout libsignal (pin docs/30 §30.2)." >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__LIBSIGNAL_PATH__|$LIBSIGNAL_PATH|" Cargo.toml.in > Cargo.toml

mkdir -p dist
cargo build --release --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_keytrans_wasm.wasm dist/keytrans.wasm
ls -l dist/keytrans.wasm
