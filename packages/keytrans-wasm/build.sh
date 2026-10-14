#!/usr/bin/env bash
# [docs/30 §30.5 WS-A / docs/34] Bangun verifier KT (pembungkus `libsignal-keytrans`).
#
# Sumber default = crate ter-vendor di repo ini
# (`vendor/signal/libsignal-keytrans`), jadi clone bersih bisa membangun tanpa
# checkout libsignal di luar. Override ke checkout penuh (mis. saat mengejar pin
# baru sebelum re-vendor) dengan salah satu cara:
#
#   KEYTRANS_PATH=~/signal/libsignal/rust/keytrans ./build.sh
#   LIBSIGNAL_PATH=~/signal/libsignal ./build.sh          # alias lama
#
# Hasil: dist/keytrans.wasm (raw module, tanpa wasm-bindgen/wasm-pack).
#
# Prasyarat: rustup target wasm32-unknown-unknown, protoc (build-dependency
# `libsignal-keytrans` memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${KEYTRANS_PATH:-}" && -n "${LIBSIGNAL_PATH:-}" ]]; then
  KEYTRANS_PATH="$LIBSIGNAL_PATH/rust/keytrans"
fi
KEYTRANS_PATH="${KEYTRANS_PATH:-$(cd ../.. && pwd)/vendor/signal/libsignal-keytrans}"
if [[ ! -f "$KEYTRANS_PATH/Cargo.toml" ]]; then
  echo "❌ Crate libsignal-keytrans tidak ditemukan di: $KEYTRANS_PATH" >&2
  echo "   Jalankan scripts/vendor-signal.sh (atau set KEYTRANS_PATH / LIBSIGNAL_PATH ke checkout libsignal, pin docs/30 §30.2)." >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__KEYTRANS_PATH__|$KEYTRANS_PATH|" Cargo.toml.in > Cargo.toml

mkdir -p dist
cargo build --release --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_keytrans_wasm.wasm dist/keytrans.wasm
ls -l dist/keytrans.wasm
