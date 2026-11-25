#!/usr/bin/env bash
# =============================================================================
# NYX — E2E Playwright terhadap stack simulasi penuh (bukan webServer dev).
#
#   bash scripts/sim/e2e.sh                      # seluruh suite, project chrome
#   bash scripts/sim/e2e.sh e2e/auth.spec.ts     # satu spec
#
# Perbedaan yang disengaja dari suite dev:
#   - web adalah Vite dev server di belakang nginx (:8080), API lewat proxy
#   - WebTransport/QUIC aktif (sidecar Rust) dan cert di-pin saat build
#   - OHTTP aktif (relay proses terpisah), KT v2 + auditor hidup
#   - PIR sidecar DAN klien PIR hidup. Override E2E memakai cron dirty 5 detik
#     (default produksi 3 menit) supaya user yang baru didaftarkan masuk snapshot
#     sebelum pencarian; helper menunggu tick itu, bukan mematikan PIR.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# PIR klien hidup (lihat header). Di-export SEBELUM up.sh agar VITE_PIR_*
# dibaca saat container web dibuat.
export SIM_PIR_CLIENT=1
export NYX_E2E_PIR=1
export SIM_E2E_PORTS=1

# up.sh memakai override port loopback (SIM_E2E_PORTS) supaya Postgres/Redis
# sudah terbuka sejak container pertama kali dibuat.
bash "$ROOT/scripts/sim/up.sh"

for port in 55432 56379; do
  for _ in $(seq 1 30); do
    if (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then break; fi
    sleep 1
  done
done

set -a
# shellcheck disable=SC1091
. "$ROOT/.sim/env"
set +a

export NODE_ENV=development
export NYX_E2E_DATABASE_URL="postgresql://nyx:${SIM_DB_PASSWORD}@127.0.0.1:55432/nyx"
export DATABASE_URL="$NYX_E2E_DATABASE_URL"
export REDIS_URL="redis://127.0.0.1:56379"
export NYX_STACK_BASE_URL="http://localhost:8080"

cd "$ROOT/web"
pnpm exec playwright test --config playwright.stack.config.ts --project=chrome "$@"
node e2e/verify-required-tests.mjs --project chrome
