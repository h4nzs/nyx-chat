// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Test runner auditor: kapan tree head dikirim, kapan state disimpan, dan apa
// yang terjadi saat verifikasi gagal. Data update diambil dari vektor resmi
// (`should_succeed`) supaya yang diuji jalur nyata — bukan update buatan sendiri.

package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"
)

const testAuditorName = "auditor-uji"

// fakeAuditorClient menyajikan update berurutan seperti layanan log dan mencatat
// tree head yang masuk.
type fakeAuditorClient struct {
	updates     []*tpb.AuditorUpdate
	auditStarts []uint64
	heads       []*tpb.AuditorTreeHead
	headErr     error
}

func (f *fakeAuditorClient) TreeSize(context.Context, *emptypb.Empty, ...grpc.CallOption) (*pb.TreeSizeResponse, error) {
	return &pb.TreeSizeResponse{TreeSize: uint64(len(f.updates))}, nil
}

func (f *fakeAuditorClient) Audit(_ context.Context, request *pb.AuditRequest, _ ...grpc.CallOption) (*pb.AuditResponse, error) {
	f.auditStarts = append(f.auditStarts, request.GetStart())

	start := request.GetStart()
	if start > uint64(len(f.updates)) {
		return &pb.AuditResponse{}, nil
	}
	end := start + request.GetLimit()
	if end > uint64(len(f.updates)) {
		end = uint64(len(f.updates))
	}
	return &pb.AuditResponse{
		Updates: f.updates[start:end],
		More:    end < uint64(len(f.updates)),
	}, nil
}

func (f *fakeAuditorClient) SetAuditorHead(_ context.Context, head *tpb.AuditorTreeHead, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	if f.headErr != nil {
		return nil, f.headErr
	}
	f.heads = append(f.heads, head)
	return &emptypb.Empty{}, nil
}

type fakeStateStore struct {
	stored     *auditorState
	storeCalls int
	loadErr    error
	storeErr   error
}

func (f *fakeStateStore) load() (*auditorState, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return f.stored, nil
}

func (f *fakeStateStore) store(state *auditorState) error {
	if f.storeErr != nil {
		return f.storeErr
	}
	copied := &auditorState{
		totalUpdatesProcessed: state.totalUpdatesProcessed,
		prefixTreeRootHash:    append([]byte(nil), state.prefixTreeRootHash...),
		logTreeNodes:          append([]logTreeNode(nil), state.logTreeNodes...),
	}
	f.stored = copied
	f.storeCalls++
	return nil
}

// testPublicConfig membangun PublicConfig mode 3 dengan kunci auditor yang sudah
// dikenal (persis bentuk yang dibangun `fetchPublicConfig` dari `/config`).
func testPublicConfig(t *testing.T, publicKey ed25519.PublicKey) *transparency.PublicConfig {
	t.Helper()
	vrfPublicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("buat kunci VRF: %v", err)
	}
	verifier, err := edvrf.NewVRFVerifier(vrfPublicKey)
	if err != nil {
		t.Fatalf("bangun verifier VRF: %v", err)
	}
	sigPublicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("buat kunci tanda tangan: %v", err)
	}
	return &transparency.PublicConfig{
		Mode:        transparency.ThirdPartyAuditing,
		SigKey:      sigPublicKey,
		AuditorKeys: map[string]ed25519.PublicKey{testAuditorName: publicKey},
		VrfKey:      verifier,
	}
}

type runnerFixture struct {
	runner *auditorRunner
	client *fakeAuditorClient
	state  *fakeStateStore
	clock  *time.Time
}

func newRunnerFixture(t *testing.T, updates []*tpb.AuditorUpdate, signaturePageSize uint64, signatureInterval time.Duration) runnerFixture {
	t.Helper()
	return newRunnerFixtureWithBatch(t, updates, auditMaxBatchSize, signaturePageSize, signatureInterval)
}

