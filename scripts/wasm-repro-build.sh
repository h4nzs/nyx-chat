#!/usr/bin/env bash
# [R1 2026-10-15] Bangun artefak WASM yang DI-COMMIT di **root kanonik**, supaya
# hash-nya reprodusibel dan bisa diverifikasi CI.
#
# Kenapa butuh root kanonik (bukan cuma `--remap-path-prefix`)?
# ---------------------------------------------------------------
# Percobaan yang melahirkan skrip ini (didokumentasikan agar tidak diulang):
#
#   1. `build.sh` apa adanya → hash BERBEDA antar direktori (62a72c14… vs
#      69c8d9f2…): rustc menyematkan path absolut sumber.
#   2. Setelah semua path di-remap ke prefix tetap (`/nyx`, `/nyx-vendor/*`,
#      `/cargo`, `/rustup`) → masih BERBEDA (51fa0767… vs c1f2c58f…) meski isi
#      file sama secara semantik. Perbandingan per-seksi menunjukkannya: section
#      `type`/`table`/`memory`/`global`/`data`/`producers` identik, tapi
#      `func`/`code`/`elem`/`name` berbeda.
#   3. Sebabnya: cargo menurunkan *unit hash* dari **package id**, dan package id
#      sebuah path dependency memuat path absolutnya
#      (`spqr 1.6.0 (path+file:///…/vendor/signal/spqr)`). Unit hash itu jadi
#      disambiguator simbol Rust (`…17h<16 hex>`) → mengubah nama termangled →
#      mengubah urutan simbol saat link → mengubah isi `func`/`code`/`elem`.
#
# Kesimpulan: byte-identik hanya bisa dicapai bila **path build identik**, jadi
# skrip ini menyalin sumber yang dibutuhkan ke satu root tetap lalu membangun di
# sana. Remap path di `build.sh` tetap dipakai — tanpa itu, path root kanonik
# bocor ke dalam artefak (pesan panic) dan hash jadi bergantung pada nilainya.
#
# Pemakaian:
#   bash scripts/wasm-repro-build.sh --verify    # default; gagal bila hash beda
#   bash scripts/wasm-repro-build.sh --update    # perbarui dist/*.wasm + manifest
#
# Override root (untuk debugging; manifest ikut mencatat nilainya):
#   NYX_WASM_REPRO_ROOT=/tmp/lain bash scripts/wasm-repro-build.sh --verify
#
# Prasyarat: rustup + toolchain pin tiap paket (`rust-toolchain.toml`), protoc,
# target wasm32-unknown-unknown. Butuh jaringan hanya untuk cache crates.io yang
# belum ada (Cargo.lock di-commit dan dipakai dengan `--locked`).
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL_ROOT="${NYX_WASM_REPRO_ROOT:-/tmp/nyx-wasm-repro}"
MANIFEST_REL="packages/wasm-artifacts.json"
MANIFEST="$SRC_ROOT/$MANIFEST_REL"

MODE="verify"
case "${1:-}" in
  --verify|"") MODE="verify" ;;
  --update)    MODE="update" ;;
  *) echo "pemakaian: $0 [--verify|--update]" >&2; exit 2 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Salin hanya yang dibutuhkan builder — TANPA `target/` (bisa ratusan MB) dan
# tanpa `Cargo.toml`/`dist` hasil build sebelumnya.
stage_tree() {
  rm -rf "$CANONICAL_ROOT"
  mkdir -p "$CANONICAL_ROOT/packages" "$CANONICAL_ROOT/vendor/signal"
  for pkg in spqr-wasm keytrans-wasm-v2 pir-wasm; do
    mkdir -p "$CANONICAL_ROOT/packages/$pkg"
    tar --exclude=./target --exclude=./Cargo.toml --exclude=./dist \
      -cf - -C "$SRC_ROOT/packages/$pkg" . | tar -xf - -C "$CANONICAL_ROOT/packages/$pkg"
  done
  # Fork KT v2 adalah crate lokal (bukan vendor Signal); Cargo.toml-nya asli,
  # hanya target/ yang dibuang.
  mkdir -p "$CANONICAL_ROOT/packages/keytrans-v2"
  tar --exclude=./target -cf - -C "$SRC_ROOT/packages/keytrans-v2" . \
    | tar -xf - -C "$CANONICAL_ROOT/packages/keytrans-v2"
  for crate in spqr; do
    mkdir -p "$CANONICAL_ROOT/vendor/signal/$crate"
    tar --exclude=./target -cf - -C "$SRC_ROOT/vendor/signal/$crate" . | tar -xf - -C "$CANONICAL_ROOT/vendor/signal/$crate"
  done
}

