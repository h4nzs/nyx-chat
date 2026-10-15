// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"errors"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	commonerrors "github.com/signalapp/keytransparency/common-errors"
	"github.com/signalapp/keytransparency/db"
	tr "github.com/signalapp/keytransparency/tree"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// updateService menyajikan test-update service upstream agar penulis log NYX
// yang sudah ada (`server/src/utils/keyTransparency.ts` → `KT_SERVER_URL`,
// protobuf `transparency.UpdateRequest` di atas gRPC h2c) **tidak berubah**.
//
// Semua penulisan diserialkan satu mutex: pohon KT memasukkan entri ke struktur
// prefix/log yang tidak aman untuk penulisan paralel, dan upstream juga
// menyerialkannya (lewat satu goroutine `updater`). Skala NYX (registrasi +
// pemulihan + satu entri distinguished per menit) jauh di bawah kapasitas itu.
type updateService struct {
	pb.UnimplementedKeyTransparencyTestServiceServer

	cfg   *transparency.PrivateConfig
	store db.TransparencyStore
	// mu dibagi dengan `auditorService` (lihat audit.go): `SetAuditorHead` juga
	// menulis state pohon, jadi keduanya harus antre di kunci yang sama.
	mu *sync.Mutex
}

func (s *updateService) Update(ctx context.Context, req *tpb.UpdateRequest) (*tpb.UpdateResponse, error) {
	if req == nil || len(req.SearchKey) == 0 {
		return nil, status.Error(codes.InvalidArgument, "search key wajib ada")
	}
	if req.Consistency == nil {
		return nil, status.Error(codes.InvalidArgument, "consistency wajib ada")
	}
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.DeadlineExceeded, err.Error())
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}

	response, err := tree.UpdateSimple(req)
	if err != nil {
		// Upstream menjawab `(nil, nil)` untuk update duplikat: penulis yang
		// mengulang entri (mis. setelah restart) harus idempoten, bukan error.
		if errors.Is(err, tr.ErrDuplicateUpdate) {
			return nil, nil
		}
		var invalidArgument *commonerrors.ErrInvalidArgument
		if errors.As(err, &invalidArgument) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		log.Printf("[kt-query] update gagal: %v", err)
		return nil, status.Error(codes.Internal, err.Error())
	}

	// Sama seperti upstream: respons bukti hanya dibuat bila diminta.
	if !req.ReturnUpdateResponse {
		return nil, nil
	}
	return response, nil
}

// ---------------------------------------------------------------------------
// Kunci `distinguished`
// ---------------------------------------------------------------------------

// distinguishedTimestamp membaca timestamp tersimpan (nilai kunci
// `distinguished` adalah string Unix detik — lihat upstream `distinguished.go`).
func (s *updateService) distinguishedTimestamp() (time.Time, bool) {
	tree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return time.Time{}, false
	}
	response, err := tree.Search(&tpb.TreeSearchRequest{
		SearchKey:   []byte(DistinguishedSearchKey),
		Consistency: &tpb.Consistency{},
	})
	if err != nil {
		// ErrNotFound/ErrEmptyTree = belum ada kunci distinguished.
		return time.Time{}, false
	}
	seconds, err := strconv.ParseInt(string(response.Value.Value), 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0), true
}

// updateDistinguished menulis ulang kunci `distinguished` dengan waktu sekarang.
func (s *updateService) updateDistinguished(ctx context.Context) error {
	_, err := s.Update(ctx, &tpb.UpdateRequest{
		SearchKey:   []byte(DistinguishedSearchKey),
		Value:       []byte(strconv.FormatInt(time.Now().Unix(), 10)),
		Consistency: &tpb.Consistency{},
	})
	return err
}

// nextDistinguishedDelay meniru `distinguished()` upstream: kalau belum ada
// nilai, tulis segera; kalau sudah ada, tunggu sampai interval berikutnya.
func (s *updateService) nextDistinguishedDelay(interval time.Duration) time.Duration {
	timestamp, ok := s.distinguishedTimestamp()
	if !ok {
		return 0
	}
	elapsed := time.Since(timestamp)
	if elapsed >= interval {
		return 0
	}
	return interval - elapsed
}

// runDistinguished menjaga kunci distinguished tetap segar. Kunci ini penting
// untuk keamanan, bukan sekadar operasional: ia satu-satunya anchor yang bisa
// dipakai klien sebelum mengenal kontak mana pun (docs/34 §34.5).
func (s *updateService) runDistinguished(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		log.Printf("[kt-query] kunci distinguished nonaktif (interval %s)", interval)
		return
	}
	timer := time.NewTimer(s.nextDistinguishedDelay(interval))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := s.updateDistinguished(ctx); err != nil {
				log.Printf("[kt-query] gagal memperbarui kunci distinguished: %v", err)
			}
			timer.Reset(interval)
		}
	}
}
