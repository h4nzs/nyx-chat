#!/usr/bin/env bash
# Build ulang artefak produksi NYX self-host, dalam urutan yang benar.
#
#   bash $SELFHOST_DIR/rebuild.sh                 # shared + web + server + marketing
#   bash $SELFHOST_DIR/rebuild.sh --sidecar       # sekaligus cargo build --release sidecar
#   bash $SELFHOST_DIR/rebuild.sh --pir           # sekaligus cargo build --release PIR sidecar
#   bash $SELFHOST_DIR/rebuild.sh --restart       # sekaligus restart unit systemd (tanpa sudo)
#   bash $SELFHOST_DIR/rebuild.sh --sidecar --pir --restart
#
# `--restart` selalu me-restart `nyx-ohttp-relay` juga: entrypoint relay ada di
# `server/dist/ohttp/relay.js`, jadi tanpa restart proses relay tetap memakai
# kode lama setelah server berubah (docs/10 §10.18).
#
# Urutan WAJIB: @nyx/shared dulu — web & server mengonsumsi packages/shared/dist,
# jadi build web/server sebelum shared = perubahan shared tak terlihat (AGENTS.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DO_SIDECAR=0
DO_PIR=0
DO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --sidecar) DO_SIDECAR=1 ;;
    --pir) DO_PIR=1 ;;
    --restart) DO_RESTART=1 ;;
    *) echo "argumen tak dikenal: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO"

echo "== 1/6  @nyx/shared =="
pnpm --filter @nyx/shared run build

echo "== 2/6  server (tsc → dist/, termasuk dist/ohttp/relay.js) =="
pnpm --filter nyx-server run build

echo "== 3/6  web (tsc -b && vite build → web/dist) =="
pnpm --filter nyx-web run build

echo "== 4/6  marketing (astro build → marketing/dist) =="
pnpm --filter marketing run build

if [[ $DO_SIDECAR -eq 1 ]]; then
  echo "== 5/6  sidecar WebTransport (cargo build --release) =="
  (cd server/transport-sidecar && cargo build --release)
  echo "   Catatan: sertifikat sidecar bisa berotasi saat kedaluwarsa — hash baru"
  echo "   hanya perlu disalin ke web/.env (VITE_TRANSPORT_CERT_HASH) untuk DEV."
else
  echo "== 5/6  sidecar WebTransport: dilewati (tambahkan --sidecar bila perlu) =="
fi

if [[ $DO_PIR -eq 1 ]]; then
  echo "== 6/6  sidecar PIR (cargo build --release --locked) =="
  (cd server/pir-sidecar && cargo build --release --locked)
  echo "   Catatan: snapshot PIR dimuat saat boot. Setelah user baru terdaftar:"
  echo "     pnpm --filter nyx-server run pir:snapshot"
  echo "     systemctl --user restart nyx-pir-sidecar"
else
  echo "== 6/6  sidecar PIR: dilewati (tambahkan --pir bila perlu) =="
fi

if [[ $DO_RESTART -eq 1 ]]; then
  echo "== restart unit (tingkat user, tidak perlu sudo) =="
  systemctl --user restart nyx-api nyx-nginx nyx-ohttp-relay
  TOCheck="nyx-api nyx-nginx nyx-ohttp-relay"
  if [[ $DO_SIDECAR -eq 1 ]]; then
    systemctl --user restart nyx-sidecar
    TOCheck="$TOCheck nyx-sidecar"
  fi
  if [[ $DO_PIR -eq 1 ]]; then
    systemctl --user restart nyx-pir-sidecar
    TOCheck="$TOCheck nyx-pir-sidecar"
  fi
  sleep 3
  systemctl --user --no-pager --full --lines=0 status $TOCheck || true
fi

echo
echo "Selesai. Kalau web/ berubah, cukup nginx yang perlu di-reload:"
echo "  systemctl --user reload nyx-nginx          # statis, tanpa downtime"
echo "  systemctl --user restart nyx-api nyx-ohttp-relay  # kalau server/ berubah (relay.js ikut)"
echo "  systemctl --user restart nyx-pir-sidecar   # hanya bila binary PIR dibangun ulang"