report() {
  local label="$1" file="$2"
  printf '%-46s %10s byte  %s\n' "$label" "$(wc -c < "$file" | tr -d '[:space:]')" "$(sha256_of "$file")"
}

echo "== root kanonik: $CANONICAL_ROOT"
stage_tree

echo "== membangun dari sumber ter-vendor (toolchain dari rust-toolchain.toml)…"
(cd "$CANONICAL_ROOT/packages/spqr-wasm" && ./build.sh >/tmp/nyx-repro-spqr.log 2>&1) \
  || { echo "GUARD GAGAL: build spqr-wasm gagal (lihat /tmp/nyx-repro-spqr.log)" >&2; tail -20 /tmp/nyx-repro-spqr.log >&2; exit 1; }
(cd "$CANONICAL_ROOT/packages/keytrans-wasm-v2" && ./build.sh >/tmp/nyx-repro-keytrans-v2.log 2>&1) \
  || { echo "GUARD GAGAL: build keytrans-wasm-v2 gagal (lihat /tmp/nyx-repro-keytrans-v2.log)" >&2; tail -20 /tmp/nyx-repro-keytrans-v2.log >&2; exit 1; }
(cd "$CANONICAL_ROOT/packages/pir-wasm" && ./build.sh >/tmp/nyx-repro-pir.log 2>&1) \
  || { echo "GUARD GAGAL: build pir-wasm gagal (lihat /tmp/nyx-repro-pir.log)" >&2; tail -20 /tmp/nyx-repro-pir.log >&2; exit 1; }

SPQR_BUILT="$CANONICAL_ROOT/packages/spqr-wasm/dist/spqr.wasm"
KT_V2_BUILT="$CANONICAL_ROOT/packages/keytrans-wasm-v2/dist/keytrans-v2.wasm"
PIR_BUILT="$CANONICAL_ROOT/packages/pir-wasm/dist/pir-client.wasm"
SPQR_DIST="$SRC_ROOT/packages/spqr-wasm/dist/spqr.wasm"
KT_V2_DIST="$SRC_ROOT/packages/keytrans-wasm-v2/dist/keytrans-v2.wasm"
PIR_DIST="$SRC_ROOT/packages/pir-wasm/dist/pir-client.wasm"

echo "== hasil build"
report "spqr.wasm (root kanonik)" "$SPQR_BUILT"
report "keytrans-v2.wasm (root kanonik)" "$KT_V2_BUILT"
report "pir-client.wasm (root kanonik)" "$PIR_BUILT"
RUSTC_VERSION="$(cd "$CANONICAL_ROOT/packages/spqr-wasm" && rustc --version)"

