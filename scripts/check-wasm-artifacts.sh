#!/usr/bin/env bash
# [docs/33 §33.10 · docs/34 · NOTICE] Guard artefak WASM yang WAJIB ter-commit.
#
# Kenapa ada: `web/src/workers/crypto.worker.ts` meng-import
# `packages/spqr-wasm/dist/spqr.wasm?url` dan verifier KT memuat
# `packages/keytrans-wasm/dist/keytrans.wasm`. Keduanya TIDAK dibangun di CI
# (checkout Signal-nya tidak ada di runner — lihat NOTICE), jadi kalau lupa
# di-commit, build web gagal jauh di dalam Vite dengan "Could not resolve
# .../spqr.wasm?url". Script ini gagal CEPAT dengan sebab + cara memperbaikinya.
#
# Pemakaian:
#   bash scripts/check-wasm-artifacts.sh
#   NYX_WASM_ARTIFACTS="packages/x/dist/y.wasm:1000" bash scripts/check-wasm-artifacts.sh  # uji
#
# Format daftar: "path:ukuran_minimum_byte" (dipisah whitespace/baris baru).
# Ambang minimum hanya untuk menangkap file kosong/stub/terpotong — ukuran asli
# jauh di atasnya (spqr ≈ 507 KiB, keytrans ≈ 293 KiB).

set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_ARTIFACTS="
packages/spqr-wasm/dist/spqr.wasm:100000
packages/keytrans-wasm/dist/keytrans.wasm:100000
"
ARTIFACTS="${NYX_WASM_ARTIFACTS:-$DEFAULT_ARTIFACTS}"

say_error() {
  # Anotasi GitHub kalau jalan di Actions, pesan biasa kalau lokal.
  printf '::error file=%s::%s\n' "$1" "$2"
  printf 'GUARD GAGAL: %s\n' "$2" >&2
}

failed=0
checked=0

for entry in $ARTIFACTS; do
  path="${entry%%:*}"
  minimum="${entry##*:}"
  if [[ "$path" == "$minimum" ]]; then
    echo "entri tidak valid (butuh path:ukuran_minimum): $entry" >&2
    failed=1
    continue
  fi

  checked=$((checked + 1))

  if [[ ! -f "$path" ]]; then
    say_error "$path" "$path hilang dari working tree — jalankan build.sh paketnya lalu commit artefaknya (bukan hanya pembungkusnya)."
    failed=1
    continue
  fi

  size="$(wc -c < "$path" | tr -d '[:space:]')"
  if [[ "$size" -lt "$minimum" ]]; then
    say_error "$path" "$path hanya $size byte (< $minimum) — artefak kosong/stub/terpotong."
    failed=1
    continue
  fi

  # Ter-track git = benar-benar ikut commit, bukan file lokal yang kebetulan ada
  # (penyebab asli build CI pecah walau mesin dev hijau).
  if git rev-parse --git-dir >/dev/null 2>&1; then
    if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
      say_error "$path" "$path ada di disk tapi TIDAK ter-track git — commit artefaknya (lihat NOTICE + .gitignore pengecualian dist/)."
      failed=1
      continue
    fi
  fi

  echo "ok: $path ($size byte, ter-track)"
done

if [[ "$checked" -eq 0 ]]; then
  echo "tidak ada artefak yang diperiksa — daftar NYX_WASM_ARTIFACTS kosong?" >&2
  exit 1
fi

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'

Perbaikan (butuh checkout Signal pada commit pin — daftar di NOTICE):
  (cd packages/spqr-wasm && ./build.sh)
  (cd packages/keytrans-wasm && ./build.sh)          # sumber ter-vendor (vendor/signal/…)
lalu commit `packages/*/dist/*.wasm`. CI tidak bisa membangun ulang artefak ini.
EOF
  exit 1
fi

echo "semua artefak WASM ter-commit dan wajar ($checked diperiksa)."
