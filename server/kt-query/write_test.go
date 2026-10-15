// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// newWriteTestService menyiapkan store in-memory yang dipakai bersama oleh jalur
// tulis dan jalur baca — persis seperti di lapangan (satu proses, satu store).
func newWriteTestService(t *testing.T) (*httptest.Server, *updateService, *transparency.PrivateConfig) {
	t.Helper()
	config := testPrivateConfig(t)
	store := db.NewMemoryTransparencyStore()
	source := &storeTreeSource{cfg: config, store: store}
	updates := &updateService{cfg: config, store: store, mu: &sync.Mutex{}}

	server := httptest.NewServer((&queryServer{source: source}).routes())
	t.Cleanup(server.Close)
	return server, updates, config
}

func updateRequest(hash []byte, value []byte) *tpb.UpdateRequest {
	return &tpb.UpdateRequest{
		SearchKey:            nyxSearchKey(hash),
		Value:                value,
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: true,
	}
}

// Tes jalur lengkap: tulis lewat update service (protokol yang sama dengan
// penulis NYX), baca lewat HTTP, lalu verifikasi dengan klien upstream.
func TestUpdateServiceMenulisEntriYangBisaDiverifikasi(t *testing.T) {
	server, updates, config := newWriteTestService(t)
	hash := usernameHash(0x5a)
	expectedValue := nyxLogValue(1, 0x11)

	response, err := updates.Update(context.Background(), updateRequest(hash, expectedValue))
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if response == nil {
		t.Fatal("Update tidak mengembalikan respons bukti padahal ReturnUpdateResponse=true")
	}
	if response.TreeHead == nil || response.TreeHead.TreeHead == nil {
		t.Fatal("update response tanpa tree head")
	}
	if len(response.VrfProof) == 0 {
		t.Fatal("update response tanpa vrf proof")
	}

	httpResponse, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", httpResponse.StatusCode, readAllString(t, httpResponse.Body))
	}
	frames := splitFramed(t, readAll(t, httpResponse.Body))

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
		&tpb.TreeSearchRequest{SearchKey: nyxSearchKey(hash), Consistency: &tpb.Consistency{}},
		&tpb.TreeSearchResponse{
			TreeHead: fullTreeHead,
			VrfProof: condensed.VrfProof,
			Search:   condensed.Search,
			Opening:  condensed.Opening,
			Value:    condensed.Value,
		},
	); err != nil {
		t.Fatalf("bukti hasil tulis-dan-baca ditolak verifier upstream: %v", err)
	}
	if len(condensed.Value.GetValue()) != 1286 {
		t.Fatalf("panjang nilai = %d, ingin 1286", len(condensed.Value.GetValue()))
	}
}

// Penulis yang mengulang entri identik (mis. setelah restart) tidak boleh
// melihat error: upstream menjawab `(nil, nil)` untuk update duplikat dan NYX
// mengandalkan sifat itu untuk idempotensi.
func TestUpdateDuplikatTidakError(t *testing.T) {
	_, updates, _ := newWriteTestService(t)
	hash := usernameHash(0x5a)
	value := nyxLogValue(1, 0x11)

	if _, err := updates.Update(context.Background(), updateRequest(hash, value)); err != nil {
		t.Fatalf("Update pertama: %v", err)
	}
	response, err := updates.Update(context.Background(), updateRequest(hash, value))
	if err != nil {
		t.Fatalf("Update duplikat harus sukses senyap, dapat: %v", err)
	}
	if response != nil {
		t.Fatal("Update duplikat mengembalikan respons bukti (upstream mengembalikan nil)")
	}
}

