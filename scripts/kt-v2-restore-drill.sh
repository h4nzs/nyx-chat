#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact admin@nyx-app.my.id.
#
# [docs/39 §39.5 · docs/10 §10.13 · docs/34 §34.6b] DRILL PEMULIHAN LOG KT **v2**.
#
# Drill v1 (`scripts/kt-restore-drill.sh`) dihapus bersama pensiunnya log v1
# (`docs/38` §38.2 baris 5/14). Skrip ini penggantinya untuk v2 (ML-DSA-65), dan
# menguji rantai yang sama sekali tidak diuji otomatis sejak 2026-10-28:
#
#   tulis (jalur produksi) → snapshot terverifikasi → bencana → pulih dari arsip
#   → bukti lolos verifier yang sama dengan klien → tumbuh tanpa percabangan
#
# Sebelas langkah, semuanya dengan kode yang sesungguhnya: penulis produksi
# (`server/scripts/kt-v2-drill-entries.ts` → `publishKeyTransparencyEntry`), dan
# verifier `nyx-kt-v2-check` yang memakai `transparency.VerifySearch` — fungsi
# yang sama yang dikompilasi menjadi `verify_search` di WASM klien.
#
# Skrip ini TIDAK menyentuh layanan/port/berkas produksi: workspace sendiri di
# /tmp, port sendiri (18087–18089, 19468–19469), kunci acak per jalannya drill,
# dan port keluarannya (`NYX_KT_V2_*_BINARY`) diarahkan ke `$WORK/bin`.
#
# Pemakaian:
#   bash scripts/kt-v2-restore-drill.sh
#   NYX_KT_DRILL_DIR=/tmp/lain NYX_KT_DRILL_ENTRIES=8 bash scripts/kt-v2-restore-drill.sh
#   bash scripts/kt-v2-restore-drill.sh --bundle ~/nyx-backups/nyx-backup-….tar.gz.age \
#     --age-key ~/.config/nyx-backup/age-identity      # dijalankan OPERATOR, lihat §A.4
#
# Prasyarat: go, jq, tar, curl, node (node_modules server sudah terpasang).
# Mode `--bundle` juga butuh `age`.

set -euo pipefail

# `NYX_REPO_ROOT` berguna saat skrip ini diuji dari salinan (mis. drill kontrol
# negatif: skrip sengaja dirusak di /tmp lalu dijalankan terhadap repo asli).
ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WORK="${NYX_KT_DRILL_DIR:-/tmp/nyx-kt-v2-restore-drill}"
ENTRIES="${NYX_KT_DRILL_ENTRIES:-5}"
READ_PORT="${NYX_KT_DRILL_READ_PORT:-18089}"
WRITE_PORT="${NYX_KT_DRILL_WRITE_PORT:-18088}"
AUDITOR_PORT="${NYX_KT_DRILL_AUDITOR_PORT:-18087}"
METRICS_PORT="${NYX_KT_DRILL_METRICS_PORT:-19468}"
# Auditor dijalankan `-once` (deterministik), bukan sebagai daemon, jadi tidak
# ada exporter auditor yang dinyalakan di drill ini: port 19469 sengaja tidak
# dipakai. Kalau operator ingin memeriksa exporter auditor, jalankan daemonnya
# manual dengan `-interval 1m -metrics-addr 127.0.0.1:19469`.
BASE="http://127.0.0.1:${READ_PORT}"
# `${DistinguishedSearchKey}` di base64url — satu-satunya search key yang bisa
# dipakai tanpa mengetahui hash pengguna (mode --bundle).
DISTINGUISHED_KEY_B64="ZGlzdGluZ3Vpc2hlZA"
AUDITOR_NAME="drill-auditor"

BUNDLE=""
AGE_KEY="${NYX_AGE_IDENTITY:-${NYX_AGE_KEY:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --age-key) AGE_KEY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Ringkasan 11 langkah. Status awal "TIDAK DIJALANKAN" — bukan lulus palsu.
# ---------------------------------------------------------------------------
STEP_LABELS=(
  "tulis lewat jalur penulis produksi"
  "snapshot terverifikasi (latest.json = pohon hidup)"
  "bukti pra-bencana lolos verifier + auditor head"
  "bencana: proses mati, DB hidup dihapus"
  "pulih HANYA dari arsip; head identik"
  "instance pulih melayani bukti yang lolos verifier"
  "tumbuh tanpa percabangan (anchor pra-bencana)"
  "auditor v2 menyelesaikan satu putaran di instance pulih"
  "kontrol negatif (root palsu, nilai palsu, kunci salah, arsip rusak)"
  "skenario rollback: perilaku klien + auditor dicatat"
  "metrik pasca-pulih tanpa label identitas"
)
declare -a STEP_STATUS
for i in $(seq 0 10); do STEP_STATUS[$i]="⏭️ TIDAK DIJALANKAN"; done
CURRENT=-1

summary() {
  local failed=0
  echo
  echo "── ringkasan drill ──"
  for i in $(seq 0 10); do
    local status="${STEP_STATUS[$i]}"
    printf '%-24s %2d. %s\n' "$status" "$((i + 1))" "${STEP_LABELS[$i]}"
    case "$status" in
      ✅) ;;
      ➖*) ;;
      *) failed=1 ;;
    esac
  done
  if [[ "$failed" -eq 1 ]]; then
    echo
    echo "❌ DRILL TIDAK LULUS — ada langkah yang gagal/tidak dijalankan."
    return 1
  fi
}
trap 'summary || exit 1' EXIT

