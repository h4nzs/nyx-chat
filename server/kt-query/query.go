// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	"github.com/signalapp/keytransparency/db"
	tr "github.com/signalapp/keytransparency/tree"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/protobuf/proto"
)

// PrefixSearchKeyUsernameHash = 0x75, sama dengan `cmd/shared.UsernameHashPrefix`
// upstream dan `KT_USERNAME_HASH_PREFIX` di `server/src/utils/keyTransparency.ts`.
const PrefixSearchKeyUsernameHash = 0x75

// DistinguishedSearchKey = search key tetap untuk kunci `distinguished`
// (upstream: `cmd/kt-server/main.go`).
const DistinguishedSearchKey = "distinguished"

const (
	usernameHashBytes      = 32
	maxMonitorKeys         = 64
	maxMonitorRequestBytes = 1 << 20
)

// treeSource menyediakan pohon baca. Dipisah sebagai interface supaya test bisa
// memakai pohon in-memory upstream tanpa LevelDB (lihat query_test.go).
type treeSource interface {
	Tree() (*transparency.Tree, error)
	Public() *transparency.PublicConfig
	Close() error
}

// storeTreeSource membangun pohon segar di atas store yang dimiliki proses ini.
//
// Pohon dibangun per permintaan (pola yang sama dengan query handler upstream:
// `config.NewTree(h.tx)` di dalam handler) supaya `latest`/tree head yang dibaca
// selalu head terbaru — penting justru karena proses ini juga yang menulis.
// Membangun pohon itu murah: satu `GetHead` + inisialisasi pohon.
type storeTreeSource struct {
	cfg   *transparency.PrivateConfig
	store db.TransparencyStore
}

func (s *storeTreeSource) Tree() (*transparency.Tree, error) {
	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return nil, fmt.Errorf("bangun pohon: %w", err)
	}
	return tree, nil
}

func (s *storeTreeSource) Public() *transparency.PublicConfig { return s.cfg.Public() }

func (s *storeTreeSource) Close() error { return nil }

// queryServer mengekspos operasi baca sebagai HTTP biner sederhana. Protobuf
// hanya lewat sebagai byte apa adanya (tanpa parsing di sini dan tanpa parsing
// di proxy Express), lalu klien memverifikasinya di WASM.
type queryServer struct {
	source treeSource
}

func (qs *queryServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", qs.handleHealth)
	mux.HandleFunc("/config", qs.handleConfig)
	mux.HandleFunc("/search", qs.handleSearch)
	mux.HandleFunc("/distinguished", qs.handleDistinguished)
	mux.HandleFunc("/monitor", qs.handleMonitor)
	return mux
}

func (qs *queryServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET saja")
		return
	}
	tree, err := qs.source.Tree()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", err.Error())
		return
	}
	head := tree.GetTransparencyTreeHead()
	if head == nil {
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "tree head hilang")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"treeSize": head.TreeSize, "timestamp": head.Timestamp})
}

// handleConfig mengembalikan kunci publik log. Ini bagian dari keamanan: klien
// membandingkan kunci ini dengan yang diharapkan sebelum mempercayai bukti apa
// pun (docs/34 §34.4) — kalau operator menukar kunci log, verifikasi gagal.
func (qs *queryServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET saja")
		return
	}
	public := qs.source.Public()
	auditors := make([]string, 0, len(public.AuditorKeys))
	for _, key := range public.AuditorKeys {
		auditors = append(auditors, hex.EncodeToString(key))
	}
	// `vrf.PublicKey` hanya menjanjikan `ECVRFVerify`; byte mentahnya diekspos
	// implementasi ed25519 lewat `Bytes()` (yang dipakai klien sebagai `vrfKey`).
	withBytes, ok := public.VrfKey.(interface{ Bytes() []byte })
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL", "kunci VRF tidak mengekspos Bytes()")
		return
	}
	vrfKey := withBytes.Bytes()
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":             int(public.Mode),
		"signatureKey":     hex.EncodeToString(public.SigKey),
		"vrfKey":           hex.EncodeToString(vrfKey),
		"auditorKeys":      auditors,
		"searchKeyPrefix":  fmt.Sprintf("%02x", PrefixSearchKeyUsernameHash),
		"distinguishedKey": DistinguishedSearchKey,
		"valueFormat":      "nyx-kt-value-v1",
	})
}

// handleSearch menyajikan bukti untuk search key NYX.
//
// Param: `hash` = base64url dari 32 byte usernameHash (bentuk yang dipakai
// klien NYX), atau `key` = base64url search key mentah. `last`/`distinguished` =
// ukuran pohon terakhir yang dilihat klien (bukti konsistensi).
//
// Body hasil: `u32 len || FullTreeHead || u32 len || CondensedTreeSearchResponse`.
func (qs *queryServer) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET saja")
		return
	}
	key, err := searchKeyFromQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}
	consistency, err := consistencyFromQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}
	qs.search(w, key, consistency)
}

// handleDistinguished menyajikan bukti untuk kunci `distinguished`, satu-satunya
// anchor yang bisa dipakai klien sebelum ia melihat kontak pertama.
func (qs *queryServer) handleDistinguished(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET saja")
		return
	}
	consistency, err := consistencyFromQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}
	qs.search(w, []byte(DistinguishedSearchKey), consistency)
}

