// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package transparency_test

import (
	"bytes"
	"crypto/mldsa"
	"crypto/sha256"
	"testing"

	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency/pb"
	"google.golang.org/protobuf/proto"
	transparencyv2 "github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
)

func testKey(t *testing.T) *mldsa.PrivateKey {
	t.Helper()
	key, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("generate ML-DSA key: %v", err)
	}
	return key
}

func testConfig(t *testing.T, mode transparencyv2.DeploymentMode, auditors map[string]*mldsa.PublicKey) *transparencyv2.PrivateConfig {
	t.Helper()
	return &transparencyv2.PrivateConfig{
		Mode:         mode,
		SigKey:       testKey(t),
		AuditorKeys:  auditors,
		PrefixAesKey: bytes.Repeat([]byte{0x03}, 32),
		OpeningKey:   bytes.Repeat([]byte{0x04}, 32),
	}
}

type clientStorage struct {
	config *transparencyv2.PublicConfig
	head   *db.TransparencyTreeHead
	root   []byte
	data   map[string]*transparencyv2.MonitoringData
}

func newClientStorage(config *transparencyv2.PublicConfig) *clientStorage {
	return &clientStorage{config: config, data: map[string]*transparencyv2.MonitoringData{}}
}

func (s *clientStorage) PublicConfig() *transparencyv2.PublicConfig { return s.config }

func (s *clientStorage) GetLastTreeHead() (*db.TransparencyTreeHead, []byte, error) {
	return s.head, s.root, nil
}

func (s *clientStorage) SetLastTreeHead(head *db.TransparencyTreeHead, root []byte) error {
	s.head, s.root = head, root
	return nil
}

func (s *clientStorage) GetData(key []byte) (*transparencyv2.MonitoringData, error) {
	return s.data[string(key)], nil
}

func (s *clientStorage) SetData(key []byte, data *transparencyv2.MonitoringData) error {
	s.data[string(key)] = data
	return nil
}

func TestIndexIsDomainSeparatedSHA256(t *testing.T) {
	searchKey := []byte{0x75, 0x01, 0x02}
	got := transparencyv2.Index(searchKey)

	raw := sha256.Sum256(searchKey)
	if got == raw {
		t.Fatal("index must not be a bare SHA-256 of the search key")
	}

	want := sha256.Sum256(append([]byte(transparencyv2.IndexDomain), searchKey...))
	if got != want {
		t.Fatalf("index mismatch: got %x want %x", got, want)
	}
	if got != transparencyv2.Index(searchKey) {
		t.Fatal("index must be deterministic")
	}
	if got == transparencyv2.Index([]byte{0x75, 0x01, 0x03}) {
		t.Fatal("different search keys must map to different indices")
	}
}

