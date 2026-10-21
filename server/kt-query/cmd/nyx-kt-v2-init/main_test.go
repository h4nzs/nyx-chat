// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"crypto/mldsa"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v2"
)

type generatedConfig struct {
	API struct {
		SigningKey    string            `yaml:"signing-key"`
		PrefixKey     string            `yaml:"prefix-key"`
		OpeningKey    string            `yaml:"opening-key"`
		Auditors      map[string]string `yaml:"auditors"`
		Distinguished time.Duration     `yaml:"distinguished"`
	} `yaml:"api"`
	DB struct {
		File string `yaml:"file"`
	} `yaml:"db"`
}

func TestInitializeMembuatConfigDanKunci(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "data", "tree.db")
	opts := options{
		configDir:   filepath.Join(dir, "etc"),
		dbFile:      db,
		auditorName: "auditor-uji",
	}

	got, err := initialize(opts)
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if got.config != filepath.Join(opts.configDir, "config.yaml") {
		t.Fatalf("config path = %s", got.config)
	}

	raw, err := os.ReadFile(got.config)
	if err != nil {
		t.Fatalf("baca config: %v", err)
	}
	var parsed generatedConfig
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("urai config: %v", err)
	}
	if parsed.DB.File != db {
		t.Fatalf("db.file = %q", parsed.DB.File)
	}
	if parsed.API.Distinguished != time.Minute {
		t.Fatalf("api.distinguished = %s", parsed.API.Distinguished)
	}
	for name, value := range map[string]string{
		"signing-key": parsed.API.SigningKey,
		"prefix-key":  parsed.API.PrefixKey,
		"opening-key": parsed.API.OpeningKey,
	} {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != mldsa.PrivateKeySize {
			t.Fatalf("%s bukan seed 32 byte: %v (%d)", name, err, len(decoded))
		}
	}
	public, err := hex.DecodeString(parsed.API.Auditors["auditor-uji"])
	if err != nil {
		t.Fatalf("kunci auditor bukan hex: %v", err)
	}
	if _, err := mldsa.NewPublicKey(mldsa.MLDSA65(), public); err != nil {
		t.Fatalf("kunci auditor tidak sah: %v", err)
	}

	info, err := os.Stat(got.auditorKey)
	if err != nil {
		t.Fatalf("stat kunci auditor: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode kunci auditor = %04o", info.Mode().Perm())
	}
	configInfo, err := os.Stat(got.config)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if configInfo.Mode().Perm() != 0o600 {
		t.Fatalf("mode config = %04o", configInfo.Mode().Perm())
	}
	seed, err := os.ReadFile(got.auditorKey)
	if err != nil {
		t.Fatalf("baca kunci auditor: %v", err)
	}
	if len(strings.TrimSpace(string(seed))) != mldsa.PrivateKeySize*2 {
		t.Fatalf("seed auditor bukan 32 byte hex")
	}

	if _, err := initialize(opts); err == nil {
		t.Fatal("initialize kedua seharusnya menolak config yang sudah ada")
	}
}

func TestInitializeForceMenggantiKunci(t *testing.T) {
	dir := t.TempDir()
	opts := options{
		configDir:   filepath.Join(dir, "etc"),
		dbFile:      filepath.Join(dir, "tree.db"),
		auditorName: "auditor-uji",
	}
	if _, err := initialize(opts); err != nil {
		t.Fatalf("initialize pertama: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(opts.configDir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	opts.force = true
	if _, err := initialize(opts); err != nil {
		t.Fatalf("initialize force: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(opts.configDir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) == string(second) {
		t.Fatal("config tidak berubah setelah -force")
	}
}
