#!/usr/bin/env bash
# Restore bundle NYX ke host ini. Default dry-run; tulis --apply untuk eksekusi.
#
#   bash restore.sh --bundle ~/nyx-backups/nyx-backup-....tar.gz.age
#   bash restore.sh --bundle ... --age-key ~/.config/nyx-backup/age-identity --apply
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATE_DIR="${NYX_STATE:-$HOME/nyx-selfhost}"
BUNDLE=""
AGE_KEY="${NYX_AGE_KEY:-$HOME/.config/nyx-backup/age-identity}"
APPLY=0
DB_PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --age-key) AGE_KEY="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --db-push) DB_PUSH=1; shift ;;
    *) echo "restore: argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$BUNDLE" ]] || { echo "restore: --bundle wajib dan harus ada" >&2; exit 2; }
[[ -f "$AGE_KEY" ]] || { echo "restore: private key age tidak ada: $AGE_KEY" >&2; exit 2; }
command -v age >/dev/null || { echo "restore: age tidak terpasang" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "restore: pg_restore tidak terpasang" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
age -d -i "$AGE_KEY" "$BUNDLE" > "$TMP/bundle.tar.gz"
tar -C "$TMP" -xzf "$TMP/bundle.tar.gz"
STAGE="$(find "$TMP" -maxdepth 1 -type d -name 'nyx-backup-*' | head -1)"
[[ -n "$STAGE" ]] || { echo "restore: struktur bundle tidak dikenal" >&2; exit 1; }

# [docs/39 §39.5] Anchor log KT v2 dari bundle: tree size + root yang dilihat
# saat backup. Dipakai di langkah 6 untuk membuktikan bahwa log hasil pulih
# adalah log YANG SAMA (LevelDB rusak sebagian bisa pulih dengan tree lebih
# kecil dan tetap exit 0 — §39.5d temuan 2). Bundle lama tidak punya nilai ini:
# restore tetap jalan, tetapi peringatannya harus terlihat (bukan dilewati diam-diam).
META_FILE="$STAGE/meta.txt"
KT_EXPECT_SIZE=""
KT_EXPECT_ROOT=""
if [[ -f "$META_FILE" ]]; then
  KT_EXPECT_SIZE="$(sed -n 's/^ktV2TreeSize=//p' "$META_FILE" | head -1)"
  KT_EXPECT_ROOT="$(sed -n 's/^ktV2Root=//p' "$META_FILE" | head -1)"
fi
if [[ -z "$KT_EXPECT_SIZE" || -z "$KT_EXPECT_ROOT" ]]; then
  echo "PERINGATAN: bundle ini TIDAK memuat anchor log KT v2 (ktV2TreeSize/ktV2Root)." >&2
  echo "            Restore tetap bisa jalan, tetapi tidak ada bukti otomatis bahwa log KT v2" >&2
  echo "            hasil pulih = log yang dibackup. Bandingkan manual dengan snapshot/latest.json," >&2
  echo "            atau jalankan backup baru dengan skrip terbaru." >&2
fi

echo "Bundle : $BUNDLE"
echo "Stage  : $STAGE"
echo "Repo   : $REPO_DIR"
echo "State  : $STATE_DIR"
if [[ -n "$KT_EXPECT_SIZE" ]]; then
  echo "KT v2  : treeSize=$KT_EXPECT_SIZE root=$KT_EXPECT_ROOT"
fi
[[ "$APPLY" -eq 1 ]] || { echo "DRY-RUN: tidak ada yang diubah. Tambahkan --apply."; exit 0; }

# shellcheck disable=SC1090
set -a; . "$STAGE/env/server.env"; set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "restore: DATABASE_URL tidak ada di bundle" >&2; exit 1; }

echo "== 1/6  Hentikan layanan =="
systemctl --user stop nyx.target 2>/dev/null || true

echo "== 2/6  Postgres =="
PG_URL="${DATABASE_URL%%\?*}"
pg_restore --clean --if-exists --no-owner --no-privileges -d "$PG_URL" "$STAGE/db.dump"

echo "== 3/6  Env + sertifikat =="
install -m 600 "$STAGE/env/server.env" "$REPO_DIR/server/.env"
[[ -f "$STAGE/env/web.env" ]] && install -m 600 "$STAGE/env/web.env" "$REPO_DIR/web/.env"
mkdir -p "$STATE_DIR/ohttp" "$STATE_DIR/pir" "$STATE_DIR/grafana" \
         "$STATE_DIR/alertmanager" "$STATE_DIR/postgres-exporter" "$STATE_DIR/sidecar-cert-backup"
for pair in \
  "ohttp-relay.env:$STATE_DIR/ohttp/relay.env" \
  "pir.env:$STATE_DIR/pir/pir.env" \
  "grafana.env:$STATE_DIR/grafana/grafana.env" \
  "ntfy-relay.env:$STATE_DIR/alertmanager/ntfy-relay.env" \
  "NTFY-TOPIC:$STATE_DIR/alertmanager/NTFY-TOPIC" \
  "postgres-exporter.env:$STATE_DIR/postgres-exporter/postgres-exporter.env" \
  "roots.pem:$STATE_DIR/attestation/roots.pem"; do
  src="${pair%%:*}"; dst="${pair#*:}"
  [[ -f "$STAGE/env/$src" ]] && install -m 600 "$STAGE/env/$src" "$dst"
