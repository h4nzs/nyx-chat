#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
TARGET=wasm32-unknown-unknown
CRATE=nyx_pir_wasm

cp Cargo.toml.in Cargo.toml
rustup target add "$TARGET" >/dev/null

export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$PWD=/build/pir-wasm --remap-path-prefix=$REPO_ROOT=/build/repo --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/build/cargo --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/build/rustup"
mkdir -p dist
cargo build --release --target "$TARGET" --locked
cp "target/$TARGET/release/$CRATE.wasm" dist/pir-client.wasm

echo "rustc: $(rustc --version)"
ls -l dist/pir-client.wasm
sha256sum dist/pir-client.wasm
