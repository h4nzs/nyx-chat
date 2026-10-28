#!/usr/bin/env bash
# Pasang unit systemd TINGKAT USER (tanpa root) dan aktifkan linger supaya
# service tetap hidup setelah logout / reboot.
#
#   bash $SELFHOST_DIR/install-user.sh
#
# Idempoten. Jalur ini dipakai karena sudo di mesin ini butuh password;
# alternatifnya `sudo bash install.sh` (unit sistem) — JANGAN keduanya sekaligus,
# karena semuanya berebut port 3000/4000/33333 (KT v2 8087/8088/8089, relay
# OHTTP 4100, sidecar PIR 9470).
#
# Sejak 2026-10-28 log KT berjalan **hanya v2**. Unit v1 (`nyx-kt-query`,
# `nyx-kt-auditor`) dipensiunkan bersama jalur tulis v1 di server NYX (docs/38):
# langkah 2 skrip ini mematikan + menghapus unit v1 yang masih terpasang, lalu
# menyalakan `nyx-kt-query-v2`/`nyx-kt-auditor-v2` dari `systemd/user/` (sebelum
# ini unit v2 dipasang manual, bukan salinan direktori ini).
#
# Berkas + data v1 TIDAK dihapus skrip ini: `kt/retired-v1/` (unit + env lama),
# `kt/etc/`, `kt/db/`, `kt/snapshots/`, `kt/auditor-state/` tetap ada sebagai
# arsip. Hapus sendiri setelah yakin tidak dibutuhkan (README §6b).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SELFHOST_DIR="${SELFHOST_DIR:-$HOME/nyx-selfhost}"
export SELFHOST_DIR NYX_REPO="$REPO_DIR" NYX_STATE="$SELFHOST_DIR"
DEST="$HOME/.config/systemd/user"
SRC="$SELFHOST_DIR"
# nyx-prometheus + nyx-grafana = tumpukan observability (loopback :9090/:3001).
# Keduanya TIDAK wajib untuk melayani pengguna, jadi kegagalannya tidak mematikan
# aplikasi — tetapi tanpa keduanya, alert yang sudah ditulis di
# ops/prometheus/alerts.yml tidak dievaluasi siapa pun.
# nyx-{node,postgres,redis}-exporter = sumber metrik host/Postgres/Valkey untuk
# job `node`/`postgres`/`redis` di prometheus.yml. Tanpa ketiganya target itu
# `up == 0` dan alert disk/RAM/eviction tidak pernah punya data.
UNITS=(nyx-api nyx-nginx nyx-kt-query-v2 nyx-kt-auditor-v2 nyx-sidecar nyx-ohttp-relay nyx-pir-sidecar nyx-prometheus nyx-grafana nyx-alertmanager nyx-ntfy-relay nyx-node-exporter nyx-postgres-exporter nyx-redis-exporter)
# Unit yang dipensiunkan 2026-10-28. Dibiarkan di daftar ini supaya mesin yang
# masih menjalankannya ikut dibersihkan sekali jalan; aman bila sudah tidak ada.
RETIRED_UNITS=(nyx-kt-query nyx-kt-auditor)

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

echo "== 0/6  Sinkronkan config dari repo =="
bash "$REPO_DIR/scripts/sync-selfhost.sh" --apply

echo "== 0/6  Cek tidak bertabrakan dengan unit sistem =="
if systemctl is-active --quiet "${UNITS[@]}" 2>/dev/null; then
  echo "Unit sistem ${UNITS[*]} sedang aktif. Matikan dulu (butuh root):" >&2
  echo "  sudo systemctl disable --now ${UNITS[*]}" >&2
  exit 1
fi
echo "   tidak ada unit sistem nyx-* yang aktif"

echo "== 1/5  Hentikan proses ad-hoc =="
pkill -f "nginx -c ${SELFHOST_DIR}/nginx/nginx.conf" 2>/dev/null || true
pkill -f 'node dist/index.js' 2>/dev/null || true
# Pola v1 tetap ada: biner lama mungkin masih jalan dari start manual.
pkill -f 'server/kt-query/nyx-kt-query' 2>/dev/null || true
pkill -f 'server/kt-query/nyx-kt-auditor' 2>/dev/null || true
pkill -f 'target/release/transport-sidecar' 2>/dev/null || true
pkill -f 'dist/ohttp/relay.js' 2>/dev/null || true
pkill -f 'pir-sidecar/target/release/pir-service' 2>/dev/null || true
pkill -f "${SELFHOST_DIR}/prometheus/bin/prometheus" 2>/dev/null || true
pkill -f "${SELFHOST_DIR}/grafana/bin/grafana" 2>/dev/null || true
for e in node postgres redis; do pkill -f "${SELFHOST_DIR}/$e-exporter/bin/prometheus-$e-exporter" 2>/dev/null || true; done
for _ in $(seq 1 30); do
  if ! ss -tln 2>/dev/null | grep -qE ':(3000|4000|4100|9470|8087|8088|8089|9100|9121|9187)\b' && ! ss -uln 2>/dev/null | grep -q ':33333\b'; then
    break
  fi
  sleep 0.5
done
echo "   sisa socket: $(ss -tuln 2>/dev/null | grep -cE ':(3000|4000|4100|9470|33333|8087|8088|8089)\b')"

echo "== 2/5  Pensiunkan unit KT v1 (docs/38) =="
for u in "${RETIRED_UNITS[@]}"; do
  if systemctl --user list-unit-files "$u.service" >/dev/null 2>&1; then
    systemctl --user disable --now "$u" 2>/dev/null || true
    rm -f "$DEST/$u.service"
    echo "   $u: dimatikan + berkas unit dihapus (data di kt/ tidak disentuh)"
  fi
