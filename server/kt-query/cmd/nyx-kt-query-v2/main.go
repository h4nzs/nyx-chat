// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"context"
	"crypto/mldsa"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"

	"google.golang.org/grpc"
)

// sortedKeys mengembalikan nama auditor terurut — hanya untuk log startup yang
// deterministik (urutan map acak akan membuat log sulit dibandingkan).
func sortedKeys(keys map[string]*mldsa.PublicKey) []string {
	names := make([]string, 0, len(keys))
	for name := range keys {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		log.Printf("[kt-query-v2] %s tidak sah (%q), memakai %d", name, raw, fallback)
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		log.Printf("[kt-query-v2] %s tidak sah (%q), memakai %s", name, raw, fallback)
		return fallback
	}
	return parsed
}

// verifyCheckExpectations membandingkan head hasil `-check` dengan yang
// tersimpan di manifes snapshot. Dipisah supaya bisa diuji tanpa menjalankan
// layanan (lihat service_test.go).
func verifyCheckExpectations(treeSize uint64, rootHex string, wantSize uint64, wantRoot string) error {
	if wantSize != 0 && treeSize != wantSize {
		return fmt.Errorf("tree size hasil ekstrak %d, manifes %d", treeSize, wantSize)
	}
	if wantRoot != "" && !strings.EqualFold(rootHex, wantRoot) {
		return fmt.Errorf("root hasil ekstrak %s, manifes %s", rootHex, wantRoot)
	}
	return nil
}

