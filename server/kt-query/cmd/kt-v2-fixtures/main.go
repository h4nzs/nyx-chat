// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Command kt-v2-fixtures generates deterministic Key Transparency v2 fixtures
// for the Rust verifier and the WASM wrapper.
//
// The fixtures are produced by the real v2 log (ML-DSA-65 tree heads, SHA-256
// index, no VRF) and are verified independently by `libsignal-keytrans-v2` in
// packages/keytrans-v2/tests and by the WASM module in
// packages/keytrans-wasm-v2. Tree-head timestamps are pinned so the fixtures do
// not expire.
//
// Usage (from server/kt-query):
//
//	go run ./cmd/kt-v2-fixtures -out ../../packages/keytrans-wasm-v2/testdata
package main

import (
	"crypto/mldsa"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency/pb"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// verifyNowMs is the fixed clock used for both tree-head signing and client
// verification. 2026-10-25T00:00:00Z — keep in sync with the fixture readers.
const verifyNowMs int64 = 1_793_000_000_000

type fixtureConfig struct {
	Mode         int      `json:"mode"`
	SignatureKey string   `json:"signatureKey"`
	AuditorKeys  []string `json:"auditorKeys"`
	SearchKey    string   `json:"searchKey"`
	Value        string   `json:"value"`
	TreeSize     uint64   `json:"treeSize"`
	VerifyNowMs  int64    `json:"verifyNowMs"`
}

func key(seed byte) *mldsa.PrivateKey {
	raw := make([]byte, mldsa.PrivateKeySize)
	for i := range raw {
		raw[i] = seed
	}
	k, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), raw)
	if err != nil {
		log.Fatalf("ML-DSA key from seed %#x: %v", seed, err)
	}
	return k
}

// searchKey meniru bentuk yang benar-benar dipakai NYX: 0x75 (UsernameHashPrefix)
// diikuti 32 byte usernameHash. Fixture 32-byte saja tidak bisa dipakai test
// jalur bundle di web, yang menurunkan search key dari usernameHash.
func searchKey(b byte) []byte {
	out := make([]byte, 33)
	out[0] = 0x75
	for i := 1; i < len(out); i++ {
		out[i] = b
	}
	return out
}

func logValue(version byte) []byte {
	out := make([]byte, 3238)
	for i := range out {
		out[i] = version
	}
	return out
}

func newConfig(mode transparency.DeploymentMode, auditors map[string]*mldsa.PublicKey) *transparency.PrivateConfig {
	return &transparency.PrivateConfig{
		Mode:         mode,
		SigKey:       key(0x21),
		AuditorKeys:  auditors,
		PrefixAesKey: make([]byte, 32),
		OpeningKey:   make([]byte, 32),
		Now:          func() int64 { return verifyNowMs },
	}
}

func mustUpdate(tree *transparency.Tree, sk, value []byte) {
	if _, err := tree.UpdateSimple(&pb.UpdateRequest{
		SearchKey:            sk,
		Value:                value,
		Consistency:          &pb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		log.Fatalf("update: %v", err)
	}
}

func mustSearch(tree *transparency.Tree, sk []byte, last uint64) *pb.TreeSearchResponse {
	req := &pb.TreeSearchRequest{SearchKey: sk, Consistency: &pb.Consistency{}}
	if last != 0 {
		req.Consistency.Last = proto.Uint64(last)
	}
	res, err := tree.Search(req)
	if err != nil {
		log.Fatalf("search: %v", err)
	}
	if res.Value == nil {
		log.Fatal("search: server omitted the value")
	}
	return res
}

// condensedFromResponse re-tags TreeSearchResponse{WIRE fields 2..5} into the
// CondensedTreeSearchResponse{WIRE fields 1..4} the clients consume. v2 has no
// VRF proof, so field 1 is omitted.
func condensedFromResponse(res *pb.TreeSearchResponse) []byte {
	search, err := proto.Marshal(res.Search)
	if err != nil {
		log.Fatalf("marshal search proof: %v", err)
	}
	value, err := proto.Marshal(res.Value)
	if err != nil {
		log.Fatalf("marshal value: %v", err)
	}
	var out []byte
	out = protowire.AppendTag(out, 2, protowire.BytesType)
	out = protowire.AppendBytes(out, search)
	out = protowire.AppendTag(out, 3, protowire.BytesType)
	out = protowire.AppendBytes(out, res.Opening)
	out = protowire.AppendTag(out, 4, protowire.BytesType)
	out = protowire.AppendBytes(out, value)
	return out
}

func frame(res *pb.TreeSearchResponse) []byte {
	head, err := proto.Marshal(res.TreeHead)
	if err != nil {
		log.Fatalf("marshal full tree head: %v", err)
	}
	condensed := condensedFromResponse(res)
	out := make([]byte, 8+len(head)+len(condensed))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(head)))
	copy(out[4:], head)
	offset := 4 + len(head)
	binary.BigEndian.PutUint32(out[offset:offset+4], uint32(len(condensed)))
	copy(out[offset+4:], condensed)
	return out
}

