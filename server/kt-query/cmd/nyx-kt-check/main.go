// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Command nyx-kt-check memeriksa layanan Key Transparency NYX dari luar, memakai
// **kode upstream apa adanya** — bukan tafsiran kami:
//
//   - `verify-search` memanggil `transparency.VerifySearch`, fungsi yang sama
//     yang dikompilasi crate Rust `libsignal-keytrans` menjadi `verify_search`
//     di WASM klien (`docs/34` §34.2). Jadi "bukti masih sah" di sini bukan
//     klaim kami tentang byte kami sendiri.
//   - `tree-size`/`audit` berbicara protokol `KeyTransparencyAuditorService`
//     upstream (stub protobuf yang di-vendor), menggantikan `cmd/kt-client`
//     upstream yang tidak ter-vendor karena `package main` (`docs/34` §34.6b).
//
// Kenapa alat ini ada: dua residual KT yang sebelumnya hanya bisa dijelaskan
// dengan kata-kata — "gate interop tidak dijalankan" dan "pemulihan dari arsip
// belum pernah dibuktikan" — jadi bisa **dijalankan dan gagal dengan exit code**.
// Dipakai `scripts/kt-restore-drill.sh` dan job CI `kt-recovery`.
package main

import (
	"context"
	"crypto/ed25519"
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

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"
)

const (
	// PrefixSearchKeyUsernameHash = 0x75, sama dengan layanan baca (`query.go`).
	PrefixSearchKeyUsernameHash = 0x75
	// httpTimeout membatasi setiap permintaan HTTP: layanan ini loopback, jadi
	// timeout panjang hanya akan menyembunyikan proses yang menggantung.
	httpTimeout = 15 * time.Second
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "head":
		err = runHead(os.Args[2:])
	case "config":
		err = runConfig(os.Args[2:])
	case "verify-search":
		err = runVerifySearch(os.Args[2:])
	case "tree-size":
		err = runTreeSize(os.Args[2:])
	case "audit":
		err = runAudit(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "❌ subperintah tidak dikenal: %s\n", os.Args[1])
		usage()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `nyx-kt-check — pemeriksa layanan Key Transparency NYX (kode verifikasi upstream)

  head          -url <base> [-expect-size N] [-expect-root HEX]
  config        -url <base>
  verify-search -url <base> (-hash <b64url32> | -key <b64url>) [-last N] [-distinguished N]
  tree-size     -addr <auditor-grpc-addr>
  audit         -addr <auditor-grpc-addr> [-start 0] [-limit 1000]

Semua perintah keluar dengan status ≠ 0 bila pemeriksaan gagal.
`)
	os.Exit(2)
}

// ---------------------------------------------------------------------------
// HTTP: /head, /config, /search
// ---------------------------------------------------------------------------

type headPayload struct {
	TreeSize  uint64 `json:"treeSize"`
	Timestamp uint64 `json:"timestamp"`
	Root      string `json:"root"`
}

type configPayload struct {
	Mode            int      `json:"mode"`
	SignatureKey    string   `json:"signatureKey"`
	VRFKey          string   `json:"vrfKey"`
	AuditorKeys     []string `json:"auditorKeys"`
	SearchKeyPrefix string   `json:"searchKeyPrefix"`
}

func getJSON[T any](base, path string) (*T, error) {
	client := &http.Client{Timeout: httpTimeout}
	response, err := client.Get(strings.TrimRight(base, "/") + path)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("GET %s: status %d: %s", path, response.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload T
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("GET %s: urai JSON: %w", path, err)
	}
	return &payload, nil
}