func TestSearchProofVerifiesWithMLDSA(t *testing.T) {
	config := testConfig(t, transparencyv2.ContactMonitoring, nil)
	store := db.NewMemoryTransparencyStore()
	tree, err := transparencyv2.NewTree(config, store)
	if err != nil {
		t.Fatalf("new tree: %v", err)
	}

	searchKey := []byte{0x75, 0xaa}
	value := bytes.Repeat([]byte{0x42}, 64)
	if _, err := tree.UpdateSimple(&pb.UpdateRequest{
		SearchKey:            searchKey,
		Value:                value,
		Consistency:          &pb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	req := &pb.TreeSearchRequest{SearchKey: searchKey, Consistency: &pb.Consistency{}}
	res, err := tree.Search(req)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.VrfProof) != 0 {
		t.Fatalf("v2 response must not carry a VRF proof: %x", res.VrfProof)
	}
	if !bytes.Equal(res.Value.Value, value) {
		t.Fatalf("unexpected value: %x", res.Value.Value)
	}
	if len(res.TreeHead.TreeHead.Signatures) != 1 {
		t.Fatalf("expected one tree head signature, got %d", len(res.TreeHead.TreeHead.Signatures))
	}
	if got := len(res.TreeHead.TreeHead.Signatures[0].Signature); got != transparencyv2.MLDSA65SignatureSize {
		t.Fatalf("tree head signature is %d bytes, want %d", got, transparencyv2.MLDSA65SignatureSize)
	}

	storage := newClientStorage(config.Public())
	if err := transparencyv2.VerifySearch(storage, req, res); err != nil {
		t.Fatalf("verify search: %v", err)
	}

	// Tampering with the tree head signature must fail closed.
	tampered := proto.Clone(res).(*pb.TreeSearchResponse)
	tampered.TreeHead.TreeHead.Signatures[0].Signature[0] ^= 0xff

	if err := transparencyv2.VerifySearch(newClientStorage(config.Public()), req, tampered); err == nil {
		t.Fatal("tampered tree head signature must be rejected")
	}

	// A v1-style VRF proof in a v2 response must also be rejected.
	withVRF := proto.Clone(res).(*pb.TreeSearchResponse)
	withVRF.VrfProof = bytes.Repeat([]byte{0x01}, 80)
	if err := transparencyv2.VerifySearch(newClientStorage(config.Public()), req, withVRF); err == nil {
		t.Fatal("v2 verifier must reject a response carrying a VRF proof")
	}
}

func TestThirdPartyAuditorUsesMLDSA(t *testing.T) {
	auditorName := "auditor-1"
	auditorKey := testKey(t)
	config := testConfig(t, transparencyv2.ThirdPartyAuditing, map[string]*mldsa.PublicKey{
		auditorName: auditorKey.PublicKey(),
	})
	store := db.NewMemoryTransparencyStore()
	tree, err := transparencyv2.NewTree(config, store)
	if err != nil {
		t.Fatalf("new tree: %v", err)
	}

	searchKey := []byte{0x75, 0xbb}
	if _, err := tree.UpdateSimple(&pb.UpdateRequest{
		SearchKey:            searchKey,
		Value:                bytes.Repeat([]byte{0x11}, 32),
		Consistency:          &pb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	head := tree.GetTransparencyTreeHead()
	root, err := tree.GetLogTree().GetRoot(head.TreeSize)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	auditorHead, _, err := transparencyv2.SignNewAuditorHead(auditorKey, config.Public(), head.TreeSize, root, auditorName)
	if err != nil {
		t.Fatalf("sign auditor head: %v", err)
	}
	if err := tree.SetAuditorHead(&pb.AuditorTreeHead{
		TreeSize:  auditorHead.TreeSize,
		Timestamp: auditorHead.Timestamp,
		Signature: auditorHead.Signature,
	}, auditorName); err != nil {
		t.Fatalf("set auditor head: %v", err)
	}

	req := &pb.TreeSearchRequest{SearchKey: searchKey, Consistency: &pb.Consistency{}}
	res, err := tree.Search(req)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.TreeHead.FullAuditorTreeHeads) != 1 {
		t.Fatalf("expected one auditor tree head, got %d", len(res.TreeHead.FullAuditorTreeHeads))
	}
	if got := len(res.TreeHead.FullAuditorTreeHeads[0].PublicKey); got != transparencyv2.MLDSA65PublicKeySize {
		t.Fatalf("auditor public key is %d bytes, want %d", got, transparencyv2.MLDSA65PublicKeySize)
	}

	if err := transparencyv2.VerifySearch(newClientStorage(config.Public()), req, res); err != nil {
		t.Fatalf("verify with auditor: %v", err)
	}

	// A corrupted auditor signature must be rejected.
	bad := proto.Clone(res).(*pb.TreeSearchResponse)
	bad.TreeHead.FullAuditorTreeHeads[0].TreeHead.Signature[0] ^= 0xff
	if err := transparencyv2.VerifySearch(newClientStorage(config.Public()), req, bad); err == nil {
		t.Fatal("tampered auditor signature must be rejected")
	}
}