done
if [[ -f "$STAGE/env/sidecar-cert-backup.tgz" ]]; then
  tar -C "$STATE_DIR" -xzf "$STAGE/env/sidecar-cert-backup.tgz"
fi

echo "== 4/6  KT v2 =="
mkdir -p "$STATE_DIR/kt"
if [[ -d "$STATE_DIR/kt/v2" ]]; then
  mv "$STATE_DIR/kt/v2" "$STATE_DIR/kt/v2.pre-restore-$(date +%s)"
fi
tar -C "$STATE_DIR/kt" -xzf "$STAGE/kt/kt-v2.tgz"

echo "== 5/6  Unit + schema + KT v2 (log → auditor) =="
if [[ "$DB_PUSH" -eq 1 ]]; then
  (cd "$REPO_DIR" && pnpm --filter nyx-server exec prisma db push)
fi
bash "$SCRIPT_DIR/install-user.sh"

# Mode 3 (ThirdPartyAuditing) menolak menyajikan bukti yang bisa diverifikasi
# klien sampai ada auditor head yang segar. Arsip yang dibuat saat auditor mati
# memang TIDAK memuat auditor head — lihat `auditorTreeSize` di `latest.json`
# arsip itu (drill 2026-10-29, docs/39 §39.5d temuan 1). Jadi setelah LevelDB
# dipulihkan, tunggu log siap lalu jalankan auditor; tanpa ini klien melihat
# `unavailable`/`unverifiable` meski datanya utuh.
kt_ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8089/healthz >/dev/null 2>&1; then
    kt_ready=1
    break
  fi
  sleep 1
done
if [[ "$kt_ready" -eq 1 ]]; then
  echo "   log KT v2 siap (:8089)"
else
  echo "   PERINGATAN: log KT v2 (:8089) belum menjawab; auditor mungkin gagal putaran pertama" >&2
fi
systemctl --user restart nyx-kt-auditor-v2 2>/dev/null || true

echo "== 6/6  Verifikasi =="
bash "$SCRIPT_DIR/verify-boot.sh"

# [docs/39 §39.5] Bandingkan head log KT v2 hasil pulih dengan anchor bundle.
# Mismatch = arsip tidak utuh / bukan arsip yang dimaksud: jangan nyatakan
# restore sukses. `-expect-size`/`-expect-root` milik `nyx-kt-v2-check` dipakai
# bila binernya ada; kalau tidak, perbandingan curl+warn tetap dilakukan.
kt_anchor_check() {
  if [[ -z "$KT_EXPECT_SIZE" || -z "$KT_EXPECT_ROOT" ]]; then
    echo "   PERINGATAN: anchor KT v2 tidak ada di meta bundle — perbandingan tree size/root DILEWATI." >&2
    return 0
  fi
  local read_url="${NYX_KT_V2_READ_URL:-http://127.0.0.1:8089}"
  local bin="${NYX_KT_V2_CHECK_BIN:-$(command -v nyx-kt-v2-check 2>/dev/null || true)}"
  if [[ -n "$bin" ]]; then
    if "$bin" head -url "$read_url" \
      -expect-size "$KT_EXPECT_SIZE" -expect-root "$KT_EXPECT_ROOT"; then
      echo "   anchor KT v2 cocok (treeSize=$KT_EXPECT_SIZE root=$KT_EXPECT_ROOT)"
      return 0
    fi
    echo "   GAGAL: head log KT v2 hasil pulih TIDAK cocok dengan bundle (ingin size=$KT_EXPECT_SIZE root=$KT_EXPECT_ROOT)." >&2
    return 1
  fi
  local head_json size root
  head_json="$(curl -fsS --max-time 3 "${read_url%/}/head" 2>/dev/null || true)"
  size="$(printf '%s' "$head_json" | sed -n 's/.*"treeSize"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p')"
  root="$(printf '%s' "$head_json" | sed -n 's/.*"root"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{1,\}\)".*/\1/p')"
  if [[ -z "$size" || -z "$root" ]]; then
    echo "   PERINGATAN: /head tidak terbaca dan nyx-kt-v2-check tidak ada — perbandingan anchor KT v2 DILEWATI." >&2
    echo "              Jalankan manual: nyx-kt-v2-check head -url $read_url -expect-size $KT_EXPECT_SIZE -expect-root $KT_EXPECT_ROOT" >&2
    return 0
  fi
  if [[ "$size" != "$KT_EXPECT_SIZE" || "${root,,}" != "${KT_EXPECT_ROOT,,}" ]]; then
    echo "   GAGAL: head log KT v2 hasil pulih size=$size root=$root, ingin size=$KT_EXPECT_SIZE root=$KT_EXPECT_ROOT." >&2
    return 1
  fi
  echo "   anchor KT v2 cocok (treeSize=$size root=$root)"
  return 0
}

if ! kt_anchor_check; then
  echo "restore: GAGAL — log KT v2 hasil pulih tidak cocok dengan anchor di bundle." >&2
  echo "         JANGAN buka layanan ke publik sebelum dijelaskan (lihat docs/39 §39.5d)." >&2
  systemctl --user stop nyx.target 2>/dev/null || true
  exit 1
fi

echo "restore selesai"