// Rotasi kunci (nilai berbeda untuk search key yang sama) HARUS terlihat:
// inilah yang membedakan log NYX dari dedupe yang salah.
func TestUpdateRotasiKunciTetapDitulis(t *testing.T) {
	server, updates, _ := newWriteTestService(t)
	hash := usernameHash(0x5a)

	if _, err := updates.Update(context.Background(), updateRequest(hash, nyxLogValue(1, 0x11))); err != nil {
		t.Fatalf("Update v1: %v", err)
	}
	if _, err := updates.Update(context.Background(), updateRequest(hash, nyxLogValue(2, 0x44))); err != nil {
		t.Fatalf("Update v2: %v", err)
	}

	response, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	defer response.Body.Close()
	frames := splitFramed(t, readAll(t, response.Body))
	condensed := &pb.CondensedTreeSearchResponse{}
	if err := proto.Unmarshal(frames[1], condensed); err != nil {
		t.Fatalf("urai condensed: %v", err)
	}
	value := condensed.Value.GetValue()
	if len(value) != 1286 || value[1] != 2 || value[2] != 0x44 {
		t.Fatalf("nilai bukan hasil rotasi v2: %x", value[:3])
	}
}

func TestUpdateMenolakPermintaanTidakSah(t *testing.T) {
	_, updates, _ := newWriteTestService(t)
	hash := usernameHash(0x5a)

	cases := map[string]*tpb.UpdateRequest{
		"search key kosong": {Value: nyxLogValue(1, 0x11), Consistency: &tpb.Consistency{}},
		"consistency hilang": {
			SearchKey: nyxSearchKey(hash),
			Value:     nyxLogValue(1, 0x11),
		},
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := updates.Update(context.Background(), request)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("kode error = %v, ingin InvalidArgument (%v)", status.Code(err), err)
			}
		})
	}

	_, err := updates.Update(context.Background(), nil)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("request nil → %v, ingin InvalidArgument", status.Code(err))
	}
}

// Tanpa `ReturnUpdateResponse`, upstream tidak mengirim bukti tetapi entri tetap
// tertulis — perilaku ini dipertahankan.
func TestUpdateTanpaReturnTetapMenulis(t *testing.T) {
	server, updates, _ := newWriteTestService(t)
	hash := usernameHash(0x5a)

	request := updateRequest(hash, nyxLogValue(1, 0x11))
	request.ReturnUpdateResponse = false
	response, err := updates.Update(context.Background(), request)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if response != nil {
		t.Fatal("respons bukti dikirim padahal ReturnUpdateResponse=false")
	}

	httpResponse, err := http.Get(server.URL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode != http.StatusOK {
		t.Fatalf("entri tidak tertulis: status %d", httpResponse.StatusCode)
	}
}

func TestKunciDistinguishedDikelola(t *testing.T) {
	_, updates, _ := newWriteTestService(t)

	// Belum ada nilai → tulis segera.
	if delay := updates.nextDistinguishedDelay(time.Minute); delay != 0 {
		t.Fatalf("delay awal = %s, ingin 0", delay)
	}
	if _, ok := updates.distinguishedTimestamp(); ok {
		t.Fatal("kunci distinguished sudah ada padahal belum ditulis")
	}

	if err := updates.updateDistinguished(context.Background()); err != nil {
		t.Fatalf("updateDistinguished: %v", err)
	}

	timestamp, ok := updates.distinguishedTimestamp()
	if !ok {
		t.Fatal("kunci distinguished tidak terbaca setelah ditulis")
	}
	// Nilai harus Unix detik (upstream mem-parse-nya demikian), bukan RFC3339.
	if drift := time.Since(timestamp); drift < 0 || drift > time.Minute {
		t.Fatalf("timestamp distinguished menyimpang %s dari sekarang", drift)
	}
	if _, err := strconv.ParseInt(strconv.FormatInt(timestamp.Unix(), 10), 10, 64); err != nil {
		t.Fatalf("timestamp tidak bisa jadi Unix detik: %v", err)
	}

	// Sudah ada nilai baru → tunggu sisa interval.
	if delay := updates.nextDistinguishedDelay(time.Minute); delay <= 0 || delay > time.Minute {
		t.Fatalf("delay berikutnya = %s, ingin (0, 1m]", delay)
	}
}

// Kunci distinguished harus bisa dipakai sebagai anchor klien sebelum klien
// mengenal kontak mana pun.
func TestKunciDistinguishedBisaDiverifikasi(t *testing.T) {
	server, updates, config := newWriteTestService(t)

	if err := updates.updateDistinguished(context.Background()); err != nil {
		t.Fatalf("updateDistinguished: %v", err)
	}

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
		t.Fatalf("anchor distinguished tidak lolos verifikasi: %v", err)
	}
}