if [[ "$MODE" == "update" ]]; then
  mkdir -p "$(dirname "$SPQR_DIST")" "$(dirname "$KT_V2_DIST")" "$(dirname "$PIR_DIST")"
  cp "$SPQR_BUILT" "$SPQR_DIST"
  cp "$KT_V2_BUILT" "$KT_V2_DIST"
  cp "$PIR_BUILT" "$PIR_DIST"
  CANONICAL_ROOT="$CANONICAL_ROOT" RUSTC_VERSION="$RUSTC_VERSION" \
    SPQR_SHA="$(sha256_of "$SPQR_BUILT")" \
    KT_V2_SHA="$(sha256_of "$KT_V2_BUILT")" \
    PIR_SHA="$(sha256_of "$PIR_BUILT")" \
    SPQR_BYTES="$(wc -c < "$SPQR_BUILT" | tr -d '[:space:]')" \
    KT_V2_BYTES="$(wc -c < "$KT_V2_BUILT" | tr -d '[:space:]')" \
    PIR_BYTES="$(wc -c < "$PIR_BUILT" | tr -d '[:space:]')" \
    MANIFEST="$MANIFEST" node -e '
      const fs = require("fs");
      const manifest = {
        note: "Dibuat scripts/wasm-repro-build.sh --update. Jangan diedit tangan: hash di sini adalah kontrak antara biner yang DI-COMMIT dan sumber ter-vendor yang bisa dibangun ulang (lihat CONTRIBUTING, NOTICE, docs/33 §33.10).",
        canonicalRoot: process.env.CANONICAL_ROOT,
        toolchain: "1.95.0",
        rustc: process.env.RUSTC_VERSION,
        artifacts: [
          { path: "packages/spqr-wasm/dist/spqr.wasm", bytes: Number(process.env.SPQR_BYTES), sha256: process.env.SPQR_SHA, source: "vendor/signal/spqr@06959b4708f9b7b1e94d0f8cc835f3958c077e94" },
          { path: "packages/keytrans-wasm-v2/dist/keytrans-v2.wasm", bytes: Number(process.env.KT_V2_BYTES), sha256: process.env.KT_V2_SHA, source: "packages/keytrans-v2@nyx-kt-v2-fork (docs/35 §35.7)" },
          { path: "packages/pir-wasm/dist/pir-client.wasm", bytes: Number(process.env.PIR_BYTES), sha256: process.env.PIR_SHA, source: "packages/pir-wasm@nyx (chalametpir-client 0.8.0)" }
        ]
      };
      fs.writeFileSync(process.env.MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`manifest diperbarui: ${process.env.MANIFEST}`);
    '
  echo "== selesai (--update): dist/*.wasm + manifest sudah disinkronkan. Commit keduanya bersama."
  exit 0
fi

# --- --verify ---------------------------------------------------------------
if [[ ! -f "$MANIFEST" ]]; then
  echo "GUARD GAGAL: $MANIFEST_REL tidak ada — jalankan: bash scripts/wasm-repro-build.sh --update" >&2
  exit 1
fi

failed=0
while IFS=$'\t' read -r rel expected built; do
  if [[ ! -f "$SRC_ROOT/$rel" ]]; then
    echo "GUARD GAGAL: $rel tidak ada di working tree — artefak yang di-commit hilang." >&2
    failed=1
    continue
  fi
  actual="$(sha256_of "$built")"
  disk="$(sha256_of "$SRC_ROOT/$rel")"
  if [[ "$actual" != "$expected" ]]; then
    echo "GUARD GAGAL: hasil build TIDAK cocok manifest untuk $rel" >&2
    echo "  manifest : $expected" >&2
    echo "  dibangun : $actual" >&2
    failed=1
  elif [[ "$disk" != "$expected" ]]; then
    echo "GUARD GAGAL: biner yang di-commit TIDAK cocok manifest untuk $rel" >&2
    echo "  manifest : $expected" >&2
    echo "  di disk  : $disk" >&2
    failed=1
  else
    echo "ok: $rel — biner yang di-commit = hasil build dari sumber ter-vendor ($expected)"
  fi
done < <(MANIFEST="$MANIFEST" SPQR_BUILT="$SPQR_BUILT" KT_V2_BUILT="$KT_V2_BUILT" PIR_BUILT="$PIR_BUILT" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.env.MANIFEST, "utf8"));
  const built = { "packages/spqr-wasm/dist/spqr.wasm": process.env.SPQR_BUILT, "packages/keytrans-wasm-v2/dist/keytrans-v2.wasm": process.env.KT_V2_BUILT, "packages/pir-wasm/dist/pir-client.wasm": process.env.PIR_BUILT };
  for (const a of m.artifacts) console.log([a.path, a.sha256, built[a.path]].join("\t"));
')

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'

Artinya salah satu dari dua hal:
  1. Sumber ter-vendor berubah tanpa artefak di-build ulang → jalankan
     `bash scripts/wasm-repro-build.sh --update` lalu commit `.wasm` + manifest.
  2. Ada perubahan yang membuat build tidak lagi deterministik (versi rustc,
     flag remap, path lain yang tersemat). Perbaiki penyebabnya — JANGAN
     sekadar memperbarui hash manifest untuk membuat CI hijau; itu menghapus
     seluruh nilai verifikasi ini.
EOF
  exit 1
fi

echo "semua artefak WASM reprodusibel dari sumber ter-vendor ($RUSTC_VERSION)."