func runHead(args []string) error {
	flags := flag.NewFlagSet("head", flag.ExitOnError)
	url := flags.String("url", "http://127.0.0.1:8085", "basis URL layanan baca")
	expectSize := flags.Uint64("expect-size", 0, "gagal bila treeSize ≠ nilai ini (0 = tidak diperiksa)")
	expectRoot := flags.String("expect-root", "", "gagal bila root ≠ hex ini (kosong = tidak diperiksa)")
	_ = flags.Parse(args)

	head, err := getJSON[headPayload](*url, "/head")
	if err != nil {
		return err
	}
	fmt.Printf("treeSize=%d root=%s\n", head.TreeSize, head.Root)

	if *expectSize != 0 && head.TreeSize != *expectSize {
		return fmt.Errorf("treeSize berubah: dapat %d, ingin %d", head.TreeSize, *expectSize)
	}
	if *expectRoot != "" && !strings.EqualFold(head.Root, *expectRoot) {
		return fmt.Errorf("root berubah: dapat %s, ingin %s", head.Root, *expectRoot)
	}
	return nil
}

func runConfig(args []string) error {
	flags := flag.NewFlagSet("config", flag.ExitOnError)
	url := flags.String("url", "http://127.0.0.1:8085", "basis URL layanan baca")
	_ = flags.Parse(args)

	config, err := getJSON[configPayload](*url, "/config")
	if err != nil {
		return err
	}
	fmt.Printf("mode=%d signatureKey=%s vrfKey=%s searchKeyPrefix=%s auditorKeys=%d\n",
		config.Mode, config.SignatureKey, config.VRFKey, config.SearchKeyPrefix, len(config.AuditorKeys))
	return nil
}

// clientStorage adalah `transparency.ClientStorage` in-memory: cukup untuk satu
// verifikasi tanpa state (anchor boleh dikosongkan, dan bila `-last`/`-distinguished`
// diisi klien memverifikasi bukti konsistensi terhadap ukuran pohon itu).
type clientStorage struct {
	config *transparency.PublicConfig
	head   *db.TransparencyTreeHead
	root   []byte
	data   map[string]*transparency.MonitoringData
}

func newClientStorage(config *transparency.PublicConfig) *clientStorage {
	return &clientStorage{config: config, data: map[string]*transparency.MonitoringData{}}
}

func (s *clientStorage) PublicConfig() *transparency.PublicConfig { return s.config }

func (s *clientStorage) GetLastTreeHead() (*db.TransparencyTreeHead, []byte, error) {
	return s.head, s.root, nil
}

func (s *clientStorage) SetLastTreeHead(head *db.TransparencyTreeHead, root []byte) error {
	s.head, s.root = head, root
	return nil
}

func (s *clientStorage) GetData(key []byte) (*transparency.MonitoringData, error) {
	return s.data[hex.EncodeToString(key)], nil
}

func (s *clientStorage) SetData(key []byte, data *transparency.MonitoringData) error {
	s.data[hex.EncodeToString(key)] = data
	return nil
}

// publicConfigFromService membangun `PublicConfig` dari `/config`. Nama auditor
// tidak dikirim endpoint itu (hanya kunci publiknya) dan memang tidak dibutuhkan
// verifikasi: upstream mencocokkan kunci berdasarkan **byte**, bukan nama.
func publicConfigFromService(config *configPayload) (*transparency.PublicConfig, error) {
	sigKey, err := hex.DecodeString(config.SignatureKey)
	if err != nil {
		return nil, fmt.Errorf("signatureKey bukan hex: %w", err)
	}
	if len(sigKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("signatureKey %d byte, ingin %d", len(sigKey), ed25519.PublicKeySize)
	}
	vrfKey, err := hex.DecodeString(config.VRFKey)
	if err != nil {
		return nil, fmt.Errorf("vrfKey bukan hex: %w", err)
	}
	verifier, err := edvrf.NewVRFVerifier(ed25519.PublicKey(vrfKey))
	if err != nil {
		return nil, fmt.Errorf("vrfKey tidak sah: %w", err)
	}
	auditors := make(map[string]ed25519.PublicKey, len(config.AuditorKeys))
	for index, value := range config.AuditorKeys {
		raw, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("auditorKeys[%d] bukan hex: %w", index, err)
		}
		auditors[fmt.Sprintf("config-%d", index)] = ed25519.PublicKey(raw)
	}
	return &transparency.PublicConfig{
		Mode:        transparency.DeploymentMode(config.Mode),
		SigKey:      ed25519.PublicKey(sigKey),
		AuditorKeys: auditors,
		VrfKey:      verifier,
	}, nil
}

