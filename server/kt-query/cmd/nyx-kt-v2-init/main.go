// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Command nyx-kt-v2-init menyiapkan pemasangan pertama log Key Transparency v2:
// direktori, kunci ML-DSA log, kunci auditor, dan config YAML yang dipakai
// bersama oleh layanan baca, penulis, dan auditor.
//
// Kenapa ada: `deploy.yml` sudah mengirim binary + unit, tetapi pemasangan
// pertama sebelumnya menuntut operator membuat kunci secara manual di VPS.
// Perintah ini membuat langkah itu idempoten dan bisa dijalankan deploy tanpa
// menyalin rahasia dari CI. Kunci **selalu lahir di VPS**; tidak ada seed yang
// melewati jaringan.
//
// Perintah ini tidak menyentuh LevelDB dan tidak mengubah config yang sudah ada
// kecuali `-force` diberikan — log yang sudah berjalan tidak boleh berganti
// kunci tanda tangan diam-diam (semua bukti lama akan ditolak).
package main

import (
	"crypto/mldsa"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultConfigDir = "/etc/nyx/kt-v2"
	defaultDBFile    = "/var/lib/nyx/kt-v2/tree.db"
	defaultAuditor   = "nyx-primary-auditor-v2"
)

type options struct {
	configDir   string
	dbFile      string
	auditorName string
	auditorKey  string
	force       bool
}

func main() {
	opts := options{}
	flag.StringVar(&opts.configDir, "config-dir", defaultConfigDir, "direktori config + kunci (root-only)")
	flag.StringVar(&opts.dbFile, "db", defaultDBFile, "lokasi LevelDB v2")
	flag.StringVar(&opts.auditorName, "auditor-name", defaultAuditor, "nama auditor di `api.auditors`")
	flag.StringVar(&opts.auditorKey, "auditor-key", "", "berkas seed auditor (default <config-dir>/auditor.key)")
	flag.BoolVar(&opts.force, "force", false, "tulis ulang config/kunci yang sudah ada (MENGHAPUS identitas log lama)")
	flag.Parse()

	paths, err := initialize(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[kt-v2-init] %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[kt-v2-init] config  : %s\n", paths.config)
	fmt.Printf("[kt-v2-init] database: %s\n", paths.db)
	fmt.Printf("[kt-v2-init] auditor : %s (kunci %s)\n", paths.auditorName, paths.auditorKey)
	fmt.Printf("[kt-v2-init] mode    : ThirdPartyAuditing (ML-DSA-65)\n")
}

type paths struct {
	config      string
	db          string
	auditorKey  string
	auditorName string
}

// initialize membuat seluruh artefak. Semua penulisan memakai file sementara +
// rename supaya proses yang mati di tengah tidak meninggalkan config separuh.
func initialize(opts options) (paths, error) {
	if strings.TrimSpace(opts.configDir) == "" {
		return paths{}, errors.New("config-dir kosong")
	}
	if strings.TrimSpace(opts.dbFile) == "" {
		return paths{}, errors.New("db kosong")
	}
	if strings.TrimSpace(opts.auditorName) == "" {
		return paths{}, errors.New("auditor-name kosong")
	}

	auditorKey := opts.auditorKey
	if auditorKey == "" {
		auditorKey = filepath.Join(opts.configDir, "auditor.key")
	}
	configPath := filepath.Join(opts.configDir, "config.yaml")
	out := paths{config: configPath, db: opts.dbFile, auditorKey: auditorKey, auditorName: opts.auditorName}

	_, configErr := os.Stat(configPath)
	if configErr == nil && !opts.force {
		return out, fmt.Errorf("%s sudah ada — pakai -force hanya bila memang ingin mengganti identitas log", configPath)
	}
	if configErr != nil && !errors.Is(configErr, os.ErrNotExist) {
		return out, fmt.Errorf("periksa %s: %w", configPath, configErr)
	}

	// Database butuh direktori induk; config dir memuat kunci privat.
	for _, dir := range []string{opts.configDir, filepath.Dir(opts.dbFile)} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return out, fmt.Errorf("buat direktori %s: %w", dir, err)
		}
	}

	signingSeed, err := randomSeed()
	if err != nil {
		return out, err
	}
	prefixKey, err := randomSeed()
	if err != nil {
		return out, err
	}
	openingKey, err := randomSeed()
	if err != nil {
		return out, err
	}
	auditorSeed, err := randomSeed()
	if err != nil {
		return out, err
	}
	auditorPrivate, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), auditorSeed)
	if err != nil {
		return out, fmt.Errorf("kunci auditor ML-DSA: %w", err)
	}
	auditorPublic := auditorPrivate.PublicKey().Bytes()

	config := fmt.Sprintf(`# NYX Key Transparency v2 — dibuat oleh nyx-kt-v2-init.
# Jangan diedit tangan kecuali mengganti kunci dengan prosedur yang terdokumentasi
# (docs/35 §35.7): mengganti signing-key membuat semua bukti lama tidak dapat
# diverifikasi klien.
api:
  signing-key: %q
  prefix-key: %q
  opening-key: %q
  auditors:
    %q: %q
  distinguished: 1m
db:
  file: %q
`,
		hex.EncodeToString(signingSeed),
		hex.EncodeToString(prefixKey),
		hex.EncodeToString(openingKey),
		opts.auditorName,
		hex.EncodeToString(auditorPublic),
		opts.dbFile,
	)

	if err := writeFileAtomic(auditorKey, []byte(hex.EncodeToString(auditorSeed)+"\n")); err != nil {
		return out, err
	}
	if err := writeFileAtomic(configPath, []byte(config)); err != nil {
		return out, err
	}
	return out, nil
}

func randomSeed() ([]byte, error) {
	seed := make([]byte, mldsa.PrivateKeySize)
	if _, err := rand.Read(seed); err != nil {
		return nil, fmt.Errorf("baca entropy: %w", err)
	}
	return seed, nil
}

func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".nyx-kt-v2-*")
	if err != nil {
		return fmt.Errorf("buat file sementara di %s: %w", dir, err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return fmt.Errorf("set mode %s: %w", tempName, err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("tulis %s: %w", tempName, err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync %s: %w", tempName, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("tutup %s: %w", tempName, err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("pasang %s: %w", path, err)
	}
	return nil
}
