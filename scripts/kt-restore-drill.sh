#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact admin@nyx-app.my.id.
#
# [docs/10 §10.13 · docs/32 §32.7 · docs/34 §34.6b] DRILL PEMULIHAN LOG KT.
#
# Yang dibuktikan, berurutan — semuanya dengan kode upstream yang sesungguhnya
# (`nyx-kt-check` memakai `transparency.VerifySearch`, fungsi yang sama yang
# dikompilasi jadi `verify_search` di WASM klien, `docs/34` §34.2):
#
#   1. entri ditulis lewat jalur penulis produksi (`server/scripts/kt-drill-entries.ts`,
#      `buildKtLogEntry` + gRPC test-update) — bukan protobuf buatan drill;
#   2. snapshot harian `nyx-kt-query` menghasilkan arsip terverifikasi, dan
#      `latest.json` menyebut tree size yang sama dengan pohon hidup;
#   3. bukti SEBELUM bencana bisa diverifikasi dari luar (`verify-search` exit 0);
#   4. **bencana**: proses dimatikan dan direktori LevelDB hidup dihapus total;
#   5. pemulihan **hanya** dari arsip `tar.gz` → tree size DAN root identik dengan
#      keadaan sebelum bencana (`head -expect-size -expect-root`);
#   6. instance hasil pemulihan masih bisa melayani bukti yang **lolos verifikasi
#      upstream** untuk entri lama;
#   7. log hasil pemulihan **bisa tumbuh tanpa percabangan**: satu entri baru
#      ditulis, lalu bukti entri lama diverifikasi terhadap anchor `last=<size
#      sebelum bencana>` — klien yang sudah menyimpan anchor tetap melihat log
#      yang konsisten (inilah properti yang rusak bila pemulihan membuat log
#      bercabang, dan lebih buruk daripada log kosong);
#   8. layanan auditor upstream (TreeSize/Audit) hidup di instance hasil pemulihan;
#   9. kontrol negatif: pemeriksa ini benar-benar bisa GAGAL (root palsu dan nilai
#      harapan palsu harus ditolak) — tanpa itu, "lulus" di atas tidak berarti apa-apa.
#
# Pemakaian:
#   scripts/kt-restore-drill.sh            # workspace di /tmp/nyx-kt-restore-drill
#   NYX_KT_DRILL_DIR=/tmp/lain ...         # ganti workspace
#   NYX_KT_DRILL_ENTRIES=12 ...            # jumlah entri (default 5)
#
# Prasyarat: go, pnpm (node_modules server sudah terpasang), jq, tar.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${NYX_KT_DRILL_DIR:-/tmp/nyx-kt-restore-drill}"
ENTRIES="${NYX_KT_DRILL_ENTRIES:-5}"
READ_PORT="${NYX_KT_DRILL_READ_PORT:-18085}"
WRITE_PORT="${NYX_KT_DRILL_WRITE_PORT:-18081}"
AUDITOR_PORT="${NYX_KT_DRILL_AUDITOR_PORT:-18082}"
BASE="http://127.0.0.1:${READ_PORT}"

for tool in go jq tar curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ '$tool' tidak ada di PATH" >&2; exit 1; }
done
[[ -x "$ROOT/server/node_modules/.bin/tsx" ]] || { echo "❌ server/node_modules/.bin/tsx tidak ada — jalankan pnpm install" >&2; exit 1; }

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() { echo "❌ DRILL GAGAL: $*" >&2; exit 1; }
step() { echo; echo "── $* ──"; }

# ---------------------------------------------------------------------------
# 0. Workspace bersih + config kunci acak
# ---------------------------------------------------------------------------
step "0. Siapkan workspace $WORK"
rm -rf "$WORK"
mkdir -p "$WORK/live" "$WORK/snap"

rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Kunci log acak per jalannya drill: drill tidak boleh bergantung pada kunci
# contoh yang mungkin juga dipakai deployment nyata.
cat > "$WORK/test_config.yaml" <<YAML
api:
  signing-key: $(rand_hex 32)
  vrf-key: $(rand_hex 32)
  prefix-key: $(rand_hex 32)
  opening-key: $(rand_hex 32)
  distinguished: 1h
db:
  file: $WORK/live
YAML
chmod 600 "$WORK/test_config.yaml"

