// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"errors"
	"log"
	"sync"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	commonerrors "github.com/signalapp/keytransparency/common-errors"
	"github.com/signalapp/keytransparency/db"
	tr "github.com/signalapp/keytransparency/tree"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
)

// ---------------------------------------------------------------------------
// Layanan auditor (docs/30 §30.5 tahap C)
// ---------------------------------------------------------------------------
//
// Upstream `kt-server` menyajikan `kt.KeyTransparencyAuditorService` untuk
// auditor pihak ketiga: auditor membaca ukuran pohon + batch update, memverifikasi
// semuanya, lalu mengirim balik **tanda tangannya atas tree head** lewat
// `SetAuditorHead`. Selama tanda tangan itu belum pernah masuk, log berjalan di
// mode `ContactMonitoring` dan byte tanda tangan auditor di bukti tidak pernah
// diperiksa siapa pun (`docs/34` §34.5 residual 1).
//
// Proses ini (`nyx-kt-query`) yang memiliki basis data, jadi dialah yang harus
// menyajikan API itu — kalau tidak, auditor pihak ketiga tidak punya lawan
// bicara sama sekali. Yang **tidak** kami lakukan: menulis verifikasi auditor
// sendiri. `SetAuditorHead` memakai kode upstream (`tree.SetAuditorHead` →
// `verifyAuditorTreeHead`) yang sama dengan yang dipakai Signal, jadi kami hanya
// menyampaikan permintaan dan tidak menafsirkan kripto.
//
// Konfigurasi mode mengikuti aturan upstream yang sudah ada di `loadConfig`:
// begitu ada entri `api.auditors` di config, pohon berjalan di
// `ThirdPartyAuditing`. Tanpa auditor terkonfigurasi, `SetAuditorHead` ditolak
// upstream (mode bukan third-party) — perilaku itu dibiarkan apa adanya, bukan
// ditambal di sini.

// auditorNameMetadataKey = header gRPC yang membawa nama auditor.
//
// Upstream memakai identitas dari **sertifikat klien mTLS**
// (`AuditorNameContextKey` diisi interceptor `cmd/kt-server`). Deployment NYX
// berjalan di loopback tanpa mTLS, jadi nama dibawa eksplisit di metadata —
// aman karena nama sendirian tidak berguna: kunci publik auditor diambil dari
// config (`api.auditors`), dan tanda tangan tetap diverifikasi oleh kode
// upstream terhadap kunci itu. Nama yang tidak terkonfigurasi ditolak lebih awal
// dengan `PermissionDenied` supaya kesalahannya jelas.
const auditorNameMetadataKey = "x-nyx-auditor-name"

// maxAuditLimit membatasi satu permintaan `Audit`. Ini layanan loopback, tapi
// permintaan besar tetap berarti pohon + proof besar di memori; batas ini menjaga
// proses penulis log tidak terganggu oleh permintaan auditor yang keliru/hostile.
const maxAuditLimit = 10_000

type auditorService struct {
	pb.UnimplementedKeyTransparencyAuditorServiceServer

	cfg   *transparency.PrivateConfig
	store db.TransparencyStore
	// mu dipakai bersama `updateService`: `SetAuditorHead` ikut menulis state
	// pohon (commit auditor head), jadi ia tidak boleh berjalan bersamaan dengan
	// update biasa.
	mu *sync.Mutex
}

func (s *auditorService) TreeSize(ctx context.Context, _ *emptypb.Empty) (*pb.TreeSizeResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.DeadlineExceeded, err.Error())
	}
	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	head := tree.GetTransparencyTreeHead()
	if head == nil {
		return nil, status.Error(codes.FailedPrecondition, "tree head hilang")
	}
	return &pb.TreeSizeResponse{TreeSize: head.TreeSize}, nil
}

