#!/usr/bin/env bash
# =============================================================================
# NYX — nyalakan stack simulasi lengkap (Postgres, Redis, API, WebTransport,
# OHTTP relay, dual PIR, KT v2 + auditor, web/nginx, coturn).
#
#   bash scripts/sim/up.sh
#
# Pertama kali butuh build image (Rust/Go/Node) — beberapa menit. Setelah itu
# hasil build di-cache. `.sim/` menyimpan rahasia yang dibuat sekali dan tidak
# pernah masuk repo.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SIM_DIR="$ROOT/.sim"
ENV_FILE="$SIM_DIR/env"
mkdir -p "$SIM_DIR"
chmod 700 "$SIM_DIR"

COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")
# Harness E2E membutuhkan port loopback Postgres/Redis untuk reset DB di host.
if [[ "${SIM_E2E_PORTS:-0}" == "1" ]]; then
  COMPOSE+=(-f "$ROOT/deploy/sim/docker-compose.e2e.yml")
fi

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_url() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48; }

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# Dibuat scripts/sim/up.sh. JANGAN di-commit.
SIM_DB_PASSWORD=$(rand_hex 16)
SIM_JWT_SECRET=$(rand_hex 32)
SIM_CSRF_SECRET=$(rand_hex 32)
SIM_CHAT_SECRET=$(rand_hex 32)
SIM_AT_REST_PEPPER=$(rand_hex 32)
SIM_APP_SECRET=$(rand_url)
SIM_OHTTP_INTERNAL_TOKEN=$(rand_url)
SIM_PIR_ADMIN_TOKEN=$(rand_url)
SIM_TURN_SECRET=$(rand_url)
SIM_TURNSTILE_SITE_KEY=1x00000000000000000000AA
SIM_PIR_RELAYS='{"a":"/api/ohttp/relay","b":"/api/ohttp/relay"}'
JWT_SECRET=$(rand_hex 32)
CSRF_SECRET=$(rand_hex 32)
CHAT_SECRET=$(rand_hex 32)
NYX_AT_REST_PEPPER=$(rand_hex 32)
BACKUP_KEY_SECRET=$(rand_hex 32)
VAPID_SUBJECT=mailto:sim@localhost
EOF
  chmod 600 "$ENV_FILE"
  echo "🔑 .sim/env dibuat (rahasia acak, mode 0600)."
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Nilai selalu dikutip tunggal: JSON (kunci PIR) dan hash aman, dan compose
# env_file membuang kutipnya. Tanpa kutip, `source .sim/env` gagal pada `{`.
set_env() {
  local key="$1" value="$2"
  grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  printf "%s='%s'\n" "$key" "$value" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  export "$key=$value"
}

# Sidecar memverifikasi JWT yang ditandatangani API. Dua nilai acak terpisah =
# setiap koneksi WebTransport ditolak. Samakan sekali di sini (juga memperbaiki
# .sim/env lama yang sempat membuat dua nilai).
if [[ "${JWT_SECRET:-}" != "${SIM_JWT_SECRET:-}" ]]; then
  set_env JWT_SECRET "${SIM_JWT_SECRET:?SIM_JWT_SECRET kosong}"
fi

echo "🏗️  Build image Node (API/relay/alat)..."
"${COMPOSE[@]}" build server

# --- Kunci OHTTP (P-256) -----------------------------------------------------
if [[ -z "${OHTTP_PRIVATE_KEY:-}" || -z "${OHTTP_PUBLIC_KEY:-}" ]]; then
  echo "🔐 Membuat kunci gateway OHTTP..."
  OHTTP_OUT="$("${COMPOSE[@]}" run --rm --no-deps -T server \
    pnpm exec tsx scripts/ohttp-key.ts)"
  OHTTP_PRIVATE_KEY="$(printf '%s\n' "$OHTTP_OUT" | sed -n 's/^OHTTP_PRIVATE_KEY=//p')"
  OHTTP_PUBLIC_KEY="$(printf '%s\n' "$OHTTP_OUT" | sed -n 's/^OHTTP_PUBLIC_KEY=//p')"
  [[ -n "$OHTTP_PRIVATE_KEY" && -n "$OHTTP_PUBLIC_KEY" ]] || {
    echo "❌ Gagal membuat kunci OHTTP" >&2
    exit 1
  }
  set_env OHTTP_PRIVATE_KEY "$OHTTP_PRIVATE_KEY"
  set_env OHTTP_PUBLIC_KEY "$OHTTP_PUBLIC_KEY"
fi