func newRunnerFixtureWithBatch(t *testing.T, updates []*tpb.AuditorUpdate, batchSize, signaturePageSize uint64, signatureInterval time.Duration) runnerFixture {
	t.Helper()

	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("buat kunci auditor: %v", err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)

	client := &fakeAuditorClient{updates: updates}
	store := &fakeStateStore{}
	clock := time.Unix(0, 0)

	runner, err := newAuditorRunner(
		testAuditorName, privateKey, testPublicConfig(t, publicKey), client, store,
		batchSize, time.Minute, signatureInterval, signaturePageSize,
		func() time.Time { return clock }, func(string, ...any) {},
	)
	if err != nil {
		t.Fatalf("bangun runner: %v", err)
	}
	return runnerFixture{runner: runner, client: client, state: store, clock: &clock}
}

func successVectorUpdates(t *testing.T) []*tpb.AuditorUpdate {
	t.Helper()
	vectors := loadTestVectors(t)
	updates := make([]*tpb.AuditorUpdate, 0, len(vectors.shouldSucceed))
	for _, entry := range vectors.shouldSucceed {
		updates = append(updates, entry.update)
	}
	return updates
}

func TestRunnerSendsHeadAfterSignaturePageSize(t *testing.T) {
	updates := successVectorUpdates(t)
	fixture := newRunnerFixture(t, updates, 3, time.Hour)
	if err := fixture.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}

	processed, err := fixture.runner.runOnce(context.Background())
	if err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	if processed != 10 {
		t.Fatalf("update diproses = %d, ingin 10", processed)
	}
	// 10 update dengan irama 3 → tree head dikirim saat mencapai 3, 6, dan 9.
	if len(fixture.client.heads) != 3 {
		t.Fatalf("tree head dikirim %d kali, ingin 3", len(fixture.client.heads))
	}
	if got := fixture.client.heads[0].GetTreeSize(); got != 3 {
		t.Fatalf("tree size tree head pertama = %d, ingin 3", got)
	}
	if fixture.state.storeCalls != 3 {
		t.Fatalf("state disimpan %d kali, ingin 3", fixture.state.storeCalls)
	}
	if fixture.state.stored == nil || fixture.state.stored.totalUpdatesProcessed != 9 {
		t.Fatalf("state tersimpan = %+v, ingin totalUpdatesProcessed=9", fixture.state.stored)
	}
}

func TestRunnerSendsHeadAfterInterval(t *testing.T) {
	updates := successVectorUpdates(t)

	t.Run("sebelum irama", func(t *testing.T) {
		fixture := newRunnerFixture(t, updates, 100, 5*time.Minute)
		if err := fixture.runner.loadState(); err != nil {
			t.Fatalf("loadState: %v", err)
		}
		*fixture.clock = time.Unix(0, 0).Add(30 * time.Second)

		if _, err := fixture.runner.runOnce(context.Background()); err != nil {
			t.Fatalf("runOnce: %v", err)
		}
		if len(fixture.client.heads) != 0 {
			t.Fatalf("tree head dikirim %d kali, ingin 0 sebelum irama", len(fixture.client.heads))
		}
	})

	t.Run("setelah irama, tanpa update baru", func(t *testing.T) {
		fixture := newRunnerFixture(t, updates, 100, 5*time.Minute)
		if err := fixture.runner.loadState(); err != nil {
			t.Fatalf("loadState: %v", err)
		}
		// Putaran pertama: semua update masuk, belum jatuh tempo → belum ada tanda tangan.
		if _, err := fixture.runner.runOnce(context.Background()); err != nil {
			t.Fatalf("runOnce pertama: %v", err)
		}
		if len(fixture.client.heads) != 0 {
			t.Fatalf("tree head dikirim %d kali sebelum irama", len(fixture.client.heads))
		}

		// Putaran kedua: tidak ada update baru, tapi irama sudah lewat → tree head
		// tetap dikirim (perilaku referensi).
		*fixture.clock = time.Unix(0, 0).Add(5 * time.Minute)
		fixture.client.updates = nil
		if _, err := fixture.runner.runOnce(context.Background()); err != nil {
			t.Fatalf("runOnce kedua: %v", err)
		}
		if len(fixture.client.heads) != 1 {
			t.Fatalf("tree head dikirim %d kali, ingin 1 setelah irama", len(fixture.client.heads))
		}
		if got := fixture.client.heads[0].GetTreeSize(); got != uint64(len(updates)) {
			t.Fatalf("tree size = %d, ingin %d", got, len(updates))
		}
	})
}

