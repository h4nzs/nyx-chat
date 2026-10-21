#!/usr/bin/env bash
# [NOTICE · docs/30 §30.2 · docs/32 · docs/33] Re-vendor kode Signal ke `vendor/`.
#
# Kenapa `vendor/` ada: satu clone repo ini cukup untuk **membangun semuanya**
# (CI juga, tanpa checkout lokal), dan "kode yang dipakai" bisa direview di
# tempat. Pin tetap dicatat di `NOTICE` + `docs/30` §30.2 — skrip ini yang
# menjaga isi `vendor/` tetap cocok dengan pin tersebut.
#
# Pemakaian:
#   scripts/vendor-signal.sh                  # pakai $HOME/signal, commit pin dicek
#   SIGNAL_ROOT=/path/lain scripts/vendor-signal.sh
#   scripts/vendor-signal.sh --force          # lanjut walau commit tidak cocok
#
# Setelah skrip ini: rebuild artefak WASM (`packages/spqr-wasm/build.sh`,
# `packages/keytrans-wasm/build.sh`) dan commit `vendor/` + artefaknya.
# Untuk Go: `cd server/kt-query && go mod vendor` (lihat README paket itu).
set -euo pipefail

PIN_SPQR="06959b4708f9b7b1e94d0f8cc835f3958c077e94"
PIN_LIBSIGNAL="e8cc2dddd578859b4a029c9c94670b24ce2b616a"
PIN_KT_SERVER="30b7a2a40604fbe04545d47f26e4c5a35f5d3161"
PIN_KT_AUDITOR="13a9126a63081c189de8422bb2e7dca770adec9f"

SIGNAL_ROOT="${SIGNAL_ROOT:-$HOME/signal}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

fail() { echo "GAGAL: $*" >&2; exit 1; }

check_pin() {
  local dir="$1" pin="$2" name="$3" head
  [[ -d "$dir/.git" ]] || fail "$name tidak ditemukan di $dir (set SIGNAL_ROOT / clone dulu)"
  head="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$head" != "$pin" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      echo "PERINGATAN: $name di commit $head, bukan pin $pin (--force)" >&2
    else
      fail "$name di commit $head, bukan pin $pin. Checkout dulu commit pin itu, atau jalankan ulang dengan --force."
    fi
  fi
}

# Versi dependensi keytrans diambil dari [workspace.dependencies] libsignal pada
# commit pin. Dep baru tanpa entri di sini = gagal keras (lihat generate di bawah).
version_for() {
  case "$1" in
    curve25519-dalek) echo "5.0" ;;
    displaydoc)       echo "0.2.6" ;;
    ed25519-dalek)    echo "3.0" ;;
    hex)              echo "0.4.3" ;;
    hmac)             echo "0.13.0" ;;
    itertools)        echo "0.15.0" ;;
    prost)            echo "0.14" ;;
    sha2)             echo "0.11" ;;
    zerocopy)         echo "0.8.33" ;;
    prost-build)      echo "0.14" ;;
    assert_matches)   echo "1.5" ;;
    const-str)        echo "1.0" ;;
    criterion)        echo "0.5" ;;
    proptest)         echo "1.7" ;;
    test-case)        echo "3.3" ;;
    uuid)             echo "1.5" ;;
    *)                echo "" ;;
  esac
}

# Materialisasi manifest: setiap `workspace = true` diganti nilai eksplisit.
generate_kt_manifest() {
  local file="$1" section="" line name rest version
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      section="${BASH_REMATCH[1]}"
      if [[ "$section" == "lints" ]]; then
        section="__skip_lints__"
        continue
      fi
      printf '%s\n' "$line"
      continue
    fi
    if [[ "$section" == "__skip_lints__" ]]; then
      continue
    fi

    case "$line" in
      "authors.workspace = true")  printf 'authors = ["Signal Messenger LLC"]\n'; continue ;;
      "license.workspace = true")  printf 'license = "AGPL-3.0-only"\n'; continue ;;
      "version.workspace = true")  printf 'version = "0.0.1"\n'; continue ;;
    esac

    if [[ "$line" == *"workspace = true"* ]]; then
      name="${line%% = *}"
      rest="${line#*= }"
      version="$(version_for "$name")"
      if [[ -z "$version" ]]; then
        echo "VENDOR_ERROR: dependensi '$name' tidak punya entri versi — tambahkan ke version_for() di scripts/vendor-signal.sh" >&2
        return 1
      fi
      rest="${rest/workspace = true/version = \"$version\"}"
      printf '%s = %s\n' "$name" "$rest"
      continue
    fi

    printf '%s\n' "$line"
  done < "$file"
}

# ---------------------------------------------------------------------------
# 1. Crate `spqr` — disalin utuh (src + benches + proofs + build.rs + metadata).
#    Crate ini self-contained (dev-dependency `spqr = { path = "." }`), jadi
#    manifestnya tidak perlu diubah.
# ---------------------------------------------------------------------------
SPQR_SRC="$SIGNAL_ROOT/SparsePostQuantumRatchet"
check_pin "$SPQR_SRC" "$PIN_SPQR" "SparsePostQuantumRatchet"

