#!/usr/bin/env bash
# Copyright (c) 2026 [han]. All rights reserved.
# This file is part of NYX, licensed under the AGPL-3.0.
# For commercial licensing, contact admin@nyx-app.my.id.
#
# [docs/32 §32.8 · docs/35 §35.7] Build layanan log Key Transparency NYX.
#
# Sejak 2026-10-28 hanya **log v2** (ML-DSA-65) yang dibangun: layanan v1
# (`nyx-kt-query`), auditor v1, dan pemeriksa `nyx-kt-check` dihapus bersama
# pensiunnya jalur v1 (`docs/38`). Yang tersisa justru yang berjalan di
# produksi: log v2, auditor v2, alat bootstrap sekali pakai, dan verifier
# eksternal `nyx-kt-v2-check` (pengganti `nyx-kt-check`, dipakai drill pemulihan
# `scripts/kt-v2-restore-drill.sh` — bukan layanan).
#
# Modul ini bergantung pada `github.com/signalapp/keytransparency`, yang TIDAK
# bisa diambil dari jaringan (repo privat — `git ls-remote` menjawab "Repository
# not found"). Karena itu paket itu **ter-vendor penuh** di
# `server/kt-query/vendor/` (dihasilkan `go mod vendor` dari checkout upstream
# pada commit pin, docs/32 §32.1: `30b7a2a40604`), dan `go.mod` **tidak** punya
# directive `replace`. Build default karenanya jalan offline, tanpa checkout di
# luar repo.
#
# Pemakaian:
#   server/kt-query/build.sh                     # build vendored (-mod=vendor)
#   server/kt-query/build.sh test [args go test] # go vet + go test
#   NYX_KT_UPSTREAM=/path/ke/key-transparency-server server/kt-query/build.sh
#       # mode "kejar pin": pakai checkout lokal (butuh jaringan untuk dep lain),
#       # hanya untuk mencoba pin baru SEBELUM `go mod vendor` + commit.
#
# Pin commit upstream: docs/32 §32.1 (`30b7a2a40604`).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Layanan log v2 (ML-DSA + indeks SHA-256, docs/35 §35.7).
V2_OUT="${NYX_KT_V2_BINARY:-$here/nyx-kt-query-v2}"
# Auditor v2: proses terpisah dengan kunci/state/port ML-DSA sendiri.
V2_AUDITOR_OUT="${NYX_KT_V2_AUDITOR_BINARY:-$here/nyx-kt-auditor-v2}"
# Bootstrap pemasangan pertama v2 (kunci + config). Bukan layanan; hanya alat
# satu kali yang dipanggil deploy bila config belum ada.
V2_INIT_OUT="${NYX_KT_V2_INIT_BINARY:-$here/nyx-kt-v2-init}"
# Verifier eksternal (pengganti `nyx-kt-check` v1). Dipakai drill pemulihan:
# `scripts/kt-v2-restore-drill.sh` menaruhnya di `$WORK/bin` lewat variabel ini.
V2_CHECK_OUT="${NYX_KT_V2_CHECK_BINARY:-$here/nyx-kt-v2-check}"
UPSTREAM="${NYX_KT_UPSTREAM:-}"

if [[ -n "$UPSTREAM" ]]; then
  # Mode kejar pin: go.mod diberi `replace` sementara, lalu dikembalikan.
  if [[ ! -f "$UPSTREAM/go.mod" ]]; then
    echo "❌ checkout upstream tidak ditemukan di $UPSTREAM" >&2
    echo "   clone lalu checkout commit yang di-pin (docs/32 §32.1)." >&2
    exit 1
  fi
  original_replace="$(grep '^replace github.com/signalapp/keytransparency' go.mod || true)"
  restore_replace() {
    [[ -n "$original_replace" ]] || return 0
    go mod edit -replace "github.com/signalapp/keytransparency=${original_replace##*=> }"
  }
  trap restore_replace EXIT
  go mod edit -replace "github.com/signalapp/keytransparency=$UPSTREAM"
  export GOFLAGS="${GOFLAGS:--mod=mod}"
  echo "ℹ️  mode kejar pin: memakai checkout $UPSTREAM (vendor/ diabaikan)"
else
  if [[ ! -d vendor ]]; then
    echo "❌ vendor/ tidak ada — jalankan 'go mod vendor' terhadap checkout upstream" >&2
    echo "   pada commit pin (docs/32 §32.1), lalu commit hasilnya." >&2
    exit 1
  fi
  export GOFLAGS="${GOFLAGS:--mod=vendor}"
fi

if [[ "${1:-build}" == "test" ]]; then
  shift || true
  go vet ./...
  go test ./... "$@"
  exit 0
fi

go build -o "$V2_OUT" ./cmd/nyx-kt-query-v2
go build -o "$V2_AUDITOR_OUT" ./cmd/nyx-kt-auditor-v2
go build -o "$V2_INIT_OUT" ./cmd/nyx-kt-v2-init
go build -o "$V2_CHECK_OUT" ./cmd/nyx-kt-v2-check
echo "dibangun: $V2_OUT"
echo "dibangun: $V2_AUDITOR_OUT"
echo "dibangun: $V2_INIT_OUT"
echo "dibangun: $V2_CHECK_OUT"