done

echo "== 3/5  Pasang unit ke ${DEST} =="
mkdir -p "$DEST"
install -m 644 "${SRC}/systemd/user/nyx-api.service" \
               "${SRC}/systemd/user/nyx-nginx.service" \
               "${SRC}/systemd/user/nyx-kt-query-v2.service" \
               "${SRC}/systemd/user/nyx-kt-auditor-v2.service" \
               "${SRC}/systemd/user/nyx-sidecar.service" \
               "${SRC}/systemd/user/nyx-ohttp-relay.service" \
               "${SRC}/systemd/user/nyx-pir-sidecar.service" \
               "${SRC}/systemd/user/nyx-prometheus.service" \
               "${SRC}/systemd/user/nyx-grafana.service" \
               "${SRC}/systemd/user/nyx-alertmanager.service" \
               "${SRC}/systemd/user/nyx-ntfy-relay.service" \
               "${SRC}/systemd/user/nyx-node-exporter.service" \
               "${SRC}/systemd/user/nyx-postgres-exporter.service" \
               "${SRC}/systemd/user/nyx-redis-exporter.service" \
               "${SRC}/systemd/user/nyx.target" \
               "${SRC}/systemd/user/nyx-backup.service" \
               "${SRC}/systemd/user/nyx-backup.timer" "$DEST/"
systemctl --user daemon-reload

echo "== 4/5  linger =="
if [[ "$(loginctl show-user "$USER" -p Linger --value)" != "yes" ]]; then
  loginctl enable-linger "$USER"
fi
loginctl show-user "$USER" -p Linger

echo "== 5/5  enable --now ${UNITS[*]} =="
systemctl --user enable --now "${UNITS[@]}"
systemctl --user enable nyx.target
if [[ -f "$HOME/.config/nyx-backup/age.pub" ]]; then
  systemctl --user enable --now nyx-backup.timer
else
  echo "   nyx-backup.timer belum diaktifkan: buat ~/.config/nyx-backup/age.pub dulu"
fi
sleep 4
systemctl --user --no-pager --full --lines=0 status "${UNITS[@]}" || true

echo
echo "Verifikasi:"
echo "  systemctl --user status nyx-api nyx-nginx nyx-kt-query-v2 nyx-kt-auditor-v2 nyx-sidecar"
echo "  journalctl --user -u nyx-api -n 40 --no-pager"
echo "  curl -s http://127.0.0.1:4000/health"
echo "  curl -s http://127.0.0.1:8089/healthz       # log Key Transparency v2"
echo "  curl -s http://127.0.0.1:4100/healthz       # relay OHTTP (butuh OHTTP_ENABLED=1)"
echo "  curl -s http://127.0.0.1:9470/health        # sidecar PIR (butuh snapshot)"
echo "  journalctl --user -u nyx-kt-auditor-v2 -n 20 --no-pager   # 'tree head DIKIRIM'"
echo "  curl -s https://api.nyx-app.my.id/health"
echo "  curl -s http://127.0.0.1:9090/-/ready                    # Prometheus"
echo "  curl -s 'http://127.0.0.1:9090/api/v1/targets' | grep -o '\"health\":\"[a-z]*\"' | sort | uniq -c"
echo "  curl -s http://127.0.0.1:3001/api/health                  # Grafana (:3001)"
echo
echo "Catatan KT: unit ini butuh $SELFHOST_DIR/kt/v2/ (config + kunci log)"
echo "yang dibuat sekali; lihat README §6b. Tanpa itu service sengaja gagal start."
echo "Catatan auditor: butuh kt/v2/etc/auditor.key + entri 'api.auditors' di"
echo "kt/v2/etc/config.yaml; tanpa itu nyx-kt-auditor-v2 sengaja gagal."
echo "Catatan observability: butuh prometheus/conf/prometheus.yml + alerts.yml di dalam"
echo "nyx-selfhost dan grafana/grafana.env (0600, password admin + secret key)."
echo "Catatan relay OHTTP: butuh ohttp/relay.env (OHTTP_GATEWAY_TARGET loopback) dan"
echo "OHTTP_RELAY_EXTERNAL=1 di server/.env; tanpa OHTTP_ENABLED=1 relay hanya menjawab 502."
echo "Catatan PIR: butuh pir/pir.env (PIR_ADMIN_TOKEN sama dengan server/.env,"
echo "PIR_MASTER_SECRET, PIR_SNAPSHOT_PATH sama dengan server) + snapshot dari"
echo "'pnpm --filter nyx-server run pir:snapshot'. Tanpa snapshot, /params menjawab 503."
echo "Catatan exporter: butuh biner di node-exporter/bin, postgres-exporter/bin, dan"
echo "redis-exporter/bin (paket Arch prometheus-*-exporter yang diekstrak, tanpa root),"
echo "plus postgres-exporter/postgres-exporter.env (0600) berisi DATA_SOURCE_NAME dari"
echo "DATABASE_URL aplikasi dengan sslmode=disable. Tanpa itu unit exporter gagal start."
echo "Config/aturannya disalin dari repo, bukan diedit di sini:"
echo "  install -m 644 ~/nyx-chat/ops/prometheus/{prometheus,alerts}.yml ~/nyx-selfhost/prometheus/conf/"
echo "  install -m 644 ~/nyx-chat/ops/grafana/dashboards/nyx-overview.json ~/nyx-selfhost/grafana/dashboards/"
