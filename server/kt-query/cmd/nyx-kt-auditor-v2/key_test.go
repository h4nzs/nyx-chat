// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Pemuatan kunci auditor: berkas seed hex → kunci ML-DSA-65. Salah baca di sini
// berarti auditor menandatangani dengan kunci yang tidak terdaftar (semua tree
// head ditolak) atau, lebih buruk, kunci yang tidak sesuai harapan operator.

package main

import (
	"crypto/mldsa"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	transparency "github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
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
	seed := make([]byte, mldsa.PrivateKeySize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	expected, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), seed)
	if err != nil {
		t.Fatalf("buat kunci acuan: %v", err)
	}

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
	privateKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci: %v", err)
	}
	publicKey := privateKey.PublicKey()
	_, err = fetchPublicConfig("http://127.0.0.1:1/tidak-ada", testAuditorName, publicKey)
	if err == nil {
		t.Fatal("alamat tidak bisa dihubungi diterima")
	}
}

func TestFetchPublicConfigV2(t *testing.T) {
	logKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci log: %v", err)
	}
	auditorKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci auditor: %v", err)
	}
	otherKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci lain: %v", err)
	}

	payload := func(abi int, auditorKeys []string) string {
		raw, err := json.Marshal(map[string]any{
			"mode":            3,
			"signatureKey":    hex.EncodeToString(logKey.PublicKey().Bytes()),
			"auditorKeys":     auditorKeys,
			"valueFormat":     "nyx-kt-value-v2",
			"abiVersion":      abi,
			"searchKeyPrefix": "00",
		})
		if err != nil {
			t.Fatalf("marshal config: %v", err)
		}
		return string(raw)
	}

	serve := func(body string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(body))
		}))
	}

	t.Run("config v2 sah", func(t *testing.T) {
		server := serve(payload(2, []string{
			hex.EncodeToString(otherKey.PublicKey().Bytes()),
			hex.EncodeToString(auditorKey.PublicKey().Bytes()),
		}))
		defer server.Close()
		config, err := fetchPublicConfig(server.URL, testAuditorName, auditorKey.PublicKey())
		if err != nil {
			t.Fatalf("fetchPublicConfig: %v", err)
		}
		if config.Mode != transparency.ThirdPartyAuditing {
			t.Fatalf("mode = %d", config.Mode)
		}
		if !config.SigKey.Equal(logKey.PublicKey()) {
			t.Fatal("kunci tanda tangan log tidak sama")
		}
		if config.AuditorKeys[testAuditorName] == nil {
			t.Fatal("kunci auditor sendiri tidak terdaftar dengan nama auditor")
		}
		if len(config.AuditorKeys) != 2 {
			t.Fatalf("auditor terdaftar = %d, ingin 2", len(config.AuditorKeys))
		}
	})

	t.Run("menolak log v1", func(t *testing.T) {
		server := serve(payload(1, []string{hex.EncodeToString(auditorKey.PublicKey().Bytes())}))
		defer server.Close()
		if _, err := fetchPublicConfig(server.URL, testAuditorName, auditorKey.PublicKey()); err == nil {
			t.Fatal("config abiVersion 1 diterima")
		}
	})

	t.Run("menolak kunci auditor yang tidak terdaftar", func(t *testing.T) {
		server := serve(payload(2, []string{hex.EncodeToString(otherKey.PublicKey().Bytes())}))
		defer server.Close()
		if _, err := fetchPublicConfig(server.URL, testAuditorName, auditorKey.PublicKey()); err == nil {
			t.Fatal("kunci auditor yang tidak terdaftar diterima")
		}
	})
}
