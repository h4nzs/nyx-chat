#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
#
# [docs/37 §37.4 P8] Sinkronkan berkas ops yang berasal dari repo.
#
# Kenapa ada: config nginx dan unit systemd dulu hidup hanya di
# `~/nyx-selfhost`, sehingga perubahan di repo (CSP, real_ip, relay OHTTP, unit
# baru) tidak pernah sampai ke mesin dan sebaliknya. Repo adalah sumber; mesin
# menerima SALINAN.
#
# Dua profil (karena bentuk deployment berbeda, bukan karena config berbeda):
#
#   selfhost  nginx/nyx.conf      → path /home/ken/... , upstream 127.0.0.1
#             ops/systemd/user/*  → {SELFHOST}/systemd/user/
#             ops/prometheus/*    → {SELFHOST}/prometheus/conf/
#             (job `nyx-api` memakai static 127.0.0.1:9464, bukan file_sd pm2)
#             ops/grafana dashboards → {SELFHOST}/grafana/dashboards/
#             (tanpa docker-compose — mesin ini tidak memakai Docker)
#
#   docker    nginx/nyx.conf      → apa adanya (server:4000, ohttp-relay:4100)
#             ops/systemd/*.service → {SELFHOST}/systemd/
#             docker-compose.yml    → {SELFHOST}/docker-compose.yml
#
# Transformasi profil `selfhost` sengaja eksplisit di bawah (bukan sed liar):
# setiap baris adalah perbedaan yang memang didokumentasikan di README selfhost.
#
# Pemakaian:
#   SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh            # dry-run
#   SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh --apply    # tulis
#   SELFHOST_DIR=~/nyx-selfhost bash scripts/sync-selfhost.sh --check    # exit 1 bila drift
#   SELFHOST_PROFILE=docker SELFHOST_DIR=/srv/nyx bash scripts/sync-selfhost.sh
#
# Yang TIDAK disinkronkan (sengaja): .env, kunci, config KT, sertifikat,
# nginx master (`nginx/nginx.conf` — path/pid/port host-specific).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELFHOST_DIR="${SELFHOST_DIR:-}"
PROFILE="${SELFHOST_PROFILE:-selfhost}"
MODE="dry-run"

for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --check) MODE="check" ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "sync-selfhost: argumen tidak dikenal: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SELFHOST_DIR" ]]; then
  echo "sync-selfhost: SELFHOST_DIR wajib diisi (mis. $HOME/nyx-selfhost)" >&2
  exit 2
fi
if [[ ! -d "$SELFHOST_DIR" ]]; then
  echo "sync-selfhost: direktori tidak ada: $SELFHOST_DIR" >&2
  exit 2
fi
case "$PROFILE" in
  selfhost|docker) ;;
  *)
    echo "sync-selfhost: SELFHOST_PROFILE harus 'selfhost' atau 'docker'" >&2
    exit 2
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Transformasi profil selfhost untuk site config nginx.
transform_selfhost_nginx() {
  sed \
    -e 's#root /var/www/nyx-marketing;#root /home/ken/nyx-chat/marketing/dist;#' \
    -e 's#root /var/www/nyx-web;#root /home/ken/nyx-chat/web/dist;#' \
    -e 's#http://server:4000#http://127.0.0.1:4000#g' \
    -e 's#http://ohttp-relay:4100#http://127.0.0.1:4100#g' \
    "$1"
}

# Transformasi profil selfhost untuk prometheus.yml: di VPS `nyx-api` di-scrape
# lewat file_sd yang ditulis `scripts/metrics-targets.mjs` (banyak instance pm2).
# Di selfhost hanya ada satu proses di 127.0.0.1:9464, jadi blok file_sd diganti
# static target; tanpa ini target `nyx-api` hilang (warning promtool: file_sd
# tidak ada) dan semua alert sisi API berhenti punya data.
transform_selfhost_prometheus() {
  awk '
    /^  # Aplikasi NYX \(Express \+ bridge \+ sweeper\)\. Tiap worker pm2 membuka$/ {
      print "  # Aplikasi NYX (Express + bridge + sweeper). Selfhost: SATU proses di"
      print "  # 127.0.0.1:9464 (METRICS_PORT default); VPS memakai file_sd yang ditulis"
      print "  # scripts/metrics-targets.mjs — profil ini menggantinya dengan static target."
      next
    }
    /^  # METRICS_PORT \+ NODE_APP_INSTANCE \* 10 \(default 9464, 9474, \.\.\.\)\. File ini dibuat$/ { next }
    /^  # deploy dengan `scripts\/metrics-targets\.mjs` setelah pm2 start\.$/ { next }
    /^  - job_name: nyx-api$/ { api=1; print; next }
    api && /^    file_sd_configs:$/ {
      print "    static_configs:"
      print "      - targets: [\x27127.0.0.1:9464\x27]"
      skip=1; next
    }
    skip {
      if ($0 ~ /^      /) next
      skip=0
    }
    { print }
  ' "$1"
}