SPQR_DST="$REPO_ROOT/vendor/signal/spqr"
rm -rf "$SPQR_DST"
mkdir -p "$SPQR_DST"
# `Cargo.lock` ikut disalin apa adanya (upstream meng-commit-nya). Jangan biarkan
# cargo di direktori ini menulis ulang lock-nya — itu membuat salinan berbeda
# dari pin tanpa perubahan kode (kejadian nyata: `cargo test` di vendor/ pernah
# menaikkan versi beberapa dependensi di lock yang ikut ter-commit).
for item in Cargo.toml Cargo.lock build.rs LICENSE README.md SECURITY.md src benches proofs; do
  [[ -e "$SPQR_SRC/$item" ]] || fail "SparsePostQuantumRatchet/$item tidak ada"
  cp -R "$SPQR_SRC/$item" "$SPQR_DST/"
done
echo "vendor: spqr      -> $SPQR_DST ($(du -sh "$SPQR_DST" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. Crate `libsignal-keytrans` — disalin apa adanya, manifest dimaterialisasi
#    karena upstream memakai inheritance `workspace = true` sementara di sini ia
#    berdiri sendiri.
# ---------------------------------------------------------------------------
LIBSIGNAL_SRC="$SIGNAL_ROOT/libsignal"
check_pin "$LIBSIGNAL_SRC" "$PIN_LIBSIGNAL" "libsignal"

KT_SRC="$LIBSIGNAL_SRC/rust/keytrans"
KT_DST="$REPO_ROOT/vendor/signal/libsignal-keytrans"
rm -rf "$KT_DST"
mkdir -p "$KT_DST"
for item in src benches build.rs; do
  [[ -e "$KT_SRC/$item" ]] || fail "libsignal/rust/keytrans/$item tidak ada"
  cp -R "$KT_SRC/$item" "$KT_DST/"
done
cp "$LIBSIGNAL_SRC/LICENSE" "$KT_DST/LICENSE"

generate_kt_manifest "$KT_SRC/Cargo.toml" > "$KT_DST/Cargo.toml"

if grep -qE '^[[:space:]]*[A-Za-z0-9_-]+\.workspace[[:space:]]*=[[:space:]]*true' "$KT_DST/Cargo.toml"; then
  fail "masih ada inheritance 'workspace = true' di vendor/signal/libsignal-keytrans/Cargo.toml"
fi

# Tabel lint yang diwarisi ditulis ulang di sini (crate mandiri).
cat >> "$KT_DST/Cargo.toml" <<'EOF'

# [lints] workspace = true (libsignal) — ditulis ulang saat vendoring.
[lints.clippy]
cast_possible_truncation = "warn"

[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = [
    'cfg(fuzzing)',
    'cfg(tokio_unstable)',
] }
EOF

echo "vendor: keytrans -> $KT_DST ($(du -sh "$KT_DST" | cut -f1))"

# ---------------------------------------------------------------------------
# 3. Catatan provenance di dalam vendor/
# ---------------------------------------------------------------------------
{
  cat <<EOF
# \`vendor/signal\` — kode Signal yang dipakai apa adanya

Dihasilkan \`scripts/vendor-signal.sh\` (jangan disunting tangan). Lisensi,
atribusi, dan daftar artefak yang dikirim ada di [\`NOTICE\`](../../NOTICE).

| Direktori | Upstream | Commit | Catatan |
|---|---|---|---|
| \`spqr/\` | https://github.com/signalapp/SparsePostQuantumRatchet | \`$PIN_SPQR\` | crate \`spqr\` v1.6.0 disalin utuh (\`src\`, \`benches\`, \`proofs\`, \`build.rs\`, \`Cargo.lock\` upstream apa adanya) |
| \`libsignal-keytrans/\` | https://github.com/signalapp/libsignal (\`rust/keytrans\`) | \`$PIN_LIBSIGNAL\` | \`Cargo.toml\` dimaterialisasi (semua \`workspace = true\` → versi eksplisit) karena crate ini berdiri sendiri di sini |
| \`../../server/kt-query/vendor/\` | https://github.com/signalapp/key-transparency-server | \`$PIN_KT_SERVER\` | dihasilkan \`go mod vendor\`, bukan oleh skrip ini |
| \`../../server/kt-query/cmd/nyx-kt-auditor/testdata/\` | https://github.com/signalapp/key-transparency-auditor | \`$PIN_KT_AUDITOR\` | hanya test vector + referensi port Go; kode Java tidak di-vendor |

Keduanya dipakai **tanpa patch**: perubahan perilaku harus datang dari naiknya
pin, bukan suntingan di sini (jangan jalankan \`cargo\` di dalam direktori
vendor — itu menulis ulang \`Cargo.lock\`/\`target/\`; gunakan salinan lain bila
perlu). Rebuild artefak WASM:

\`\`\`bash
(cd packages/spqr-wasm && ./build.sh)          # SPQR_CRATE_PATH=... untuk checkout lain
(cd packages/keytrans-wasm && ./build.sh)      # KEYTRANS_PATH=... untuk checkout lain
\`\`\`

Setelah pin naik: jalankan \`scripts/vendor-signal.sh\`, rebuild artefak, lalu
commit \`vendor/\`, \`dist/*.wasm\`, dan pembaruan \`NOTICE\` + \`docs/30\` §30.2
dalam satu perubahan.
EOF
} > "$REPO_ROOT/vendor/README.md"

echo
echo "Selesai. Total vendor Rust: $(du -sh "$REPO_ROOT/vendor" | cut -f1)"
echo "Langkah berikutnya: rebuild artefak WASM, lalu (bila perlu) 'go mod vendor' di server/kt-query."
