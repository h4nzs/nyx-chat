// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"bytes"
	"crypto/mldsa"
	"strings"
	"testing"

	"github.com/signalapp/keytransparency/db"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
)

// verifyCheckExpectations adalah satu-satunya hal yang membuat `-check` menjadi
// gerbang verifikasi arsip, bukan sekadar "basis data bisa dibuka". LevelDB
// memulihkan diri dari salinan sebagian, jadi exit code 0 tanpa perbandingan
// head pernah membuat arsip rusak tampak sah (drill 2026-10-29, docs/39 §39.5d).
func TestVerifyCheckExpectations(t *testing.T) {
	root := strings.Repeat("ab", 32)

	cases := []struct {
		name     string
		size     uint64
		rootHex  string
		wantSize uint64
		wantRoot string
		wantErr  bool
	}{
		{name: "cocok, root case-insensitive", size: 5, rootHex: root, wantSize: 5, wantRoot: strings.ToUpper(root)},
		{name: "tanpa harapan = no-op", size: 5, rootHex: root},
		{name: "ukuran berbeda", size: 6, rootHex: root, wantSize: 5, wantErr: true},
		{name: "root berbeda", size: 5, rootHex: root, wantRoot: strings.Repeat("0", 64), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyCheckExpectations(tc.size, tc.rootHex, tc.wantSize, tc.wantRoot)
			if tc.wantErr && err == nil {
				t.Fatal("harus gagal, tetapi lolos")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("tidak boleh gagal: %v", err)
			}
		})
	}
}

// Manifes snapshot mencatat head auditor yang ikut tersimpan. Tanpa itu, satu-
// satunya cara mengetahui arsip "butuh auditor dulu" adalah mencoba memulihkan
// (docs/39 §39.5d temuan 1).
func TestNewestAuditorHeadMasukKeManifes(t *testing.T) {
	sigKey, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), bytes.Repeat([]byte{0x01}, mldsa.PrivateKeySize))
	if err != nil {
		t.Fatalf("kunci log: %v", err)
	}
	auditorKey, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), bytes.Repeat([]byte{0x31}, mldsa.PrivateKeySize))
	if err != nil {
		t.Fatalf("kunci auditor: %v", err)
	}
	cfg := &transparency.PrivateConfig{
		Mode:         transparency.ThirdPartyAuditing,
		SigKey:       sigKey,
		AuditorKeys:  map[string]*mldsa.PublicKey{"aud-drill": auditorKey.PublicKey()},
		PrefixAesKey: bytes.Repeat([]byte{0x03}, 32),
		OpeningKey:   bytes.Repeat([]byte{0x04}, 32),
	}
	tree, err := transparency.NewTree(cfg, db.NewMemoryTransparencyStore())
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}

	// Sebelum ada auditor head: manifes TIDAK boleh mengarang angka.
	if name, head := newestAuditorHead(tree); name != "" || head != nil {
		t.Fatalf("head auditor sudah ada padahal belum ditandatangani: %q %v", name, head)
	}

	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            append([]byte{PrefixSearchKeyUsernameHash}, bytes.Repeat([]byte{0x5a}, 32)...),
		Value:                nyxValueV2(1, 0x11),
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri: %v", err)
	}
	logHead := tree.GetTransparencyTreeHead()
	root, err := tree.GetLogTree().GetRoot(logHead.TreeSize)
	if err != nil {
		t.Fatalf("ambil root: %v", err)
	}
	auditorHead, _, err := transparency.SignNewAuditorHead(auditorKey, cfg.Public(), logHead.TreeSize, root, "aud-drill")
	if err != nil {
		t.Fatalf("tanda tangani head auditor: %v", err)
	}
	if err := tree.SetAuditorHead(&tpb.AuditorTreeHead{
		TreeSize:  auditorHead.TreeSize,
		Timestamp: auditorHead.Timestamp,
		Signature: auditorHead.Signature,
	}, "aud-drill"); err != nil {
		t.Fatalf("pasang head auditor: %v", err)
	}

	name, head := newestAuditorHead(tree)
	if name != "aud-drill" {
		t.Errorf("nama auditor = %q, ingin aud-drill", name)
	}
	if head == nil || head.TreeSize != logHead.TreeSize || head.Timestamp != auditorHead.Timestamp {
		t.Fatalf("head auditor tidak sesuai: %+v (ingin treeSize=%d timestamp=%d)",
			head, logHead.TreeSize, auditorHead.Timestamp)
	}
}
