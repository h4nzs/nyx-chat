// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"bytes"
	"path/filepath"
	"testing"

	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"
	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/opt"
)

// Tes ini **menjaga keputusan arsitektur**, bukan menguji kode kita: goleveldb
// mengambil `LOCK_SH` saat dibuka read-only (`storage.newFileLock`) sedangkan
// penulis memegang `LOCK_EX`, jadi dua proses tidak bisa berbagi basis data.
// Kalau suatu saat pustaka itu melonggarkan aturannya, tes ini gagal dan
// keputusan "satu proses memiliki basis data" bisa ditinjau ulang.
//
// (goleveldb melepas kunci *in-process*-nya saat read-only — `fileStorage.Lock()`
// mengembalikan kunci no-op — tapi itu tidak berlaku untuk flock di level OS.)
func TestLevelDBTidakBisaDibagiDuaProses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")

	writer, err := db.NewLDBTransparencyStore(path)
	if err != nil {
		t.Fatalf("buka store penulis: %v", err)
	}
	defer func() {
		if closer, ok := writer.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	}()

	// Handle kedua, read-only, di samping penulis: harus DITOLAK.
	reader, err := leveldb.OpenFile(path, &opt.Options{ReadOnly: true})
	if err == nil {
		reader.Close()
		t.Fatal("read-only dibuka bersamaan penulis — asumsi kepemilikan tunggal berubah")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("resource temporarily unavailable")) {
		t.Fatalf("error tidak seperti yang diharapkan: %v", err)
	}
}

func TestStoreEksklusifTulisBacaBolakBalik(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	config := testPrivateConfig(t)

	store, err := openStore(path)
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}

	hash := usernameHash(0x5a)
	expectedValue := nyxLogValue(1, 0x11)

	tree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}
	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            nyxSearchKey(hash),
		Value:                expectedValue,
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri NYX: %v", err)
	}

	// Pohon baru di atas store yang sama harus melihat head terbaru — inilah
	// yang membuat layanan baca selalu segar tanpa buka-ulang LevelDB.
	freshTree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon kedua: %v", err)
	}
	head := freshTree.GetTransparencyTreeHead()
	if head.TreeSize == 0 {
		t.Fatal("tree head tidak maju setelah tulis")
	}
	response, err := freshTree.Search(&tpb.TreeSearchRequest{
		SearchKey:   nyxSearchKey(hash),
		Consistency: &tpb.Consistency{},
	})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if !bytes.Equal(response.Value.Value, expectedValue) {
		t.Fatal("nilai yang dibaca bukan nilai yang ditulis")
	}
}

// Catatan: store upstream (`db.NewLDBTransparencyStore`) tidak mengekspos `Close`,
// jadi "buka, tulis, tutup, buka lagi" tidak bisa diuji di dalam satu proses
// (handle pertama masih memegang flock — lihat tes di atas). Persistensi antar
// restart diverifikasi di jalur hidup: `-check` pada basis data yang sudah diisi
// harus melaporkan `treeSize` yang sama (lihat README §Verifikasi).
