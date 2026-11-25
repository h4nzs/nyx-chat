#!/usr/bin/env bash
# Hentikan stack simulasi. default: container + network, volume dipertahankan.
#   bash scripts/sim/down.sh --volumes   # ikut hapus data/kunci (build ulang)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")
# Override ikut dimuat supaya network `e2e-publish` (dibuat saat E2E) juga
# dihapus, termasuk bila stack dinyalakan tanpa override tersebut.
if [[ -f "$ROOT/deploy/sim/docker-compose.e2e.yml" ]]; then
  COMPOSE+=(-f "$ROOT/deploy/sim/docker-compose.e2e.yml")
fi
"${COMPOSE[@]}" down "$@"