step "Bangun nyx-kt-query + nyx-kt-check (dari vendor/, tanpa checkout upstream)"
"$ROOT/server/kt-query/build.sh" >/dev/null
QUERY="$ROOT/server/kt-query/nyx-kt-query"
CHECK="$ROOT/server/kt-query/nyx-kt-check"

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------
start_server() {
  "$QUERY" \
    -config "$WORK/test_config.yaml" \
    -read-addr "127.0.0.1:${READ_PORT}" \
    -write-addr "127.0.0.1:${WRITE_PORT}" \
    -auditor-addr "127.0.0.1:${AUDITOR_PORT}" \
    -snapshot-dir "$WORK/snap" \
    -snapshot-interval 2s \
    -snapshot-keep 3 \
    >> "$WORK/server.log" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then return 0; fi
    kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$WORK/server.log" >&2; fail "nyx-kt-query mati saat start"; }
    sleep 0.5
  done
  tail -20 "$WORK/server.log" >&2
  fail "nyx-kt-query tidak siap dalam 30 detik"
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

# head_fields: mencetak "size root" dari `nyx-kt-check head`.
head_fields() { "$CHECK" head -url "$BASE" | sed -n 's/^treeSize=\([0-9]*\) root=\(.*\)$/\1 \2/p'; }

# ---------------------------------------------------------------------------
# 1. Nyalakan + tulis entri lewat jalur penulis produksi
# ---------------------------------------------------------------------------
step "1. Nyalakan layanan dan tulis $ENTRIES entri lewat penulis produksi"
start_server

WRITE_OUT="$(cd "$ROOT/server" && KT_SERVER_URL="http://127.0.0.1:${WRITE_PORT}" KT_DRILL_ENTRIES="$ENTRIES" \
  ./node_modules/.bin/tsx scripts/kt-drill-entries.ts)"
echo "$WRITE_OUT"
FIRST_HASH="$(echo "$WRITE_OUT" | sed -n 's/^DRILL_FIRST_HASH=//p' | tail -1)"
FIRST_VALUE="$(echo "$WRITE_OUT" | sed -n 's/^DRILL_FIRST_VALUE=//p' | tail -1)"
[[ -n "$FIRST_HASH" && -n "$FIRST_VALUE" ]] || fail "penulis tidak mengembalikan hash/nilai entri"

read -r SIZE_BEFORE ROOT_BEFORE <<<"$(head_fields)"
[[ -n "${SIZE_BEFORE:-}" && -n "${ROOT_BEFORE:-}" ]] || fail "tidak bisa membaca tree head"
echo "tree head sebelum bencana: size=$SIZE_BEFORE root=$ROOT_BEFORE"

# ---------------------------------------------------------------------------
# 2. Tunggu snapshot terverifikasi yang memuat semua entri
# ---------------------------------------------------------------------------
step "2. Tunggu snapshot harian terverifikasi (latest.json)"
SNAP_OK=0
for _ in $(seq 1 60); do
  if [[ -f "$WORK/snap/latest.json" ]]; then
    if [[ "$(jq -r '.treeSize' "$WORK/snap/latest.json")" == "$SIZE_BEFORE" ]]; then SNAP_OK=1; break; fi
  fi
  sleep 0.5
done
[[ "$SNAP_OK" == "1" ]] || { jq . "$WORK/snap/latest.json" 2>/dev/null || true; fail "snapshot terverifikasi dengan treeSize=$SIZE_BEFORE tidak muncul"; }
ARCHIVE="$(jq -r '.file' "$WORK/snap/latest.json")"
ROOT_SNAP="$(jq -r '.root' "$WORK/snap/latest.json")"
[[ -f "$WORK/snap/$ARCHIVE" ]] || fail "arsip $ARCHIVE disebut latest.json tapi tidak ada"
[[ "$ROOT_SNAP" == "$ROOT_BEFORE" ]] || fail "root di manifest ($ROOT_SNAP) ≠ root hidup ($ROOT_BEFORE)"
echo "arsip: $ARCHIVE ($(stat -c%s "$WORK/snap/$ARCHIVE") byte)"

# ---------------------------------------------------------------------------
# 3. Bukti SEBELUM bencana harus bisa diverifikasi dari luar
# ---------------------------------------------------------------------------
# Anchor ditulis ke berkas yang sama seperti klien nyata: itulah "head terakhir yang
# sudah dipercaya klien", dan satu-satunya cara bukti konsistensi bisa diverifikasi
# setelah bencana (`docs/34` §34.5).
ANCHOR="$WORK/anchor.json"
step "3. Verifikasi bukti sebelum bencana (verifier upstream)"
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" -anchor "$ANCHOR" \
  || fail "bukti sebelum bencana tidak bisa diverifikasi"
[[ "$(jq -r '.treeSize' "$ANCHOR")" == "$SIZE_BEFORE" ]] || fail "anchor tidak mencatat ukuran pohon pra-bencana"
"$CHECK" tree-size -addr "127.0.0.1:${AUDITOR_PORT}" || fail "layanan auditor tidak menjawab TreeSize"
"$CHECK" audit -addr "127.0.0.1:${AUDITOR_PORT}" -start 0 -limit 100 || fail "layanan auditor tidak menjawab Audit"

