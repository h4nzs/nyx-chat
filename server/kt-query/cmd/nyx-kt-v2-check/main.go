// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Command nyx-kt-v2-check memverifikasi bukti log Key Transparency v2 **dari
// luar** layanan — pengganti `nyx-kt-check` v1 yang dihapus bersama pensiunnya
// log v1 (`docs/38` §38.2 baris 5).
//
// Kenapa alat ini ada: drill pemulihan (`scripts/kt-v2-restore-drill.sh`) harus
// membuktikan bahwa bukti yang disajikan instance hasil pulih **lolos verifier
// yang sama** dengan yang dipakai klien, bukan sekadar "layanan menjawab 200".
// Verifikasi di sini memakai `transparency.VerifySearch`, fungsi yang sama yang
// dikompilasi menjadi `verify_search` di WASM klien (`packages/keytrans-wasm-v2`,
// `docs/34` §34.2) — bukan pemeriksaan buatan drill.
//
// Alat ini juga menyimpan **anchor** klien (tree size + root terakhir yang
// dipercaya) di satu berkas JSON. Anchor itulah yang membuat langkah
// "log tumbuh tanpa percabangan" bisa diuji: klien yang selamat dari bencana
// memegang anchor lama, dan bukti konsistensi harus bisa diverifikasi terhadap
// anchor itu. Tanpa anchor, verifikasi hanya membuktikan "pohon ini sah",
// bukan "pohon ini adalah lanjutan dari yang sudah saya lihat".
//
// Subcommand:
//
//	nyx-kt-v2-check config        -url http://127.0.0.1:18089 [-expect-abi 2]
//	nyx-kt-v2-check head          -url … [-expect-size N] [-expect-root hex]
//	nyx-kt-v2-check verify-search -url … (-hash b64url | -key b64url)
//	                              [-expect-value hex] [-anchor file] [-config cfg.yaml]
//	nyx-kt-v2-check tree-size     -addr 127.0.0.1:18087
//	nyx-kt-v2-check audit         -addr 127.0.0.1:18087 -start 0 -limit 100
//
// Sumber kunci publik log: `-config` (berkas config kt-server yang sama dengan
// yang dipakai layanan, hanya `api.signing-key`/`api.auditors` yang dibaca) atau
// `-signature-key` (hex ML-DSA-65 langsung). Memberi kunci yang **berbeda** dari
// kunci log adalah kontrol negatif yang disengaja: alat ini harus menolak tree
// head yang ditandatangani kunci lain, karena itulah yang membuat snapshot
// tanpa kunci tidak berguna.
package main

import (
	"bytes"
	"context"
	"crypto/mldsa"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
	"gopkg.in/yaml.v2"

	pb "github.com/signalapp/keytransparency/cmd/kt-server/pb"
	"github.com/signalapp/keytransparency/db"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
)

const httpTimeout = 20 * time.Second

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	command := os.Args[1]
	args := os.Args[2:]

	var err error
	switch command {
	case "config":
		err = runConfig(args)
	case "head":
		err = runHead(args)
	case "verify-search":
		err = runVerifySearch(args)
	case "tree-size":
		err = runTreeSize(args)
	case "audit":
		err = runAudit(args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `nyx-kt-v2-check — verifier bukti log Key Transparency v2

  config        -url URL [-expect-abi N]
  head          -url URL [-expect-size N] [-expect-root HEX]
  verify-search -url URL (-hash B64URL | -key B64URL) [-expect-value HEX]
                [-anchor FILE] [-config CONFIG_YAML | -signature-key HEX]
  tree-size     -addr HOST:PORT
  audit         -addr HOST:PORT [-start N] [-limit N]
`)
}

// ---------------------------------------------------------------------------
// HTTP: /config, /head, /search
// ---------------------------------------------------------------------------

type configResponse struct {
	Mode           int      `json:"mode"`
	SignatureKey   string   `json:"signatureKey"`
	AuditorKeys    []string `json:"auditorKeys"`
	ValueFormat    string   `json:"valueFormat"`
	ABIVersion     int      `json:"abiVersion"`
	SearchKeyPrefix string  `json:"searchKeyPrefix"`
}