func TestRunnerTidakMenyimpanStateBilaHeadDitolak(t *testing.T) {
	updates := successVectorUpdates(t)
	fixture := newRunnerFixture(t, updates, 1, time.Hour)
	fixture.client.headErr = errors.New("auditor tidak terkonfigurasi")
	if err := fixture.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}

	if _, err := fixture.runner.runOnce(context.Background()); err == nil {
		t.Fatal("runOnce sukses padahal SetAuditorHead gagal")
	}
	if fixture.state.storeCalls != 0 {
		t.Fatalf("state disimpan %d kali padahal tree head ditolak — posisi auditor bisa melompat", fixture.state.storeCalls)
	}
}

func TestRunnerBerhentiSaatBuktiTidakKonsisten(t *testing.T) {
	updates := successVectorUpdates(t)
	// Rusak satu bit di root lama proof update kedua: exactly jenis inkonsistensi
	// yang harus menghentikan tanda tangan auditor.
	corrupted := make([]*tpb.AuditorUpdate, len(updates))
	for index, update := range updates {
		corrupted[index] = update
	}
	differentKey := corrupted[1].GetProof().GetDifferentKey()
	if differentKey == nil {
		t.Fatal("vektor kedua tidak memakai proof differentKey — test ini perlu diperbarui")
	}
	differentKey.OldSeed[0] ^= 0x01

	fixture := newRunnerFixture(t, corrupted, 1, time.Hour)
	if err := fixture.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}

	_, err := fixture.runner.runOnce(context.Background())
	if err == nil {
		t.Fatal("runOnce sukses padahal bukti sudah dirusak")
	}
	if !errors.Is(err, errInvalidProof) {
		t.Fatalf("error = %v, ingin membungkus errInvalidProof", err)
	}
	// Yang penting: auditor tidak pernah menandatangani melewati posisi yang sudah
	// diverifikasi, dan state hanya disimpan untuk tanda tangan yang benar-benar
	// terkirim.
	for index, head := range fixture.client.heads {
		if head.GetTreeSize() > 1 {
			t.Fatalf("tree head ke-%d menandatangani treeSize=%d padahal update ke-1 gagal", index, head.GetTreeSize())
		}
	}
	if fixture.state.storeCalls != len(fixture.client.heads) {
		t.Fatalf("state disimpan %d kali untuk %d tree head", fixture.state.storeCalls, len(fixture.client.heads))
	}
	if fixture.runner.totalUpdatesProcessed != 1 {
		t.Fatalf("posisi auditor = %d, ingin 1 (berhenti tepat sebelum update yang rusak)",
			fixture.runner.totalUpdatesProcessed)
	}
}

func TestRunnerMelanjutkanDariStateTersimpan(t *testing.T) {
	updates := successVectorUpdates(t)

	// Putaran pertama: hanya lima update pertama yang tersedia di layanan.
	first := newRunnerFixture(t, updates[:5], 100, 0)
	if err := first.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}
	if _, err := first.runner.runOnce(context.Background()); err != nil {
		t.Fatalf("runOnce pertama: %v", err)
	}
	if first.state.stored == nil || first.state.stored.totalUpdatesProcessed != 5 {
		t.Fatalf("state putaran pertama = %+v, ingin totalUpdatesProcessed=5", first.state.stored)
	}

	// Putaran kedua (proses baru) dengan state dari putaran pertama: log sudah
	// tumbuh ke 10 update, dan auditor harus melanjutkan dari posisi 5.
	second := newRunnerFixture(t, updates, 100, 0)
	second.state.stored = first.state.stored
	if err := second.runner.loadState(); err != nil {
		t.Fatalf("loadState kedua: %v", err)
	}
	if second.runner.totalUpdatesProcessed != 5 {
		t.Fatalf("posisi awal putaran kedua = %d, ingin 5", second.runner.totalUpdatesProcessed)
	}

	// Sisa lima update: hanya itu yang boleh diambil dari layanan.
	processed, err := second.runner.runOnce(context.Background())
	if err != nil {
		t.Fatalf("runOnce kedua: %v", err)
	}
	if processed != 5 {
		t.Fatalf("update diproses putaran kedua = %d, ingin 5", processed)
	}
	if second.client.auditStarts[0] != 5 {
		t.Fatalf("Audit putaran kedua dimulai di %d, ingin 5", second.client.auditStarts[0])
	}
	if second.runner.totalUpdatesProcessed != 10 {
		t.Fatalf("posisi akhir = %d, ingin 10", second.runner.totalUpdatesProcessed)
	}
	// Root pohon log harus sama dengan yang diharapkan vektor untuk update terakhir.
	root, err := second.runner.log.rootHash()
	if err != nil {
		t.Fatalf("rootHash: %v", err)
	}
	vectors := loadTestVectors(t)
	expected := vectors.shouldSucceed[len(vectors.shouldSucceed)-1].logRoot
	if string(root) != string(expected) {
		t.Fatalf("root setelah lanjut = %x, ingin %x", root, expected)
	}
}

