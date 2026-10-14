// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"

	"google.golang.org/grpc"
)

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		log.Printf("[kt-query] %s tidak sah (%q), memakai %s", name, raw, fallback)
		return fallback
	}
	return parsed
}

func main() {
	configPath := flag.String("config", envOr("KT_CONFIG_FILE", "test_config.yaml"),
		"lokasi config YAML kt-server (dipakai bersama penulis log NYX)")
	readAddr := flag.String("read-addr", envOr("NYX_KT_QUERY_ADDR", "127.0.0.1:8085"),
		"alamat HTTP baca (wajib loopback; proxy ada di server NYX)")
	writeAddr := flag.String("write-addr", envOr("NYX_KT_WRITE_ADDR", "127.0.0.1:8081"),
		"alamat gRPC test-update; default sama dengan KT_SERVER_URL penulis agar tidak berubah")
	dbFile := flag.String("db", "", "override `db.file` dari config")
	distinguished := flag.Duration("distinguished", 0,
		"interval kunci distinguished; 0 = pakai `api.distinguished` dari config")
	checkOnly := flag.Bool("check", false, "buka database + bangun pohon, lalu keluar (health check deploy)")
	flag.Parse()

	config, fileConfig, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("[kt-query] %v", err)
	}

	file := *dbFile
	if file == "" {
		file = fileConfig.DB.File
	}
	if file == "" {
		log.Fatal("[kt-query] `db.file` kosong dan -db tidak diberikan")
	}

	interval := *distinguished
	if interval == 0 {
		interval = fileConfig.API.Distinguished
	}

	// Basis data dibuka **eksklusif**: proses ini pemilik tunggal (LevelDB
	// menolak dibagi dua proses — lihat dokumentasi paket di store.go).
	store, err := openStore(file)
	if err != nil {
		log.Fatalf("[kt-query] %v", err)
	}

	source := &storeTreeSource{cfg: config, store: store}
	tree, err := source.Tree()
	if err != nil {
		log.Fatalf("[kt-query] %v", err)
	}
	head := tree.GetTransparencyTreeHead()
	log.Printf("[kt-query] config=%s db=%s mode=%d treeSize=%d distinguished=%s",
		*configPath, file, config.Mode, head.TreeSize, interval)

	if *checkOnly {
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	updates := &updateService{cfg: config, store: store}
	go updates.runDistinguished(ctx, interval)

	grpcListener, err := net.Listen("tcp", *writeAddr)
	if err != nil {
		log.Fatalf("[kt-query] listen gRPC %s: %v", *writeAddr, err)
	}
	grpcServer := grpc.NewServer()
	pb.RegisterKeyTransparencyTestServiceServer(grpcServer, updates)
	go func() {
		log.Printf("[kt-query] test-update gRPC di %s (untuk penulis NYX)", *writeAddr)
		if err := grpcServer.Serve(grpcListener); err != nil {
			log.Printf("[kt-query] gRPC berhenti: %v", err)
		}
	}()

	httpServer := &http.Server{
		Addr:              *readAddr,
		Handler:           (&queryServer{source: source}).routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}

	go func() {
		<-ctx.Done()
		log.Printf("[kt-query] sinyal berhenti diterima")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		grpcServer.GracefulStop()
	}()

	log.Printf("[kt-query] HTTP baca di http://%s (loopback saja — jangan expose)", *readAddr)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[kt-query] server berhenti: %v", err)
	}
}
