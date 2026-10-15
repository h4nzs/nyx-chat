// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

// ---------------------------------------------------------------------------
// Helper auditor (mode 3)
// ---------------------------------------------------------------------------

const testAuditorName = "nyx-auditor"

// newAuditorFixture menyiapkan store in-memory + config mode
// `ThirdPartyAuditing` dengan satu auditor terkonfigurasi — bentuk yang sama
// dengan deployment NYX begitu `api.auditors` diisi di config kt-server.
func newAuditorFixture(t *testing.T) (*auditorService, *updateService, *transparency.PrivateConfig, ed25519.PrivateKey) {
	t.Helper()
	config := testPrivateConfig(t)
	auditorPriv := ed25519.NewKeyFromSeed(idiomSeed(0x99))
	config.AuditorKeys = map[string]ed25519.PublicKey{testAuditorName: auditorPriv.Public().(ed25519.PublicKey)}
	config.Mode = transparency.ThirdPartyAuditing

	store := db.NewMemoryTransparencyStore()
	mu := &sync.Mutex{}
	return &auditorService{cfg: config, store: store, mu: mu},
		&updateService{cfg: config, store: store, mu: mu},
		config, auditorPriv
}

func idiomSeed(seed byte) []byte {
	out := make([]byte, ed25519.SeedSize)
	for i := range out {
		out[i] = seed
	}
	return out
}

func auditorContext(name string) context.Context {
	return metadata.NewIncomingContext(context.Background(), auditorMetadata(name))
}

// signedHead menandatangani tree head saat ini dengan kunci auditor.
// `SignNewAuditorHead` adalah API upstream yang sama yang dipakai auditor asli
// (di sana root dihitung auditor dari update yang dia audit; di test ini root
// diambil dari pohon lokal supaya yang diuji adalah jalur terima-tolaknya).
func signedHead(t *testing.T, config *transparency.PrivateConfig, priv ed25519.PrivateKey, store db.TransparencyStore) *tpb.AuditorTreeHead {
	t.Helper()
	tree, err := transparency.NewTree(config, store)
	if err != nil {
		t.Fatalf("bangun pohon: %v", err)
	}
	size := tree.GetTransparencyTreeHead().TreeSize
	root, err := tree.GetLogTree().GetRoot(size)
	if err != nil {
		t.Fatalf("ambil root: %v", err)
	}
	head, _, err := transparency.SignNewAuditorHead(priv, config.Public(), size, root, testAuditorName)
	if err != nil {
		t.Fatalf("tandatangani auditor head: %v", err)
	}
	return &tpb.AuditorTreeHead{TreeSize: head.TreeSize, Timestamp: head.Timestamp, Signature: head.Signature}
}

func writeNyxEntry(t *testing.T, updates *updateService, hash []byte, keyVersion byte) {
	t.Helper()
	if _, err := updates.Update(context.Background(), &tpb.UpdateRequest{
		SearchKey:            nyxSearchKey(hash),
		Value:                nyxLogValue(keyVersion, 0x11),
		Consistency:          &tpb.Consistency{},
		ReturnUpdateResponse: false,
	}); err != nil {
		t.Fatalf("tulis entri: %v", err)
	}
}

