#!/usr/bin/env bash
# Verifikasi pasca-reboot untuk nyx-selfhost (level user, tanpa root).
#
# Tujuan: satu perintah yang menjawab "apakah SEMUA layanan NYX menyala kembali
# sendiri setelah perangkat boot?". Jalankan setelah reboot:
#
#   $SELFHOST_DIR/verify-boot.sh
#
# Keluar dengan kode 0 hanya bila semua pemeriksaan lulus. Skrip ini TIDAK
# mengubah apa pun (read-only: systemctl show/is-active, ss, curl).
set -uo pipefail

# Pemilik unit user = pemanggil skrip (tidak bergantung pada env $USER, yang
# tidak selalu ada bila skrip dijalankan dari konteks non-interaktif).
TARGET_USER="$(id -un)"

USER_UNITS="nyx-api nyx-sidecar nyx-nginx nyx-kt-query-v2 nyx-kt-auditor-v2 nyx-prometheus nyx-grafana nyx-alertmanager nyx-ntfy-relay nyx-node-exporter nyx-postgres-exporter nyx-redis-exporter nyx-ohttp-relay nyx-pir-sidecar"
SYSTEM_UNITS="postgresql valkey cloudflared"
# KT v1 (`nyx-kt-query`, `nyx-kt-auditor`, port 8081/8082/8085 + exporter
# 9466/9467) pensiun 2026-10-28 (docs/38): daftar ini hanya memuat v2.
# 9465 = exporter sidecar, 9468 = log KT v2, 9469 = auditor v2; 4100 = relay
# OHTTP, 9470 = sidecar PIR; 8087/8088/8089 = KT v2 auditor/tulis/baca.
TCP_PORTS="3000 4000 4100 9470 8087 8088 8089 9090 9093 9464 9465 9468 9469 3001 9100 9121 9187"
FAILED=0

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mGAGAL\033[0m %s\n' "$1"; FAILED=1; }
hdr()  { printf '\n== %s ==\n' "$1"; }

hdr "1. Manajer user hidup tanpa sesi login (linger)"
if [ "$(loginctl show-user "$TARGET_USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  ok "linger aktif untuk $TARGET_USER — unit user ikut menyala saat boot tanpa perlu login"
else
  bad "linger TIDAK aktif → perbaiki: loginctl enable-linger $TARGET_USER"
fi

hdr "2. Unit system (prasyarat)"
for u in $SYSTEM_UNITS; do
  if systemctl is-enabled "$u" >/dev/null 2>&1; then
    systemctl is-active "$u" >/dev/null 2>&1 && ok "$u enabled + running" || bad "$u enabled tapi TIDAK running"
  else
    bad "$u tidak enabled"
  fi
done

hdr "3. Unit user NYX (enabled + active)"
for u in $USER_UNITS; do
  en=$(systemctl --user is-enabled "$u" 2>&1)
  ac=$(systemctl --user is-active "$u" 2>&1)
  if [ "$en" = "enabled" ] && [ "$ac" = "active" ]; then
    ok "$u (enabled, active)"
  else
    bad "$u (enabled=$en, active=$ac)"
  fi
done
if [[ -f "$HOME/.config/nyx-backup/age.pub" ]]; then
  en=$(systemctl --user is-enabled nyx-backup.timer 2>&1)
  ac=$(systemctl --user is-active nyx-backup.timer 2>&1)
  if [ "$en" = "enabled" ] && [ "$ac" = "active" ]; then
    ok "nyx-backup.timer (enabled, active)"
  else
    bad "nyx-backup.timer (enabled=$en, active=$ac)"
  fi
fi

hdr "4. Port loopback hidup"
for p in $TCP_PORTS; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then
    ok "tcp/$p mendengarkan"
  else
    bad "tcp/$p TIDAK mendengarkan"
  fi
done
if ss -lun 2>/dev/null | grep -q ':33333 '; then
  ok "udp/33333 (WebTransport sidecar) mendengarkan"
else
  bad "udp/33333 TIDAK mendengarkan"
fi

hdr "5. Health endpoint"
check_http() { # $1=nama $2=url
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$2" 2>/dev/null)
  [ "$code" = "200" ] && ok "$1 → 200" || bad "$1 → ${code:-tanpa respons} ($2)"
}
check_http "nyx-api /health"        "http://127.0.0.1:4000/health"
check_http "nginx :3000 (frontend)" "http://127.0.0.1:3000/"
check_http "ohttp-relay /healthz"   "http://127.0.0.1:4100/healthz"
check_http "pir-sidecar /health"    "http://127.0.0.1:9470/health"
check_http "prometheus /-/ready"    "http://127.0.0.1:9090/-/ready"
check_http "grafana /api/health"    "http://127.0.0.1:3001/api/health"

hdr "6. Eksporter metrik (NYX + host/Postgres/Valkey)"
for m in "9464 nyx-api" "9465 nyx-sidecar" "9468 nyx-kt-query-v2" "9469 nyx-kt-auditor-v2" "9100 node" "9187 postgres" "9121 redis"; do
  port=${m%% *}; name=${m##* }
  n=$(curl -s --max-time 5 "http://127.0.0.1:$port/metrics" 2>/dev/null | grep -c '^# TYPE')
  [ "${n:-0}" -gt 0 ] && ok "$name: $n keluarga metrik" || bad "$name: exporter tidak menjawab"
done

hdr "7. Prometheus men-scrape semua target"
down=$(curl -s --max-time 5 http://127.0.0.1:9090/api/v1/targets 2>/dev/null \
  | grep -o '"health":"[a-z]*"' | grep -c 'down' || true)
up=$(curl -s --max-time 5 http://127.0.0.1:9090/api/v1/targets 2>/dev/null \
  | grep -o '"health":"up"' | grep -c up || true)
if [ "${down:-1}" -eq 0 ] && [ "${up:-0}" -ge 5 ]; then
  ok "$up target up, 0 down"
else
  bad "target Prometheus: $up up, $down down (curl http://127.0.0.1:9090/api/v1/targets)"
fi

hdr "8. Log KT v2 jalan lagi (auditor memberi putaran baru)"
rounds=$(curl -s --max-time 5 http://127.0.0.1:9469/metrics 2>/dev/null | awk -F' ' '/^nyx_kt_auditor_rounds_total/{sum+=$2} END{print sum+0}')
tree=$(ss -ltn 2>/dev/null | grep -q ':8089 ' && echo ya || echo tidak)
[ "$rounds" -gt 0 ] && ok "auditor v2: $rounds putaran sejak nyala" || bad "auditor v2 belum menyelesaikan putaran"
[ "$tree" = "ya" ] && ok "log KT v2 (baca :8089) siap" || bad "log KT v2 (:8089) tidak mendengarkan"

printf '\n%s\n' "------------------------------------------------------------------"
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mSEMUA LULUS\033[0m — seluruh layanan NYX menyala kembali setelah boot.\n'
else
  printf '\033[31mADA YANG GAGAL\033[0m — lihat baris bertanda GAGAL di atas, lalu:\n'
  printf '  systemctl --user status <unit>   # atau: journalctl --user -u <unit> -n 50\n'
fi
printf '%s\n' "------------------------------------------------------------------"
exit "$FAILED"
