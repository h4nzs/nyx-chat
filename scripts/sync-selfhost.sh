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

pairs=()   # format: src|dest_rel|transform(bool)

if [[ "$PROFILE" == "selfhost" ]]; then
  pairs+=("$ROOT_DIR/ops/nginx/nyx.conf|nginx/nyx.conf|1")
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
  if [[ "$transform" == "1" ]]; then
    transform_selfhost_nginx "$src" > "$out"
  else
    cp "$src" "$out"
  fi
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
  else
    echo "  sudo nginx -t && sudo systemctl reload nginx"
    echo "  sudo systemctl daemon-reload"
  fi
fi
