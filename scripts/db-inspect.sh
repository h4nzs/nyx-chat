#!/bin/bash
# Read-only psql helper ke DB lokal NYX (kredensial tidak di-echo).
# Pemakaian: bash scripts/db-inspect.sh "SELECT ..."
DB_URL=$(grep -m1 '^DATABASE_URL' "$(dirname "$0")/../server/.env" | cut -d= -f2- | tr -d '"')
export PGUSER=$(echo "$DB_URL" | sed -E 's|.*://([^:]+):.*|\1|')
export PGPASSWORD=$(echo "$DB_URL" | sed -E 's|.*://[^:]+:(.*)@[^@]*$|\1|')
export PGHOST=$(echo "$DB_URL" | sed -E 's|.*@([^:/]+):.*|\1|')
export PGPORT=$(echo "$DB_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
export PGDATABASE=$(echo "$DB_URL" | sed -E 's|.*/([a-zA-Z_0-9]+)\?.*|\1|')
export PGSSLMODE=disable
exec psql -v ON_ERROR_STOP=1 "$@"
