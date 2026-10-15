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
# ---------------------------------------------------------------------------
# REPRODUSIBEL (R1, 2026-10-15): path absolut di-remap ke prefix tetap dan
# toolchain dipin, supaya hash artefak tidak bergantung pada mesin pembangun dan
# CI bisa membangun ULANG dari `vendor/` lalu membandingkan hash dengan
# `packages/wasm-artifacts.json`. Lihat komentar panjang di
# `packages/spqr-wasm/build.sh` untuk alasan + cara memperbarui bila sengaja
# berubah.
# ---------------------------------------------------------------------------
#
# Prasyarat: rustup (toolchain dipin `rust-toolchain.toml`), protoc
# (build-dependency `libsignal-keytrans` memakai prost-build).
set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"

# Lihat `packages/spqr-wasm/build.sh`: hash yang cocok manifest hanya dihasilkan
# bila build dijalankan di root kanonik (`scripts/wasm-repro-build.sh`).
if [[ "$REPO_ROOT" != "${NYX_WASM_REPRO_ROOT:-/tmp/nyx-wasm-repro}" ]]; then
  echo "⚠️  Membangun di $REPO_ROOT, bukan root kanonik untuk verifikasi CI." >&2
  echo "    Artefak ini TIDAK akan cocok dengan packages/wasm-artifacts.json (CI merah)." >&2
  echo "    Untuk artefak yang diverifikasi: bash scripts/wasm-repro-build.sh --update" >&2
fi

if [[ -z "${KEYTRANS_PATH:-}" && -n "${LIBSIGNAL_PATH:-}" ]]; then
  KEYTRANS_PATH="$LIBSIGNAL_PATH/rust/keytrans"
fi
KEYTRANS_PATH="${KEYTRANS_PATH:-$REPO_ROOT/vendor/signal/libsignal-keytrans}"
if [[ ! -f "$KEYTRANS_PATH/Cargo.toml" ]]; then
  echo "❌ Crate libsignal-keytrans tidak ditemukan di: $KEYTRANS_PATH" >&2
  echo "   Jalankan scripts/vendor-signal.sh (atau set KEYTRANS_PATH / LIBSIGNAL_PATH ke checkout libsignal, pin docs/30 §30.2)." >&2
  exit 1
fi

command -v protoc >/dev/null || { echo "❌ protoc tidak ada di PATH (dibutuhkan prost-build)." >&2; exit 1; }

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

sed "s|__KEYTRANS_PATH__|$KEYTRANS_PATH|" Cargo.toml.in > Cargo.toml

# Remap path absolut → prefix tetap (lihat spqr-wasm/build.sh untuk penjelasan).
KEYTRANS_VENDOR_ROOT="$REPO_ROOT/vendor/signal"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
RUSTFLAGS_REPRO="--remap-path-prefix=$KEYTRANS_PATH=/nyx-vendor/libsignal-keytrans"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$KEYTRANS_VENDOR_ROOT=/nyx-vendor"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$REPO_ROOT=/nyx"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$CARGO_HOME_DIR=/cargo"
RUSTFLAGS_REPRO="$RUSTFLAGS_REPRO --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"

mkdir -p dist
RUSTFLAGS="$RUSTFLAGS_REPRO" \
  cargo build --release --locked --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/nyx_keytrans_wasm.wasm dist/keytrans.wasm
echo "rustc: $(rustc --version)"
ls -l dist/keytrans.wasm
sha256sum dist/keytrans.wasm
