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

echo "Bundle : $BUNDLE"
echo "Stage  : $STAGE"
echo "Repo   : $REPO_DIR"
echo "State  : $STATE_DIR"
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
echo "restore selesai"