func fetchJSON(url string, out any) error {
	client := &http.Client{Timeout: httpTimeout}
	response, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("GET %s: status %d: %s", url, response.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return fmt.Errorf("urai JSON dari %s: %w", url, err)
	}
	return nil
}

func runConfig(args []string) error {
	flags := flag.NewFlagSet("config", flag.ContinueOnError)
	url := flags.String("url", "http://127.0.0.1:18089", "basis URL layanan baca")
	expectABI := flags.Int("expect-abi", 0, "gagal bila abiVersion berbeda dari nilai ini")
	if err := flags.Parse(args); err != nil {
		return err
	}

	var payload configResponse
	if err := fetchJSON(strings.TrimRight(*url, "/")+"/config", &payload); err != nil {
		return err
	}
	if *expectABI != 0 && payload.ABIVersion != *expectABI {
		return fmt.Errorf("abiVersion=%d, ingin %d", payload.ABIVersion, *expectABI)
	}
	if payload.ValueFormat != "nyx-kt-value-v2" {
		return fmt.Errorf("valueFormat=%q, ingin nyx-kt-value-v2", payload.ValueFormat)
	}
	fmt.Printf("OK config mode=%d abiVersion=%d valueFormat=%s signatureKeyBytes=%d auditors=%d\n",
		payload.Mode, payload.ABIVersion, payload.ValueFormat, len(payload.SignatureKey)/2, len(payload.AuditorKeys))
	return nil
}

type headResponse struct {
	TreeSize  uint64 `json:"treeSize"`
	Timestamp int64  `json:"timestamp"`
	Root      string `json:"root"`
}

func runHead(args []string) error {
	flags := flag.NewFlagSet("head", flag.ContinueOnError)
	url := flags.String("url", "http://127.0.0.1:18089", "basis URL layanan baca")
	expectSize := flags.Uint64("expect-size", 0, "gagal bila tree size berbeda")
	expectRoot := flags.String("expect-root", "", "gagal bila root (hex) berbeda")
	if err := flags.Parse(args); err != nil {
		return err
	}

	var head headResponse
	if err := fetchJSON(strings.TrimRight(*url, "/")+"/head", &head); err != nil {
		return err
	}
	if *expectSize != 0 && head.TreeSize != *expectSize {
		return fmt.Errorf("tree size=%d, ingin %d", head.TreeSize, *expectSize)
	}
	if *expectRoot != "" && !strings.EqualFold(head.Root, *expectRoot) {
		return fmt.Errorf("root=%s, ingin %s", head.Root, *expectRoot)
	}
	fmt.Printf("OK head treeSize=%d root=%s timestamp=%d\n", head.TreeSize, head.Root, head.Timestamp)
	return nil
}

// readFrames memecah body `u32 len || payload` berulang (bentuk yang ditulis
// `query.go` untuk /search dan /distinguished).
func readFrames(body []byte) ([][]byte, error) {
	var frames [][]byte
	offset := 0
	for offset < len(body) {
		if offset+4 > len(body) {
			return nil, fmt.Errorf("frame terpotong di offset %d", offset)
		}
		length := int(binary.BigEndian.Uint32(body[offset : offset+4]))
		offset += 4
		if length < 0 || offset+length > len(body) {
			return nil, fmt.Errorf("payload terpotong di offset %d (len=%d)", offset, length)
		}
		frames = append(frames, body[offset:offset+length])
		offset += length
	}
	return frames, nil
}

// ---------------------------------------------------------------------------
// Anchor klien: satu-satunya bukti bahwa log ini LANJUTAN dari yang sudah
// dilihat klien, bukan pohon lain dengan ukuran berapa pun.
// ---------------------------------------------------------------------------

type anchorFile struct {
	TreeSize  uint64 `json:"treeSize"`
	Timestamp int64  `json:"timestamp"`
	Root      string `json:"root"`
}

type anchorStorage struct {
	cfg  *transparency.PublicConfig
	path string
	head *db.TransparencyTreeHead
	root []byte
}

