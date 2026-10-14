// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/tree/transparency"

	"gopkg.in/yaml.v2"
)

// fileConfig memuat hanya bagian config kt-server yang dibutuhkan layanan baca.
// Config yang sama dipakai penulis (`kt-server -config ...`), jadi operator
// hanya punya satu berkas: kalau kunci log berbeda, pohon tidak akan terbaca dan
// layanan menolak start (bukannya menyajikan bukti yang tidak bisa diverifikasi).
type fileConfig struct {
	API struct {
		SigningKey string            `yaml:"signing-key"`
		VRFKey     string            `yaml:"vrf-key"`
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

// loadConfig membaca config kt-server dan menurunkan `PrivateConfig` pohon
// dengan aturan yang **identik** dengan upstream (`APIConfig.TreeConfig`),
// termasuk pemilihan mode: auditor terkonfigurasi → ThirdPartyAuditing.
func loadConfig(path string) (*transparency.PrivateConfig, *fileConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("baca config %s: %w", path, err)
	}
	var parsed fileConfig
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return nil, nil, fmt.Errorf("urai config %s: %w", path, err)
	}

	seed, err := decodeHexKey(parsed.API.SigningKey, ed25519.SeedSize, "api.signing-key")
	if err != nil {
		return nil, nil, err
	}
	vrfSeed, err := decodeHexKey(parsed.API.VRFKey, 0, "api.vrf-key")
	if err != nil {
		return nil, nil, err
	}
	vrfKey, err := edvrf.NewVRFSigner(vrfSeed)
	if err != nil {
		return nil, nil, fmt.Errorf("api.vrf-key tidak sah: %w", err)
	}
	prefixKey, err := decodeHexKey(parsed.API.PrefixKey, 32, "api.prefix-key")
	if err != nil {
		return nil, nil, err
	}
	openingKey, err := decodeHexKey(parsed.API.OpeningKey, 32, "api.opening-key")
	if err != nil {
		return nil, nil, err
	}

	auditorKeys := make(map[string]ed25519.PublicKey, len(parsed.API.Auditors))
	for name, value := range parsed.API.Auditors {
		raw, err := hex.DecodeString(expandEnv(value))
		if err != nil {
			return nil, nil, fmt.Errorf("auditor %s bukan hex: %w", name, err)
		}
		if len(raw) != ed25519.PublicKeySize {
			return nil, nil, fmt.Errorf("auditor %s panjang kunci salah: %d", name, len(raw))
		}
		auditorKeys[name] = ed25519.PublicKey(raw)
	}

	mode := transparency.ContactMonitoring
	if len(auditorKeys) > 0 {
		mode = transparency.ThirdPartyAuditing
	}

	return &transparency.PrivateConfig{
		Mode:         mode,
		SigKey:       ed25519.NewKeyFromSeed(seed),
		AuditorKeys:  auditorKeys,
		VrfKey:       vrfKey,
		PrefixAesKey: prefixKey,
		OpeningKey:   openingKey,
	}, &parsed, nil
}
