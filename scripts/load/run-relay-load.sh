#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact [admin@nyx-app.my.id].
#
# [docs/30 §30.15 WS-G(3)] Jalankan load test relay k6 secara utuh tapi aman:
#
#   1. pastikan API hidup (kalau tidak, keluar dengan pesan jelas — bukan hasil
#      "p95 cepat" dari endpoint yang tidak ada);
#   2. siapkan akun + device + percakapan uji (idempoten);
#   3. SMOKE dulu (5 VU): membuktikan sesi, cookie CSRF, dan device benar-benar
#      terbawa. Tanpa langkah ini, kegagalan autentikasi tampak seperti beban
#      ringan (401/403 dijawab cepat tanpa menyentuh DB);
#   4. profil penuh (default 500 VU, ~20 pesan/s agregat saat fase hold).
#
# Beban ini MENULIS pesan ke DB lokal dan butuh Postgres + Redis hidup.
# JANGAN arahkan ke produksi. Jalankan untuk rilis/malam, bukan tiap PR.
#
# Pemakaian:
#   BASE_URL=http://127.0.0.1:4000 scripts/load/run-relay-load.sh
#   NYX_MAX_VUS=100 scripts/load/run-relay-load.sh       # mesin kecil
#   NYX_ITER_SLEEP_SECONDS=25 scripts/load/run-relay-load.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"

fail() { echo "❌ $*" >&2; exit 1; }
ok() { echo "✅ $*"; }

command -v k6 >/dev/null 2>&1 || fail "k6 tidak ada di PATH (butuh k6 v0.5x+ / v2)."

echo "── 1/4 API hidup? ($BASE_URL/health) ──"
curl -fsS --max-time 5 "$BASE_URL/health" >/dev/null \
  || fail "API tidak menjawab di $BASE_URL — nyalakan server + Postgres + Redis dulu."
ok "API menjawab"

echo
echo "── 2/4 siapkan akun + device + percakapan uji ──"
# `--exports` mencetak baris `export …` (tanpa PII runtime selain hash username).
eval "$(cd "$ROOT" && pnpm --filter nyx-server exec tsx scripts/load-test-user.ts --exports 2>/dev/null | grep '^export')"
[[ -n "${NYX_CONVERSATION_ID:-}" && -n "${NYX_DEVICE_ID:-}" ]] || fail "penyiapan akun gagal (env tidak lengkap)."
ok "akun siap (conversation=$NYX_CONVERSATION_ID)"

common_env=(
  --env "BASE_URL=$BASE_URL"
  --env "NYX_USER=$NYX_USER"
  --env "NYX_PASS=$NYX_PASS"
  --env "NYX_USERNAME_HASH=$NYX_USERNAME_HASH"
  --env "NYX_CONVERSATION_ID=$NYX_CONVERSATION_ID"
  --env "NYX_DEVICE_ID=$NYX_DEVICE_ID"
)

echo
echo "── 3/4 SMOKE (5 VU) — buktikan sesi & CSRF benar-benar terbawa ──"
k6 run --quiet "${common_env[@]}" --env NYX_SMOKE=1 --env NYX_ITER_SLEEP_SECONDS=1 \
  "$ROOT/scripts/load/relay.k6.js" \
  || fail "SMOKE gagal: harness belum sehat (jangan lanjut ke beban penuh)."
ok "SMOKE lulus (send 201 + fetch 200, 0 error)"

echo
echo "── 4/4 BEBAN PENUH (NYX_MAX_VUS=${NYX_MAX_VUS:-500}, jeda ${NYX_ITER_SLEEP_SECONDS:-25}s) ──"
k6 run --quiet "${common_env[@]}" "$ROOT/scripts/load/relay.k6.js" \
  || fail "gate load test tidak terpenuhi (lihat THRESHOLDS di atas)."
ok "gate WS-G(3) terpenuhi: send/fetch p95 < 200ms, error rate < 1%"
