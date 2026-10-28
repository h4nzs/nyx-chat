#!/usr/bin/env bash
# Backup terenkripsi NYX self-host: Postgres, KT v2, env/kunci, sertifikat, unit.
#
#   bash deploy/selfhost/scripts/backup.sh
#   NYX_BACKUP_UPLOAD=0 bash deploy/selfhost/scripts/backup.sh   # lokal saja
#
# Rahasia TIDAK pernah dicetak. Bundle hanya bisa dibuka dengan private key age
# yang disimpan di luar mesin ini (password manager / media offline).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATE_DIR="${NYX_STATE:-$HOME/nyx-selfhost}"
BACKUP_DIR="${NYX_BACKUP_DIR:-$HOME/nyx-backups}"
RECIPIENT_FILE="${NYX_BACKUP_RECIPIENT_FILE:-$HOME/.config/nyx-backup/age.pub}"
UPLOAD="${NYX_BACKUP_UPLOAD:-1}"
RETENTION_DAYS="${NYX_BACKUP_RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$BACKUP_DIR/nyx-backup-$TS"
ARCHIVE="$BACKUP_DIR/nyx-backup-$TS.tar.gz.age"

need() { command -v "$1" >/dev/null 2>&1 || { echo "backup: '$1' tidak ada. $2" >&2; exit 1; }; }
need age "Pasang age (mis. ke ~/.local/bin): https://github.com/FiloSottile/age/releases"
need pg_dump "Pasang postgresql-client."
[[ -f "$RECIPIENT_FILE" ]] || { echo "backup: recipient age tidak ada: $RECIPIENT_FILE" >&2; exit 1; }
[[ -f "$REPO_DIR/server/.env" ]] || { echo "backup: $REPO_DIR/server/.env tidak ada" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. "$REPO_DIR/server/.env"
set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "backup: DATABASE_URL kosong" >&2; exit 1; }

mkdir -p "$STAGE"/{env,units,kt}
restarted=0
restart_kt() {
  if [[ "$restarted" -eq 1 ]]; then
    systemctl --user start nyx-kt-query-v2 nyx-kt-auditor-v2 2>/dev/null || true
    restarted=0
  fi
}
trap restart_kt EXIT

echo "== 1/5  Postgres =="
PG_URL="${DATABASE_URL%%\?*}"
pg_dump "$PG_URL" -Fc -f "$STAGE/db.dump"

echo "== 2/5  KT v2 (LevelDB konsisten: service dihentikan sementara) =="
if systemctl --user is-active --quiet nyx-kt-auditor-v2 2>/dev/null; then
  systemctl --user stop nyx-kt-auditor-v2 nyx-kt-query-v2
  restarted=1
fi
if [[ -d "$STATE_DIR/kt/v2" ]]; then
  tar -C "$STATE_DIR/kt" -czf "$STAGE/kt/kt-v2.tgz" v2
fi
restart_kt

echo "== 3/5  Env, kunci, sertifikat, unit =="
copy() { [[ -f "$1" ]] && install -m 600 "$1" "$2" || true; }
copy "$REPO_DIR/server/.env" "$STAGE/env/server.env"
copy "$REPO_DIR/web/.env" "$STAGE/env/web.env"
copy "$STATE_DIR/ohttp/relay.env" "$STAGE/env/ohttp-relay.env"
copy "$STATE_DIR/pir/pir.env" "$STAGE/env/pir.env"
copy "$STATE_DIR/grafana/grafana.env" "$STAGE/env/grafana.env"
copy "$STATE_DIR/alertmanager/ntfy-relay.env" "$STAGE/env/ntfy-relay.env"
copy "$STATE_DIR/alertmanager/NTFY-TOPIC" "$STAGE/env/NTFY-TOPIC"
copy "$STATE_DIR/postgres-exporter/postgres-exporter.env" "$STAGE/env/postgres-exporter.env"
copy "$STATE_DIR/attestation/roots.pem" "$STAGE/env/roots.pem"
if [[ -d "$STATE_DIR/sidecar-cert-backup" ]]; then
  tar -C "$STATE_DIR" -czf "$STAGE/env/sidecar-cert-backup.tgz" sidecar-cert-backup
fi
if [[ -d "$HOME/.config/systemd/user" ]]; then
  tar -C "$HOME/.config/systemd/user" -czf "$STAGE/units/user-units.tgz" \
    --wildcards 'nyx-*.service' 'nyx-*.timer' 'nyx.target' 2>/dev/null || true
fi
{
  echo "created=$TS"
  echo "repo=$REPO_DIR"
  echo "commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "node=$(node --version 2>/dev/null || echo unknown)"
  echo "pnpm=$(pnpm --version 2>/dev/null || echo unknown)"
  echo "postgres=$(psql --version 2>/dev/null | head -1 || echo unknown)"
  echo "host=$(hostname)"
} > "$STAGE/meta.txt"

echo "== 4/5  Enkripsi =="
tar -C "$BACKUP_DIR" -czf "$BACKUP_DIR/nyx-backup-$TS.tar.gz" "nyx-backup-$TS"
age -R "$RECIPIENT_FILE" -o "$ARCHIVE" "$BACKUP_DIR/nyx-backup-$TS.tar.gz"
rm -rf "$STAGE" "$BACKUP_DIR/nyx-backup-$TS.tar.gz"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

echo "== 5/5  Unggah R2 + retensi =="
if [[ "$UPLOAD" == "1" ]] && command -v rclone >/dev/null 2>&1 && [[ -n "${R2_ACCOUNT_ID:-}" && -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  export RCLONE_CONFIG_NYXBACKUP_TYPE=s3
  export RCLONE_CONFIG_NYXBACKUP_PROVIDER=Cloudflare
  export RCLONE_CONFIG_NYXBACKUP_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_NYXBACKUP_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_NYXBACKUP_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  BUCKET="${NYX_BACKUP_R2_BUCKET:-${R2_BUCKET_NAME:-}}"
  if [[ -n "$BUCKET" ]]; then
    rclone copy --s3-no-check-bucket "$ARCHIVE" "nyxbackup:$BUCKET/nyx-backups/" --no-traverse
    rclone copy --s3-no-check-bucket "$ARCHIVE.sha256" "nyxbackup:$BUCKET/nyx-backups/" --no-traverse
    echo "   diunggah ke r2:$BUCKET/nyx-backups/"
  else
    echo "   R2_BUCKET_NAME kosong; unggahan dilewati" >&2
  fi
else
  echo "   unggahan dilewati (rclone/kredensial tidak tersedia atau NYX_BACKUP_UPLOAD=0)"
fi
find "$BACKUP_DIR" -maxdepth 1 -name 'nyx-backup-*.tar.gz.age' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'nyx-backup-*.tar.gz.age.sha256' -mtime "+$RETENTION_DAYS" -delete
echo "selesai: $ARCHIVE"