# --- Kunci OHTTP suite hybrid (X-Wing) --------------------------------------
# [docs/43 §43.12.4] Klien selalu meminta `application/ohttp-keys+xwing`. Tanpa
# slot X-Wing, gateway hanya menyajikan collection P-256 dan stack ini tidak
# pernah menguji suite yang dipakai produksi — asersi hybrid di
# `web/e2e/ohttp.spec.ts` pun mustahil lulus.
if [[ -z "${OHTTP_XWING_PRIVATE_KEY:-}" || -z "${OHTTP_XWING_PUBLIC_KEY:-}" ]]; then
  echo "🔐 Membuat kunci gateway OHTTP X-Wing..."
  XWING_OUT="$("${COMPOSE[@]}" run --rm --no-deps -T server \
    pnpm exec tsx scripts/ohttp-key.ts --suite=xwing)"
  OHTTP_XWING_PRIVATE_KEY="$(printf '%s\n' "$XWING_OUT" | sed -n 's/^OHTTP_XWING_PRIVATE_KEY=//p')"
  OHTTP_XWING_PUBLIC_KEY="$(printf '%s\n' "$XWING_OUT" | sed -n 's/^OHTTP_XWING_PUBLIC_KEY=//p')"
  [[ -n "$OHTTP_XWING_PRIVATE_KEY" && -n "$OHTTP_XWING_PUBLIC_KEY" ]] || {
    echo "❌ Gagal membuat kunci OHTTP X-Wing" >&2
    exit 1
  }
  set_env OHTTP_XWING_PRIVATE_KEY "$OHTTP_XWING_PRIVATE_KEY"
  set_env OHTTP_XWING_PUBLIC_KEY "$OHTTP_XWING_PUBLIC_KEY"
fi

# --- Kunci tanda tangan manifest PIR (ML-DSA-65) -----------------------------
mkdir -p "$SIM_DIR/pir-keys"
if [[ -z "${SIM_PIR_MANIFEST_KEYS:-}" || -z "${PIR_SIGNING_KEYS:-}" ]]; then
  echo "🔐 Membuat kunci manifest PIR..."
  # Target mount HARUS berbeda dari `/keys:ro` milik service `server`;
  # duplicate mount ke path yang sama membuat opsi `:ro` menang dan keygen
  # gagal `EROFS`. Path file yang dicetak (`/keygen/...`) tidak dipakai —
  # `PIR_SIGNING_KEYS` menunjuk mount baca-saja `/keys/...` di server.
  PIR_OUT="$("${COMPOSE[@]}" run --rm --no-deps -T \
    -v "$SIM_DIR/pir-keys:/keygen" -e OUT_DIR=/keygen \
    server pnpm exec tsx scripts/pir-e2e-keys.ts)"
  MANIFEST_JSON="$(PIR_OUT="$PIR_OUT" node -e '
    const parsed = JSON.parse(process.env.PIR_OUT);
    const out = {};
    for (const [id, entry] of Object.entries(parsed)) out[id] = entry.publicKey;
    process.stdout.write(JSON.stringify(out));
  ')"
  SIGNING_JSON='{"a":"/keys/a.key","b":"/keys/b.key"}'
  set_env SIM_PIR_MANIFEST_KEYS "$MANIFEST_JSON"
  set_env PIR_MANIFEST_KEYS "$MANIFEST_JSON"
  set_env PIR_SIGNING_KEYS "$SIGNING_JSON"
fi

# --- Sertifikat WebTransport (self-signed, dibuat sidecar) ------------------
echo "🏗️  Build sidecar transport + PIR + KT..."
"${COMPOSE[@]}" build sidecar pir-a pir-b kt-query

echo "🚀 Menyalakan Postgres, Redis, dan sidecar untuk membuat sertifikat..."
"${COMPOSE[@]}" up -d postgres redis sidecar

for _ in $(seq 1 90); do
  if "${COMPOSE[@]}" exec -T sidecar test -s /certs/transport_cert.der >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
CERT_HASH="$("${COMPOSE[@]}" exec -T sidecar sha256sum /certs/transport_cert.der 2>/dev/null | cut -d' ' -f1 || true)"
if [[ ! "$CERT_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "❌ Sertifikat sidecar tidak terbaca; cek 'docker compose logs sidecar'" >&2
  exit 1
fi
set_env SIM_TRANSPORT_CERT_HASH "$CERT_HASH"
echo "🔏 WebTransport cert SHA-256: $CERT_HASH"

# --- Build web (image Vite dev; VITE_* dibaca saat start) -------------------
echo "🏗️  Build web (image Vite dev server)..."
"${COMPOSE[@]}" build web

echo "🚀 Menyalakan seluruh stack..."
"${COMPOSE[@]}" up -d --remove-orphans

echo -n "⏳ Menunggu API siap"
for _ in $(seq 1 120); do
  if curl -fsS http://localhost:8080/health >/dev/null 2>&1; then
    echo " ✅"
    break
  fi
  echo -n "."
  sleep 2
done
if ! curl -fsS http://localhost:8080/health >/dev/null 2>&1; then
  echo ""
  echo "❌ API belum siap. Log terakhir:" >&2
  "${COMPOSE[@]}" logs --tail=40 server migrate >&2 || true
  exit 1
fi

echo ""
echo "✅ Stack simulasi hidup:"
echo "   app        http://localhost:8080"
echo "   API        http://localhost:8080/api"
echo "   WebTransport UDP 33333 (pin $CERT_HASH)"
echo "   PIR client $([[ "${SIM_PIR_CLIENT:-1}" == "1" ]] && echo 'AKTIF (index menyusul ≤3 menit)' || echo 'mati')"
echo ""
"${COMPOSE[@]}" ps
