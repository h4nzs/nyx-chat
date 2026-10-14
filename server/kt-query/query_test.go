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
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/protobuf/proto"
)

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func testPrivateConfig(t *testing.T) *transparency.PrivateConfig {
	t.Helper()
	vrfKey, err := edvrf.NewVRFSigner(bytes.Repeat([]byte{0x02}, 32))
	if err != nil {
		t.Fatalf("buat kunci VRF: %v", err)
	}
	return &transparency.PrivateConfig{
		Mode:         transparency.ContactMonitoring,
		SigKey:       ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x01}, ed25519.SeedSize)),
		VrfKey:       vrfKey,
		PrefixAesKey: bytes.Repeat([]byte{0x03}, 32),
		OpeningKey:   bytes.Repeat([]byte{0x04}, 32),
	}
}

// nyxLogValue membangun nilai log format NYX v1 (docs/32 §32.2): 1286 byte,
// byte pertama 0x01 — nilai inilah yang membuat query service upstream
// mengembalikan error internal (lihat dokumentasi paket di store.go).
func nyxLogValue(keyVersion byte, identityKey byte) []byte {
	value := make([]byte, 0, 1286)
	value = append(value, 0x01, keyVersion)
	value = append(value, bytes.Repeat([]byte{identityKey}, 32)...)
	value = append(value, bytes.Repeat([]byte{0x22}, 1216)...)
	value = append(value, bytes.Repeat([]byte{0x33}, 32)...)
	value = append(value, 0x00, 0x00, 0x4e, 0xb1)
	return value
}

func usernameHash(seed byte) []byte { return bytes.Repeat([]byte{seed}, 32) }

func nyxSearchKey(hash []byte) []byte {
	return append([]byte{PrefixSearchKeyUsernameHash}, hash...)
}

type memTreeSource struct {
	config *transparency.PrivateConfig
	tree   *transparency.Tree
}

func (m *memTreeSource) Tree() (*transparency.Tree, error)  { return m.tree, nil }
func (m *memTreeSource) Public() *transparency.PublicConfig { return m.config.Public() }
func (m *memTreeSource) Close() error                       { return nil }

// newTestServer membangun pohon in-memory dengan dua entri NYX (keyVersion 1 dan
// rotasi 2) plus entri `distinguished`, lalu membungkusnya sebagai handler.
func newTestServer(t *testing.T) (*httptest.Server, *transparency.PrivateConfig, []byte) {
	t.Helper()

	config := testPrivateConfig(t)
	store := db.NewMemoryTransparencyStore()
	tree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}

	hash := usernameHash(0x5a)
	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            nyxSearchKey(hash),
		Value:                nyxLogValue(1, 0x11),
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri v1: %v", err)
	}
	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            nyxSearchKey(hash),
		Value:                nyxLogValue(2, 0x44),
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri v2: %v", err)
	}
	if _, err := tree.UpdateSimple(&tpb.UpdateRequest{
		SearchKey:            []byte(DistinguishedSearchKey),
		Value:                []byte{0x00, 0x11, 0x22},
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}); err != nil {
		t.Fatalf("tulis entri distinguished: %v", err)
	}

	source := &memTreeSource{config: config, tree: tree}
	server := httptest.NewServer((&queryServer{source: source}).routes())
	t.Cleanup(server.Close)
	return server, config, hash
}

// ---------------------------------------------------------------------------
// Client storage upstream (untuk verifikasi — inilah yang dilakukan crate Rust
// `libsignal-keytrans` di WASM, lewat `transparency.VerifySearch`)
// ---------------------------------------------------------------------------

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

// splitFramed membaca `u32 len || payload` berurutan.
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

// ---------------------------------------------------------------------------
// Tes
// ---------------------------------------------------------------------------

