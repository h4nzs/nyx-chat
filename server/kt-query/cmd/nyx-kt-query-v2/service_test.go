// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

package main

import (
	"bytes"
	"crypto/mldsa"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	"github.com/signalapp/keytransparency/db"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"

	"google.golang.org/protobuf/proto"
)

// nyxValueV2 membangun nilai log NYX v2. Isinya tidak ditafsirkan lapisan
// transparansi (hanya dibungkus panjang), tetapi ukurannya harus sama dengan
// nilai nyata supaya bukti yang diuji mewakili produksi.
func nyxValueV2(keyVersion, identityKey byte) []byte {
	value := make([]byte, 3238)
	value[0] = 0x02
	value[1] = keyVersion
	for i := 2; i < 34; i++ {
		value[i] = identityKey
	}
	return value
}

func testConfig(t *testing.T) *transparency.PrivateConfig {
	t.Helper()
	key, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), bytes.Repeat([]byte{0x01}, mldsa.PrivateKeySize))
	if err != nil {
		t.Fatalf("buat kunci ML-DSA: %v", err)
	}
	return &transparency.PrivateConfig{
		Mode:         transparency.ContactMonitoring,
		SigKey:       key,
		PrefixAesKey: bytes.Repeat([]byte{0x03}, 32),
		OpeningKey:   bytes.Repeat([]byte{0x04}, 32),
	}
}

type memTreeSource struct {
	config *transparency.PrivateConfig
	tree   *transparency.Tree
}

func (m *memTreeSource) Tree() (*transparency.Tree, error)  { return m.tree, nil }
func (m *memTreeSource) Public() *transparency.PublicConfig { return m.config.Public() }
func (m *memTreeSource) Close() error                       { return nil }

func newV2TestServer(t *testing.T) (*httptest.Server, *transparency.PrivateConfig, []byte) {
	t.Helper()

	config := testConfig(t)
	store := db.NewMemoryTransparencyStore()
	tree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}

	hash := bytes.Repeat([]byte{0x5a}, 32)
	searchKey := append([]byte{PrefixSearchKeyUsernameHash}, hash...)
	for _, version := range []byte{1, 2} {
		if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
			SearchKey:            searchKey,
			Value:                nyxValueV2(version, 0x11),
			Consistency:          &tpb.Consistency{},
			ReturnUpdateResponse: true,
		}); err != nil {
			t.Fatalf("tulis entri v%d: %v", version, err)
		}
	}
	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            []byte(DistinguishedSearchKey),
		Value:                []byte{0x00, 0x11, 0x22},
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri distinguished: %v", err)
	}

	server := httptest.NewServer((&queryServer{source: &memTreeSource{config: config, tree: tree}}).routes())
	t.Cleanup(server.Close)
	return server, config, hash
}

type testClientStorage struct {
	config *transparency.PublicConfig
	head   *db.TransparencyTreeHead
	root   []byte
	data   map[string]*transparency.MonitoringData
}

func newTestClientStorage(config *transparency.PublicConfig) *testClientStorage {
	return &testClientStorage{config: config, data: map[string]*transparency.MonitoringData{}}
}

func (s *testClientStorage) PublicConfig() *transparency.PublicConfig { return s.config }

func (s *testClientStorage) GetLastTreeHead() (*db.TransparencyTreeHead, []byte, error) {
	return s.head, s.root, nil
}

func (s *testClientStorage) SetLastTreeHead(head *db.TransparencyTreeHead, root []byte) error {
	s.head, s.root = head, root
	return nil
}

func (s *testClientStorage) GetData(key []byte) (*transparency.MonitoringData, error) {
	return s.data[hex.EncodeToString(key)], nil
}

func (s *testClientStorage) SetData(key []byte, data *transparency.MonitoringData) error {
	s.data[hex.EncodeToString(key)] = data
	return nil
}

func splitFramed(t *testing.T, body []byte) [][]byte {
	t.Helper()
	var out [][]byte
	offset := 0
	for offset < len(body) {
		if offset+4 > len(body) {
			t.Fatalf("frame terpotong di offset %d", offset)
		}
		length := int(binary.BigEndian.Uint32(body[offset : offset+4]))
		offset += 4
		if offset+length > len(body) {
			t.Fatalf("payload terpotong di offset %d (len=%d)", offset, length)
		}
		out = append(out, body[offset:offset+length])
		offset += length
	}
	return out
}