pairs=()   # format: src|dest_rel|transform(0=tidak, 1=nginx, 2=prometheus)

if [[ "$PROFILE" == "selfhost" ]]; then
  pairs+=("$ROOT_DIR/ops/nginx/nyx.conf|nginx/nyx.conf|1")
  pairs+=("$ROOT_DIR/ops/prometheus/prometheus.yml|prometheus/conf/prometheus.yml|2")
  pairs+=("$ROOT_DIR/ops/prometheus/alerts.yml|prometheus/conf/alerts.yml|0")
  pairs+=("$ROOT_DIR/ops/prometheus/tests.yml|prometheus/conf/tests.yml|0")
  pairs+=("$ROOT_DIR/ops/grafana/dashboards/nyx-overview.json|grafana/dashboards/nyx-overview.json|0")
  for unit in "$ROOT_DIR"/ops/systemd/user/*.service; do
    [[ -e "$unit" ]] || continue
    pairs+=("$unit|systemd/user/$(basename "$unit")|0")
  done
else
  pairs+=("$ROOT_DIR/ops/nginx/nyx.conf|nginx/nyx.conf|0")
  pairs+=("$ROOT_DIR/docker-compose.yml|docker-compose.yml|0")
  for unit in "$ROOT_DIR"/ops/systemd/*.service "$ROOT_DIR"/ops/systemd/*.env.example; do
    [[ -e "$unit" ]] || continue
    pairs+=("$unit|systemd/$(basename "$unit")|0")
  done
fi

# Bandingkan src (setelah transform) dengan file tujuan. `candidate` adalah file
# yang akan dipasang bila --apply; `--check` membandingkan versi yang sama.
prepare_candidate() {
  local src="$1" transform="$2" out="$3"
  case "$transform" in
    1) transform_selfhost_nginx "$src" > "$out" ;;
    2) transform_selfhost_prometheus "$src" > "$out" ;;
    *) cp "$src" "$out" ;;
  esac
}

drift=0
same=0
missing=0
idx=0

for pair in "${pairs[@]}"; do
  src="${pair%%|*}"
  rest="${pair#*|}"
  dest_rel="${rest%%|*}"
  transform="${rest##*|}"
  dest="$SELFHOST_DIR/$dest_rel"
  idx=$((idx + 1))
  candidate="$TMP_DIR/candidate-$idx"
  prepare_candidate "$src" "$transform" "$candidate"

  if [[ ! -f "$dest" ]]; then
    echo "MISSING  $dest_rel  (belum ada di mesin)"
    missing=$((missing + 1))
    drift=$((drift + 1))
    if [[ "$MODE" == "apply" ]]; then
      mkdir -p "$(dirname "$dest")"
      install -m 0644 "$candidate" "$dest"
    fi
    continue
  fi

  if cmp -s "$candidate" "$dest"; then
    same=$((same + 1))
    continue
  fi

  drift=$((drift + 1))
  echo "DRIFT    $dest_rel  (repo ≠ mesin)"
  if [[ "$MODE" == "apply" ]]; then
    install -m 0644 "$candidate" "$dest"
    echo "         → disalin"
  fi
done

echo "sync-selfhost: profile=$PROFILE, $same sama, $drift berbeda ($missing belum ada), mode=$MODE"

if [[ "$MODE" == "check" && "$drift" -gt 0 ]]; then
  echo "sync-selfhost: drift terdeteksi — jalankan --apply setelah meninjau diff." >&2
  exit 1
fi

if [[ "$MODE" == "apply" && "$drift" -gt 0 ]]; then
  echo "sync-selfhost: salinan diperbarui. Muat ulang yang terkena:"
  if [[ "$PROFILE" == "selfhost" ]]; then
    echo "  nginx -t -c $SELFHOST_DIR/nginx/nginx.conf && systemctl --user reload nyx-nginx"
    echo "  systemctl --user daemon-reload   # bila unit berubah"
    echo "  $SELFHOST_DIR/prometheus/bin/promtool check config $SELFHOST_DIR/prometheus/conf/prometheus.yml"
    echo "  systemctl --user reload nyx-prometheus   # bila config/aturan berubah"
  else
    echo "  sudo nginx -t && sudo systemctl reload nginx"
    echo "  sudo systemctl daemon-reload"
  fi
fi