func loadAnchorStorage(path string, cfg *transparency.PublicConfig) (*anchorStorage, error) {
	storage := &anchorStorage{cfg: cfg, path: path}
	if path == "" {
		return storage, nil
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return storage, nil
	}
	if err != nil {
		return nil, fmt.Errorf("baca anchor %s: %w", path, err)
	}
	var anchor anchorFile
	if err := json.Unmarshal(raw, &anchor); err != nil {
		return nil, fmt.Errorf("anchor %s bukan JSON yang sah: %w", path, err)
	}
	root, err := hex.DecodeString(anchor.Root)
	if err != nil {
		return nil, fmt.Errorf("root di anchor bukan hex: %w", err)
	}
	storage.head = &db.TransparencyTreeHead{TreeSize: anchor.TreeSize, Timestamp: anchor.Timestamp}
	storage.root = root
	return storage, nil
}

func (s *anchorStorage) PublicConfig() *transparency.PublicConfig { return s.cfg }

func (s *anchorStorage) GetLastTreeHead() (*db.TransparencyTreeHead, []byte, error) {
	return s.head, s.root, nil
}

func (s *anchorStorage) SetLastTreeHead(head *db.TransparencyTreeHead, root []byte) error {
	s.head, s.root = head, root
	if s.path == "" {
		return nil
	}
	payload, err := json.Marshal(anchorFile{
		TreeSize:  head.TreeSize,
		Timestamp: head.Timestamp,
		Root:      hex.EncodeToString(root),
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.path+".tmp", payload, 0o600); err != nil {
		return err
	}
	return os.Rename(s.path+".tmp", s.path)
}

func (s *anchorStorage) GetData([]byte) (*transparency.MonitoringData, error) { return nil, nil }

func (s *anchorStorage) SetData([]byte, *transparency.MonitoringData) error { return nil }

// ---------------------------------------------------------------------------
// Kunci publik log
// ---------------------------------------------------------------------------

// minimalConfig hanya membaca bagian yang menentukan kepercayaan: kunci tanda
// tangan log dan kunci auditor. Pembacaan ini sengaja terpisah dari
// `cmd/nyx-kt-query-v2/config.go` — alat verifikasi tidak boleh meminjam parser
// yang sama dengan pihak yang diverifikasi.
type minimalConfig struct {
	API struct {
		SigningKey string            `yaml:"signing-key"`
		Auditors   map[string]string `yaml:"auditors"`
	} `yaml:"api"`
}

func publicConfigFromFile(path string) (*transparency.PublicConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("baca config %s: %w", path, err)
	}
	var parsed minimalConfig
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("urai config %s: %w", path, err)
	}
	seed, err := hex.DecodeString(strings.TrimSpace(os.ExpandEnv(parsed.API.SigningKey)))
	if err != nil {
		return nil, fmt.Errorf("api.signing-key bukan hex: %w", err)
	}
	private, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), seed)
	if err != nil {
		return nil, fmt.Errorf("api.signing-key tidak sah: %w", err)
	}
	auditors := make(map[string]*mldsa.PublicKey, len(parsed.API.Auditors))
	for name, value := range parsed.API.Auditors {
		bytesValue, err := hex.DecodeString(strings.TrimSpace(os.ExpandEnv(value)))
		if err != nil {
			return nil, fmt.Errorf("auditor %s bukan hex: %w", name, err)
		}
		key, err := mldsa.NewPublicKey(mldsa.MLDSA65(), bytesValue)
		if err != nil {
			return nil, fmt.Errorf("auditor %s tidak sah: %w", name, err)
		}
		auditors[name] = key
	}
	mode := transparency.ContactMonitoring
	if len(auditors) > 0 {
		mode = transparency.ThirdPartyAuditing
	}
	return &transparency.PublicConfig{Mode: mode, SigKey: private.PublicKey(), AuditorKeys: auditors}, nil
}

