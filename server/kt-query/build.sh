#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact admin@nyx-app.my.id.
#
# [docs/32 §32.8] Build `nyx-kt-query`.
#
# Modul ini bergantung pada `github.com/signalapp/keytransparency`, yang TIDAK
# bisa diambil dari jaringan (repo privat — `git ls-remote` menjawab "Repository
# not found"). Karena itu `go.mod` memuat directive `replace` ke checkout lokal
# yang di-pin; skrip ini menyetel ulang path-nya bila checkout berada di tempat
# lain, lalu mengembalikan `go.mod` ke nilai semula.
#
# Pemakaian:
#   server/kt-query/build.sh                     # checkout default (~/signal/…)
#   NYX_KT_UPSTREAM=/path/ke/key-transparency-server server/kt-query/build.sh
#   server/kt-query/build.sh test                # jalankan go test
#
# Pin commit upstream: docs/32 §32.1 (`30b7a2a40604`).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

DEFAULT_UPSTREAM="$(cd "$here/../../.." && pwd)/signal/key-transparency-server"
UPSTREAM="${NYX_KT_UPSTREAM:-$DEFAULT_UPSTREAM}"
OUT="${NYX_KT_BINARY:-$here/nyx-kt-query}"

if [[ ! -f "$UPSTREAM/go.mod" ]]; then
  echo "checkout upstream tidak ditemukan di $UPSTREAM" >&2
  echo "clone lalu checkout commit yang di-pin (docs/32 §32.1), atau set NYX_KT_UPSTREAM" >&2
  exit 1
fi

original_replace="$(grep '^replace github.com/signalapp/keytransparency' go.mod || true)"
restore_replace() {
  [[ -n "$original_replace" ]] || return 0
  go mod edit -replace "github.com/signalapp/keytransparency=${original_replace##*=> }"
}

# go.mod yang di-commit menunjuk checkout default; sesuaikan bila diminta.
trap restore_replace EXIT
go mod edit -replace "github.com/signalapp/keytransparency=$UPSTREAM"

export GOFLAGS="${GOFLAGS:--mod=mod}"

if [[ "${1:-build}" == "test" ]]; then
  shift || true
  go vet ./...
  go test ./... "$@"
  exit 0
fi

go build -o "$OUT" .
echo "dibangun: $OUT"
