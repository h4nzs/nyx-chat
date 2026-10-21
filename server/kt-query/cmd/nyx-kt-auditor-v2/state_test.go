// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// State auditor menyimpan posisi verifikasi. Kalau berkasnya bisa diubah tanpa
// terdeteksi, auditor bisa dibuat "melanjutkan" dari posisi palsu — karena itu
// state ditandatangani dan tanda tangannya diperiksa saat dimuat.

package main

import (
	"crypto/mldsa"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newTestStateStore(t *testing.T) (*fileStateStore, string, *mldsa.PrivateKey) {
	t.Helper()
	privateKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci: %v", err)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	return newFileStateStore(path, privateKey), path, privateKey
}

func sampleState() *auditorState {
	return &auditorState{
		totalUpdatesProcessed: 3,
		prefixTreeRootHash:    randomBytes(32),
		logTreeNodes: []logTreeNode{
			{id: 1, hash: randomBytes(32)},
			{id: 4, hash: randomBytes(32)},
		},
	}
}

func TestStateStorePutaranPenuh(t *testing.T) {
	store, path, _ := newTestStateStore(t)
	before, err := store.load()
	if err != nil {
		t.Fatalf("load state kosong: %v", err)
	}
	if before != nil {
		t.Fatalf("state kosong mengembalikan %+v, ingin nil", before)
	}

	original := sampleState()
	if err := store.store(original); err != nil {
		t.Fatalf("store: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if permission := info.Mode().Perm(); permission != 0o600 {
		t.Fatalf("mode state = %04o, ingin 0600", permission)
	}

	loaded, err := store.load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded == nil {
		t.Fatal("state tersimpan tidak terbaca")
	}
	if loaded.totalUpdatesProcessed != original.totalUpdatesProcessed {
		t.Fatalf("totalUpdatesProcessed = %d, ingin %d", loaded.totalUpdatesProcessed, original.totalUpdatesProcessed)
	}
	if string(loaded.prefixTreeRootHash) != string(original.prefixTreeRootHash) {
		t.Fatal("root prefix tree tidak sama setelah putaran penuh")
	}
	if len(loaded.logTreeNodes) != len(original.logTreeNodes) {
		t.Fatalf("jumlah simpul = %d, ingin %d", len(loaded.logTreeNodes), len(original.logTreeNodes))
	}
	for index := range original.logTreeNodes {
		if loaded.logTreeNodes[index].id != original.logTreeNodes[index].id ||
			string(loaded.logTreeNodes[index].hash) != string(original.logTreeNodes[index].hash) {
			t.Fatalf("simpul ke-%d tidak sama setelah putaran penuh", index)
		}
	}
}

func TestStateStoreMenolakStateYangDiubah(t *testing.T) {
	store, path, _ := newTestStateStore(t)
	if err := store.store(sampleState()); err != nil {
		t.Fatalf("store: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("baca: %v", err)
	}
	var file stateFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("urai: %v", err)
	}
	// Geser posisi auditor tanpa memperbarui tanda tangan: inilah serangan yang
	// harus ditolak (auditor dipaksa "melompat" dari posisi yang belum diverifikasi).
	file.TotalUpdatesProcessed = 100
	tampered, err := json.Marshal(file)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatalf("tulis: %v", err)
	}

	if _, err := store.load(); err == nil {
		t.Fatal("state yang diubah diterima — seharusnya ditolak karena tanda tangan tidak cocok")
	}
}

func TestStateStoreMenolakStateDariKunciLain(t *testing.T) {
	store, path, _ := newTestStateStore(t)
	if err := store.store(sampleState()); err != nil {
		t.Fatalf("store: %v", err)
	}

	// Auditor baru (kunci berbeda) membaca state auditor lama: tanda tangan sah
	// tapi bukan untuk kunci ini, jadi harus ditolak.
	otherKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci lain: %v", err)
	}
	other := newFileStateStore(path, otherKey)
	if _, err := other.load(); err == nil {
		t.Fatal("state auditor lain diterima — seharusnya ditolak")
	}
}

func TestStateStoreMenolakIsiTidakLengkap(t *testing.T) {
	store, path, privateKey := newTestStateStore(t)

	write := func(payload statePayload) {
		signed, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		signature, err := signState(privateKey, signed)
		if err != nil {
			t.Fatalf("tandatangani: %v", err)
		}
		raw, err := json.Marshal(stateFile{
			statePayload: payload,
			Signature:    base64.StdEncoding.EncodeToString(signature),
		})
		if err != nil {
			t.Fatalf("marshal berkas: %v", err)
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatalf("tulis: %v", err)
		}
	}

	// Nol update tapi ada state: tidak masuk akal, ditolak.
	write(statePayload{TotalUpdatesProcessed: 0, PrefixTreeRootHash: ""})
	if _, err := store.load(); err == nil {
		t.Fatal("state dengan nol update diterima")
	}

	// Root prefix tree bukan hex / panjang salah.
	write(statePayload{TotalUpdatesProcessed: 1, PrefixTreeRootHash: "zz"})
	if _, err := store.load(); err == nil {
		t.Fatal("root prefix tree bukan hex diterima")
	}
	write(statePayload{TotalUpdatesProcessed: 1, PrefixTreeRootHash: "aabb"})
	if _, err := store.load(); err == nil {
		t.Fatal("root prefix tree 2 byte diterima")
	}
}