func publicConfigFromKey(hexKey string) (*transparency.PublicConfig, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(hexKey))
	if err != nil {
		return nil, fmt.Errorf("signature-key bukan hex: %w", err)
	}
	key, err := mldsa.NewPublicKey(mldsa.MLDSA65(), raw)
	if err != nil {
		return nil, fmt.Errorf("signature-key tidak sah: %w", err)
	}
	return &transparency.PublicConfig{Mode: transparency.ContactMonitoring, SigKey: key}, nil
}

// ---------------------------------------------------------------------------
// verify-search
// ---------------------------------------------------------------------------

func runVerifySearch(args []string) error {
	flags := flag.NewFlagSet("verify-search", flag.ContinueOnError)
	url := flags.String("url", "http://127.0.0.1:18089", "basis URL layanan baca")
	hash := flags.String("hash", "", "base64url usernameHash (32 byte)")
	key := flags.String("key", "", "base64url search key mentah")
	expectValue := flags.String("expect-value", "", "hex nilai log yang diharapkan")
	anchorPath := flags.String("anchor", "", "berkas anchor klien (dibaca lalu diperbarui)")
	configPath := flags.String("config", "", "config kt-server (kunci publik log)")
	signatureKey := flags.String("signature-key", "", "hex kunci publik ML-DSA-65 log")
	consistentWith := flags.Uint64("consistent-with", 0, "uji konsistensi terhadap ukuran pohon ini (tanpa memakai anchor)")
	if err := flags.Parse(args); err != nil {
		return err
	}

	if (*hash == "") == (*key == "") {
		return errors.New("wajib salah satu: -hash atau -key")
	}
	var cfg *transparency.PublicConfig
	var err error
	switch {
	case *configPath != "" && *signatureKey != "":
		return errors.New("-config dan -signature-key tidak boleh bersamaan")
	case *configPath != "":
		cfg, err = publicConfigFromFile(*configPath)
	case *signatureKey != "":
		cfg, err = publicConfigFromKey(*signatureKey)
	default:
		return errors.New("wajib -config atau -signature-key (tanpa kunci, bukti tidak bisa dipercaya)")
	}
	if err != nil {
		return err
	}

	storage, err := loadAnchorStorage(*anchorPath, cfg)
	if err != nil {
		return err
	}
	if *consistentWith != 0 {
		// Mode uji konsistensi tanpa anchor: klien "menyatakan" sudah melihat
		// ukuran ini. Root-nya tidak diketahui, jadi hanya dipakai untuk
		// memastikan server MENOLAK permintaan yang mustahil (mis. setelah
		// rollback) — bukan untuk memverifikasi bukti.
		storage.head = &db.TransparencyTreeHead{TreeSize: *consistentWith}
		storage.root = nil
	}

	searchKey, err := resolveSearchKey(*hash, *key)
	if err != nil {
		return err
	}

	request := fmt.Sprintf("%s/search?key=%s", strings.TrimRight(*url, "/"), base64URL(searchKey))
	last := storage.head
	if last != nil && last.TreeSize > 0 {
		request += fmt.Sprintf("&last=%d", last.TreeSize)
	}

	client := &http.Client{Timeout: httpTimeout}
	response, err := client.Get(request)
	if err != nil {
		return fmt.Errorf("GET %s: %w", request, err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d: %s", request, response.StatusCode, strings.TrimSpace(string(body)))
	}

	frames, err := readFrames(body)
	if err != nil {
		return err
	}
	if len(frames) != 2 {
		return fmt.Errorf("jumlah frame = %d, ingin 2", len(frames))
	}

	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		return fmt.Errorf("urai FullTreeHead: %w", err)
	}
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		return fmt.Errorf("urai CondensedTreeSearchResponse: %w", err)
	}
	if condensed.Value == nil || condensed.Search == nil {
		return errors.New("respons tidak memuat bukti search/nilai")
	}

	searchResponse := &tpb.TreeSearchResponse{
		TreeHead: fullTreeHead,
		Search:   condensed.Search,
		Opening:  condensed.Opening,
		Value:    condensed.Value,
	}
	searchRequest := &tpb.TreeSearchRequest{SearchKey: searchKey, Consistency: &tpb.Consistency{}}
	if storage.head != nil && storage.head.TreeSize > 0 {
		searchRequest.Consistency.Last = proto.Uint64(storage.head.TreeSize)
	}

	if err := transparency.VerifySearch(storage, searchRequest, searchResponse); err != nil {
		return fmt.Errorf("verifikasi search GAGAL: %w", err)
	}

	value := condensed.Value.GetValue()
	if *expectValue != "" {
		want, err := hex.DecodeString(strings.TrimSpace(*expectValue))
		if err != nil {
			return fmt.Errorf("-expect-value bukan hex: %w", err)
		}
		if !bytes.Equal(value, want) {
			return fmt.Errorf("nilai tidak cocok: dapat %s… (%d byte)", hex.EncodeToString(value[:min(8, len(value))]), len(value))
		}
	}
	fmt.Printf("OK verify-search treeSize=%d valueBytes=%d anchor=%s\n",
		fullTreeHead.TreeHead.GetTreeSize(), len(value), describeAnchor(storage))
	return nil
}

