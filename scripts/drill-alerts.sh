#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact [admin@nyx-app.my.id].
#
# [docs/30 WS-G(2)] DRILL alert — satu perintah untuk membuktikan bahwa aturan
# di `ops/prometheus/alerts.yml` **benar-benar bisa menyala**, bukan sekadar
# ditulis. Empat lapis:
#
#   1. `promtool check config`  — config scrape sah (rule_files, scrape_configs).
#   2. `promtool check rules`   — ekspresi PromQL kompilasi.
#   3. `promtool test rules`    — uji unit: tiap aturan punya kasus MENYALA dan
#                                 (untuk ambang yang mudah salah) kasus TIDAK
#                                 MENYALA. Lapis inilah yang menemukan aturan
#                                 "dead" (mis. `A and B` dengan label tak sepadan).
#   4. Kontrak metrik + cakupan — setiap metrik `nyx_*` yang dirujuk aturan harus
#                                 benar-benar dideklarasikan, dan setiap aturan
#                                 harus punya kasus drill.
#
# Opsional (bila API NYX hidup): scrape `/metrics` nyata dan pastikan tidak ada
# nama metrik yang belum dideklarasikan (salah tulis nama = aturan diam).
#
# Pemakaian:
#   scripts/drill-alerts.sh
#   METRICS_URL=http://127.0.0.1:9464/metrics scripts/drill-alerts.sh
#   SKIP_LIVE=1 scripts/drill-alerts.sh          # lompati lapis live
#
# promtool: dipakai dari PATH bila ada; kalau tidak, diunduh (versi dipin) ke
# `.cache/promtool/`. Tanpa jaringan + tanpa promtool → skrip berhenti dengan
# pesan jelas (bukan lulus palsu).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROM_DIR="$ROOT/ops/prometheus"
ALERTS="$PROM_DIR/alerts.yml"
TESTS="$PROM_DIR/tests.yml"
CONFIG="$PROM_DIR/prometheus.yml"
METRICS_TS="$ROOT/server/src/utils/metrics.ts"

# Versi promtool dipin supaya drill deterministik (aturan format lama tetap sah
# di versi baru, tapi kita tidak ingin perilaku uji berubah tanpa sadar).
PROMTOOL_VERSION="${PROMTOOL_VERSION:-3.15.0}"
CACHE_DIR="$ROOT/.cache/promtool"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:9464/metrics}"

fail() { echo "❌ $*" >&2; exit 1; }
ok() { echo "✅ $*"; }

resolve_promtool() {
  if [[ -n "${PROMTOOL:-}" && -x "${PROMTOOL}" ]]; then
    echo "$PROMTOOL"
    return
  fi
  if command -v promtool >/dev/null 2>&1; then
    command -v promtool
    return
  fi
  local binary="$CACHE_DIR/promtool-$PROMTOOL_VERSION"
  if [[ -x "$binary" ]]; then
    echo "$binary"
    return
  fi
  local archive="$CACHE_DIR/prometheus-$PROMTOOL_VERSION.linux-amd64.tar.gz"
  mkdir -p "$CACHE_DIR"
  echo "⬇️  promtool $PROMTOOL_VERSION belum ada — mengunduh ke $CACHE_DIR" >&2
  curl -fsSL --retry 3 --max-time 120 -o "$archive" \
    "https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/prometheus-${PROMTOOL_VERSION}.linux-amd64.tar.gz" \
    || fail "unduh promtool gagal (set PROMTOOL=/path/ke/promtool untuk mode offline)"
  tar -xzf "$archive" -C "$CACHE_DIR" "prometheus-${PROMTOOL_VERSION}.linux-amd64/promtool"
  mv "$CACHE_DIR/prometheus-${PROMTOOL_VERSION}.linux-amd64/promtool" "$binary"
  chmod +x "$binary"
  echo "$binary"
}

PROMTOOL_BIN="$(resolve_promtool)"
echo "🔧 promtool: $PROMTOOL_BIN ($("$PROMTOOL_BIN" --version | head -1))"