fail() {
  STEP_STATUS[$CURRENT]="❌"
  echo "❌ DRILL GAGAL (langkah $((CURRENT + 1))): $*" >&2
  exit 1
}
step() {
  # Tutup langkah sebelumnya sebagai lulus, lalu buka langkah baru.
  if [[ "$CURRENT" -ge 0 ]]; then STEP_STATUS[$CURRENT]="✅"; fi
  CURRENT="$1"
  echo
  echo "── $((CURRENT + 1))/11  ${STEP_LABELS[$CURRENT]} ──"
}
ok() { echo "   ✅ $*"; }
# pass menutup langkah TERAKHIR (yang tidak ditutup oleh `step` berikutnya).
pass() { STEP_STATUS[$CURRENT]="✅"; }

# ---------------------------------------------------------------------------
# Prasyarat
# ---------------------------------------------------------------------------
for tool in go jq tar curl od dd; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ '$tool' tidak ada di PATH" >&2; exit 1; }
done
[[ -x "$ROOT/server/node_modules/.bin/tsx" ]] || {
  echo "❌ server/node_modules/.bin/tsx tidak ada — jalankan pnpm install" >&2
  exit 1
}
if [[ -n "$BUNDLE" ]]; then
  command -v age >/dev/null 2>&1 || { echo "❌ mode --bundle butuh 'age'" >&2; exit 1; }
  [[ -n "$AGE_KEY" && -f "$AGE_KEY" ]] || { echo "❌ mode --bundle butuh --age-key/NYX_AGE_IDENTITY" >&2; exit 1; }
  [[ -f "$BUNDLE" ]] || { echo "❌ bundle tidak ada: $BUNDLE" >&2; exit 1; }
fi
# Jangan pernah menimpa binary layanan hidup (larangan AGENTS.md/§0 #3).
case "$WORK" in
  "$HOME/nyx-selfhost"*|/etc/*|/var/lib/*)
    echo "❌ NYX_KT_DRILL_DIR=$WORK menunjuk lokasi produksi — pilih path lain." >&2
    exit 1 ;;
esac

QUERY_PID=""
AUDITOR_PID=""
cleanup() {
  # Hanya PID milik skrip ini (bukan `pkill -f`: pola itu bisa mencocokkan baris
  # perintah shell pemanggil sendiri).
  for pid in "$QUERY_PID" "$AUDITOR_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
stop_query() {
  if [[ -n "$QUERY_PID" ]] && kill -0 "$QUERY_PID" 2>/dev/null; then
    kill "$QUERY_PID" 2>/dev/null || true
    wait "$QUERY_PID" 2>/dev/null || true
  fi
  QUERY_PID=""
}
stop_auditor() {
  if [[ -n "$AUDITOR_PID" ]] && kill -0 "$AUDITOR_PID" 2>/dev/null; then
    kill "$AUDITOR_PID" 2>/dev/null || true
    wait "$AUDITOR_PID" 2>/dev/null || true
  fi
  AUDITOR_PID=""
}

rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ---------------------------------------------------------------------------
# Workspace + binary + kunci
# ---------------------------------------------------------------------------
rm -rf "$WORK"
mkdir -p "$WORK/bin" "$WORK/live" "$WORK/snap" "$WORK/audit"
echo "workspace : $WORK"

SIGN_SEED="$(rand_hex 32)"
PREFIX_KEY="$(rand_hex 32)"
OPENING_KEY="$(rand_hex 32)"
rand_hex 32 > "$WORK/auditor.key"
chmod 600 "$WORK/auditor.key"

echo "── membangun binary ke \$WORK/bin (binary layanan hidup tidak disentuh) ──"
NYX_KT_V2_BINARY="$WORK/bin/nyx-kt-query-v2" \
NYX_KT_V2_AUDITOR_BINARY="$WORK/bin/nyx-kt-auditor-v2" \
NYX_KT_V2_INIT_BINARY="$WORK/bin/nyx-kt-v2-init" \
NYX_KT_V2_CHECK_BINARY="$WORK/bin/nyx-kt-v2-check" \
  "$ROOT/server/kt-query/build.sh" >"$WORK/build.log" 2>&1 || {
    tail -30 "$WORK/build.log" >&2
    echo "❌ build gagal" >&2
    exit 1
  }
QUERY="$WORK/bin/nyx-kt-query-v2"
AUDITOR="$WORK/bin/nyx-kt-auditor-v2"
CHECK="$WORK/bin/nyx-kt-v2-check"

AUDITOR_PUB="$("$AUDITOR" -name "$AUDITOR_NAME" -key-file "$WORK/auditor.key" -print-public-key | head -1)"
[[ ${#AUDITOR_PUB} -eq 3904 ]] || { echo "❌ kunci publik auditor bukan 1952 byte hex (${#AUDITOR_PUB})" >&2; exit 1; }

write_config() {
  local path="$1" db="$2" signing="$3"
  cat > "$path" <<YAML
api:
  signing-key: $signing
  prefix-key: $PREFIX_KEY
  opening-key: $OPENING_KEY
  auditors:
    $AUDITOR_NAME: $AUDITOR_PUB
  distinguished: 1h
db:
  file: $db
YAML
  chmod 600 "$path"
}
CONFIG="$WORK/config.yaml"
write_config "$CONFIG" "$WORK/live/tree.db" "$SIGN_SEED"

# ---------------------------------------------------------------------------
# Helper layanan
# ---------------------------------------------------------------------------
# start_query <db-dir> <snapshot-dir>
start_query() {
  local db="$1" snap="$2"
  "$QUERY" \
    -config "$CONFIG" \
    -db "$db" \
    -read-addr "127.0.0.1:${READ_PORT}" \
    -write-addr "127.0.0.1:${WRITE_PORT}" \
    -auditor-addr "127.0.0.1:${AUDITOR_PORT}" \
    -metrics-addr "127.0.0.1:${METRICS_PORT}" \
    -snapshot-dir "$snap" \
    -snapshot-interval 2s \
    -snapshot-keep 3 \
    >>"$WORK/server.log" 2>&1 &
  QUERY_PID=$!

  for _ in $(seq 1 80); do
    if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$QUERY_PID" 2>/dev/null; then
      tail -20 "$WORK/server.log" >&2
      fail "nyx-kt-query-v2 mati saat start"
    fi
    sleep 0.5
  done
  tail -20 "$WORK/server.log" >&2
  fail "nyx-kt-query-v2 tidak siap dalam 40 detik"
}

# auditor_once <state-file>
auditor_once() {
  local state="$1"
  "$AUDITOR" \
    -name "$AUDITOR_NAME" \
    -key-file "$WORK/auditor.key" \
    -state-file "$state" \
    -read-url "$BASE" \
    -auditor-addr "127.0.0.1:${AUDITOR_PORT}" \
    -metrics-addr 0 \
    -once >>"$WORK/auditor.log" 2>&1
}

# head_fields: "size root" dari `nyx-kt-v2-check head`.
head_fields() {
  "$CHECK" head -url "$BASE" | sed -n 's/^OK head treeSize=\([0-9]*\) root=\([0-9a-fA-F]*\).*/\1 \2/p'
}