func TestConfigMenyingkapKunciPublikNYX(t *testing.T) {
	server, config, _ := newTestServer(t)

	response, err := http.Get(server.URL + "/config")
	if err != nil {
		t.Fatalf("GET /config: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}

	var payload struct {
		Mode            int      `json:"mode"`
		SignatureKey    string   `json:"signatureKey"`
		VRFKey          string   `json:"vrfKey"`
		AuditorKeys     []string `json:"auditorKeys"`
		SearchKeyPrefix string   `json:"searchKeyPrefix"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("urai JSON: %v", err)
	}

	public := config.Public()
	if payload.SignatureKey != hex.EncodeToString(public.SigKey) {
		t.Errorf("signatureKey tidak cocok dengan konfigurasi pohon")
	}
	if payload.SearchKeyPrefix != "75" {
		t.Errorf("searchKeyPrefix = %q, ingin 75", payload.SearchKeyPrefix)
	}
	if payload.Mode != int(transparency.ContactMonitoring) {
		t.Errorf("mode = %d, ingin %d", payload.Mode, transparency.ContactMonitoring)
	}
	if len(payload.VRFKey) != 64 {
		t.Errorf("vrfKey tidak 32 byte hex: %q", payload.VRFKey)
	}
}

// Tes inti: bukti yang disajikan adapter untuk **nilai format NYX** harus lolos
// verifikasi klien upstream — jalur yang sama dengan `verify_search` di WASM.
// Dengan query service upstream, permintaan ini bahkan tidak sampai ke tahap
// verifikasi (dijawab `permission denied` / error internal, docs/32 §32.8).
func TestSearchNilaiNYXLolosVerifikasiUpstream(t *testing.T) {
	server, config, hash := newTestServer(t)

	url := server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash)
	response, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	body := readAll(t, response.Body)
	frames := splitFramed(t, body)
	if len(frames) != 2 {
		t.Fatalf("jumlah frame = %d, ingin 2", len(frames))
	}

	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		t.Fatalf("urai FullTreeHead: %v", err)
	}
	if fullTreeHead.TreeHead == nil || fullTreeHead.TreeHead.TreeSize == 0 {
		t.Fatalf("tree head kosong")
	}

	// Bentuk condensed memakai nomor field tersendiri (vrf_proof=1, search=2,
	// opening=3, value=4) — bukan `TreeSearchResponse` internal (yang menaruh
	// tree_head di field 1). Inilah sebabnya WASM melakukan re-tag protobuf.
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		t.Fatalf("urai condensed: %v", err)
	}

	searchResponse := &tpb.TreeSearchResponse{
		TreeHead: fullTreeHead,
		VrfProof: condensed.VrfProof,
		Search:   condensed.Search,
		Opening:  condensed.Opening,
		Value:    condensed.Value,
	}

	storage := newTestClientStorage(config.Public())
	if err := transparency.VerifySearch(
		storage,
		&tpb.TreeSearchRequest{SearchKey: nyxSearchKey(hash), Consistency: &tpb.Consistency{}},
		searchResponse,
	); err != nil {
		t.Fatalf("verifikasi upstream menolak bukti adapter: %v", err)
	}
	if storage.head == nil {
		t.Fatal("verifikasi tidak menyimpan tree head")
	}

	// Nilai yang diterima harus tepat nilai NYX v1 yang ditulis (rotasi terakhir).
	value := searchResponse.Value.Value
	if len(value) != 1286 {
		t.Fatalf("panjang nilai = %d, ingin 1286", len(value))
	}
	if value[0] != 0x01 || value[1] != 0x02 {
		t.Fatalf("nilai bukan format NYX v1 terbaru: %x", value[:2])
	}
	if !bytes.Equal(value[2:34], bytes.Repeat([]byte{0x44}, 32)) {
		t.Fatal("identity key bukan hasil rotasi")
	}
}

func TestSearchHashTidakDikenalMenghasilkanNotFound(t *testing.T) {
	server, _, _ := newTestServer(t)

	hash := usernameHash(0x7e)
	response, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, ingin 404", response.StatusCode)
	}
	if !strings.Contains(readAllString(t, response.Body), "NOT_FOUND") {
		t.Fatal("kode error bukan NOT_FOUND")
	}
}

func TestSearchMenolakSearchKeyDiLuarNamespaceNYX(t *testing.T) {
	server, _, _ := newTestServer(t)

	cases := map[string]string{
		"prefix Signal aci":  base64.RawURLEncoding.EncodeToString(append([]byte{'a'}, bytes.Repeat([]byte{0x01}, 16)...)),
		"panjang hash salah": base64.RawURLEncoding.EncodeToString(append([]byte{PrefixSearchKeyUsernameHash}, bytes.Repeat([]byte{0x01}, 31)...)),
		"prefix angka":       base64.RawURLEncoding.EncodeToString(append([]byte{'n'}, bytes.Repeat([]byte{0x01}, 32)...)),
	}
	for name, encoded := range cases {
		t.Run(name, func(t *testing.T) {
			response, err := http.Get(server.URL + "/search?key=" + encoded)
			if err != nil {
				t.Fatalf("GET /search: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, ingin 400", response.StatusCode)
			}
		})
	}
}

func TestSearchMenolakParameterKosongDanGanda(t *testing.T) {
	server, _, hash := newTestServer(t)
	encoded := base64.RawURLEncoding.EncodeToString(hash)

	for _, path := range []string{
		"/search",
		"/search?hash=" + encoded + "&key=" + encoded,
		"/search?hash=" + encoded + "&last=abc",
	} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s → status %d, ingin 400", path, response.StatusCode)
		}
	}
}

// Anchor: `/distinguished` harus bisa dipakai sebelum klien tahu kontak mana pun.
func TestDistinguishedAnchorBisaDiverifikasi(t *testing.T) {
	server, config, _ := newTestServer(t)

	response, err := http.Get(server.URL + "/distinguished")
	if err != nil {
		t.Fatalf("GET /distinguished: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	frames := splitFramed(t, readAll(t, response.Body))
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

	storage := newTestClientStorage(config.Public())
	if err := transparency.VerifySearch(
		storage,
		&tpb.TreeSearchRequest{SearchKey: []byte(DistinguishedSearchKey), Consistency: &tpb.Consistency{}},
		&tpb.TreeSearchResponse{
			TreeHead: fullTreeHead,
			VrfProof: condensed.VrfProof,
			Search:   condensed.Search,
			Opening:  condensed.Opening,
			Value:    condensed.Value,
		},
	); err != nil {
		t.Fatalf("verifikasi distinguished gagal: %v", err)
	}
}

// Monitor: bukti harus bisa dihasilkan untuk search key NYX dan diverifikasi
// klien upstream. Permintaan dibangun seperti `kt-client monitor`: commitment
// index = keluaran VRF dari bukti search terakhir.
func TestMonitorSearchKeyNYXBisaDiverifikasi(t *testing.T) {
	server, config, hash := newTestServer(t)

	// 1) Search dulu: klien butuh commitment index + posisi entri.
	response, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	frames := splitFramed(t, readAll(t, response.Body))
	response.Body.Close()

	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		t.Fatalf("urai FullTreeHead: %v", err)
	}
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		t.Fatalf("urai condensed: %v", err)
	}
	if condensed.Search == nil {
		t.Fatal("search proof hilang")
	}

	searchKey := nyxSearchKey(hash)
	commitmentIndex, err := config.Public().VrfKey.ECVRFVerify(searchKey, condensed.VrfProof)
	if err != nil {
		t.Fatalf("hitung commitment index: %v", err)
	}

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

	// 2) Minta bukti monitor.
	postResponse, err := http.Post(server.URL+"/monitor", "application/octet-stream", bytes.NewReader(encodedRequest))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	defer postResponse.Body.Close()
	if postResponse.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", postResponse.StatusCode, readAllString(t, postResponse.Body))
	}
	monitorResponse := &tpb.MonitorResponse{}
	if err := proto.Unmarshal(readAll(t, postResponse.Body), monitorResponse); err != nil {
		t.Fatalf("urai monitor response: %v", err)
	}
	if len(monitorResponse.Proofs) != 1 {
		t.Fatalf("jumlah proof = %d, ingin 1", len(monitorResponse.Proofs))
	}
	if monitorResponse.TreeHead == nil || monitorResponse.TreeHead.TreeHead == nil {
		t.Fatal("tree head monitor hilang")
	}

	// 3) Verifikasi dengan klien upstream (storage yang sama dengan langkah 1).
	storage := newTestClientStorage(config.Public())
	if err := transparency.VerifySearch(
		storage,
		&tpb.TreeSearchRequest{SearchKey: searchKey, Consistency: &tpb.Consistency{}},
		&tpb.TreeSearchResponse{
			TreeHead: fullTreeHead,
			VrfProof: condensed.VrfProof,
			Search:   condensed.Search,
			Opening:  condensed.Opening,
			Value:    condensed.Value,
		},
	); err != nil {
		t.Fatalf("verifikasi search prasyarat gagal: %v", err)
	}
	if err := transparency.VerifyMonitor(storage, monitorRequest, monitorResponse); err != nil {
		t.Fatalf("verifikasi monitor upstream menolak bukti adapter: %v", err)
	}
}

func TestMonitorMenolakRequestKosongDanKeyAsing(t *testing.T) {
	server, _, _ := newTestServer(t)

	// Kosong.
	empty, err := proto.Marshal(&tpb.MonitorRequest{Consistency: &tpb.Consistency{}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	response, err := http.Post(server.URL+"/monitor", "application/octet-stream", bytes.NewReader(empty))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("request kosong → status %d, ingin 400", response.StatusCode)
	}

	// Konsistensi hilang.
	missingConsistency, err := proto.Marshal(&tpb.MonitorRequest{Keys: []*tpb.MonitorKey{{
		SearchKey: nyxSearchKey(usernameHash(0x5a)),
	}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	response, err = http.Post(server.URL+"/monitor", "application/octet-stream", bytes.NewReader(missingConsistency))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("tanpa consistency → status %d, ingin 400", response.StatusCode)
	}

	// Search key di luar namespace NYX.
	foreign, err := proto.Marshal(&tpb.MonitorRequest{
		Keys:        []*tpb.MonitorKey{{SearchKey: append([]byte{'a'}, bytes.Repeat([]byte{0x01}, 16)...)}},
		Consistency: &tpb.Consistency{},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	response, err = http.Post(server.URL+"/monitor", "application/octet-stream", bytes.NewReader(foreign))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("key asing → status %d, ingin 400", response.StatusCode)
	}

	// Body rusak.
	response, err = http.Post(server.URL+"/monitor", "application/octet-stream", strings.NewReader("bukan protobuf"))
	if err != nil {
		t.Fatalf("POST /monitor: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("body rusak → status %d, ingin 400", response.StatusCode)
	}
}

func TestParseTreeSize(t *testing.T) {
	if value, err := parseTreeSize(""); err != nil || value != nil {
		t.Errorf("kosong → (%v, %v), ingin (nil, nil)", value, err)
	}
	if value, err := parseTreeSize("0"); err != nil || value != nil {
		t.Errorf("nol → (%v, %v), ingin (nil, nil)", value, err)
	}
	value, err := parseTreeSize("64")
	if err != nil || value == nil || *value != 64 {
		t.Errorf("64 → (%v, %v)", value, err)
	}
	if _, err := parseTreeSize("abc"); err == nil {
		t.Error("angka tidak sah harus error")
	}
}

func readAll(t *testing.T, reader interface{ Read([]byte) (int, error) }) []byte {
	t.Helper()
	var buffer bytes.Buffer
	chunk := make([]byte, 4096)
	for {
		n, err := reader.Read(chunk)
		buffer.Write(chunk[:n])
		if err != nil {
			return buffer.Bytes()
		}
	}
}

func readAllString(t *testing.T, reader interface{ Read([]byte) (int, error) }) string {
	t.Helper()
	return string(readAll(t, reader))
}