echo
echo "── 1/4 konfigurasi scrape + aturan ──"
# `rule_files: alerts.yml` relatif terhadap direktori config → jalankan dari sana.
(cd "$PROM_DIR" && "$PROMTOOL_BIN" check config "$(basename "$CONFIG")")
(cd "$PROM_DIR" && "$PROMTOOL_BIN" check rules "$(basename "$ALERTS")")
ok "config & aturan kompilasi bersih"

echo
echo "── 2/4 drill: uji unit aturan (menyala & tidak menyala) ──"
(cd "$PROM_DIR" && "$PROMTOOL_BIN" test rules "$(basename "$TESTS")")
ok "semua kasus drill lulus"

echo
echo "── 3/4 kontrak metrik + cakupan aturan ──"
# Nama metrik nyx_* yang dirujuk aturan, tanpa suffix histogram/`_total`.
# Baris komentar dibuang dulu: komentar penjelas menyebut nama metrik juga, dan
# nama yang terpotong di batas baris akan terlihat seperti metrik tak dikenal.
referenced="$(
  grep -vE '^\s*#' "$ALERTS" \
    | grep -oE 'nyx_[a-z0-9_]+' \
    | sed -E 's/_(bucket|count|sum)$//' \
    | sort -u
)"
declared="$(grep -oE "'nyx_[a-z0-9_]+'" "$METRICS_TS" | tr -d "'" | sort -u)"

missing="$(comm -23 <(echo "$referenced") <(echo "$declared") || true)"
if [[ -n "$missing" ]]; then
  echo "$missing" | sed 's/^/   - /' >&2
  fail "aturan merujuk metrik yang TIDAK dideklarasikan (aturan ini tidak akan pernah menyala)"
fi
ok "semua $(echo "$referenced" | wc -l) metrik nyx_* yang dirujuk aturan sudah dideklarasikan di metrics.ts"

# Setiap aturan WAJIB punya kasus drill — aturan baru tanpa drill = aturan yang
# belum dibuktikan pernah menyala.
rules="$(grep -oE '^\s+- alert: [A-Za-z0-9_]+' "$ALERTS" | awk '{print $3}' | sort -u)"
drilled="$(grep -oE '^\s+alertname: [A-Za-z0-9_]+' "$TESTS" | awk '{print $2}' | sort -u)"
undrilled="$(comm -23 <(echo "$rules") <(echo "$drilled") || true)"
if [[ -n "$undrilled" ]]; then
  echo "$undrilled" | sed 's/^/   - /' >&2
  fail "aturan belum punya kasus drill di ops/prometheus/tests.yml"
fi
ok "semua $(echo "$rules" | wc -l) aturan punya kasus drill"

echo
echo "── 4/4 scrape nyata (opsional) ──"
if [[ "${SKIP_LIVE:-0}" == "1" ]]; then
  echo "⏭️  dilewati (SKIP_LIVE=1)"
else
  body="$(curl -fsS --max-time 5 "$METRICS_URL" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    echo "⏭️  exporter tidak menjawab di $METRICS_URL — lapis ini dilewati (bukan lulus palsu)."
  else
    live_names="$(
      echo "$body" | grep -E '^# TYPE ' | awk '{print $3}' \
        | sed -E 's/_(bucket|count|sum)$//' | sort -u
    )"
    undeclared="$(comm -23 <(echo "$live_names") <(echo "$declared") || true)"
    if [[ -n "$undeclared" ]]; then
      echo "$undeclared" | sed 's/^/   - /' >&2
      fail "exporter mengirim metrik yang tidak dideklarasikan (salah tulis nama = aturan diam)"
    fi
    ok "exporter hidup: $(echo "$live_names" | wc -l) keluarga metrik ter-scrape, semuanya terdeklarasi"
  fi
fi

echo
echo "🎉 Drill alert lulus: config, $(echo "$rules" | wc -l) aturan, dan semua kasus menyala/tidak-menyala."