// searchProof mengambil bukti `/search` dan menyusun `TreeSearchResponse` yang
// bisa diverifikasi verifier upstream (re-tag field condensed — sama dengan yang
// dilakukan WASM `libsignal-keytrans`).
func searchProof(t *testing.T, serverURL string, hash []byte) (*tpb.FullTreeHead, *tpb.TreeSearchResponse) {
	t.Helper()
	response, err := http.Get(serverURL + "/search?hash=" + base64.RawURLEncoding.EncodeToString(hash))
	if err != nil {
		t.Fatalf("GET /search: %v", err)
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
	return fullTreeHead, &tpb.TreeSearchResponse{
		TreeHead: fullTreeHead,
		VrfProof: condensed.VrfProof,
		Search:   condensed.Search,
		Opening:  condensed.Opening,
		Value:    condensed.Value,
	}
}

// ---------------------------------------------------------------------------
// Tes
// ---------------------------------------------------------------------------

func TestAuditorTreeSizeDanAuditMengikutiIsiLog(t *testing.T) {
	auditor, updates, _, _ := newAuditorFixture(t)

	writeNyxEntry(t, updates, usernameHash(0x21), 1)
	writeNyxEntry(t, updates, usernameHash(0x22), 2)

	size, err := auditor.TreeSize(context.Background(), &emptypb.Empty{})
	if err != nil {
		t.Fatalf("TreeSize: %v", err)
	}
	if size.GetTreeSize() != 2 {
		t.Fatalf("tree size = %d, ingin 2", size.GetTreeSize())
	}

	audit, err := auditor.Audit(context.Background(), &pb.AuditRequest{Start: 0, Limit: 10})
	if err != nil {
		t.Fatalf("Audit: %v", err)
	}
	if len(audit.GetUpdates()) != 2 {
		t.Fatalf("jumlah update = %d, ingin 2", len(audit.GetUpdates()))
	}
	if audit.GetMore() {
		t.Fatal("More = true padahal semua update terkirim")
	}
	// Update pertama wajib berbentuk `newTree` untuk auditor (kontrak upstream).
	if audit.GetUpdates()[0].GetProof().GetNewTree() == nil {
		t.Fatal("update pertama bukan proof newTree")
	}
}

func TestAuditorMenolakPermintaanTidakSah(t *testing.T) {
	auditor, _, _, _ := newAuditorFixture(t)

	cases := map[string]*pb.AuditRequest{
		"limit nol":           {Start: 0, Limit: 0},
		"limit terlalu besar": {Start: 0, Limit: maxAuditLimit + 1},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := auditor.Audit(context.Background(), req)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("kode = %v, ingin InvalidArgument (err=%v)", status.Code(err), err)
			}
		})
	}

	t.Run("permintaan nil", func(t *testing.T) {
		_, err := auditor.Audit(context.Background(), nil)
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf("kode = %v, ingin InvalidArgument", status.Code(err))
		}
	})
}

// Ini inti mode 3: bukti TIDAK bisa diverifikasi sampai auditor mengirim tanda
// tangannya, dan bisa diverifikasi sesudahnya. Dua sisi ini diuji dengan
// verifier upstream yang sama dengan yang dipakai WASM klien.
func TestMode3ButuhAuditorHeadDanLolosSetelahSetAuditorHead(t *testing.T) {
	auditor, updates, config, priv := newAuditorFixture(t)
	hash := usernameHash(0x31)
	writeNyxEntry(t, updates, hash, 1)

	server := httptest.NewServer((&queryServer{source: &storeTreeSource{cfg: config, store: auditor.store}}).routes())
	t.Cleanup(server.Close)

	verify := func(head *tpb.FullTreeHead, res *tpb.TreeSearchResponse) error {
		storage := newTestClientStorage(config.Public())
		return transparency.VerifySearch(storage, &tpb.TreeSearchRequest{
			SearchKey:   nyxSearchKey(hash),
			Consistency: &tpb.Consistency{},
		}, res)
	}

	headBefore, resBefore := searchProof(t, server.URL, hash)
	if len(headBefore.GetFullAuditorTreeHeads()) != 0 {
		t.Fatal("auditor head sudah ada padahal belum ada SetAuditorHead")
	}
	err := verify(headBefore, resBefore)
	if err == nil {
		t.Fatal("verifikasi mode 3 lolos tanpa auditor head — seharusnya ditolak")
	}
	if !strings.Contains(err.Error(), "auditor tree head not provided") {
		t.Fatalf("error tak terduga: %v", err)
	}

	// Auditor (di lapangan: proses `key-transparency-auditor`) menandatangani
	// head, lalu mengirimnya lewat API yang kita layani.
	head := signedHead(t, config, priv, auditor.store)
	if _, err := auditor.SetAuditorHead(auditorContext(testAuditorName), head); err != nil {
		t.Fatalf("SetAuditorHead: %v", err)
	}

	headAfter, resAfter := searchProof(t, server.URL, hash)
	if len(headAfter.GetFullAuditorTreeHeads()) != 1 {
		t.Fatalf("auditor head di bukti = %d, ingin 1", len(headAfter.GetFullAuditorTreeHeads()))
	}
	if got := headAfter.GetFullAuditorTreeHeads()[0].GetTreeHead().GetTreeSize(); got != head.GetTreeSize() {
		t.Fatalf("tree size auditor = %d, ingin %d", got, head.GetTreeSize())
	}
	if err := verify(headAfter, resAfter); err != nil {
		t.Fatalf("verifikasi mode 3 menolak bukti setelah auditor head diterima: %v", err)
	}
}