# ---------------------------------------------------------------------------
# 4. BENCANA: proses mati + direktoriv LevelDB hidup dihapus
# ---------------------------------------------------------------------------
step "4. Bencana: matikan proses dan hapus basis data hidup tanpa sisa"
stop_server
rm -rf "$WORK/live"
[[ ! -e "$WORK/live" ]] || fail "basis data hidup masih ada"
echo "basis data hidup dihapus; satu-satunya salinan = $ARCHIVE"

# ---------------------------------------------------------------------------
# 5. Pulihkan HANYA dari arsip
# ---------------------------------------------------------------------------
step "5. Pulihkan dari arsip"
mkdir -p "$WORK/live"
tar -xzf "$WORK/snap/$ARCHIVE" -C "$WORK/live"
start_server

"$CHECK" head -url "$BASE" -expect-size "$SIZE_BEFORE" -expect-root "$ROOT_BEFORE" \
  || fail "tree head hasil pemulihan berbeda dari sebelum bencana"

# ---------------------------------------------------------------------------
# 6. Instance hasil pemulihan masih melayani bukti yang lolos verifier upstream
# ---------------------------------------------------------------------------
step "6. Verifikasi bukti entri lama di instance hasil pemulihan"
# Anchor dari sebelum bencana dipakai apa adanya: klien yang selamat tidak tahu
# ada bencana, jadi permintaan ini harus lolos dengan anchor lamanya.
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" -anchor "$ANCHOR" \
  || fail "bukti entri lama tidak bisa diverifikasi setelah pemulihan"

# ---------------------------------------------------------------------------
# 7. Log hasil pemulihan bisa tumbuh tanpa percabangan
# ---------------------------------------------------------------------------
step "7. Tumbuhkan log dan verifikasi anchor pra-bencana"
# Offset indeks = ENTRIES: entri baru memakai search key BARU, jadi kunci yang
# jadi pembanding (hash pertama) tidak ikut dirotasi dan nilainya tetap sama.
GROW_OUT="$(cd "$ROOT/server" && KT_SERVER_URL="http://127.0.0.1:${WRITE_PORT}" KT_DRILL_ENTRIES=1 \
  KT_DRILL_KEY_VERSION=2 KT_DRILL_INDEX_OFFSET="$ENTRIES" ./node_modules/.bin/tsx scripts/kt-drill-entries.ts)"
echo "$GROW_OUT" | tail -1
read -r SIZE_AFTER ROOT_AFTER <<<"$(head_fields)"
[[ "$SIZE_AFTER" -gt "$SIZE_BEFORE" ]] || fail "log tidak tumbuh setelah pemulihan ($SIZE_AFTER ≤ $SIZE_BEFORE)"
echo "tree head setelah tumbuh: size=$SIZE_AFTER root=$ROOT_AFTER"

# Klien yang menyimpan anchor dari SEBELUM bencana harus tetap bisa
# memverifikasi: ini yang membuktikan pemulihan tidak membuat log bercabang.
# `-last` sengaja TIDAK diberikan — nilainya diambil dari anchor, sama seperti
# klien sungguhan yang tidak menghitung sendiri ukuran pohonnya.
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" -anchor "$ANCHOR" \
  || fail "bukti konsistensi dari anchor pra-bencana ditolak setelah pemulihan"
[[ "$(jq -r '.treeSize' "$ANCHOR")" == "$SIZE_AFTER" ]] || fail "anchor tidak maju ke ukuran pohon terbaru"

# ---------------------------------------------------------------------------
# 8. Layanan auditor hidup di instance hasil pemulihan
# ---------------------------------------------------------------------------
step "8. Layanan auditor upstream di instance hasil pemulihan"
"$CHECK" tree-size -addr "127.0.0.1:${AUDITOR_PORT}" || fail "TreeSize gagal setelah pemulihan"
"$CHECK" audit -addr "127.0.0.1:${AUDITOR_PORT}" -start 0 -limit 100 || fail "Audit gagal setelah pemulihan"

# ---------------------------------------------------------------------------
# 9. Kontrol negatif — pemeriksa harus bisa gagal
# ---------------------------------------------------------------------------
step "9. Kontrol negatif (harness benar-benar memeriksa)"
if "$CHECK" head -url "$BASE" -expect-root "$(printf '0%.0s' {1..64})" >/dev/null 2>&1; then
  fail "head -expect-root menerima root palsu"
fi
if "$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "00" >/dev/null 2>&1; then
  fail "verify-search menerima nilai harapan palsu"
fi
echo "kontrol negatif OK: root palsu dan nilai harapan palsu sama-sama ditolak"

echo
echo "✅ DRILL PEMULIHAN KT LULUS: $ENTRIES entri, bencana (DB dihapus), pulih dari $ARCHIVE,"
echo "   tree head identik (size=$SIZE_BEFORE), bukti tetap lolos verifier upstream, dan log"
echo "   bisa tumbuh ke size=$SIZE_AFTER tanpa memutus anchor pra-bencana."
