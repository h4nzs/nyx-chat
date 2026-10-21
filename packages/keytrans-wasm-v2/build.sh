#!/usr/bin/env bash
# [docs/35 §35.7 Fase 7] Bangun verifier KT v2 (pembungkus
# `libsignal-keytrans-v2`, fork NYX dengan ML-DSA-65 dan indeks SHA-256).
#
# Sumber = `packages/keytrans-v2` (fork di repo ini), jadi clone bersih bisa
# membangun tanpa checkout di luar. Hasil: dist/keytrans-v2.wasm (raw module,
# tanpa wasm-bindgen/wasm-pack).
#
# Prasyarat: rustup (toolchain dipin `rust-toolchain.toml`), protoc
# (build-dependency memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
KEYTRANS_V2_PATH="${KEYTRANS_V2_PATH:-$REPO_ROOT/packages/keytrans-v2}"

if [[ ! -f "$KEYTRANS_V2_PATH/Cargo.toml" ]]; then
  echo "❌ Crate libsignal-keytrans-v2 tidak ditemukan di: $KEYTRANS_V2_PATH" >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__KEYTRANS_V2_PATH__|$KEYTRANS_V2_PATH|" Cargo.toml.in > Cargo.toml

# Remap path absolut → prefix tetap agar hash artefak tidak bergantung mesin.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
RUSTFLAGS_REPRO="--remap-path-prefix=$KEYTRANS_V2_PATH=/nyx/packages/keytrans-v2"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$REPO_ROOT=/nyx"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$CARGO_HOME_DIR=/cargo"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"

mkdir -p dist
RUSTFLAGS="$RUSTFLAGS_REPRO" \
  cargo build --release --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_keytrans_wasm_v2.wasm dist/keytrans-v2.wasm
echo "rustc: $(rustc --version)"
ls -l dist/keytrans-v2.wasm
sha256sum dist/keytrans-v2.wasm
