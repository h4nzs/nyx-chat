// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Package main mengimplementasikan `nyx-kt-query`: layanan Key Transparency NYX
// (baca **dan** tulis) di atas paket pohon upstream yang di-pin.
//
// ## Kenapa layanan ini ada (dua temuan, keduanya dari pengujian)
//
// **Temuan 1 — query service upstream tidak bisa melayani nilai log NYX.**
// `aciSearch()` wajib punya entri `'a'||aci` dan membandingkan
// `aci_identity_key` dengan nilainya; log NYX tidak punya entri ACI, sehingga
// setiap pencarian NYX dijawab `permission denied`. Lebih jauh,
// `usernameHashSearch()` menolak nilai apa pun yang bukan `0x00||aci16` — dan
// bukan hanya tidak menjawab, tapi mengembalikan error internal yang
// **menggagalkan seluruh SearchV2** (docs/32 §32.8):
//
//	== A) SEARCH tanpa entri ACI di log (kondisi log NYX) ==
//	search permission denied
//	== B) SEARCH dengan nilai format Signal 0x00||aci16 ==
//	ACI search response:            Value: 1111…(identity key)
//	Username hash search response:  Value: 1111…(aci16)
//	== C) tulis nilai format NYX (1286 B) ke search key yang sama ==
//	NYX entry written: {"treeSize":"4","vrfProofLength":80,"hasUpdateProof":true}
//	== D) SEARCH setelah nilai format NYX ==
//	search request: rpc error: code = Unavailable desc = unexpected error
//
// **Temuan 2 — LevelDB tidak bisa dibagi dua proses.** Rencana awal adalah
// membuka basis data yang sama secara *read-only* di samping `kt-server`, tetapi
// `storage.newFileLock(path, readOnly=true)` mengambil `LOCK_SH` di level OS,
// sedangkan penulis memegang `LOCK_EX`. goleveldb hanya melepas kunci
// *in-process*-nya saat read-only, bukan flock-nya. Terbukti:
//
//	store_test.go: buka read-only di samping penulis: resource temporarily unavailable
//
// Konsekuensinya: **satu proses harus memiliki basis data**. Modul ini yang
// memilikinya — ia menyajikan tiga hal sekaligus:
//
//  1. sisi baca NYX (`/search`, `/distinguished`, `/monitor`, `/config`) —
//     semantik NYX: search key `0x75||usernameHash(32)`, nilai NYX v2 apa adanya;
//  2. test-update gRPC yang **kompatibel dengan penulis NYX yang sudah ada**
//     (`server/src/utils/keyTransparency.ts` → `KT_SERVER_URL` tidak berubah);
//  3. loop kunci `distinguished` (timestamp Unix), seperti peran yang dipegang
//     `kt-server` sebelumnya.
//
// Yang TIDAK diubah dari v2: nilai log (docs/32 §32.2, frozen), protokol/bentuk
// bukti (protobuf upstream), dan struktur pohon/commitment. Yang berbeda hanya
// autentikasi tree head (ML-DSA-65, bukan Ed25519) dan indeks (SHA-256, bukan
// VRF) — keduanya berasal dari paket `v2/transparency`, bukan dari modul ini.
package main

import (
	"fmt"

	"github.com/signalapp/keytransparency/db"
)

// openStore membuka basis data transparansi **secara eksklusif** memakai store
// upstream apa adanya (`leveldb.OpenFile(file, nil)` + pemulihan bila korup).
//
// Karena modul ini pemilik tunggal, tidak ada lagi TTL/buka-ulang: `Tree()`
// membangun pohon segar dari store yang sama setiap permintaan, jadi tree head
// yang disajikan selalu head terbaru yang baru saja ditulis.
func openStore(file string) (db.TransparencyStore, error) {
	store, err := db.NewLDBTransparencyStore(file)
	if err != nil {
		return nil, fmt.Errorf("buka basis data KT %s: %w", file, err)
	}
	return store, nil
}