func (s *auditorService) Audit(ctx context.Context, req *pb.AuditRequest) (*pb.AuditResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "permintaan audit kosong")
	}
	if req.Limit == 0 {
		return nil, status.Error(codes.InvalidArgument, "limit wajib > 0")
	}
	if req.Limit > maxAuditLimit {
		return nil, status.Errorf(codes.InvalidArgument, "limit melebihi batas %d", maxAuditLimit)
	}
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.DeadlineExceeded, err.Error())
	}

	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	updates, more, err := tree.Audit(req.Start, req.Limit)
	if err != nil {
		return nil, auditorErrorToStatus(err)
	}
	return &pb.AuditResponse{Updates: updates, More: more}, nil
}

func (s *auditorService) SetAuditorHead(ctx context.Context, head *tpb.AuditorTreeHead) (*emptypb.Empty, error) {
	name, err := auditorNameFromContext(ctx)
	if err != nil {
		return nil, err
	}
	// Nama yang tidak terkonfigurasi tidak mungkin lolos verifikasi tanda tangan
	// (kunci publiknya tidak ada), tapi ditolak di sini supaya pesan errornya
	// jelas dan tidak membakar waktu verifikasi.
	if _, ok := s.cfg.AuditorKeys[name]; !ok {
		return nil, status.Errorf(codes.PermissionDenied, "auditor %q tidak terkonfigurasi", name)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	if err := tree.SetAuditorHead(head, name); err != nil {
		var signatureFailed *tr.ErrAuditorSignatureVerificationFailed
		if errors.As(err, &signatureFailed) {
			// Terlihat di log operator: ini tanda bahaya (head tidak sah), bukan
			// sekadar input salah.
			log.Printf("[kt-query] auditor %q: tanda tangan tree head DITOLAK: %v", name, err)
			return nil, auditorErrorToStatus(err)
		}
		return nil, auditorErrorToStatus(err)
	}
	log.Printf("[kt-query] auditor %q: tree head diterima (treeSize=%d)", name, head.GetTreeSize())
	return &emptypb.Empty{}, nil
}

// auditorNameFromContext membaca nama auditor dari metadata gRPC.
func auditorNameFromContext(ctx context.Context) (string, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return "", status.Error(codes.InvalidArgument, "tanpa metadata auditor")
	}
	values := md.Get(auditorNameMetadataKey)
	if len(values) == 0 || values[0] == "" {
		return "", status.Errorf(codes.InvalidArgument, "header %q wajib ada", auditorNameMetadataKey)
	}
	if len(values) > 1 {
		return "", status.Errorf(codes.InvalidArgument, "header %q hanya boleh satu nilai", auditorNameMetadataKey)
	}
	return values[0], nil
}

// auditorErrorToStatus memetakan error upstream ke kode gRPC — pemetaan yang
// sama dengan `toGrpcError` di `cmd/kt-server/kt_handler.go` (kita tidak bisa
// mengimpornya karena paket itu `package main`).
func auditorErrorToStatus(err error) error {
	var invalidArgument *commonerrors.ErrInvalidArgument
	var invalidConfig *tr.ErrInvalidTreeConfiguration
	var permissionDenied *commonerrors.ErrPermissionDenied
	var signatureFailed *tr.ErrAuditorSignatureVerificationFailed

	switch {
	case err == nil:
		return nil
	case errors.As(err, &invalidArgument):
		return status.Error(codes.InvalidArgument, invalidArgument.Error())
	case errors.As(err, &invalidConfig):
		return status.Error(codes.FailedPrecondition, invalidConfig.Error())
	case errors.As(err, &permissionDenied):
		return status.Error(codes.PermissionDenied, permissionDenied.Error())
	case errors.Is(err, tr.ErrEmptyTree):
		return status.Error(codes.FailedPrecondition, err.Error())
	case errors.As(err, &signatureFailed):
		return status.Error(codes.FailedPrecondition, signatureFailed.Error())
	case errors.Is(err, tr.ErrOutOfRange):
		return status.Error(codes.OutOfRange, err.Error())
	default:
		return status.Error(codes.Unknown, err.Error())
	}
}

// auditorNameFromMetadata membantu pemanggil non-gRPC (test/CLI) menyusun
// metadata yang benar tanpa menulis literal string di banyak tempat.
func auditorMetadata(name string) metadata.MD {
	return metadata.Pairs(auditorNameMetadataKey, name)
}
