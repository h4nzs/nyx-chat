// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"path/filepath"
	"testing"

	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
)

func frame(payload []byte) []byte {
	out := make([]byte, 4, 4+len(payload))
	binary.BigEndian.PutUint32(out, uint32(len(payload)))
	return append(out, payload...)
}

func TestSplitFramed(t *testing.T) {
	t.Run("dua frame utuh", func(t *testing.T) {
		body := append(frame([]byte("head")), frame([]byte("condensed"))...)
		frames, err := splitFramed(body)
		if err != nil {
			t.Fatalf("splitFramed: %v", err)
		}
		if len(frames) != 2 || string(frames[0]) != "head" || string(frames[1]) != "condensed" {
			t.Fatalf("frame tidak sesuai: %q", frames)
		}
	})

	t.Run("header terpotong", func(t *testing.T) {
		if _, err := splitFramed([]byte{0x00, 0x00}); err == nil {
			t.Fatal("header 2 byte diterima — seharusnya ditolak")
		}
	})

	t.Run("payload terpotong", func(t *testing.T) {
		body := frame([]byte("head"))
		if _, err := splitFramed(body[:len(body)-1]); err == nil {
			t.Fatal("payload terpotong diterima — seharusnya ditolak")
		}
	})

	t.Run("body kosong", func(t *testing.T) {
		frames, err := splitFramed(nil)
		if err != nil || len(frames) != 0 {
			t.Fatalf("body kosong: frames=%v err=%v", frames, err)
		}
	})
}

// validConfig membangun payload `/config` yang sah: kunci tanda tangan ed25519
// asli + kunci VRF asli (dibangkitkan dari seed, bukan byte acak).
func validConfig(t *testing.T) configPayload {
	t.Helper()
	sigKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x01}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	// Kunci VRF publik diturunkan dari seed yang sama seperti `NewVRFSigner`
	// (`PrivateKey.Public()` mengembalikan byte ed25519 mentah).
	vrfSeed := bytes.Repeat([]byte{0x02}, 32)
	if _, err := edvrf.NewVRFSigner(vrfSeed); err != nil {
		t.Fatalf("buat kunci VRF: %v", err)
	}
	vrfPublic := ed25519.NewKeyFromSeed(vrfSeed).Public().(ed25519.PublicKey)
	return configPayload{
		Mode:         int(transparency.ContactMonitoring),
		SignatureKey: hex.EncodeToString(sigKey),
		VRFKey:       hex.EncodeToString(vrfPublic),
		AuditorKeys:  []string{hex.EncodeToString(bytes.Repeat([]byte{0x09}, 32))},
	}
}

func TestPublicConfigFromService(t *testing.T) {
	t.Run("payload sah", func(t *testing.T) {
		payload := validConfig(t)
		config, err := publicConfigFromService(&payload)
		if err != nil {
			t.Fatalf("publicConfigFromService: %v", err)
		}
		if config.Mode != transparency.ContactMonitoring {
			t.Fatalf("mode = %d", config.Mode)
		}
		if hex.EncodeToString(config.SigKey) != payload.SignatureKey {
			t.Fatal("kunci tanda tangan tidak diteruskan apa adanya")
		}
		// Nama auditor tidak dikirim `/config`; yang penting kuncinya ada dan
		// jumlahnya sama, karena upstream mencocokkan kunci berdasarkan byte.
		if len(config.AuditorKeys) != 1 {
			t.Fatalf("jumlah auditor = %d, ingin 1", len(config.AuditorKeys))
		}
		if config.VrfKey == nil {
			t.Fatal("VrfKey nil")
		}
	})

	cases := map[string]func(*configPayload){
		"signatureKey bukan hex":     func(c *configPayload) { c.SignatureKey = "zz" },
		"signatureKey panjang salah": func(c *configPayload) { c.SignatureKey = "0011" },
		"vrfKey bukan hex":           func(c *configPayload) { c.VRFKey = "not-hex" },
		"vrfKey titik tidak sah":     func(c *configPayload) { c.VRFKey = hex.EncodeToString(make([]byte, 32)) },
		"auditorKeys bukan hex":      func(c *configPayload) { c.AuditorKeys = []string{"zz"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			payload := validConfig(t)
			mutate(&payload)
			if _, err := publicConfigFromService(&payload); err == nil {
				t.Fatal("payload tidak sah diterima — seharusnya ditolak")
			}
		})
	}
}

