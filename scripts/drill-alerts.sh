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
#   4. Kontrak metrik + cakupan — setiap metrik `nyx_*` yang dirujuk aturan
#                                 ATAU PANEL DASHBOARD harus benar-benar
#                                 dideklarasikan, dan setiap aturan harus punya
#                                 kasus drill. (Panel yang merujuk metrik salah
#                                 tulis hanya menampilkan "No data", bukan error
#                                 — jadi salah tulis di sana tidak pernah ketahuan
#                                 tanpa lapis ini.)
#
# Empat sumber deklarasi (semuanya di-repo, bukan hasil runtime):
#   - `server/src/utils/metrics.ts`                          → metrik nyx-api
#   - `server/kt-query/cmd/nyx-kt-auditor-v2/metrics.go`     → metrik auditor KT
#   - `server/kt-query/cmd/nyx-kt-query-v2/metrics.go`       → metrik proses log KT
#   - `server/transport-sidecar/src/metrics.rs`              → metrik sidecar WT
# Aturan yang merujuk metrik di luar keempatnya TIDAK akan pernah menyala, dan
# tanpa lapis ini kesalahan itu tidak mengeluarkan error apa pun.
#
# Opsional (bila exporter hidup): scrape `/metrics` nyata dari tiap exporter dan
# pastikan tidak ada nama metrik yang belum dideklarasikan (salah tulis nama =
# aturan diam). Setiap exporter yang tidak menjawab DILEWATI dengan catatan —
# bukan dihitung lulus.
#
# Pemakaian:
#   scripts/drill-alerts.sh
#   METRICS_URL=http://127.0.0.1:9464/metrics scripts/drill-alerts.sh
#   AUDITOR_METRICS_URL=http://127.0.0.1:9469/metrics scripts/drill-alerts.sh
#   KT_QUERY_METRICS_URL=http://127.0.0.1:9468/metrics scripts/drill-alerts.sh
#   SIDECAR_METRICS_URL=http://127.0.0.1:9465/metrics scripts/drill-alerts.sh
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
AUDITOR_METRICS_GO="$ROOT/server/kt-query/cmd/nyx-kt-auditor-v2/metrics.go"
KT_QUERY_METRICS_GO="$ROOT/server/kt-query/cmd/nyx-kt-query-v2/metrics.go"
SIDECAR_METRICS_RS="$ROOT/server/transport-sidecar/src/metrics.rs"
DASHBOARD="$ROOT/ops/grafana/dashboards/nyx-overview.json"

# Versi promtool dipin supaya drill deterministik (aturan format lama tetap sah
# di versi baru, tapi kita tidak ingin perilaku uji berubah tanpa sadar).
PROMTOOL_VERSION="${PROMTOOL_VERSION:-3.15.0}"
CACHE_DIR="$ROOT/.cache/promtool"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:9464/metrics}"
AUDITOR_METRICS_URL="${AUDITOR_METRICS_URL:-http://127.0.0.1:9469/metrics}"
KT_QUERY_METRICS_URL="${KT_QUERY_METRICS_URL:-http://127.0.0.1:9468/metrics}"
SIDECAR_METRICS_URL="${SIDECAR_METRICS_URL:-http://127.0.0.1:9465/metrics}"

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
# Sisi server: nama metrik ditulis sebagai string berkutip satu. Sisi Go
# (auditor + proses log): lewat `defineCounter("…")`/`defineGauge("…")`. Sisi
# Rust (sidecar): lewat `name: "…"` pada `METRIC_DEFS`. Semuanya sengaja
# berpola, supaya nama di dalam komentar/help tidak ikut terbaca sebagai
# deklarasi.
declared_ts="$(grep -oE "'nyx_[a-z0-9_]+'" "$METRICS_TS" | tr -d "'" || true)"
declared_go="$(grep -oE 'define(Counter|Gauge)\("nyx_[a-z0-9_]+' "$AUDITOR_METRICS_GO" | grep -oE 'nyx_[a-z0-9_]+' || true)"
declared_go_query="$(grep -oE 'define(Counter|Gauge)\("nyx_[a-z0-9_]+' "$KT_QUERY_METRICS_GO" | grep -oE 'nyx_[a-z0-9_]+' || true)"
declared_rs="$(grep -oE 'name: "nyx_[a-z0-9_]+' "$SIDECAR_METRICS_RS" | grep -oE 'nyx_[a-z0-9_]+' || true)"
declared="$(printf '%s\n%s\n%s\n%s\n' "$declared_ts" "$declared_go" "$declared_go_query" "$declared_rs" \
  | grep -v '^$' | sort -u)"

