#!/usr/bin/env bash
# [docs/33 §33.10 · docs/34 · NOTICE] Guard artefak WASM yang WAJIB ter-commit.
#
# Kenapa ada: `web/src/workers/crypto.worker.ts` meng-import
# `packages/spqr-wasm/dist/spqr.wasm?url` dan verifier KT memuat
# `packages/keytrans-wasm/dist/keytrans.wasm`. Kalau lupa di-commit, build web
# gagal jauh di dalam Vite dengan "Could not resolve .../spqr.wasm?url". Script
# ini gagal CEPAT dengan sebab + cara memperbaikinya.
#
# [R1 2026-10-15] Cakupannya naik dari "ada, cukup besar, ter-track" menjadi
# **verifikasi HASH terhadap `packages/wasm-artifacts.json`**. Ukuran saja tidak
# membuktikan apa pun: biner apa pun yang cukup besar akan lolos, dan sebelum ini
# tidak ada satu pun pemeriksaan yang mengaitkan biner yang dikirim ke browser
# dengan sumber ter-vendor di repo. Yang membuktikan asal-usulnya adalah
# `scripts/wasm-repro-build.sh --verify` (job CI `wasm`) — skrip INI adalah
# jaring cepatnya, supaya drift terdeteksi sebelum build 5 menit dijalankan.
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

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Hash yang diharapkan per path, dibaca dari packages/wasm-artifacts.json.
# Tanpa manifest, pemeriksaan hash dilewati dengan peringatan (bukan gagal) supaya
# skrip ini tetap bisa dipakai pada pengujian dengan NYX_WASM_ARTIFACTS.
declare -A MANIFEST_SHA=()
MANIFEST_PATH="$(cd "$(dirname "$0")/.." && pwd)/packages/wasm-artifacts.json"
if [[ -f "$MANIFEST_PATH" ]] && command -v node >/dev/null 2>&1; then
  while IFS=$'\t' read -r mp msha; do
    [[ -n "$mp" ]] && MANIFEST_SHA["$mp"]="$msha"
  done < <(MANIFEST_PATH="$MANIFEST_PATH" node -e '
    const m = JSON.parse(require("fs").readFileSync(process.env.MANIFEST_PATH, "utf8"));
    for (const a of m.artifacts ?? []) console.log(`${a.path}\t${a.sha256}`);
  ')
else
  echo "peringatan: packages/wasm-artifacts.json tidak terbaca (atau node tidak ada) — verifikasi HASH dilewati." >&2
fi

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

  # [R1] Cocokkan dengan manifest: inilah yang mengikat biner ke sumber
  # ter-vendor. Gagal di sini = "artefak dan sumbernya sudah tidak sinkron".
  if [[ -n "${MANIFEST_SHA[$path]:-}" ]]; then
    actual="$(hash_of "$path")"
    if [[ "$actual" != "${MANIFEST_SHA[$path]}" ]]; then
      # Catatan: JANGAN memakai backtick di pesan ini — di dalam string berkutip
      # ganda ia memicu command substitution, dan pesan ini justru menjalankan
      # build WASM 5 menit sebelum mencetak apa pun (pernah terjadi, 2026-10-15).
      say_error "$path" "hash tidak cocok manifest ($actual != ${MANIFEST_SHA[$path]}). Jalankan 'bash scripts/wasm-repro-build.sh --update' lalu commit .wasm + manifest; kalau hash bergeser tanpa perubahan sumber, itu tanda build tidak lagi reprodusibel — perbaiki penyebabnya, jangan cukup perbarui manifest."
      failed=1
      continue
    fi
  fi

  echo "ok: $path ($size byte, ter-track, hash cocok manifest)"
done

if [[ "$checked" -eq 0 ]]; then
  echo "tidak ada artefak yang diperiksa — daftar NYX_WASM_ARTIFACTS kosong?" >&2
  exit 1
fi

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'

Perbaikan (sumber Signal ter-vendor di repo; pin di NOTICE):
  bash scripts/wasm-repro-build.sh --update    # bangun ulang DI ROOT KANONIK + tulis manifest
lalu commit `packages/*/dist/*.wasm` + `packages/wasm-artifacts.json` dalam SATU commit.

Hash harus dibangun di root kanonik (`/tmp/nyx-wasm-repro`): unit hash cargo memuat
path paket, jadi build dari direktori lain menghasilkan simbol termangled yang
berbeda walau kode-nya identik. Job CI `wasm` membangun ulang dari `vendor/` dan
membandingkan hash — itu bukti bahwa biner yang dikirim ke browser berasal dari
sumber yang tertinjau.
EOF
  exit 1
fi

echo "semua artefak WASM ter-commit dan wajar ($checked diperiksa)."