func TestResolveSearchKey(t *testing.T) {
	hash := bytes.Repeat([]byte{0x5a}, 32)
	encoded := base64.RawURLEncoding.EncodeToString(hash)

	t.Run("hash diberi prefix 0x75", func(t *testing.T) {
		key, err := resolveSearchKey(encoded, "")
		if err != nil {
			t.Fatalf("resolveSearchKey: %v", err)
		}
		if len(key) != 33 || key[0] != PrefixSearchKeyUsernameHash {
			t.Fatalf("search key = %x", key)
		}
	})

	t.Run("key mentah diteruskan", func(t *testing.T) {
		raw := append([]byte{PrefixSearchKeyUsernameHash}, hash...)
		key, err := resolveSearchKey("", base64.RawURLEncoding.EncodeToString(raw))
		if err != nil {
			t.Fatalf("resolveSearchKey: %v", err)
		}
		if !bytes.Equal(key, raw) {
			t.Fatalf("search key berubah: %x", key)
		}
	})

	rejects := map[string]struct{ hash, key string }{
		"keduanya kosong":   {"", ""},
		"keduanya diisi":    {encoded, encoded},
		"hash pendek":       {base64.RawURLEncoding.EncodeToString(hash[:31]), ""},
		"hash bukan base64": {"!!!", ""},
		"key bukan base64":  {"", "!!!"},
	}
	for name, input := range rejects {
		t.Run(name, func(t *testing.T) {
			if _, err := resolveSearchKey(input.hash, input.key); err == nil {
				t.Fatal("input tidak sah diterima — seharusnya ditolak")
			}
		})
	}
}

// Anchor adalah state klien: kalau berkasnya hilang, bukti konsistensi tidak
// bisa diverifikasi lagi (`verifyFullTreeHead` upstream menolak). Jadi
// round-trip-nya harus benar-benar disimpan dan dibaca ulang.
func TestAnchorRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "anchor.json")
	payload := validConfig(t)
	public, err := publicConfigFromService(&payload)
	if err != nil {
		t.Fatalf("publicConfigFromService: %v", err)
	}

	const timestamp = int64(1_700_000_000_000)
	storage := newClientStorage(public)
	root := bytes.Repeat([]byte{0xab}, 32)
	storage.head = &db.TransparencyTreeHead{TreeSize: 42, Timestamp: timestamp}
	storage.root = root
	if err := storage.saveAnchor(path); err != nil {
		t.Fatalf("saveAnchor: %v", err)
	}

	restored := newClientStorage(public)
	if err := restored.loadAnchor(path); err != nil {
		t.Fatalf("loadAnchor: %v", err)
	}
	if restored.head == nil || restored.head.TreeSize != 42 || restored.head.Timestamp != timestamp {
		t.Fatalf("tree head tidak pulih: %+v", restored.head)
	}
	if !bytes.Equal(restored.root, root) {
		t.Fatalf("root tidak pulih: %x", restored.root)
	}

	t.Run("berkas tidak ada bukan error", func(t *testing.T) {
		empty := newClientStorage(public)
		if err := empty.loadAnchor(filepath.Join(t.TempDir(), "tidak-ada.json")); err != nil {
			t.Fatalf("loadAnchor berkas hilang: %v", err)
		}
		if empty.head != nil {
			t.Fatal("anchor terisi padahal berkas tidak ada")
		}
	})
}

func TestShortHex(t *testing.T) {
	if got := shortHex("00112233445566778899aabbccddeeff"); got != "00112233445566778899aabb" {
		t.Fatalf("shortHex = %q", got)
	}
	if got := shortHex("0011"); got != "0011" {
		t.Fatalf("shortHex pendek = %q", got)
	}
}
