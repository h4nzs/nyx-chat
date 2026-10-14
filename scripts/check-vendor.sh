#!/usr/bin/env bash
# [NOTICE · docs/25 · docs/30 §30.2] Guard sumber Signal yang di-vendor.
#
# Kenapa ada: `vendor/signal/` (Rust: crate `spqr` + `libsignal-keytrans`) dan
# `server/kt-query/vendor/` (Go: `keytransparency`) adalah satu-satunya cara
# repo ini bisa dibangun di clone bersih / CI — checkout Signal tidak ada di
# runner. Kalau isinya lupa di-commit, `packages/*/build.sh` dan `go build`
# gagal di mesin orang lain (bukan di mesin yang punya checkout), dan `NOTICE`
# jadi berbohong soal apa yang didistribusikan.
#
# Yang diperiksa:
#   1. manifest tiap crate ter-vendor ada dan tidak lagi mewarisi
#      `workspace = true` (libsignal-keytrans dimaterialisasi saat vendoring);
#   2. commit pin di `vendor/README.md` cocok dengan pin di `NOTICE`;
#   3. `server/kt-query/vendor/modules.txt` ada, `go.mod` TIDAK memuat
#      `replace` ke checkout lokal, dan setiap paket yang dicatat modules.txt
#      benar-benar ada di disk;
#   4. semua berkas di atas ter-track git (bukan hasil lokal yang belum di-add).
#
# Pemakaian: bash scripts/check-vendor.sh
set -euo pipefail

cd "$(dirname "$0")/.."

say_error() {
  # Anotasi GitHub kalau jalan di Actions, pesan biasa kalau lokal.
  printf '::error file=%s::%s\n' "$1" "$2"
  printf 'GUARD GAGAL: %s\n' "$2" >&2
}

failed=0

check_file() {
  local path="$1" why="$2"
  [[ -f "$path" ]] || { say_error "$path" "$path hilang — $why"; failed=1; return 1; }
  return 0
}

tracked() {
  local path="$1"
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    say_error "$path" "$path ada di disk tapi TIDAK ter-track git — commit hasil 'scripts/vendor-signal.sh' (lihat NOTICE)."
    failed=1
  fi
}

# --- 1 & 4: crate Rust ter-vendor -------------------------------------------
if check_file vendor/signal/spqr/Cargo.toml "jalankan scripts/vendor-signal.sh"; then
  grep -q '^name = "spqr"' vendor/signal/spqr/Cargo.toml \
    || { say_error vendor/signal/spqr/Cargo.toml "bukan manifest crate 'spqr'."; failed=1; }
  echo "ok: vendor/signal/spqr ($(du -sh vendor/signal/spqr | cut -f1))"
fi

if check_file vendor/signal/libsignal-keytrans/Cargo.toml "jalankan scripts/vendor-signal.sh"; then
  grep -q '^name = "libsignal-keytrans"' vendor/signal/libsignal-keytrans/Cargo.toml \
    || { say_error vendor/signal/libsignal-keytrans/Cargo.toml "bukan manifest 'libsignal-keytrans'."; failed=1; }
  # Manifest harus sudah dimaterialisasi: crate ini berdiri sendiri di sini.
  # (Regex sengaja hanya menangkap entri nyata `kunci.workspace = true`; komentar
  # penjelas di manifest memuat frasa yang sama.)
  if grep -qE '^[[:space:]]*[A-Za-z0-9_-]+\.workspace[[:space:]]*=[[:space:]]*true' vendor/signal/libsignal-keytrans/Cargo.toml; then
    say_error vendor/signal/libsignal-keytrans/Cargo.toml "masih memuat 'workspace = true' — jalankan scripts/vendor-signal.sh (materialisasi manifest)."
    failed=1
  fi
  echo "ok: vendor/signal/libsignal-keytrans ($(du -sh vendor/signal/libsignal-keytrans | cut -f1))"
fi

# --- 2: pin di vendor/README.md cocok dengan NOTICE -------------------------
if check_file vendor/README.md "jalankan scripts/vendor-signal.sh"; then
  pins="$(grep -E '^Pinned commit: [0-9a-f]{40}' NOTICE | awk '{print $3}')"
  [[ -n "$pins" ]] || { say_error NOTICE "tidak ada baris 'Pinned commit:' di NOTICE."; failed=1; }
  while read -r pin; do
    [[ -n "$pin" ]] || continue
    grep -q "$pin" vendor/README.md \
      || { say_error vendor/README.md "pin $pin ada di NOTICE tapi tidak di vendor/README.md — re-vendor lalu perbarui keduanya."; failed=1; }
  done <<< "$pins"
  echo "ok: vendor/README.md memuat semua pin NOTICE"
fi

# --- 3: modul Go ter-vendor -------------------------------------------------
KT_QUERY=server/kt-query
if check_file "$KT_QUERY/vendor/modules.txt" "jalankan 'go mod vendor' di server/kt-query"; then
  if grep -qE '^replace github\.com/signalapp/keytransparency' "$KT_QUERY/go.mod"; then
    say_error "$KT_QUERY/go.mod" "masih memuat 'replace' ke checkout lokal — build jadi bergantung pada checkout di luar repo."
    failed=1
  fi
  missing=0
  while read -r pkg; do
    [[ -n "$pkg" ]] || continue
    if [[ ! -d "$KT_QUERY/vendor/$pkg" ]]; then
      say_error "$KT_QUERY/vendor/$pkg" "paket dicatat di modules.txt tapi tidak ada di disk — jalankan 'go mod vendor'."
      missing=$((missing + 1))
    fi
  done < <(grep -E '^github\.com/signalapp/keytransparency(/[^ ]*)?$' "$KT_QUERY/vendor/modules.txt")
  [[ "$missing" -eq 0 ]] || failed=1
  echo "ok: $KT_QUERY/vendor ($(du -sh "$KT_QUERY/vendor" | cut -f1))"
fi

# --- 4: ter-track git -------------------------------------------------------
if [[ -d vendor/signal ]]; then
  tracked vendor/signal/spqr/Cargo.toml
  tracked vendor/signal/libsignal-keytrans/Cargo.toml
  tracked vendor/README.md
fi
if [[ -d "$KT_QUERY/vendor" ]]; then
  tracked "$KT_QUERY/vendor/modules.txt"
  tracked "$KT_QUERY/vendor/github.com/signalapp/keytransparency/tree/transparency"
fi

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'

Perbaikan:
  scripts/vendor-signal.sh                      # Rust (butuh checkout Signal pada pin NOTICE)
  (cd server/kt-query && go mod vendor)         # Go   (idem)
lalu commit `vendor/`, `server/kt-query/vendor/`, dan pembaruan NOTICE + docs/30 §30.2.
EOF
  exit 1
fi

echo "semua sumber Signal ter-commit dan konsisten dengan NOTICE."