// splitFramed membaca `u32 len || payload` berurutan (bentuk yang sama dengan
// yang ditulis `appendFramed` di `query.go`).
func splitFramed(body []byte) ([][]byte, error) {
	var out [][]byte
	for offset := 0; offset < len(body); {
		if offset+4 > len(body) {
			return nil, fmt.Errorf("frame terpotong di offset %d", offset)
		}
		length := int(binary.BigEndian.Uint32(body[offset : offset+4]))
		offset += 4
		if offset+length > len(body) {
			return nil, fmt.Errorf("payload terpotong di offset %d (len=%d)", offset, length)
		}
		out = append(out, body[offset:offset+length])
		offset += length
	}
	return out, nil
}

// fetchSearchProof mengambil bukti `/search` (atau `/distinguished`) dan
// menyusunnya sebagai `TreeSearchResponse` yang bisa diverifikasi verifier
// upstream — `condensed` di-*re-tag* ke field bernama sama, seperti yang
// dilakukan modul WASM `libsignal-keytrans`.
func fetchSearchProof(base string, key []byte, last, distinguished uint64) (*tpb.TreeSearchResponse, error) {
	query := "?key=" + base64.RawURLEncoding.EncodeToString(key)
	if last > 0 {
		query += fmt.Sprintf("&last=%d", last)
	}
	if distinguished > 0 {
		query += fmt.Sprintf("&distinguished=%d", distinguished)
	}

	client := &http.Client{Timeout: httpTimeout}
	response, err := client.Get(strings.TrimRight(base, "/") + "/search" + query)
	if err != nil {
		return nil, fmt.Errorf("GET /search: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("GET /search: status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("baca /search: %w", err)
	}

	frames, err := splitFramed(body)
	if err != nil {
		return nil, err
	}
	if len(frames) != 2 {
		return nil, fmt.Errorf("jumlah frame = %d, ingin 2", len(frames))
	}
	fullTreeHead := &tpb.FullTreeHead{}
	if err := proto.Unmarshal(frames[0], fullTreeHead); err != nil {
		return nil, fmt.Errorf("urai FullTreeHead: %w", err)
	}
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		return nil, fmt.Errorf("urai condensed: %w", err)
	}
	return &tpb.TreeSearchResponse{
		TreeHead: fullTreeHead,
		VrfProof: condensed.VrfProof,
		Search:   condensed.Search,
		Opening:  condensed.Opening,
		Value:    condensed.Value,
	}, nil
}

// anchorFile meniru state klien KT: head + root terakhir yang sudah diverifikasi.
// Ini bukan kemewahan — tanpa anchor yang tersimpan, bukti konsistensi tidak bisa
// diverifikasi sama sekali (`verifyFullTreeHead` upstream menolak "consistency
// proof provided when not expected", temuan `docs/34` §34.5), jadi alat yang tidak
// menyimpan anchor tidak bisa membuktikan apa pun soal log yang tumbuh.
type anchorFile struct {
	TreeSize  uint64 `json:"treeSize"`
	Timestamp int64  `json:"timestamp"`
	Root      string `json:"root"`
}

func (s *clientStorage) loadAnchor(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("baca anchor %s: %w", path, err)
	}
	var anchor anchorFile
	if err := json.Unmarshal(raw, &anchor); err != nil {
		return fmt.Errorf("urai anchor %s: %w", path, err)
	}
	root, err := hex.DecodeString(anchor.Root)
	if err != nil {
		return fmt.Errorf("root anchor bukan hex: %w", err)
	}
	s.head = &db.TransparencyTreeHead{TreeSize: anchor.TreeSize, Timestamp: anchor.Timestamp}
	s.root = root
	return nil
}