func readAll(t *testing.T, body io.Reader) []byte {
	t.Helper()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("baca body: %v", err)
	}
	return raw
}

func TestConfigV2MengeksposKunciMLDSA(t *testing.T) {
	server, config, _ := newV2TestServer(t)

	response, err := http.Get(server.URL + "/config")
	if err != nil {
		t.Fatalf("GET /config: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}

	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("urai config: %v", err)
	}
	if _, ok := payload["vrfKey"]; ok {
		t.Error("v2 tidak boleh mengekspos vrfKey")
	}
	if payload["valueFormat"] != "nyx-kt-value-v2" {
		t.Errorf("valueFormat = %v", payload["valueFormat"])
	}
	if payload["abiVersion"] != float64(2) {
		t.Errorf("abiVersion = %v", payload["abiVersion"])
	}
	sigRaw, err := hex.DecodeString(payload["signatureKey"].(string))
	if err != nil {
		t.Fatalf("signatureKey bukan hex: %v", err)
	}
	if len(sigRaw) != mldsa.MLDSA65PublicKeySize {
		t.Errorf("panjang signatureKey = %d, ingin %d", len(sigRaw), mldsa.MLDSA65PublicKeySize)
	}
	if !bytes.Equal(sigRaw, config.Public().SigKey.Bytes()) {
		t.Error("signatureKey bukan kunci publik log")
	}
}

func TestSearchDanMonitorV2BisaDiverifikasi(t *testing.T) {
	server, config, hash := newV2TestServer(t)

	response, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("status %d", response.StatusCode)
	}
	frames := splitFramed(t, readAll(t, response.Body))
	response.Body.Close()
	if len(frames) != 2 {
		t.Fatalf("jumlah frame = %d, ingin 2", len(frames))
	}

	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		t.Fatalf("urai FullTreeHead: %v", err)
	}
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		t.Fatalf("urai condensed: %v", err)
	}
	if condensed.Search == nil || condensed.Value == nil {
		t.Fatal("search proof atau nilai hilang")
	}

	searchKey := append([]byte{PrefixSearchKeyUsernameHash}, hash...)
	storage := newTestClientStorage(config.Public())
	searchRequest := &tpb.TreeSearchRequest{SearchKey: searchKey, Consistency: &tpb.Consistency{}}
	searchResponse := &tpb.TreeSearchResponse{
		TreeHead: fullTreeHead,
		Search:   condensed.Search,
		Opening:  condensed.Opening,
		Value:    condensed.Value,
	}
	if err := transparency.VerifySearch(storage, searchRequest, searchResponse); err != nil {
		t.Fatalf("verifikasi search v2 gagal: %v", err)
	}
	if !bytes.Equal(condensed.Value.Value, nyxValueV2(2, 0x11)) {
		t.Error("nilai yang dikembalikan bukan nilai terbaru")
	}

	// v2: commitment index dihitung klien dari search key (SHA-256 berdomain),
	// tidak lagi berasal dari keluaran VRF.
	commitmentIndex := transparency.Index(searchKey)
	consistency := &tpb.Consistency{}
	if size := fullTreeHead.TreeHead.TreeSize; size > 0 {
		consistency.Last = &size
	}
	monitorRequest := &tpb.MonitorRequest{
		Keys: []*tpb.MonitorKey{{
			SearchKey:       searchKey,
			EntryPosition:   condensed.Search.Pos,
			CommitmentIndex: commitmentIndex[:],
		}},
		Consistency: consistency,
	}
	encodedRequest, err := proto.Marshal(monitorRequest)
	if err != nil {
		t.Fatalf("marshal monitor request: %v", err)
	}
	postResponse, err := http.Post(server.URL+"/monitor", "application/octet-stream", bytes.NewReader(encodedRequest))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	defer postResponse.Body.Close()
	if postResponse.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", postResponse.StatusCode, readAll(t, postResponse.Body))
	}
	monitorResponse := &tpb.MonitorResponse{}
	if err := proto.Unmarshal(readAll(t, postResponse.Body), monitorResponse); err != nil {
		t.Fatalf("urai monitor response: %v", err)
	}
	if len(monitorResponse.Proofs) != 1 {
		t.Fatalf("jumlah proof = %d, ingin 1", len(monitorResponse.Proofs))
	}
	if err := transparency.VerifyMonitor(storage, monitorRequest, monitorResponse); err != nil {
		t.Fatalf("verifikasi monitor v2 gagal: %v", err)
	}
}