missing="$(comm -23 <(echo "$referenced") <(echo "$declared") || true)"
if [[ -n "$missing" ]]; then
  echo "$missing" | sed 's/^/   - /' >&2
  fail "aturan merujuk metrik yang TIDAK dideklarasikan (aturan ini tidak akan pernah menyala)"
fi
ok "semua $(echo "$referenced" | wc -l) metrik nyx_* yang dirujuk aturan sudah dideklarasikan (metrics.ts + metrics.go ×2 + metrics.rs)"

# Kontrak yang sama untuk dashboard: panel yang merujuk metrik salah tulis TIDAK
# error, hanya menampilkan "No data" — dan "No data" di produksi paling sering
# dibaca sekadar sebagai "sedang sepi". Hanya nilai `expr` yang dibaca (bukan
# deskripsi panel), supaya nama metrik yang cuma disebut di dokumentasi panel
# tidak dianggap sebagai query.
dash_referenced="$(
  grep '"expr"' "$DASHBOARD" \
    | grep -oE 'nyx_[a-z0-9_]+' \
    | sed -E 's/_(bucket|count|sum)$//' \
    | sort -u
)"
dash_missing="$(comm -23 <(echo "$dash_referenced") <(echo "$declared") || true)"
if [[ -n "$dash_missing" ]]; then
  echo "$dash_missing" | sed 's/^/   - /' >&2
  fail "dashboard merujuk metrik yang TIDAK dideklarasikan (panel itu akan menampilkan 'No data' selamanya)"
fi
ok "semua $(echo "$dash_referenced" | wc -l) metrik nyx_* yang dirujuk panel dashboard sudah dideklarasikan"

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
  # Empat exporter dipisah: kalau nyx-api hidup dan auditor mati, lapis ini tetap
  # memeriksa yang hidup — "salah satu tidak menjawab" bukan alasan melewatkan
  # yang lain (itu justru kasus yang ingin terlihat).
  label_and_urls=(
    "nyx-api:$METRICS_URL"
    "nyx-kt-auditor-v2:$AUDITOR_METRICS_URL"
    "nyx-kt-query-v2:$KT_QUERY_METRICS_URL"
    "nyx-sidecar:$SIDECAR_METRICS_URL"
  )
  for entry in "${label_and_urls[@]}"; do
    label="${entry%%:*}"
    url="${entry#*:}"
    body="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ -z "$body" ]]; then
      echo "⏭️  exporter $label tidak menjawab di $url — dilewati (bukan lulus palsu)."
      continue
    fi
    live_names="$(
      echo "$body" | grep -E '^# TYPE ' | awk '{print $3}' \
        | sed -E 's/_(bucket|count|sum)$//' | sort -u
    )"
    undeclared="$(comm -23 <(echo "$live_names") <(echo "$declared") || true)"
    if [[ -n "$undeclared" ]]; then
      echo "$undeclared" | sed 's/^/   - /' >&2
      fail "exporter $label mengirim metrik yang tidak dideklarasikan (salah tulis nama = aturan diam)"
    fi
    ok "exporter $label hidup: $(echo "$live_names" | wc -l) keluarga metrik ter-scrape, semuanya terdeklarasi"
  done
fi

echo
echo "🎉 Drill alert lulus: config, $(echo "$rules" | wc -l) aturan, dan semua kasus menyala/tidak-menyala."