func (s *clientStorage) saveAnchor(path string) error {
	if s.head == nil {
		return errors.New("tidak ada tree head untuk disimpan sebagai anchor")
	}
	payload, err := json.Marshal(anchorFile{
		TreeSize:  s.head.TreeSize,
		Timestamp: s.head.Timestamp,
		Root:      hex.EncodeToString(s.root),
	})
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func runVerifySearch(args []string) error {
	flags := flag.NewFlagSet("verify-search", flag.ExitOnError)
	url := flags.String("url", "http://127.0.0.1:8085", "basis URL layanan baca")
	hash := flags.String("hash", "", "base64url 32 byte usernameHash")
	key := flags.String("key", "", "base64url search key mentah")
	last := flags.Uint64("last", 0, "ukuran pohon terakhir yang dipercaya klien (bukti konsistensi)")
	distinguished := flags.Uint64("distinguished", 0, "ukuran pohon terakhir untuk anchor distinguished")
	expectValue := flags.String("expect-value", "", "bila diisi: hex nilai log yang diharapkan")
	anchorPath := flags.String("anchor", "", "berkas JSON anchor klien: dibaca sebagai head terakhir, ditulis ulang setelah verifikasi sukses")
	_ = flags.Parse(args)

	searchKey, err := resolveSearchKey(*hash, *key)
	if err != nil {
		return err
	}
	config, err := getJSON[configPayload](*url, "/config")
	if err != nil {
		return err
	}
	public, err := publicConfigFromService(config)
	if err != nil {
		return err
	}

	storage := newClientStorage(public)
	if *anchorPath != "" {
		if err := storage.loadAnchor(*anchorPath); err != nil {
			return err
		}
	}
	// Klien nyata selalu mengirim ukuran pohon yang sudah dipercayainya. Bila
	// anchor tersedia dan `-last` tidak diberikan, pakai anchor itu — inilah yang
	// membuat bukti konsistensi benar-benar diperiksa, bukan dilewati.
	if *last == 0 && storage.head != nil {
		*last = storage.head.TreeSize
	}

	proof, err := fetchSearchProof(*url, searchKey, *last, *distinguished)
	if err != nil {
		return err
	}

	if err := transparency.VerifySearch(storage, &tpb.TreeSearchRequest{
		SearchKey:   searchKey,
		Consistency: &tpb.Consistency{Last: optionalTreeSize(*last), Distinguished: optionalTreeSize(*distinguished)},
	}, proof); err != nil {
		return fmt.Errorf("verifikasi bukti GAGAL: %w", err)
	}

	// Nilai log datang sebagai `UpdateValue{Value []byte}`; yang dibandingkan
	// hanya ringkasannya (`UpdateValue` tidak punya accessor bebas).
	value := proof.GetValue().GetValue()
	valueHex := hex.EncodeToString(value)
	if *expectValue != "" && !strings.EqualFold(valueHex, *expectValue) {
		return fmt.Errorf("nilai log berbeda: dapat %d byte, ingin nilai %s", len(value), *expectValue)
	}
	// Panjang + potongan awal nilai dicetak supaya log drill bisa dibandingkan
	// sebelum/sesudah pemulihan tanpa menyalin nilai log (data pengguna) utuh.
	fmt.Printf("OK verify-search treeSize=%d last=%d valueBytes=%d valuePrefix=%s\n",
		proof.GetTreeHead().GetTreeHead().GetTreeSize(), *last, len(value), shortHex(valueHex))

	if *anchorPath != "" {
		if err := storage.saveAnchor(*anchorPath); err != nil {
			return fmt.Errorf("simpan anchor %s: %w", *anchorPath, err)
		}
		fmt.Printf("OK anchor tersimpan size=%d root=%s\n", storage.head.TreeSize, shortHex(hex.EncodeToString(storage.root)))
	}
	return nil
}

// shortHex meringkas nilai log jadi 12 byte pertama hex — cukup untuk mendeteksi
// perubahan, tanpa menyalin isi log lengkap ke log CI.
func shortHex(value string) string {
	if len(value) <= 24 {
		return value
	}
	return value[:24]
}

func optionalTreeSize(value uint64) *uint64 {
	if value == 0 {
		return nil
	}
	return &value
}

func resolveSearchKey(hash, key string) ([]byte, error) {
	switch {
	case hash == "" && key == "":
		return nil, errors.New("wajib salah satu: -hash atau -key")
	case hash != "" && key != "":
		return nil, errors.New("-hash dan -key tidak boleh bersamaan")
	case hash != "":
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(hash, "="))
		if err != nil {
			return nil, fmt.Errorf("-hash bukan base64url: %w", err)
		}
		if len(decoded) != 32 {
			return nil, fmt.Errorf("-hash harus 32 byte, dapat %d", len(decoded))
		}
		return append([]byte{PrefixSearchKeyUsernameHash}, decoded...), nil
	default:
		decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(key, "="))
		if err != nil {
			return nil, fmt.Errorf("-key bukan base64url: %w", err)
		}
		return decoded, nil
	}
}

