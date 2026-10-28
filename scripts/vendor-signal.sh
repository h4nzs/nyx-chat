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
# Setelah skrip ini: rebuild artefak WASM (`packages/spqr-wasm/build.sh`; verifier
# KT v2 adalah fork lokal `packages/keytrans-v2`, bukan vendor Signal) dan commit
# `vendor/` + artefaknya.
# Untuk Go: `cd server/kt-query && go mod vendor` (lihat README paket itu).
set -euo pipefail

PIN_SPQR="06959b4708f9b7b1e94d0f8cc835f3958c077e94"
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
# 2. Catatan provenance di dalam vendor/
# ---------------------------------------------------------------------------
{
  cat <<EOF
# \`vendor/signal\` — kode Signal yang dipakai apa adanya

Dihasilkan \`scripts/vendor-signal.sh\` (jangan disunting tangan). Lisensi,
atribusi, dan daftar artefak yang dikirim ada di [\`NOTICE\`](../../NOTICE).

| Direktori | Upstream | Commit | Catatan |
|---|---|---|---|
| \`spqr/\` | https://github.com/signalapp/SparsePostQuantumRatchet | \`$PIN_SPQR\` | crate \`spqr\` v1.6.0 disalin utuh (\`src\`, \`benches\`, \`proofs\`, \`build.rs\`, \`Cargo.lock\` upstream apa adanya) |
| \`../../server/kt-query/vendor/\` | https://github.com/signalapp/key-transparency-server | \`$PIN_KT_SERVER\` | dihasilkan \`go mod vendor\`, bukan oleh skrip ini |
| \`../../server/kt-query/cmd/nyx-kt-auditor-v2/testdata/\` | https://github.com/signalapp/key-transparency-auditor | \`$PIN_KT_AUDITOR\` | hanya test vector + referensi port Go; kode Java tidak di-vendor |

Semua dipakai **tanpa patch**: perubahan perilaku harus datang dari naiknya
pin, bukan suntingan di sini (jangan jalankan \`cargo\` di dalam direktori
vendor — itu menulis ulang \`Cargo.lock\`/\`target/\`; gunakan salinan lain bila
perlu). Rebuild artefak WASM:

\`\`\`bash
(cd packages/spqr-wasm && ./build.sh)          # SPQR_CRATE_PATH=... untuk checkout lain
# Verifier KT v2 dibangun dari fork lokal packages/keytrans-v2 (bukan vendor Signal):
(cd packages/keytrans-wasm-v2 && ./build.sh)
\`\`\`

Setelah pin naik: jalankan \`scripts/vendor-signal.sh\`, rebuild artefak, lalu
commit \`vendor/\`, \`dist/*.wasm\`, dan pembaruan \`NOTICE\` + \`docs/30\` §30.2
dalam satu perubahan.
EOF
} > "$REPO_ROOT/vendor/README.md"

echo
echo "Selesai. Total vendor Rust: $(du -sh "$REPO_ROOT/vendor" | cut -f1)"
echo "Langkah berikutnya: rebuild artefak WASM, lalu (bila perlu) 'go mod vendor' di server/kt-query."