func writeConfig(dir, name string, cfg fixtureConfig) {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		log.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), append(raw, '\n'), 0o644); err != nil {
		log.Fatalf("write config: %v", err)
	}
}

func writeFixture(dir, name string, res *pb.TreeSearchResponse, cfg fixtureConfig) {
	if err := os.WriteFile(filepath.Join(dir, name), frame(res), 0o644); err != nil {
		log.Fatalf("write fixture: %v", err)
	}
	writeConfig(dir, name+".json", cfg)
}

func main() {
	out := flag.String("out", "testdata", "output directory")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatalf("mkdir: %v", err)
	}

	logKey := key(0x21)
	alice := searchKey(0xa1)
	bob := searchKey(0xb2)

	// --- Contact monitoring (no auditor) -----------------------------------
	store := db.NewMemoryTransparencyStore()
	cfg := newConfig(transparency.ContactMonitoring, nil)
	tree, err := transparency.NewTree(cfg, store)
	if err != nil {
		log.Fatalf("new tree: %v", err)
	}
	mustUpdate(tree, alice, logValue(1))
	mustUpdate(tree, bob, logValue(0x0b))
	mustUpdate(tree, alice, logValue(2))

	first := mustSearch(tree, alice, 0)
	writeFixture(*out, "search-first.bin", first, fixtureConfig{
		Mode:         1,
		SignatureKey: hex.EncodeToString(cfg.SigKey.PublicKey().Bytes()),
		AuditorKeys:  []string{},
		SearchKey:    hex.EncodeToString(alice),
		Value:        hex.EncodeToString(first.Value.GetValue()),
		TreeSize:     first.TreeHead.TreeHead.TreeSize,
		VerifyNowMs:  verifyNowMs,
	})

	anchor := first.TreeHead.TreeHead.TreeSize
	mustUpdate(tree, bob, logValue(0x0c))
	anchored := mustSearch(tree, alice, anchor)
	writeFixture(*out, "search-anchored.bin", anchored, fixtureConfig{
		Mode:         1,
		SignatureKey: hex.EncodeToString(cfg.SigKey.PublicKey().Bytes()),
		AuditorKeys:  []string{},
		SearchKey:    hex.EncodeToString(alice),
		Value:        hex.EncodeToString(anchored.Value.GetValue()),
		TreeSize:     anchored.TreeHead.TreeHead.TreeSize,
		VerifyNowMs:  verifyNowMs,
	})

	// --- Third-party auditing (ML-DSA auditor head) ------------------------
	auditorKey := key(0x31)
	auditorName := "auditor-1"
	auditedCfg := newConfig(transparency.ThirdPartyAuditing, map[string]*mldsa.PublicKey{
		auditorName: auditorKey.PublicKey(),
	})
	auditedTree, err := transparency.NewTree(auditedCfg, db.NewMemoryTransparencyStore())
	if err != nil {
		log.Fatalf("new audited tree: %v", err)
	}
	mustUpdate(auditedTree, alice, logValue(1))
	mustUpdate(auditedTree, bob, logValue(0x0b))

	head := auditedTree.GetTransparencyTreeHead()
	root, err := auditedTree.GetLogTree().GetRoot(head.TreeSize)
	if err != nil {
		log.Fatalf("root: %v", err)
	}
	auditorHead, _, err := transparency.SignNewAuditorHead(auditorKey, auditedCfg.Public(), head.TreeSize, root, auditorName)
	if err != nil {
		log.Fatalf("sign auditor head: %v", err)
	}
	if err := auditedTree.SetAuditorHead(&pb.AuditorTreeHead{
		TreeSize:  auditorHead.TreeSize,
		Timestamp: auditorHead.Timestamp,
		Signature: auditorHead.Signature,
	}, auditorName); err != nil {
		log.Fatalf("set auditor head: %v", err)
	}

	audited := mustSearch(auditedTree, alice, 0)
	if len(audited.TreeHead.FullAuditorTreeHeads) != 1 {
		log.Fatalf("expected one auditor head, got %d", len(audited.TreeHead.FullAuditorTreeHeads))
	}
	writeFixture(*out, "search-audited.bin", audited, fixtureConfig{
		Mode:         3,
		SignatureKey: hex.EncodeToString(logKey.PublicKey().Bytes()),
		AuditorKeys:  []string{hex.EncodeToString(auditorKey.PublicKey().Bytes())},
		SearchKey:    hex.EncodeToString(alice),
		Value:        hex.EncodeToString(audited.Value.GetValue()),
		TreeSize:     audited.TreeHead.TreeHead.TreeSize,
		VerifyNowMs:  verifyNowMs,
	})

	fmt.Printf("wrote v2 fixtures to %s (verifyNowMs=%d)\n", *out, verifyNowMs)
}