func TestSetAuditorHeadMenolakTandaTanganYangDiubah(t *testing.T) {
	auditor, updates, config, priv := newAuditorFixture(t)
	writeNyxEntry(t, updates, usernameHash(0x41), 1)

	head := signedHead(t, config, priv, auditor.store)
	head.Signature[0] ^= 0x01

	_, err := auditor.SetAuditorHead(auditorContext(testAuditorName), head)
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("kode = %v, ingin FailedPrecondition (err=%v)", status.Code(err), err)
	}
}

func TestSetAuditorHeadMenolakKunciAuditorLain(t *testing.T) {
	auditor, updates, config, _ := newAuditorFixture(t)
	writeNyxEntry(t, updates, usernameHash(0x42), 1)

	// Kunci penyerang: bukan auditor yang terkonfigurasi di log.
	attacker := ed25519.NewKeyFromSeed(idiomSeed(0x77))
	head := signedHead(t, config, attacker, auditor.store)

	_, err := auditor.SetAuditorHead(auditorContext(testAuditorName), head)
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("kode = %v, ingin FailedPrecondition (err=%v)", status.Code(err), err)
	}
}

func TestSetAuditorHeadMenolakNamaTidakDikonfigurasiDanTanpaMetadata(t *testing.T) {
	auditor, updates, config, priv := newAuditorFixture(t)
	writeNyxEntry(t, updates, usernameHash(0x43), 1)
	head := signedHead(t, config, priv, auditor.store)

	t.Run("nama tidak terkonfigurasi", func(t *testing.T) {
		_, err := auditor.SetAuditorHead(auditorContext("auditor-penyusup"), head)
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("kode = %v, ingin PermissionDenied", status.Code(err))
		}
	})

	t.Run("tanpa metadata", func(t *testing.T) {
		_, err := auditor.SetAuditorHead(context.Background(), head)
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf("kode = %v, ingin InvalidArgument", status.Code(err))
		}
	})
}

func TestSetAuditorHeadMenolakSaatModeBukanThirdPartyAuditing(t *testing.T) {
	// Kunci auditor sengaja ADA di config, tapi mode tetap ContactMonitoring:
	// keputusan mode ada di upstream (`tree.SetAuditorHead`), bukan di lapisan
	// kami — jadi yang diuji di sini adalah penolakan upstream itu sendiri.
	config := testPrivateConfig(t)
	auditorPriv := ed25519.NewKeyFromSeed(idiomSeed(0x99))
	config.AuditorKeys = map[string]ed25519.PublicKey{testAuditorName: auditorPriv.Public().(ed25519.PublicKey)}
	config.Mode = transparency.ContactMonitoring

	store := db.NewMemoryTransparencyStore()
	auditor := &auditorService{cfg: config, store: store, mu: &sync.Mutex{}}
	updates := &updateService{cfg: config, store: store, mu: auditor.mu}
	writeNyxEntry(t, updates, usernameHash(0x44), 1)

	head := signedHead(t, config, auditorPriv, store)
	_, err := auditor.SetAuditorHead(auditorContext(testAuditorName), head)
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("kode = %v, ingin FailedPrecondition (err=%v)", status.Code(err), err)
	}
	if !strings.Contains(err.Error(), "not in third-party auditing mode") {
		t.Fatalf("error tak terduga: %v", err)
	}
}
