#!/usr/bin/env bash
# =============================================================================
# NYX — smoke stack simulasi: buktikan setiap layanan benar-benar hidup dan
# batas jaringan berlaku. Bukan pengganti E2E; ini pemeriksaan cepat setelah
# `scripts/sim/up.sh`.
#
#   bash scripts/sim/smoke.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")

pass=0
fail=0
ok() { printf '  ✅ %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  ❌ %s\n' "$1"; fail=$((fail + 1)); }

echo "— Entry point (nginx → API) —"
if curl -fsS http://localhost:8080/health >/dev/null; then ok "/health"; else bad "/health"; fi
if curl -fsS http://localhost:8080/ >/dev/null; then ok "web /"; else bad "web /"; fi

echo "— WebTransport —"
if "${COMPOSE[@]}" exec -T sidecar test -s /certs/transport_cert.der; then
  ok "sidecar cert ada ($("${COMPOSE[@]}" exec -T sidecar sha256sum /certs/transport_cert.der | cut -d' ' -f1 | cut -c1-16)…)"
else
  bad "sidecar cert tidak ada"
fi
if ss -lun 2>/dev/null | grep -q ':33333'; then ok "UDP 33333 listen"; else bad "UDP 33333 tidak listen"; fi

echo "— OHTTP (relay proses terpisah) —"
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/ohttp/config)"
[[ "$code" == "200" ]] && ok "/api/ohttp/config → 200" || bad "/api/ohttp/config → $code"

echo "— PIR (dua sidecar) —"
for role in a b; do
  if "${COMPOSE[@]}" exec -T "pir-$role" curl -fsS "http://127.0.0.1:$([[ $role == a ]] && echo 9470 || echo 9471)/health" >/dev/null; then
    ok "pir-$role /health"
  else
    bad "pir-$role /health"
  fi
done
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/pir/a/manifest)"
# 200 = ringkasan manifest; 401 = rute ter-mount dan gerbang sesi aktif (curl
# tanpa sesi); 404 = sidecar hidup tetapi index belum dibangun (job 3 menit).
[[ "$code" == "200" || "$code" == "401" || "$code" == "404" ]] && ok "/api/pir/a/manifest → $code" || bad "/api/pir/a/manifest → $code"

echo "— Key Transparency v2 —"
if "${COMPOSE[@]}" exec -T kt-query curl -fsS http://127.0.0.1:8089/healthz >/dev/null; then
  ok "kt-query /healthz"
else
  bad "kt-query /healthz"
fi
if "${COMPOSE[@]}" ps --status running --services | grep -qx kt-auditor; then
  ok "kt-auditor berjalan"
else
  bad "kt-auditor tidak berjalan"
fi

echo "— TURN (coturn, host network) —"
if ss -lun 2>/dev/null | grep -q ':3478'; then ok "UDP 3478 listen"; else bad "UDP 3478 tidak listen"; fi

echo "— Isolasi jaringan —"
if "${COMPOSE[@]}" exec -T web getent hosts postgres >/dev/null 2>&1 \
  || "${COMPOSE[@]}" exec -T web getent hosts redis >/dev/null 2>&1; then
  bad "web bisa menjangkau Postgres/Redis (batas jaringan bocor)"
else
  ok "web tidak bisa menjangkau Postgres/Redis"
fi

echo ""
echo "Hasil: $pass lulus, $fail gagal"
[[ "$fail" -eq 0 ]]