func TestDistinguishedAnchorV2BisaDiverifikasi(t *testing.T) {
	server, config, _ := newV2TestServer(t)

	response, err := http.Get(server.URL + "/distinguished")
	if err != nil {
		t.Fatalf("GET /distinguished: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	frames := splitFramed(t, readAll(t, response.Body))
	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		t.Fatalf("urai FullTreeHead: %v", err)
	}
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		t.Fatalf("urai condensed: %v", err)
	}
	if err := transparency.VerifySearch(
		newTestClientStorage(config.Public()),
		&tpb.TreeSearchRequest{SearchKey: []byte(DistinguishedSearchKey), Consistency: &tpb.Consistency{}},
		&tpb.TreeSearchResponse{
			TreeHead: fullTreeHead,
			Search:   condensed.Search,
			Opening:  condensed.Opening,
			Value:    condensed.Value,
		},
	); err != nil {
		t.Fatalf("verifikasi distinguished v2 gagal: %v", err)
	}
}

func TestUpdateServiceV2MenulisLewatPohonYangSama(t *testing.T) {
	config := testConfig(t)
	store := db.NewMemoryTransparencyStore()
	updates := &updateService{cfg: config, store: store, mu: &sync.Mutex{}}

	searchKey := append([]byte{PrefixSearchKeyUsernameHash}, bytes.Repeat([]byte{0x7e}, 32)...)
	if _, err := updates.Update(t.Context(), &tpb.UpdateRequest{
		SearchKey:            searchKey,
		Value:                nyxValueV2(1, 0x22),
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	tree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}
	response, err := tree.Search(&tpb.TreeSearchRequest{SearchKey: searchKey, Consistency: &tpb.Consistency{}})
	if err != nil {
		t.Fatalf("search setelah update: %v", err)
	}
	if !bytes.Equal(response.Value.Value, nyxValueV2(1, 0x22)) {
		t.Error("nilai yang ditulis lewat gRPC tidak terbaca")
	}
}

func TestLoadConfigV2MenolakKunciYangSalah(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("tulis config: %v", err)
		}
		return path
	}
	valid := func(auditor string) string {
		return "api:\n" +
			"  signing-key: " + strings.Repeat("11", mldsa.PrivateKeySize) + "\n" +
			"  prefix-key: " + strings.Repeat("22", 32) + "\n" +
			"  opening-key: " + strings.Repeat("33", 32) + "\n" +
			"  distinguished: 1m\n" +
			auditor +
			"db:\n  file: /tmp/nyx-kt-v2-test\n"
	}

	path := write("valid.yaml", valid(""))
	config, parsed, err := loadConfig(path)
	if err != nil {
		t.Fatalf("config valid ditolak: %v", err)
	}
	if config.Mode != transparency.ContactMonitoring {
		t.Errorf("mode = %d, ingin ContactMonitoring", config.Mode)
	}
	if len(parsed.API.SigningKey) == 0 {
		t.Error("config tidak terurai")
	}

	short := write("short.yaml", valid("  auditors:\n    aud: "+strings.Repeat("44", 32)+"\n"))
	if _, _, err := loadConfig(short); err == nil {
		t.Error("kunci auditor 32 byte seharusnya ditolak (v2 butuh 1952 byte)")
	}

	long := write("long.yaml", valid("  auditors:\n    aud: "+strings.Repeat("44", mldsa.MLDSA65PublicKeySize)+"\n"))
	config, _, err = loadConfig(long)
	if err != nil {
		t.Fatalf("config auditor v2 ditolak: %v", err)
	}
	if config.Mode != transparency.ThirdPartyAuditing {
		t.Errorf("mode = %d, ingin ThirdPartyAuditing", config.Mode)
	}
	if len(config.AuditorKeys) != 1 {
		t.Errorf("jumlah auditor = %d, ingin 1", len(config.AuditorKeys))
	}
}
