// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

package main

import (
	"crypto/mldsa"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"

	"gopkg.in/yaml.v2"
)

// fileConfig memuat hanya bagian config kt-server yang dibutuhkan layanan baca.
// Config yang sama dipakai penulis (`kt-server -config ...`), jadi operator
// hanya punya satu berkas: kalau kunci log berbeda, pohon tidak akan terbaca dan
// layanan menolak start (bukannya menyajikan bukti yang tidak bisa diverifikasi).
//
// v2 tidak punya `vrf-key`: indeks adalah SHA-256 publik (docs/35 §35.7), jadi
// field itu tidak lagi dibaca — config v1 yang masih memuatnya tetap dapat
// dipakai karena YAML mengabaikan field yang tidak dikenal.
type fileConfig struct {
	API struct {
		SigningKey string            `yaml:"signing-key"`
		PrefixKey  string            `yaml:"prefix-key"`
		OpeningKey string            `yaml:"opening-key"`
		Auditors   map[string]string `yaml:"auditors"`
		// Interval kunci `distinguished` (mis. "1m"). Layanan ini yang
		// memeliharanya, jadi nilainya dibaca dari config yang sama.
		Distinguished time.Duration `yaml:"distinguished"`
	} `yaml:"api"`
	DB struct {
		File string `yaml:"file"`
	} `yaml:"db"`
}

// expandEnv meniru `envstr` upstream: nilai YAML boleh berisi `$VAR`/`${VAR}`.
func expandEnv(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return trimmed
	}
	return os.ExpandEnv(trimmed)
}

func decodeHexKey(value string, size int, name string) ([]byte, error) {
	raw, err := hex.DecodeString(expandEnv(value))
	if err != nil {
		return nil, fmt.Errorf("%s bukan hex: %w", name, err)
	}
	if size > 0 && len(raw) != size {
		return nil, fmt.Errorf("%s panjangnya salah: ingin=%d dapat=%d", name, size, len(raw))
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("%s kosong", name)
	}
	return raw, nil
}

// loadConfig membaca config kt-server dan menurunkan `PrivateConfig` pohon.
// Aturan mode tetap sama: auditor terkonfigurasi → ThirdPartyAuditing. Bedanya
// hanya primitif: ML-DSA-65 (seed 32 byte) menggantikan Ed25519, dan kunci
// auditor adalah encoding ML-DSA-65 (1952 byte), bukan Ed25519 (32 byte).
func loadConfig(path string) (*transparency.PrivateConfig, *fileConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("baca config %s: %w", path, err)
	}
	var parsed fileConfig
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return nil, nil, fmt.Errorf("urai config %s: %w", path, err)
	}

	seed, err := decodeHexKey(parsed.API.SigningKey, mldsa.PrivateKeySize, "api.signing-key")
	if err != nil {
		return nil, nil, err
	}
	sigKey, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), seed)
	if err != nil {
		return nil, nil, fmt.Errorf("api.signing-key tidak sah: %w", err)
	}
	prefixKey, err := decodeHexKey(parsed.API.PrefixKey, 32, "api.prefix-key")
	if err != nil {
		return nil, nil, err
	}
	openingKey, err := decodeHexKey(parsed.API.OpeningKey, 32, "api.opening-key")
	if err != nil {
		return nil, nil, err
	}

	auditorKeys := make(map[string]*mldsa.PublicKey, len(parsed.API.Auditors))
	for name, value := range parsed.API.Auditors {
		raw, err := hex.DecodeString(expandEnv(value))
		if err != nil {
			return nil, nil, fmt.Errorf("auditor %s bukan hex: %w", name, err)
		}
		if len(raw) != mldsa.MLDSA65PublicKeySize {
			return nil, nil, fmt.Errorf("auditor %s panjang kunci salah: %d", name, len(raw))
		}
		key, err := mldsa.NewPublicKey(mldsa.MLDSA65(), raw)
		if err != nil {
			return nil, nil, fmt.Errorf("auditor %s tidak sah: %w", name, err)
		}
		auditorKeys[name] = key
	}

	mode := transparency.ContactMonitoring
	if len(auditorKeys) > 0 {
		mode = transparency.ThirdPartyAuditing
	}

	return &transparency.PrivateConfig{
		Mode:         mode,
		SigKey:       sigKey,
		AuditorKeys:  auditorKeys,
		PrefixAesKey: prefixKey,
		OpeningKey:   openingKey,
	}, &parsed, nil
}