func describeAnchor(storage *anchorStorage) string {
	if storage.head == nil {
		return "baru"
	}
	return fmt.Sprintf("%d/%s", storage.head.TreeSize, hex.EncodeToString(storage.root)[:min(16, len(hex.EncodeToString(storage.root)))])
}

func resolveSearchKey(hash, key string) ([]byte, error) {
	if key != "" {
		decoded, err := decodeBase64URL(key)
		if err != nil {
			return nil, fmt.Errorf("-key bukan base64url: %w", err)
		}
		return decoded, nil
	}
	decoded, err := decodeBase64URL(hash)
	if err != nil {
		return nil, fmt.Errorf("-hash bukan base64url: %w", err)
	}
	if len(decoded) != 32 {
		return nil, fmt.Errorf("-hash harus 32 byte, dapat %d", len(decoded))
	}
	// 0x75 = `UsernameHashPrefix`, sama dengan `KT_USERNAME_HASH_PREFIX` di
	// `server/src/utils/keyTransparency.ts`.
	return append([]byte{0x75}, decoded...), nil
}

func decodeBase64URL(value string) ([]byte, error) {
	trimmed := strings.TrimRight(value, "=")
	decoded, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, err
	}
	if len(decoded) == 0 {
		return nil, errors.New("kosong")
	}
	return decoded, nil
}

func base64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

// ---------------------------------------------------------------------------
// Layanan auditor (gRPC)
// ---------------------------------------------------------------------------

func dialAuditor(addr string) (*grpc.ClientConn, error) {
	return grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
}

func runTreeSize(args []string) error {
	flags := flag.NewFlagSet("tree-size", flag.ContinueOnError)
	addr := flags.String("addr", "127.0.0.1:18087", "alamat gRPC auditor")
	if err := flags.Parse(args); err != nil {
		return err
	}
	conn, err := dialAuditor(*addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	response, err := pb.NewKeyTransparencyAuditorServiceClient(conn).TreeSize(ctx, &emptypb.Empty{})
	if err != nil {
		return fmt.Errorf("TreeSize: %w", err)
	}
	fmt.Printf("OK tree-size treeSize=%d\n", response.GetTreeSize())
	return nil
}

func runAudit(args []string) error {
	flags := flag.NewFlagSet("audit", flag.ContinueOnError)
	addr := flags.String("addr", "127.0.0.1:18087", "alamat gRPC auditor")
	start := flags.Uint64("start", 0, "posisi awal")
	limit := flags.Uint64("limit", 100, "jumlah update")
	if err := flags.Parse(args); err != nil {
		return err
	}
	conn, err := dialAuditor(*addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	response, err := pb.NewKeyTransparencyAuditorServiceClient(conn).Audit(ctx, &pb.AuditRequest{Start: *start, Limit: *limit})
	if err != nil {
		return fmt.Errorf("Audit: %w", err)
	}
	fmt.Printf("OK audit updates=%d more=%t\n", len(response.GetUpdates()), response.GetMore())
	return nil
}
