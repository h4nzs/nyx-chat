#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact admin@nyx-app.my.id.
#
# [docs/10 §10.23 · docs/38 §38.3] Laporan `nyx_kt_writes_total{result="invalid"}`.
#
# Pertanyaan yang dijawab laporan ini, dan hanya itu:
#   1. Berapa banyak tulisan KT yang DILEWATI, dan berapa pangsa `invalid`
#      terhadap seluruh tulisan? (Prometheus)
#   2. Berapa perangkat yang belum punya kunci PQ (`signingKeyV2` kosong), dan
#      berapa yang masih aktif? (Postgres, agregat saja)
#   3. Sebabnya apa — perangkat lama vs input cacat? (journal, dikelompokkan per
#      `<reason>`)
#
# Sifat yang dijaga: **baca-saja dan tanpa identitas**. Tidak ada `SELECT` baris,
# tidak ada usernameHash/userId/IP yang dicetak, dan tidak menulis apa pun ke DB.
# Aman dijalankan harian oleh operator; tidak butuh root.
#
# Pemakaian:
#   bash scripts/kt-invalid-report.sh
#   PROMETHEUS_URL=http://127.0.0.1:9090 bash scripts/kt-invalid-report.sh
#   NYX_API_JOURNAL_UNIT=nyx-api bash scripts/kt-invalid-report.sh
#   SKIP_DB=1 / SKIP_JOURNAL=1 bash scripts/kt-invalid-report.sh
#
# Prasyarat: curl + jq (Prometheus), psql (opsional), journalctl (opsional).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROM="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
UNIT="${NYX_API_JOURNAL_UNIT:-nyx-api}"
SINCE="${NYX_INVALID_SINCE:-30 days ago}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ '$1' tidak ada di PATH" >&2; exit 1; }; }
need curl
need jq

prom_query() {
  local query="$1"
  curl -fsS --max-time 8 --get "$PROM/api/v1/query" --data-urlencode "query=$query" 2>/dev/null \
    | jq -r '.data.result[]? | "\(.metric.result // .metric.le // "nilai")\t\(.value[1])"' || true
}

echo "== 1/3  Prometheus ($PROM) =="
if ! curl -fsS --max-time 5 "$PROM/-/ready" >/dev/null 2>&1; then
  echo "   ⏭️  Prometheus tidak menjawab — bagian metrik dilewati (bukan lulus)."
else
  printf '   %-14s %s\n' "hasil" "tulisan (24 jam)"
  for window in 24h 7d; do
    echo "   ── jendela $window ──"
    out="$(prom_query "sum by (result) (increase(nyx_kt_writes_total[$window]))")"
    if [[ -z "$out" ]]; then
      echo "   (tidak ada seri — belum ada tulisan KT di jendela ini)"
    else
      echo "$out" | awk -F'\t' '{printf "   %-14s %.0f\n", $1, $2}'
    fi
  done

  # Pangsa invalid. `or vector(0)` wajib: tanpa satu pun tulisan, vektornya
  # kosong dan "0%" akan tampil sebagai "No data" — dua hal yang berbeda.
  share="$(curl -fsS --max-time 8 --get "$PROM/api/v1/query" \
    --data-urlencode 'query=(sum(increase(nyx_kt_writes_total{result="invalid"}[24h])) / clamp_min(sum(increase(nyx_kt_writes_total[24h])), 1)) or vector(0)' \
    2>/dev/null | jq -r '.data.result[0].value[1] // "0"')"
  echo
  printf '   pangsa invalid (24 jam): %.2f%%  (ambang alert 5%%)\n' "$(awk -v s="$share" 'BEGIN { printf "%.2f", s * 100 }')"
fi

echo
echo "== 2/3  Perangkat tanpa kunci PQ (Postgres, agregat) =="
if [[ "${SKIP_DB:-0}" == "1" ]]; then
  echo "   ⏭️  dilewati (SKIP_DB=1)"
else
  if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/server/.env" ]]; then
    # Hanya membaca; nilainya tidak pernah dicetak.
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/server/.env"
    set +a
  fi
  if [[ -z "${DATABASE_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
    echo "   ⏭️  dilewati (DATABASE_URL atau psql tidak tersedia)"
  else
    PG_URL="${DATABASE_URL%%\?*}"
    psql "$PG_URL" -X -q -A -t -v ON_ERROR_STOP=1 <<'SQL' | awk -F'|' '{printf "   %-34s %s\n", $1, $2}'
BEGIN READ ONLY;
SELECT 'perangkat total', count(*) FROM "Device";
SELECT 'perangkat tanpa signingKeyV2', count(*) FROM "Device" WHERE "signingKeyV2" IS NULL;
SELECT 'perangkat punya signingKeyV2', count(*) FROM "Device" WHERE "signingKeyV2" IS NOT NULL;
SELECT 'perangkat lama aktif <=30 hari', count(*) FROM "Device" WHERE "signingKeyV2" IS NULL AND "lastActiveAt" > now() - interval '30 days';
SELECT 'perangkat lama aktif <=90 hari', count(*) FROM "Device" WHERE "signingKeyV2" IS NULL AND "lastActiveAt" > now() - interval '90 days';
ROLLBACK;
SQL
    echo "   (tanpa kolom tanggal pembuatan perangkat: schema hanya menyimpan lastActiveAt"
    echo "    sebagai bucket 15 menit, jadi 'lama' di sini = belum punya kunci PQ.)"
  fi
fi

echo
echo "== 3/3  Sebab dari journal (dikelompokkan, tanpa identifier) =="
if [[ "${SKIP_JOURNAL:-0}" == "1" ]]; then
  echo "   ⏭️  dilewati (SKIP_JOURNAL=1)"
else
  lines=""
  for args in "--user -u $UNIT" "-u $UNIT"; do
    if lines="$(journalctl $args --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -F '[KT] Entri log dilewati' || true)"; [[ -n "$lines" ]]; then break; fi
  done
  if [[ -z "$lines" ]]; then
    echo "   (tidak ada baris '[KT] Entri log dilewati' dalam $SINCE —"
    echo "    journal bisa terotasi sejak tulisan terakhir yang dilewati)"
  else
    echo "$lines" \
      | sed -E 's/.*dilewati \(keyVersion [0-9]+, ([a-z_]+)\): (.+)$/\1\t\2/' \
      | sort | uniq -c | sort -rn \
      | awk -F'\t' '{printf "   %6s  %s\n", $1, $2}'
    echo "   total: $(echo "$lines" | wc -l) baris"
  fi
fi

echo
echo "Cara membaca:"
echo "  - pangsa <1% dan perangkat lama aktif sedikit  → utang migrasi biasa, tidak perlu alarm."
echo "  - pangsa >5% selama 6 jam (alert)              → dorong rotasi perangkat PQ (docs/10 §10.23)."
echo "  - reason selain KT_V2_SIGNING_KEY_INVALID      → input cacat: bug klien, bukan perangkat lama."
