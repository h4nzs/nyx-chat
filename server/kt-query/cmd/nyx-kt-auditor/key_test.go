// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Pemuatan kunci auditor: berkas seed hex → kunci ed25519. Salah baca di sini
// berarti auditor menandatangani dengan kunci yang tidak terdaftar (semua tree
// head ditolak) atau, lebih buruk, kunci yang tidak sesuai harapan operator.

package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeKeyFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auditor.key")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("tulis kunci: %v", err)
	}
	return path
}

func TestLoadAuditorKey(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	expected := ed25519.NewKeyFromSeed(seed)

	t.Run("hex dengan baris baru", func(t *testing.T) {
		path := writeKeyFile(t, hex.EncodeToString(seed)+"\n")
		key, err := loadAuditorKey(path)
		if err != nil {
			t.Fatalf("loadAuditorKey: %v", err)
		}
		if !key.Equal(expected) {
			t.Fatal("kunci yang dimuat berbeda dari seed")
		}
	})

	t.Run("dengan prefiks 0x", func(t *testing.T) {
		path := writeKeyFile(t, "0x"+hex.EncodeToString(seed))
		key, err := loadAuditorKey(path)
		if err != nil {
			t.Fatalf("loadAuditorKey: %v", err)
		}
		if !key.Equal(expected) {
			t.Fatal("kunci dengan prefiks 0x berbeda dari seed")
		}
	})

	t.Run("bukan hex", func(t *testing.T) {
		path := writeKeyFile(t, strings.Repeat("z", 64))
		if _, err := loadAuditorKey(path); err == nil {
			t.Fatal("kunci bukan hex diterima")
		}
	})

	t.Run("panjang salah", func(t *testing.T) {
		path := writeKeyFile(t, hex.EncodeToString(seed[:16]))
		if _, err := loadAuditorKey(path); err == nil {
			t.Fatal("seed 16 byte diterima")
		}
	})

	t.Run("berkas tidak ada", func(t *testing.T) {
		if _, err := loadAuditorKey(filepath.Join(t.TempDir(), "tidak-ada")); err == nil {
			t.Fatal("berkas tidak ada diterima")
		}
	})
}

func TestFetchPublicConfigMenolakModeBukanTiga(t *testing.T) {
	// Endpoint /config diuji dengan server HTTP tiruan: yang penting di sini
	// adalah penolakan mode, karena menjalankan auditor pada mode 1 membuat
	// `SetAuditorHead` selalu ditolak layanan (percuma, dan menyesatkan operator).
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("buat kunci: %v", err)
	}
	_, err = fetchPublicConfig("http://127.0.0.1:1/tidak-ada", testAuditorName, publicKey)
	if err == nil {
		t.Fatal("alamat tidak bisa dihubungi diterima")
	}
}