# write_entries <count> <key-version> <offset> → mencetak keluaran penulis
write_entries() {
  local count="$1" version="$2" offset="$3"
  (cd "$ROOT/server" && \
    KT_V2_SERVER_URL="http://127.0.0.1:${WRITE_PORT}" \
    KT_DRILL_ENTRIES="$count" \
    KT_DRILL_KEY_VERSION="$version" \
    KT_DRILL_INDEX_OFFSET="$offset" \
    ./node_modules/.bin/tsx scripts/kt-v2-drill-entries.ts)
}

# wait_snapshot_auditor <dir> <tree-size> → nama arsip yang manifesnya MENCATAT
# auditor head pada tree size itu. Dipakai untuk membuktikan bahwa arsip yang
# dibuat setelah auditor menandatangani head bersifat mandiri (tidak butuh auditor
# berjalan lagi saat dipulihkan) — kebalikan dari arsip pra-auditor.
wait_snapshot_auditor() {
  local dir="$1" size="$2"
  for _ in $(seq 1 80); do
    if [[ -f "$dir/latest.json" ]]; then
      local got
      got="$(jq -r '.auditorTreeSize // 0' "$dir/latest.json")"
      if [[ "$got" == "$size" ]]; then
        jq -r '.file' "$dir/latest.json"
        return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

# wait_snapshot <dir> <tree-size> <root> → mencetak nama arsip
wait_snapshot() {
  local dir="$1" size="$2" root="$3"
  for _ in $(seq 1 80); do
    if [[ -f "$dir/latest.json" ]]; then
      local got_size got_root
      got_size="$(jq -r '.treeSize' "$dir/latest.json")"
      got_root="$(jq -r '.root' "$dir/latest.json")"
      if [[ "$got_size" == "$size" && "$got_root" == "$root" ]]; then
        jq -r '.file' "$dir/latest.json"
        return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------------------
# Mode --bundle (A.4): dijalankan OPERATOR, bukan CI.
# ---------------------------------------------------------------------------
bundle_mode() {
  echo "⚠️  mode --bundle: skrip ini membuka KUNCI LOG (config.yaml + auditor.key)"
  echo "    dari bundle terenkripsi, menyalinnya ke direktori sementara di /tmp,"
  echo "    dan menghapusnya di akhir. Hanya jalankan di mesin yang Anda percaya."

  TMP_BUNDLE="$(mktemp -d "${TMPDIR:-/tmp}/nyx-kt-bundle-XXXXXX")"
  # Salinan kunci TIDAK boleh tertinggal di /tmp bila skrip gagal di tengah.
  wipe_bundle() {
    if command -v shred >/dev/null 2>&1; then
      find "$TMP_BUNDLE" -type f -exec shred -u {} + 2>/dev/null || true
    fi
    rm -rf "$TMP_BUNDLE"
  }
  cleanup_bundle() { stop_query; stop_auditor; wipe_bundle; }
  trap 'cleanup_bundle; summary || exit 1' EXIT

  # Langkah yang tidak berlaku di mode ini ditandai ➖ (bukan ✅ palsu, bukan
  # ❌): bundle sudah berisi arsip + kunci, jadi tidak ada tulis/snapshot/
  # bencana/kontrol negatif yang dijalankan di sini.
  for i in 0 1 2 3 8 9; do STEP_STATUS[$i]="➖ mode --bundle"; done

  age -d -i "$AGE_KEY" "$BUNDLE" >"$TMP_BUNDLE/bundle.tar.gz" || fail "dekripsi bundle gagal (kunci age salah?)"
  tar -C "$TMP_BUNDLE" -xzf "$TMP_BUNDLE/bundle.tar.gz" || fail "arsip bundle rusak"
  STAGE="$(find "$TMP_BUNDLE" -maxdepth 1 -type d -name 'nyx-backup-*' | head -1)"
  [[ -n "$STAGE" ]] || fail "struktur bundle tidak dikenal (tidak ada nyx-backup-*/)"
  [[ -f "$STAGE/kt/kt-v2.tgz" ]] || fail "bundle tidak memuat kt/kt-v2.tgz — backup.sh tidak menyertakan log KT?"

  mkdir -p "$WORK/bundle"
  tar -C "$WORK/bundle" -xzf "$STAGE/kt/kt-v2.tgz" || fail "kt-v2.tgz rusak"

  local kt_dir="$WORK/bundle/v2"
  [[ -f "$kt_dir/etc/config.yaml" ]] || fail "bundle tidak memuat v2/etc/config.yaml (kunci log hilang — temuan)"
  [[ -f "$kt_dir/etc/auditor.key" ]] || fail "bundle tidak memuat v2/etc/auditor.key (kunci auditor hilang — temuan)"
  [[ -d "$kt_dir/db" ]] || fail "bundle tidak memuat v2/db"

  CONFIG="$kt_dir/etc/config.yaml"
  cp -a "$kt_dir/db" "$WORK/live/restored"
  cp -a "$kt_dir/snapshots" "$WORK/bundle-snapshots" 2>/dev/null || true
  local state="$kt_dir/auditor-state.json"
  [[ -f "$state" ]] || fail "bundle tidak memuat auditor-state.json — auditor tidak bisa melanjutkan (temuan)"

  step 4
  "$QUERY" -check -config "$CONFIG" -db "$WORK/live/restored" || fail "-check pada DB dari bundle gagal"
  start_query "$WORK/live/restored" "$WORK/snap"
  "$CHECK" head -url "$BASE" | tee "$WORK/bundle-head.txt"
  ok "(-check) DB dari bundle terbuka, instance menyajikan head"

  step 5
  "$CHECK" config -url "$BASE" -expect-abi 2 || fail "/config bukan abiVersion 2"
  "$CHECK" verify-search -url "$BASE" -key "$DISTINGUISHED_KEY_B64" \
    -config "$CONFIG" -anchor "$WORK/bundle-anchor.json" \
    || fail "bukti distinguished dari bundle tidak lolos verifier"
  ok "bukti distinguished lolos verifikasi (anchor dibuat)"

  step 6
  local grow
  grow="$(write_entries 1 2 0)"
  echo "$grow" | tail -3
  "$CHECK" verify-search -url "$BASE" -key "$DISTINGUISHED_KEY_B64" \
    -config "$CONFIG" -anchor "$WORK/bundle-anchor.json" \
    || fail "log dari bundle tidak bisa tumbuh tanpa memutus anchor"
  ok "log tumbuh dan anchor lama tetap bisa diverifikasi"

  step 7
  cp "$state" "$WORK/bundle-auditor-state.json"
  auditor_once "$WORK/bundle-auditor-state.json" \
    || fail "auditor tidak bisa melanjutkan dari state di bundle"
  ok "auditor melanjutkan state dari bundle"

  step 10
  assert_metrics
  pass

  echo
  echo "✅ MODE BUNDLE LULUS untuk $BUNDLE (langkah 1–4, 9, 10 tidak berlaku)."
}

# assert_metrics: metrik pasca-pulih tidak membawa label identitas.
assert_metrics() {
  local body
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:${METRICS_PORT}/metrics" 2>/dev/null || true)"
  [[ -n "$body" ]] || fail "/metrics instance pulih tidak menjawab di :${METRICS_PORT}"
  echo "$body" | grep -q '^nyx_kt_query_tree_size ' || fail "nyx_kt_query_tree_size tidak ada"
  echo "$body" | grep -q '^nyx_kt_query_reads_total{' || fail "nyx_kt_query_reads_total tidak ada"
  if echo "$body" | grep -Eq '="[0-9a-fA-F]{32,}"'; then
    fail "ada label metrik berbentuk hash panjang (indikasi kebocoran identitas)"
  fi
  if echo "$body" | grep -Eq '="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'; then
    fail "ada label metrik berbentuk UUID (indikasi kebocoran identitas)"
  fi
  ok "$(echo "$body" | grep -c '^nyx_kt_query_') seri nyx_kt_query_* tanpa label identitas"
}

trap 'cleanup; summary || exit 1' EXIT

if [[ -n "$BUNDLE" ]]; then
  bundle_mode
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Tulis entri lewat jalur penulis produksi
# ---------------------------------------------------------------------------
step 0
start_query "$WORK/live" "$WORK/snap"
echo "   query PID=$QUERY_PID (workspace drill, port $READ_PORT/$WRITE_PORT/$AUDITOR_PORT)"

WRITE_OUT="$(write_entries "$ENTRIES" 1 0)" || fail "penulis produksi gagal"
# DRILL_FIRST_VALUE adalah 3238 byte hex — tidak dicetak utuh.
echo "$WRITE_OUT" | grep -v '^DRILL_FIRST_VALUE=' | sed 's/^/   /'
FIRST_HASH="$(echo "$WRITE_OUT" | sed -n 's/^DRILL_FIRST_HASH=//p' | tail -1)"
FIRST_VALUE="$(echo "$WRITE_OUT" | sed -n 's/^DRILL_FIRST_VALUE=//p' | tail -1)"
[[ -n "$FIRST_HASH" && -n "$FIRST_VALUE" ]] || fail "penulis tidak mengembalikan hash/nilai entri"
ok "$ENTRIES entri tertulis lewat publishKeyTransparencyEntry → gRPC Update"

# ---------------------------------------------------------------------------
# 2. Snapshot terverifikasi
# ---------------------------------------------------------------------------
step 1
read -r SIZE_BEFORE ROOT_BEFORE <<<"$(head_fields)"
[[ -n "${SIZE_BEFORE:-}" && -n "${ROOT_BEFORE:-}" ]] || fail "tidak bisa membaca tree head"

ARCHIVE="$(wait_snapshot "$WORK/snap" "$SIZE_BEFORE" "$ROOT_BEFORE")" \
  || { jq . "$WORK/snap/latest.json" 2>/dev/null || true; fail "snapshot treeSize=$SIZE_BEFORE tidak muncul"; }
[[ -f "$WORK/snap/$ARCHIVE" ]] || fail "arsip $ARCHIVE disebut latest.json tapi tidak ada"
# Salinan diambil KELUAR direktori snapshot: proses log memangkas arsip lama
# (`-snapshot-keep 3`) setiap putaran, jadi arsip "pra-bencana" bisa hilang di
# tengah drill kalau dibaca langsung dari $WORK/snap (pernah terjadi di run 4).
mkdir -p "$WORK/archive"
cp -p "$WORK/snap/$ARCHIVE" "$WORK/archive/$ARCHIVE"
ARCHIVE_PATH="$WORK/archive/$ARCHIVE"
echo "   arsip: $ARCHIVE ($(stat -c%s "$ARCHIVE_PATH") byte)"
echo "   head : size=$SIZE_BEFORE root=$ROOT_BEFORE"
# Auditor belum menandatangani apa pun di titik ini, jadi manifes HARUS kosong
# untuk field auditor — kalau tidak, field itu tidak bisa dipercaya.
[[ "$(jq -r '.auditorTreeSize // 0' "$WORK/snap/latest.json")" == "0" ]] \
  || fail "manifes mengaku punya auditor head padahal auditor belum berjalan"
ok "latest.json = pohon hidup (size + root), tanpa auditor head (jujur)"

# ---------------------------------------------------------------------------
# 3. Bukti pra-bencana lolos verifier + auditor head
# ---------------------------------------------------------------------------
step 2
# Mode 3 (ThirdPartyAuditing): klien WAJIB menerima auditor head yang segar.
# Karena itu auditor harus menyelesaikan satu putaran SEBELUM bukti bisa
# diverifikasi — persis seperti produksi dengan `api.auditors` terisi.
auditor_once "$WORK/auditor-state.json" || { tail -20 "$WORK/auditor.log" >&2; fail "auditor -once gagal"; }
ok "auditor menandatangani tree head (mode 3 aktif)"

# Snapshot berikutnya HARUS mencatat head auditor di manifesnya. Inilah arsip
# "normal" produksi (auditor menandatangani tiap jam, snapshot harian): ia
# mandiri, sedangkan $ARCHIVE yang dipakai drill sengaja kasus terburuk.
AUDITED_ARCHIVE="$(wait_snapshot_auditor "$WORK/snap" "$SIZE_BEFORE")" \
  || { jq . "$WORK/snap/latest.json" 2>/dev/null || true; fail "snapshot setelah auditor tidak mencatat auditorTreeSize=$SIZE_BEFORE"; }
AUDITED_NAME="$(jq -r '.auditorName' "$WORK/snap/latest.json")"
ok "snapshot $AUDITED_ARCHIVE mencatat auditor head $AUDITED_NAME (treeSize=$SIZE_BEFORE)"

ANCHOR="$WORK/anchor.json"
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" \
  -config "$CONFIG" -anchor "$ANCHOR" || fail "bukti pra-bencana tidak lolos verifier"
[[ "$(jq -r '.treeSize' "$ANCHOR")" == "$SIZE_BEFORE" ]] || fail "anchor tidak mencatat ukuran pohon pra-bencana"
"$CHECK" config -url "$BASE" -expect-abi 2 || fail "/config bukan abiVersion 2"
"$CHECK" tree-size -addr "127.0.0.1:${AUDITOR_PORT}" || fail "layanan auditor tidak menjawab TreeSize"
"$CHECK" audit -addr "127.0.0.1:${AUDITOR_PORT}" -start 0 -limit 100 || fail "layanan auditor tidak menjawab Audit"
ok "VerifySearch lulus, abiVersion=2, TreeSize+Audit menjawab"

# ---------------------------------------------------------------------------
# 4. Bencana
# ---------------------------------------------------------------------------
step 3
stop_query
stop_auditor
rm -rf "$WORK/live" "$WORK/snap"
[[ ! -e "$WORK/live" ]] || fail "basis data hidup masih ada"
# Direktori snapshot ikut dihapus: tidak boleh ada arsip lain yang bisa
# "menyelamatkan" drill, dan tidak boleh ada arsip yang lebih baru dari ini.
ok "proses drill mati, DB hidup dihapus; satu-satunya salinan = $ARCHIVE_PATH"

# ---------------------------------------------------------------------------
# 5. Pulih hanya dari arsip + config
# ---------------------------------------------------------------------------
step 4
mkdir -p "$WORK/live"
tar -xzf "$ARCHIVE_PATH" -C "$WORK/live" || fail "ekstraksi arsip gagal"
# `-check` dengan harapan head: exit 0 saja tidak cukup (LevelDB memulihkan diri
# dari salinan sebagian), jadi angkanya yang dibandingkan dengan manifes.
"$QUERY" -check -config "$CONFIG" -db "$WORK/live" \
  -expect-size "$SIZE_BEFORE" -expect-root "$ROOT_BEFORE" \
  || fail "-check: hasil ekstrak tidak cocok dengan manifes (arsip tidak layak disebut backup)"
start_query "$WORK/live" "$WORK/snap"
"$CHECK" head -url "$BASE" -expect-size "$SIZE_BEFORE" -expect-root "$ROOT_BEFORE" \
  || fail "tree head hasil pemulihan berbeda dari sebelum bencana"
ok "head identik dengan manifes (size=$SIZE_BEFORE) dan -check lulus"

# ---------------------------------------------------------------------------
# 6. Instance pulih melayani bukti yang lolos verifier
# ---------------------------------------------------------------------------
step 5
"$CHECK" config -url "$BASE" -expect-abi 2 || fail "/config instance pulih bukan abiVersion 2"

# TEMUAN DRILL (2026-10-29, run pertama): arsip yang dibuat SEBELUM auditor
# menandatangani tree head TIDAK memuat auditor head, sehingga instance hasil
# pulih menjawab `auditor tree head not provided even though auditing is
# required` — mode 3 menolak menyajikan bukti sebelum auditor berjalan lagi.
# Jadi urutan pemulihan yang benar di produksi: DB → layanan → auditor → baru
# bukti bisa diverifikasi klien. Baris di bawah menjalankan urutan itu.
if ! "$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -config "$CONFIG" \
     -anchor "$WORK/pre-auditor-anchor.json" >/dev/null 2>&1; then
  echo "   ℹ️  tanpa auditor head, verifikasi ditolak (perilaku mode 3 yang benar)"
fi
auditor_once "$WORK/auditor-state.json" || { tail -20 "$WORK/auditor.log" >&2; fail "auditor tidak bisa melanjutkan di instance pulih"; }
ok "auditor menandatangani ulang tree head pada instance pulih"

# Anchor dari sebelum bencana dipakai apa adanya: klien yang selamat tidak tahu
# ada bencana, jadi permintaan ini harus lolos dengan anchor lamanya.
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" \
  -config "$CONFIG" -anchor "$ANCHOR" || fail "bukti entri lama tidak lolos verifier setelah pemulihan"
ok "bukti entri lama lolos VerifySearch dengan anchor pra-bencana"

# ---------------------------------------------------------------------------
# 7. Tumbuh tanpa percabangan
# ---------------------------------------------------------------------------
step 6
GROW_OUT="$(write_entries 1 2 "$ENTRIES")" || fail "penulisan entri baru setelah pemulihan gagal"
echo "$GROW_OUT" | tail -2 | sed 's/^/   /'
read -r SIZE_AFTER ROOT_AFTER <<<"$(head_fields)"
[[ -n "${SIZE_AFTER:-}" ]] || fail "tidak bisa membaca tree head setelah tumbuh"
[[ "$SIZE_AFTER" -gt "$SIZE_BEFORE" ]] || fail "log tidak tumbuh ($SIZE_AFTER ≤ $SIZE_BEFORE)"
"$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" \
  -config "$CONFIG" -anchor "$ANCHOR" \
  || fail "bukti konsistensi dari anchor pra-bencana ditolak setelah pemulihan"
[[ "$(jq -r '.treeSize' "$ANCHOR")" == "$SIZE_AFTER" ]] || fail "anchor tidak maju ke ukuran pohon terbaru"
ok "size $SIZE_BEFORE → $SIZE_AFTER (root ${ROOT_AFTER:0:16}…), anchor maju tanpa percabangan"

# ---------------------------------------------------------------------------
# 8. Auditor v2 pada instance pulih — termasuk auditor yang KEHILANGAN state
# ---------------------------------------------------------------------------
step 7
# `auditor-state.json` hilang = auditor harus bisa mengaudit ulang log dari nol.
# Itu properti terpisah dari "melanjutkan state": backup berisi state, tetapi
# operator yang memulihkan bisa saja hanya punya arsip snapshot.
rm -f "$WORK/auditor-fresh-state.json"
auditor_once "$WORK/auditor-fresh-state.json" \
  || { tail -20 "$WORK/auditor.log" >&2; fail "auditor dengan state kosong gagal mengaudit instance pulih"; }
ok "$(tail -1 "$WORK/auditor.log")"
ok "auditor bootstrap dari state kosong (audit ulang seluruh log) selesai"

# ---------------------------------------------------------------------------
# 9. Kontrol negatif
# ---------------------------------------------------------------------------
step 8
# (a) root palsu
if "$CHECK" head -url "$BASE" -expect-root "$(printf '0%.0s' {1..64})" >/dev/null 2>&1; then
  fail "head -expect-root menerima root palsu"
fi
# (b) nilai harapan palsu
if "$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "00" \
     -config "$CONFIG" -anchor "$ANCHOR" >/dev/null 2>&1; then
  fail "verify-search menerima nilai harapan palsu"
fi
# (c) kunci log yang salah — bukti bahwa snapshot TANPA kunci tidak berguna
write_config "$WORK/wrong-config.yaml" "$WORK/live/tree.db" "$(rand_hex 32)"
WRONG_OUT="$("$CHECK" verify-search -url "$BASE" -hash "$FIRST_HASH" -expect-value "$FIRST_VALUE" \
  -config "$WORK/wrong-config.yaml" -anchor "$WORK/nonexistent-anchor.json" 2>&1)" && \
  fail "verify-search menerima tree head yang ditandatangani kunci lain"
echo "   kunci salah ditolak: $(echo "$WRONG_OUT" | head -1)"
# (d) arsip dirusak satu byte
CORRUPT="$WORK/corrupt.tar.gz"
cp "$ARCHIVE_PATH" "$CORRUPT"
OFFSET=$(( $(stat -c%s "$CORRUPT") / 2 ))
ORIG_BYTE="$(dd if="$CORRUPT" bs=1 skip="$OFFSET" count=1 2>/dev/null | od -An -tu1 | tr -d ' \n')"
FLIP_BYTE=$(( (ORIG_BYTE + 128) % 256 ))
printf "\\$(printf '%03o' "$FLIP_BYTE")" | dd of="$CORRUPT" bs=1 seek="$OFFSET" count=1 conv=notrunc 2>/dev/null
NEW_BYTE="$(dd if="$CORRUPT" bs=1 skip="$OFFSET" count=1 2>/dev/null | od -An -tu1 | tr -d ' \n')"
[[ "$NEW_BYTE" != "$ORIG_BYTE" ]] || fail "gagal merusak satu byte arsip (offset $OFFSET)"
mkdir -p "$WORK/corrupt"
if tar -xzf "$CORRUPT" -C "$WORK/corrupt" 2>/dev/null; then
  fail "tar menerima arsip yang dirusak (byte $ORIG_BYTE→$NEW_BYTE @ $OFFSET)"
fi
# LevelDB bisa **memulihkan** diri dari salinan sebagian: `-check` yang exit 0
# saja BUKAN bukti arsip sah — ia hanya membangun pohon dari berkas yang ada.
# Yang menentukan: ukuran pohonnya harus berbeda dari yang terverifikasi
# (kalau sama, isi log yang diakui utuh padahal arsipnya rusak).
CORRUPT_OUT="$("$QUERY" -check -config "$CONFIG" -db "$WORK/corrupt" 2>&1)" && CORRUPT_RC=0 || CORRUPT_RC=1
CORRUPT_SIZE="$(echo "$CORRUPT_OUT" | sed -n 's/.*treeSize=\([0-9]*\).*/\1/p' | tail -1)"
if [[ "$CORRUPT_RC" -eq 0 ]]; then
  echo "   ℹ️  -check polos pada sisa ekstraksi exit 0 (treeSize=${CORRUPT_SIZE:-?}) — pemulihan parsial LevelDB; inilah sebabnya exit code tidak dipakai sebagai bukti"
fi
# Gerbang yang benar: harapan head. Ini harus MENOLAK sisa ekstraksi tadi.
if "$QUERY" -check -config "$CONFIG" -db "$WORK/corrupt" \
     -expect-size "$SIZE_AFTER" -expect-root "$ROOT_AFTER" >/dev/null 2>&1; then
  fail "arsip rusak lolos -check -expect-size/-expect-root (gerbang verifikasi bocor)"
fi
"$CHECK" head -url "$BASE" -expect-size "$SIZE_AFTER" >/dev/null \
  || fail "instance drill tidak lagi sehat setelah kontrol negatif"
ok "root palsu, nilai palsu, kunci salah, dan arsip rusak semuanya ditolak"

# ---------------------------------------------------------------------------
# 10. Skenario rollback (observasi, bukan kebijakan)
# ---------------------------------------------------------------------------
step 9
stop_query
remove_rb() { rm -rf "$WORK/rb"; }
remove_rb
mkdir -p "$WORK/rb/live" "$WORK/rb/snap"

start_query "$WORK/rb/live" "$WORK/rb/snap"
RB_A="$(write_entries 3 1 0)" || fail "rollback: penulisan batch pertama gagal"
echo "$RB_A" | grep -v '^DRILL_FIRST_VALUE=' | tail -2 | sed 's/^/   /'
RB_HASH="$(echo "$RB_A" | sed -n 's/^DRILL_FIRST_HASH=//p' | tail -1)"
read -r RB_SIZE_N RB_ROOT_N <<<"$(head_fields)"
RB_ARCHIVE="$(wait_snapshot "$WORK/rb/snap" "$RB_SIZE_N" "$RB_ROOT_N")" \
  || fail "rollback: snapshot pada size=$RB_SIZE_N tidak muncul"
# Sama seperti langkah 2: arsip "lama" disalin keluar karena snapshotter akan
# memangkasnya saat kita menulis entri berikutnya.
mkdir -p "$WORK/rb/archive"
cp -p "$WORK/rb/snap/$RB_ARCHIVE" "$WORK/rb/archive/$RB_ARCHIVE"
RB_ARCHIVE_PATH="$WORK/rb/archive/$RB_ARCHIVE"
echo "   snapshot lama: $RB_ARCHIVE (size=$RB_SIZE_N)"

write_entries 2 3 3 >/dev/null || fail "rollback: penulisan batch kedua gagal"
read -r RB_SIZE_NM RB_ROOT_NM <<<"$(head_fields)"
[[ "$RB_SIZE_NM" -gt "$RB_SIZE_N" ]] || fail "rollback: pohon tidak bertambah"
echo "   pohon: size=$RB_SIZE_N → $RB_SIZE_NM (root ${RB_ROOT_NM:0:16}…)"
auditor_once "$WORK/rb/auditor-state.json" || fail "rollback: auditor -once (pra-bencana) gagal"
"$CHECK" verify-search -url "$BASE" -hash "$RB_HASH" -config "$CONFIG" -anchor "$WORK/rb/anchor.json" \
  || fail "rollback: verifikasi pra-bencana gagal"
echo "   klien + auditor sudah melihat size=$RB_SIZE_NM"

stop_query
rm -rf "$WORK/rb/live" "$WORK/rb/snap"
mkdir -p "$WORK/rb/live"
tar -xzf "$RB_ARCHIVE_PATH" -C "$WORK/rb/live" || fail "rollback: ekstraksi arsip lama gagal"
start_query "$WORK/rb/live" "$WORK/rb/snap"
read -r RB_RESTORED RB_ROOT_RESTORED <<<"$(head_fields)"
[[ "$RB_RESTORED" == "$RB_SIZE_N" ]] || fail "rollback: instance pulih bukan pada size=$RB_SIZE_N"
echo "   pulih dari arsip lama: size=$RB_RESTORED (root ${RB_ROOT_RESTORED:0:16}…)"

# Klien dengan anchor lebih baru: HARUS ditolak (kalau diterima, itu temuan berat).
RB_CLIENT_MSG="$("$CHECK" verify-search -url "$BASE" -hash "$RB_HASH" \
  -config "$CONFIG" -anchor "$WORK/rb/anchor.json" 2>&1)" && RB_CLIENT_ACCEPT=1 || RB_CLIENT_ACCEPT=0
# Auditor dengan state lebih baru: perilakunya DICATAT (bisa menolak atau gagal).
RB_AUDIT_MSG="$(auditor_once "$WORK/rb/auditor-state.json" 2>&1)" && RB_AUDIT_ACCEPT=1 || RB_AUDIT_ACCEPT=0
RB_AUDIT_MSG="$(tail -3 "$WORK/auditor.log" | tr '\n' ' ')"
tail -5 "$WORK/auditor.log" | sed 's/^/   auditor: /'

{
  echo "rollback dari snapshot size=$RB_SIZE_N setelah klien/auditor melihat size=$RB_SIZE_NM"
  echo "klien  : $([[ "$RB_CLIENT_ACCEPT" == 1 ]] && echo DITERIMA || echo DITOLAK) — $(echo "$RB_CLIENT_MSG" | head -1)"
  echo "auditor: $([[ "$RB_AUDIT_ACCEPT" == 1 ]] && echo DITERIMA || echo DITOLAK) — $RB_AUDIT_MSG"
} | tee "$WORK/rollback-report.txt" | sed 's/^/   /'

if [[ "$RB_CLIENT_ACCEPT" == 1 ]]; then
  fail "klien dengan anchor lebih baru MENERIMA log yang di-rollback (temuan keamanan)"
fi
if [[ "$RB_AUDIT_ACCEPT" == 1 ]]; then
  echo "   ⚠️  TEMUAN: auditor menerima log yang di-rollback dan menandatangani head baru."
  echo "       Dicatat di docs/39 §39.5 sebagai perilaku nyata, bukan disembunyikan."
fi
ok "perilaku rollback tercatat: klien menolak (wajib), auditor $([[ "$RB_AUDIT_ACCEPT" == 1 ]] && echo menerima || echo menolak)"

# ---------------------------------------------------------------------------
# 11. Metrik pasca-pulih
# ---------------------------------------------------------------------------
step 10
assert_metrics
pass

echo
echo "✅ DRILL PEMULIHAN KT v2 LULUS: $ENTRIES entri → snapshot $ARCHIVE → DB dihapus"
echo "   → pulih (size=$SIZE_BEFORE identik) → tumbuh ke size=$SIZE_AFTER tanpa memutus anchor,"
echo "   auditor berjalan di instance pulih, dan semua kontrol negatif benar-benar merah."
echo "   Laporan rollback: $WORK/rollback-report.txt"
