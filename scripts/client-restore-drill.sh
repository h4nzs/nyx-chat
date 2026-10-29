#!/usr/bin/env bash
# Drill pemulihan KLIEN: restore `.nyxbak` terhadap dump Postgres NYATA
# (docs/39 §39.6, baris "Restore klien dari `.nyxbak`").
#
# Kenapa drill ini ada: unit test `backupRestore.test.ts` memakai store palsu dan
# backend kripto palsu, jadi ia membuktikan logika pemetaan — bukan bahwa arsip
# dari klien nyata bisa dipulihkan di atas data yang berasal dari dump nyata.
# Drill ini menutup jarak itu: dump diambil dengan cara yang sama seperti backup
# harian (`pg_dump -Fc`), direstore ke klaster sementara, lalu baris klien
# dibangun dari hasil restore itu dan diputar lewat jalur produksi
# (KDF argon2id + XChaCha20-Poly1305 + Dexie/IndexedDB nyata).
#
# Tidak menyentuh database hidup: klaster `initdb` sendiri di /tmp, port
# sendiri, dihapus di akhir (trap, juga saat gagal).
#
#   bash scripts/client-restore-drill.sh
#   NYX_CLIENT_DRILL_DIR=/tmp/x NYX_CLIENT_DRILL_PORT=15433 bash scripts/...
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${NYX_CLIENT_DRILL_DIR:-/tmp/nyx-client-restore-drill}"
# Bukan `PORT`: `server/.env` mendefinisikan `PORT=4000` (API hidup), dan skrip
# ini membaca .env. Dulu nama yang sama membuat postgres drill mencoba mengikat
# port 4000 → "could not create listen socket". Drill menemukannya sendiri.
DRILL_PORT="${NYX_CLIENT_DRILL_PORT:-15433}"
TSX="$ROOT/web/node_modules/.bin/tsx"
# Bisa ditimpa untuk MEMBUKTIKAN harness-nya tidak buta: jalankan dengan salinan
# skrip yang sengaja dirusak (mis. ciphertext digeser 1 karakter) dan pastikan
# drill jadi merah. Bukti "lulus" tanpa kontrol negatif tidak berarti apa-apa
# (pelajaran dari drill KT v2, docs/39 §39.6).
DRILL_TS="${NYX_CLIENT_DRILL_TS:-$ROOT/web/scripts/client-restore-drill.ts}"