// ---------------------------------------------------------------------------
// gRPC: layanan auditor upstream (TreeSize/Audit)
// ---------------------------------------------------------------------------

func dialAuditor(addr string) (*grpc.ClientConn, pb.KeyTransparencyAuditorServiceClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, fmt.Errorf("sambung auditor %s: %w", addr, err)
	}
	return conn, pb.NewKeyTransparencyAuditorServiceClient(conn), nil
}

func runTreeSize(args []string) error {
	flags := flag.NewFlagSet("tree-size", flag.ExitOnError)
	addr := flags.String("addr", "127.0.0.1:8082", "alamat gRPC layanan auditor")
	_ = flags.Parse(args)

	conn, client, err := dialAuditor(*addr)
	if err != nil {
		return err
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	response, err := client.TreeSize(ctx, &emptypb.Empty{})
	if err != nil {
		return fmt.Errorf("TreeSize: %w", err)
	}
	fmt.Printf("OK tree-size treeSize=%d\n", response.GetTreeSize())
	return nil
}

// runAudit memanggil `Audit` dan memeriksa bentuk jawabannya — inilah bagian
// protokol auditor upstream yang bisa dijalankan tanpa implementasi auditor
// (yang tidak ada di repo upstream: `cmd/kt-client` hanya mencetak, dan
// verifikasi jejak audit hidup di implementasi auditor Java Signal).
func runAudit(args []string) error {
	flags := flag.NewFlagSet("audit", flag.ExitOnError)
	addr := flags.String("addr", "127.0.0.1:8082", "alamat gRPC layanan auditor")
	start := flags.Uint64("start", 0, "posisi awal batch audit")
	limit := flags.Uint64("limit", 1000, "jumlah update per batch")
	_ = flags.Parse(args)

	conn, client, err := dialAuditor(*addr)
	if err != nil {
		return err
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	response, err := client.Audit(ctx, &pb.AuditRequest{Start: *start, Limit: *limit})
	if err != nil {
		return fmt.Errorf("Audit: %w", err)
	}
	updates := response.GetUpdates()
	if len(updates) == 0 {
		return errors.New("Audit mengembalikan nol update")
	}
	// Kontrak upstream: update pertama batch dimulai dari posisi 0 wajib
	// berbentuk proof `newTree` (auditor memakainya untuk menyusun pohonnya).
	if *start == 0 && updates[0].GetProof().GetNewTree() == nil {
		return errors.New("update pertama bukan proof newTree")
	}
	kinds := map[string]int{}
	real, fake := 0, 0
	for _, update := range updates {
		if update.GetReal() {
			real++
		} else {
			fake++
		}
		switch update.GetProof().GetProof().(type) {
		case *tpb.AuditorProof_NewTree_:
			kinds["newTree"]++
		case *tpb.AuditorProof_DifferentKey_:
			kinds["differentKey"]++
		case *tpb.AuditorProof_SameKey_:
			kinds["sameKey"]++
		default:
			kinds["unknown"]++
		}
	}
	fmt.Printf("OK audit updates=%d real=%d fake=%d more=%v newTree=%d differentKey=%d sameKey=%d\n",
		len(updates), real, fake, response.GetMore(), kinds["newTree"], kinds["differentKey"], kinds["sameKey"])
	return nil
}