func (qs *queryServer) search(w http.ResponseWriter, key []byte, consistency *tpb.Consistency) {
	tree, err := qs.source.Tree()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", err.Error())
		return
	}

	response, err := tree.Search(&tpb.TreeSearchRequest{SearchKey: key, Consistency: consistency})
	if err != nil {
		// "Tidak ada di log" bukan kegagalan layanan: klien harus bisa
		// membedakannya dari "layanan mati" (degradasi terlihat, docs/34 §34.6).
		if errors.Is(err, tr.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "search key tidak ada di log")
			return
		}
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}

	fullTreeHead, err := proto.Marshal(response.TreeHead)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	// Bentuk `CondensedTreeSearchResponse` yang sama dengan yang dikonsumsi
	// `verify_search` di WASM (vrf_proof=1, search=2, opening=3, value=4).
	condensed, err := proto.Marshal(&pb.CondensedTreeSearchResponse{
		VrfProof: response.VrfProof,
		Search:   response.Search,
		Opening:  response.Opening,
		Value:    response.Value,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}

	out := make([]byte, 0, len(fullTreeHead)+len(condensed)+8)
	out = appendFramed(out, fullTreeHead)
	out = appendFramed(out, condensed)
	writeBinary(w, out)
}

// handleMonitor menyajikan bukti monitor. Body permintaan = `transparency.MonitorRequest`
// (dibangun klien dari monitoring data tersimpan), body hasil = `transparency.MonitorResponse`
// — persis dua byte-blob yang diminta `verify_monitor` di WASM.
//
// Catatan jujur: permintaan monitor dibangun di sisi klien, dan konstruksinya
// butuh `commitment_index` per kunci (keluaran VRF dari bukti search terakhir).
// ABI WASM saat ini belum punya op untuk itu (docs/34 §34.6 poin 2), jadi
// endpoint ini sudah benar dan teruji di sisi server, tetapi belum dipanggil
// klien produksi.
func (qs *queryServer) handleMonitor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "POST saja")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxMonitorRequestBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}

	request := &tpb.MonitorRequest{}
	if err := proto.Unmarshal(body, request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "monitor request tidak bisa dibaca")
		return
	}
	if len(request.Keys) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "monitor request tanpa kunci")
		return
	}
	if len(request.Keys) > maxMonitorKeys {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT",
			fmt.Sprintf("terlalu banyak kunci (%d > %d)", len(request.Keys), maxMonitorKeys))
		return
	}
	if request.Consistency == nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "consistency wajib ada")
		return
	}
	for _, key := range request.Keys {
		if !isAllowedSearchKey(key.GetSearchKey()) {
			writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "search key di luar namespace NYX")
			return
		}
	}

	tree, err := qs.source.Tree()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "UNAVAILABLE", err.Error())
		return
	}
	response, err := tree.Monitor(request)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ARGUMENT", err.Error())
		return
	}
	encoded, err := proto.Marshal(response)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeBinary(w, encoded)
}

func searchKeyFromQuery(r *http.Request) ([]byte, error) {
	query := r.URL.Query()
	rawKey := query.Get("key")
	hash := query.Get("hash")

	switch {
	case rawKey == "" && hash == "":
		return nil, errors.New("wajib salah satu: hash (base64url 32 byte) atau key (base64url)")
	case rawKey != "" && hash != "":
		return nil, errors.New("hash dan key tidak boleh bersamaan")
	}

	if hash != "" {
		decoded, err := decodeBase64Url(hash)
		if err != nil {
			return nil, fmt.Errorf("hash bukan base64url: %w", err)
		}
		if len(decoded) != usernameHashBytes {
			return nil, fmt.Errorf("hash harus %d byte, dapat %d", usernameHashBytes, len(decoded))
		}
		return append([]byte{PrefixSearchKeyUsernameHash}, decoded...), nil
	}

	decoded, err := decodeBase64Url(rawKey)
	if err != nil {
		return nil, fmt.Errorf("key bukan base64url: %w", err)
	}
	// Pembatasan namespace: layanan ini melayani log NYX (usernameHash dan
	// distinguished), bukan oracle pencarian bebas untuk prefix Signal lain.
	if !isAllowedSearchKey(decoded) {
		return nil, errors.New("key di luar namespace NYX")
	}
	return decoded, nil
}

// isAllowedSearchKey membatasi ke `0x75 || hash(32)` dan `distinguished`.
func isAllowedSearchKey(key []byte) bool {
	if string(key) == DistinguishedSearchKey {
		return true
	}
	return len(key) == 1+usernameHashBytes && key[0] == PrefixSearchKeyUsernameHash
}

func consistencyFromQuery(r *http.Request) (*tpb.Consistency, error) {
	consistency := &tpb.Consistency{}
	last, err := parseTreeSize(r.URL.Query().Get("last"))
	if err != nil {
		return nil, err
	}
	distinguished, err := parseTreeSize(r.URL.Query().Get("distinguished"))
	if err != nil {
		return nil, err
	}
	consistency.Last = last
	consistency.Distinguished = distinguished
	return consistency, nil
}

// parseTreeSize mengembalikan nil untuk kosong/0: "belum pernah melihat apa pun"
// sama dengan tidak mengirim field (upstream menolak `last = 0`).
func parseTreeSize(value string) (*uint64, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("ukuran pohon bukan angka: %w", err)
	}
	if parsed == 0 {
		return nil, nil
	}
	return &parsed, nil
}

func decodeBase64Url(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
}

func appendFramed(dst []byte, payload []byte) []byte {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(payload)))
	dst = append(dst, length[:]...)
	return append(dst, payload...)
}

func writeBinary(w http.ResponseWriter, payload []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