FAILED=0
ok()  { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mGAGAL\033[0m %s\n' "$1"; FAILED=1; }
hdr() { printf '\n== %s ==\n' "$1"; }

CLUSTER_STARTED=0
cleanup() {
  if [ "$CLUSTER_STARTED" = "1" ]; then
    pg_ctl -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true
  fi
  # Klaster berisi data produksi (hasil dump) — jangan ditinggal.
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

hdr "1. Perkakas"
missing=0
for tool in initdb pg_ctl psql pg_dump createdb pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || { bad "$tool tidak ada di PATH"; missing=1; }
done
[ -x "$TSX" ] || { bad "tsx tidak ada di $TSX (jalankan pnpm install di web)"; missing=1; }
[ -f "$DRILL_TS" ] || { bad "skrip drill hilang: $DRILL_TS"; missing=1; }
[ -f "$ROOT/server/.env" ] || { bad "server/.env tidak ada — butuh DATABASE_URL sumber" ; missing=1; }
[ "$missing" -eq 0 ] && ok "semua perkakas tersedia"
[ "$FAILED" -eq 0 ] || exit 1

# ---------------------------------------------------------------- 2. dump
hdr "2. Dump dari database sumber (cara yang sama dengan backup harian)"
# Subshell: env `server/.env` (63 variabel, termasuk PORT/NODE_ENV) tidak boleh
# bocor ke sisa skrip dan ke proses postgres drill.
SRC_URL="$(cd "$ROOT/server" && set -a && . ./.env && printf '%s' "${DATABASE_URL%%\?*}")"
[ -n "$SRC_URL" ] || { echo "GAGAL: DATABASE_URL kosong di server/.env"; exit 1; }

rm -rf "$WORK" && mkdir -p "$WORK"
src_counts=$(psql "$SRC_URL" -At -c \
  'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Conversation"), (SELECT count(*) FROM "Message"), (SELECT count(*) FROM "Device");')
[ -n "$src_counts" ] || { echo "GAGAL: tidak bisa membaca database sumber"; exit 1; }
t0=$(date +%s%N)
pg_dump "$SRC_URL" -Fc -f "$WORK/prod.dump" 2>"$WORK/dump.err" || { bad "pg_dump gagal: $(cat "$WORK/dump.err")"; exit 1; }
ok "pg_dump $(du -h "$WORK/prod.dump" | cut -f1) dalam $(( ($(date +%s%N) - t0) / 1000000 )) ms — sumber: $src_counts (users|conversations|messages|devices)"

# ---------------------------------------------------------------- 3. klaster
hdr "3. Klaster sementara (initdb, bukan database hidup)"
initdb -D "$WORK/data" -U drill --auth=trust --no-instructions >"$WORK/initdb.log" 2>&1 \
  || { bad "initdb gagal: $(tail -3 "$WORK/initdb.log")"; exit 1; }
pg_ctl -D "$WORK/data" -l "$WORK/pg.log" \
  -o "-p $DRILL_PORT -k $WORK -c listen_addresses=127.0.0.1" start >"$WORK/pgctl.log" 2>&1
if [ $? -eq 0 ]; then CLUSTER_STARTED=1; ok "klaster hidup di 127.0.0.1:$DRILL_PORT ($(postgres --version 2>/dev/null || echo postgres))"; else
  bad "klaster gagal start: $(tail -3 "$WORK/pg.log")"; exit 1
fi

# ---------------------------------------------------------------- 4. restore
hdr "4. pg_restore ke database baru"
createdb -h 127.0.0.1 -p "$DRILL_PORT" -U drill nyx_client_restore_drill || { bad "createdb gagal"; exit 1; }
t0=$(date +%s%N)
if pg_restore --no-owner --no-privileges -h 127.0.0.1 -p "$DRILL_PORT" -U drill \
     -d nyx_client_restore_drill "$WORK/prod.dump" >"$WORK/restore.log" 2>&1; then
  ok "pg_restore exit 0 dalam $(( ($(date +%s%N) - t0) / 1000000 )) ms"
else
  bad "pg_restore gagal: $(tail -5 "$WORK/restore.log")"; exit 1
fi
DRILL_URL="postgres://drill@127.0.0.1:$DRILL_PORT/nyx_client_restore_drill"

# ---------------------------------------------------------------- 5. isi
hdr "5. Isi hasil restore (bukan sekadar exit 0)"
drl_tables=$(psql "$DRILL_URL" -At -c \
  'SELECT count(*) FROM information_schema.tables WHERE table_schema = $$public$$ AND table_type = $$BASE TABLE$$;')
src_tables=$(psql "$SRC_URL" -At -c \
  'SELECT count(*) FROM information_schema.tables WHERE table_schema = $$public$$ AND table_type = $$BASE TABLE$$;')
[ "$drl_tables" = "$src_tables" ] && ok "tabel: $drl_tables (sumber $src_tables)" || bad "tabel: $drl_tables ≠ sumber $src_tables"
drl_counts=$(psql "$DRILL_URL" -At -c \
  'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Conversation"), (SELECT count(*) FROM "Message"), (SELECT count(*) FROM "Device");')
[ "$drl_counts" = "$src_counts" ] && ok "baris identik dengan sumber: $drl_counts" || bad "baris beda: $drl_counts ≠ sumber $src_counts"

# ---------------------------------------------------------------- 6. fixture
hdr "6. Fixture klien dari dump hasil restore"
psql "$DRILL_URL" -Atq -o "$WORK/fixture.json" <<'SQL'
SELECT json_build_object(
  'conversations', (
    SELECT coalesce(json_agg(row_to_json(c)), '[]'::json) FROM (
      SELECT id, "isGroup", "encryptedMetadata", "lastMessageAt", "createdAt" FROM "Conversation"
    ) c),
  'messages', (
    SELECT coalesce(json_agg(row_to_json(m)), '[]'::json) FROM (
      SELECT id, "conversationId", "senderId", content, seq, type::text AS type, "createdAt"
      FROM "Message" ORDER BY "createdAt"
    ) m),
  'devices', (
    SELECT coalesce(json_agg(row_to_json(d)), '[]'::json) FROM (
      SELECT id, "userId",
             encode("publicKey", 'base64')  AS "publicKeyB64",
             CASE WHEN "pqPublicKey" IS NULL THEN NULL ELSE encode("pqPublicKey", 'base64') END AS "pqPublicKeyB64",
             encode("signingKey", 'base64') AS "signingKeyB64",
             CASE WHEN "signingKeyV2" IS NULL THEN NULL ELSE encode("signingKeyV2", 'base64') END AS "signingKeyV2B64",
             CASE WHEN "encryptedPrivateKey" IS NULL THEN NULL ELSE encode("encryptedPrivateKey", 'base64') END AS "encryptedPrivateKeyB64",
             "cryptoVersion"
      FROM "Device"
    ) d)
);
SQL
[ -s "$WORK/fixture.json" ] && ok "fixture $(du -h "$WORK/fixture.json" | cut -f1) diekspor" || { bad "fixture kosong"; exit 1; }

# ---------------------------------------------------------------- 7. klien
hdr "7. Ekspor .nyxbak → wipe → restore (jalur produksi)"
if "$TSX" "$DRILL_TS" "$WORK/fixture.json"; then
  ok "drill klien lulus"
else
  bad "drill klien gagal (lihat keluaran di atas)"
fi

# ---------------------------------------------------------------- 8. ringkas
hdr "8. Ringkasan"
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mSEMUA LULUS\033[0m — dump direstore, .nyxbak dipulihkan, id/ciphertext cocok.\n'
  printf 'Klaster sementara dihapus (trap).\n'
else
  printf '\033[31mADA YANG GAGAL\033[0m — klaster mungkin masih ada di %s.\n' "$WORK"
fi
exit "$FAILED"