func main() {
	configPath := flag.String("config", envOr("KT_V2_CONFIG_FILE", "kt-v2-config.yaml"),
		"lokasi config YAML kt-server (dipakai bersama penulis log NYX)")
	readAddr := flag.String("read-addr", envOr("NYX_KT_V2_QUERY_ADDR", "127.0.0.1:8089"),
		"alamat HTTP baca (wajib loopback; proxy ada di server NYX)")
	writeAddr := flag.String("write-addr", envOr("NYX_KT_V2_WRITE_ADDR", "127.0.0.1:8088"),
		"alamat gRPC test-update; default sama dengan KT_V2_SERVER_URL penulis")
	auditorAddr := flag.String("auditor-addr", envOr("NYX_KT_V2_AUDITOR_ADDR", "127.0.0.1:8087"),
		"alamat gRPC layanan auditor pihak ketiga (TreeSize/Audit/SetAuditorHead); kosong = nonaktif")
	dbFile := flag.String("db", "", "override `db.file` dari config")
	distinguished := flag.Duration("distinguished", 0,
		"interval kunci distinguished; 0 = pakai `api.distinguished` dari config")
	snapshotDir := flag.String("snapshot-dir", envOr("NYX_KT_V2_SNAPSHOT_DIR", ""),
		"direktori arsip snapshot basis data; kosong = snapshot nonaktif")
	snapshotInterval := flag.Duration("snapshot-interval", envDuration("NYX_KT_V2_SNAPSHOT_INTERVAL", 24*time.Hour),
		"jeda antar snapshot (dipakai bila -snapshot-dir diisi)")
	snapshotKeep := flag.Int("snapshot-keep", envInt("NYX_KT_V2_SNAPSHOT_KEEP", defaultSnapshotKeep),
		"jumlah arsip snapshot terakhir yang disimpan di -snapshot-dir")
	metricsAddr := flag.String("metrics-addr", envOr("NYX_KT_V2_METRICS_ADDR", "127.0.0.1:9468"),
		"alamat exporter /metrics (loopback WAJIB; \"0\" = matikan)")
	checkOnly := flag.Bool("check", false, "buka database + bangun pohon, lalu keluar (health check deploy)")
	// Verifikasi arsip, bukan sekadar "bisa dibuka". LevelDB bisa MEMULIHKAN diri
	// dari salinan sebagian (arsip yang dirusak satu byte), jadi `-check` exit 0
	// tidak membuktikan arsip itu berisi log yang diharapkan. Dengan flag ini
	// satu perintah bisa membandingkan head hasil ekstrak dengan `latest.json`
	// (`docs/39` §39.5d temuan 2, §39.5b langkah 4).
	checkExpectSize := flag.Uint64("expect-size", 0, "dengan -check: gagal bila tree size hasil ekstrak berbeda")
	checkExpectRoot := flag.String("expect-root", "", "dengan -check: gagal bila root (hex) hasil ekstrak berbeda")
	flag.Parse()

	config, fileConfig, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("[kt-query-v2] %v", err)
	}

	file := *dbFile
	if file == "" {
		file = fileConfig.DB.File
	}
	if file == "" {
		log.Fatal("[kt-query-v2] `db.file` kosong dan -db tidak diberikan")
	}

	interval := *distinguished
	if interval == 0 {
		interval = fileConfig.API.Distinguished
	}

	// Basis data dibuka **eksklusif**: proses ini pemilik tunggal (LevelDB
	// menolak dibagi dua proses — lihat dokumentasi paket di store.go).
	store, err := openStore(file)
	if err != nil {
		log.Fatalf("[kt-query-v2] %v", err)
	}

	source := &storeTreeSource{cfg: config, store: store}
	tree, err := source.Tree()
	if err != nil {
		log.Fatalf("[kt-query-v2] %v", err)
	}
	head := tree.GetTransparencyTreeHead()
	log.Printf("[kt-query-v2] config=%s db=%s mode=%d treeSize=%d distinguished=%s",
		*configPath, file, config.Mode, head.TreeSize, interval)

	if *checkOnly {
		if *checkExpectSize == 0 && *checkExpectRoot == "" {
			return
		}
		root, err := tree.GetLogTree().GetRoot(head.TreeSize)
		if err != nil {
			log.Fatalf("[kt-query-v2] -check: ambil root: %v", err)
		}
		rootHex := hex.EncodeToString(root)
		if err := verifyCheckExpectations(head.TreeSize, rootHex, *checkExpectSize, *checkExpectRoot); err != nil {
			log.Fatalf("[kt-query-v2] -check GAGAL: %v", err)
		}
		log.Printf("[kt-query-v2] -check cocok: treeSize=%d root=%s", head.TreeSize, rootHex)
		return
	} else if *checkExpectSize != 0 || *checkExpectRoot != "" {
		// Menolak kombinasi yang membuang flag keamanan diam-diam.
		log.Fatalf("[kt-query-v2] -expect-size/-expect-root hanya berlaku bersama -check")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Satu kunci untuk semua penulis state pohon: update penulis NYX dan
	// `SetAuditorHead` dari auditor tidak boleh berjalan bersamaan.
	mu := &sync.Mutex{}
	updates := &updateService{cfg: config, store: store, mu: mu}
	go updates.runDistinguished(ctx, interval)

	// [docs/30 WS-G(7)] Metrik proses log (loopback). Dinyalakan sebelum listener
	// lain supaya kegagalan start-nya kelihatan sebagai `up == 0`, bukan senyap.
	if _, err := startQueryMetrics(ctx, *metricsAddr, queryMetrics, log.Printf); err != nil {
		// BUKAN alasan mematikan log: penulisan tetap fail-open (docs/32), dan
		// alert `NyxKtQueryDown` (up == 0) yang menutup kasus ini.
		log.Printf("[kt-query-v2] metrik TIDAK aktif: %v", err)
	}

	// Nilai awal dua metrik yang bisa dibaca langsung dari log: ukuran pohon dan
	// umur anchor `distinguished`. Keduanya BERTAHAN setelah restart (dibaca dari
	// basis data), jadi alert "anchor basi" tidak menyala hanya karena proses baru
	// hidup — beda dengan metrik yang lahir dari peristiwa runtime.
	queryMetrics.setTreeSize(head.TreeSize)
	if timestamp, ok := updates.distinguishedTimestamp(); ok {
		queryMetrics.setDistinguishedTimestamp(timestamp)
	}

	// [docs/10 §10.13] Salinan harian log KT: penulisan dijeda, direktori disalin,
	// salinan diverifikasi terhadap tree head hidup, lalu diarsipkan. Pengunggahan
	// ke R2 dilakukan proses lain (`server/src/jobs/ktSnapshot.ts`) — kredensial
	// objek tidak dipasang di proses log.
	if *snapshotDir != "" {
		snapshotter := newSnapshotter(config, store, file, mu, *snapshotDir, *snapshotKeep)
		go snapshotter.run(ctx, *snapshotInterval)
	} else {
		log.Printf("[kt-query-v2] snapshot nonaktif (NYX_KT_V2_SNAPSHOT_DIR kosong)")
	}

	grpcListener, err := net.Listen("tcp", *writeAddr)
	if err != nil {
		log.Fatalf("[kt-query-v2] listen gRPC %s: %v", *writeAddr, err)
	}
	grpcServer := grpc.NewServer()
	pb.RegisterKeyTransparencyTestServiceServer(grpcServer, updates)
	go func() {
		log.Printf("[kt-query-v2] test-update gRPC di %s (untuk penulis NYX)", *writeAddr)
		if err := grpcServer.Serve(grpcListener); err != nil {
			log.Printf("[kt-query-v2] gRPC berhenti: %v", err)
		}
	}()

	// Layanan auditor: listener terpisah supaya penulis log dan auditor tidak
	// berbagi port (auditor adalah pihak ketiga; jalur penulis tetap tidak berubah).
	var auditorServer *grpc.Server
	var auditorListener net.Listener
	if *auditorAddr != "" {
		auditorListener, err = net.Listen("tcp", *auditorAddr)
		if err != nil {
			log.Fatalf("[kt-query-v2] listen gRPC auditor %s: %v", *auditorAddr, err)
		}
		auditorServer = grpc.NewServer()
		pb.RegisterKeyTransparencyAuditorServiceServer(auditorServer, &auditorService{cfg: config, store: store, mu: mu})
		auditors := "(tidak ada auditor terkonfigurasi)"
		if len(config.AuditorKeys) > 0 {
			auditors = strings.Join(sortedKeys(config.AuditorKeys), ",")
		}
		go func() {
			log.Printf("[kt-query-v2] auditor gRPC di %s — auditor terkonfigurasi: %s (mode=%d)",
				*auditorAddr, auditors, config.Mode)
			if err := auditorServer.Serve(auditorListener); err != nil {
				log.Printf("[kt-query-v2] gRPC auditor berhenti: %v", err)
			}
		}()
	}

	httpServer := &http.Server{
		Addr:              *readAddr,
		Handler:           (&queryServer{source: source}).routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}

	go func() {
		<-ctx.Done()
		log.Printf("[kt-query-v2] sinyal berhenti diterima")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		grpcServer.GracefulStop()
		if auditorServer != nil {
			auditorServer.GracefulStop()
		}
	}()

	log.Printf("[kt-query-v2] HTTP baca di http://%s (loopback saja — jangan expose)", *readAddr)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[kt-query-v2] server berhenti: %v", err)
	}
}