func TestNewAuditorRunnerMenolakKonfigurasiSalah(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("buat kunci: %v", err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	config := testPublicConfig(t, publicKey)
	client := &fakeAuditorClient{}

	t.Run("nama auditor tidak terdaftar", func(t *testing.T) {
		_, err := newAuditorRunner("nama-lain", privateKey, config, client, &fakeStateStore{},
			auditMaxBatchSize, time.Minute, time.Hour, 1, time.Now, func(string, ...any) {})
		if err == nil {
			t.Fatal("runner dibangun dengan nama auditor yang tidak ada di config")
		}
	})

	t.Run("mode bukan third-party", func(t *testing.T) {
		contactConfig := *config
		contactConfig.Mode = transparency.ContactMonitoring
		_, err := newAuditorRunner(testAuditorName, privateKey, &contactConfig, client, &fakeStateStore{},
			auditMaxBatchSize, time.Minute, time.Hour, 1, time.Now, func(string, ...any) {})
		if err == nil {
			t.Fatal("runner dibangun padahal config layanan bukan mode 3")
		}
	})

	t.Run("batch size melebihi batas upstream", func(t *testing.T) {
		_, err := newAuditorRunner(testAuditorName, privateKey, config, client, &fakeStateStore{},
			auditMaxBatchSize+1, time.Minute, time.Hour, 1, time.Now, func(string, ...any) {})
		if err == nil {
			t.Fatal("runner menerima batch size di atas batas upstream (1000)")
		}
	})
}

func TestRunnerOnceMengirimSatuTreeHeadDiAkhir(t *testing.T) {
	updates := successVectorUpdates(t)
	// Irama jauh (1 jam) dan irama jumlah besar: tanpa `forceHead`, tidak ada head.
	fixture := newRunnerFixture(t, updates, 1_000_000, time.Hour)
	if err := fixture.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}

	processed, err := fixture.runner.runOnceForceHead(context.Background())
	if err != nil {
		t.Fatalf("runOnceForceHead: %v", err)
	}
	if processed != len(updates) {
		t.Fatalf("update diproses = %d, ingin %d", processed, len(updates))
	}
	if len(fixture.client.heads) != 1 {
		t.Fatalf("tree head dikirim %d kali, ingin tepat 1", len(fixture.client.heads))
	}
	if got := fixture.client.heads[0].GetTreeSize(); got != uint64(len(updates)) {
		t.Fatalf("tree size = %d, ingin %d (seluruh pohon yang sudah diverifikasi)", got, len(updates))
	}
	if fixture.state.storeCalls != 1 {
		t.Fatalf("state disimpan %d kali, ingin 1", fixture.state.storeCalls)
	}
}

func TestRunnerMemintaBatchSejakPosisiTerakhir(t *testing.T) {
	updates := successVectorUpdates(t)
	fixture := newRunnerFixtureWithBatch(t, updates, 4, 4, 0)
	if err := fixture.runner.loadState(); err != nil {
		t.Fatalf("loadState: %v", err)
	}
	if _, err := fixture.runner.runOnce(context.Background()); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	// Batch 4 dari 10 update → permintaan pada posisi 0, 4, dan 8.
	want := []uint64{0, 4, 8}
	if len(fixture.client.auditStarts) != len(want) {
		t.Fatalf("Audit dipanggil %d kali (%v), ingin %v", len(fixture.client.auditStarts), fixture.client.auditStarts, want)
	}
	for index, start := range want {
		if fixture.client.auditStarts[index] != start {
			t.Fatalf("Audit ke-%d dimulai di %d, ingin %d", index, fixture.client.auditStarts[index], start)
		}
	}
}
