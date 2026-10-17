// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Command nyx-kt-auditor menjalankan **auditor pihak ketiga** untuk log Key
// Transparency NYX: ia menarik aliran update (`Audit`), memverifikasi setiap
// bukti terhadap pandangannya sendiri, lalu menandatangani tree head dan
// mengirimkannya balik (`SetAuditorHead`). Tanpa proses ini, log hanya berjalan
// `ContactMonitoring` (mode 1) — byte tanda tangan auditor tidak pernah
// diperiksa siapa pun (`docs/34` §34.5).
//
// Verifikasi di sini **bukan** tafsiran kami: algoritmanya port baris-per-baris
// dari implementasi auditor referensi Signal
// (`signalapp/key-transparency-auditor`, Java, AGPL-3.0) — lihat `prefix_tree.go`
// dan `log_tree.go`. Yang memakai kode upstream apa adanya: penyusunan tanda
// tangan tree head (`transparency.SignNewAuditorHead`, fungsi yang sama dengan
// yang dipakai verifier `SetAuditorHead` di `server/kt-query/audit.go`).
//
// Nama auditor dibawa di metadata gRPC `x-nyx-auditor-name` (deployment loopback
// tanpa mTLS); kunci publiknya harus ada di `api.auditors` config log. Nama
// sendirian tidak berguna — tanda tangan tetap diverifikasi terhadap kunci
// publik di config.
//
// Di mode daemon, proses ini juga menyajikan `/metrics` (format teks Prometheus)
// di alamat **loopback** (`-metrics-addr`, default 127.0.0.1:9466) supaya
// kemacetan auditor terlihat tanpa membaca journal — lihat `metrics.go` dan
// `ops/prometheus/{prometheus.yml,alerts.yml}`.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/tree/transparency"
)

// auditorNameMetadataKey harus sama dengan `auditorNameMetadataKey` di
// `server/kt-query/audit.go`. Bila salah satu berubah, auditor akan ditolak
// `InvalidArgument` — bukan diam-diam berjalan tanpa identitas.
const auditorNameMetadataKey = "x-nyx-auditor-name"

const httpTimeout = 15 * time.Second

type options struct {
	name              string
	keyFile           string
	stateFile         string
	readURL           string
	auditorAddr       string
	metricsAddr       string
	batchSize         uint64
	interval          time.Duration
	signatureInterval time.Duration
	signaturePageSize uint64
	once              bool
	check             bool
	printPublicKey    bool
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("[kt-auditor] ")

	parsed, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ %v\n", err)
		os.Exit(2)
	}
	if err := run(parsed); err != nil {
		fmt.Fprintf(os.Stderr, "❌ %v\n", err)
		os.Exit(1)
	}
}

func parseFlags(args []string) (options, error) {
	var parsed options
	flags := flag.NewFlagSet("nyx-kt-auditor", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&parsed.name, "name", envOr("NYX_KT_AUDITOR_NAME", ""),
		"nama auditor; harus punya entri di `api.auditors` config log")
	flags.StringVar(&parsed.keyFile, "key-file", envOr("NYX_KT_AUDITOR_KEY_FILE", ""),
		"berkas berisi seed ed25519 auditor (64 karakter hex, mode 0600)")
	flags.StringVar(&parsed.stateFile, "state-file", envOr("NYX_KT_AUDITOR_STATE_FILE", "/var/lib/nyx/kt-auditor/state.json"),
		"berkas state auditor (JSON bertanda tangan; dibuat bila belum ada)")
	flags.StringVar(&parsed.readURL, "read-url", envOr("NYX_KT_QUERY_URL", "http://127.0.0.1:8085"),
		"basis URL layanan baca (dipakai untuk mengambil /config)")
	flags.StringVar(&parsed.auditorAddr, "auditor-addr", envOr("NYX_KT_AUDITOR_ADDR", "127.0.0.1:8082"),
		"alamat gRPC layanan auditor log")
	flags.StringVar(&parsed.metricsAddr, "metrics-addr", envOr("NYX_KT_AUDITOR_METRICS_ADDR", "127.0.0.1:9466"),
		"alamat exporter /metrics (loopback WAJIB; \"0\" = matikan)")
	flags.Uint64Var(&parsed.batchSize, "batch-size", envUint("NYX_KT_AUDITOR_BATCH_SIZE", auditMaxBatchSize),
		"jumlah update per permintaan Audit (maksimum 1000, batas upstream)")
	flags.DurationVar(&parsed.interval, "interval", envDuration("NYX_KT_AUDITOR_INTERVAL", time.Minute),
		"jeda antar putaran audit")
	flags.DurationVar(&parsed.signatureInterval, "signature-interval", envDuration("NYX_KT_AUDITOR_SIGNATURE_INTERVAL", time.Hour),
		"irama mengirim tree head bertanda tangan (0 = setiap putaran)")
	flags.Uint64Var(&parsed.signaturePageSize, "signature-page-size", envUint("NYX_KT_AUDITOR_SIGNATURE_PAGE_SIZE", 1_000_000),
		"jumlah update yang memicu pengiriman tree head")
	flags.BoolVar(&parsed.once, "once", false,
		"proses semua update yang tersedia, kirim SATU tree head di akhir, lalu keluar (drill/verifikasi)")
	flags.BoolVar(&parsed.check, "check", false,
		"periksa config layanan + koneksi layanan auditor, lalu keluar (tidak menyentuh state)")
	flags.BoolVar(&parsed.printPublicKey, "print-public-key", false,
		"cetak kunci publik auditor (hex) + baris `api.auditors` yang siap ditempel, lalu keluar")
	flags.Usage = func() {
		fmt.Fprint(os.Stderr, `nyx-kt-auditor — auditor pihak ketiga untuk log Key Transparency NYX

  nyx-kt-auditor -name <nama> -key-file <berkas> [-state-file <berkas>]
                 [-read-url http://127.0.0.1:8085] [-auditor-addr 127.0.0.1:8082]
                 [-metrics-addr 127.0.0.1:9466]
                 [-batch-size 1000] [-interval 1m] [-signature-interval 1h]
                 [-signature-page-size 1000000] [-once] [-check] [-print-public-key]

Semua flag bisa lewat env: NYX_KT_AUDITOR_NAME, NYX_KT_AUDITOR_KEY_FILE,
NYX_KT_AUDITOR_STATE_FILE, NYX_KT_QUERY_URL, NYX_KT_AUDITOR_ADDR,
NYX_KT_AUDITOR_METRICS_ADDR, dst.

Keluar dengan status ≠ 0 bila config layanan bukan mode 3, kunci auditor tidak
terdaftar di config, atau update tidak bisa diverifikasi.
`)
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		return parsed, err
	}
	if parsed.name == "" {
		return parsed, errors.New("flag -name wajib diisi (nama auditor di `api.auditors`)")
	}
	if parsed.keyFile == "" {
		return parsed, errors.New("flag -key-file wajib diisi (seed ed25519 auditor)")
	}
	if parsed.stateFile == "" && !parsed.check {
		return parsed, errors.New("flag -state-file wajib diisi")
	}
	return parsed, nil
}

func run(parsed options) error {
	privateKey, err := loadAuditorKey(parsed.keyFile)
	if err != nil {
		return err
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)

	if parsed.printPublicKey {
		// Dipakai saat pemasangan: hasilnya adalah entri yang harus ada di
		// `api.auditors` config log — supaya kunci publik tidak pernah disalin
		// dengan tangan (salah salin = semua tanda tangan ditolak).
		fmt.Printf("%x\n", publicKey)
		fmt.Printf("api.auditors:\n  %s: %x\n", parsed.name, publicKey)
		return nil
	}

	config, err := fetchPublicConfig(parsed.readURL, parsed.name, publicKey)
	if err != nil {
		return err
	}
	log.Printf("config=%s mode=%d kunci auditor %q cocok dengan yang terdaftar",
		parsed.readURL, config.Mode, parsed.name)

	conn, err := dialAuditor(parsed.auditorAddr, parsed.name)
	if err != nil {
		return err
	}
	defer conn.Close()
	client := pb.NewKeyTransparencyAuditorServiceClient(conn)

	if parsed.check {
		ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
		defer cancel()
		response, err := client.TreeSize(ctx, &emptypb.Empty{})
		if err != nil {
			return fmt.Errorf("TreeSize: %w", err)
		}
		fmt.Printf("OK kt-auditor mode=3 auditor=%s treeSize=%d\n", parsed.name, response.GetTreeSize())
		return nil
	}

	store := newFileStateStore(parsed.stateFile, privateKey)
	runner, err := newAuditorRunner(
		parsed.name, privateKey, config, client, store,
		parsed.batchSize, parsed.interval, parsed.signatureInterval, parsed.signaturePageSize,
		time.Now, log.Printf,
	)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if parsed.once {
		if err := runner.loadState(); err != nil {
			return err
		}
		processed, err := runner.runOnceForceHead(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("OK kt-auditor once updates=%d treeSize=%d state=%s\n",
			processed, runner.totalUpdatesProcessed, parsed.stateFile)
		return nil
	}

	// Exporter metrik hanya untuk mode daemon: `-once`/`-check` selesai dalam
	// hitungan detik, jadi tidak ada deret waktu yang berguna untuk di-scrape.
	if _, err := startAuditorMetrics(ctx, parsed.metricsAddr, runner.metrics, log.Printf); err != nil {
		return err
	}

	return runner.run(ctx)
}

// loadAuditorKey membaca seed ed25519 (hex) dari berkas dan membangun kunci privat.
func loadAuditorKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("baca kunci auditor %s: %w", path, err)
	}
	// Mode longgar pada berkas kunci = siapa pun di host bisa menandatangani tree
	// head atas nama auditor; diperingatkan, bukan ditolak (operator yang tahu).
	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o077 != 0 {
		log.Printf("peringatan: %s bermode %04o — sebaiknya 0600", path, info.Mode().Perm())
	}

	trimmed := strings.TrimPrefix(strings.TrimSpace(string(raw)), "0x")
	seed, err := hex.DecodeString(trimmed)
	if err != nil {
		return nil, fmt.Errorf("kunci auditor %s bukan hex: %w", path, err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("kunci auditor %s %d byte, ingin %d (seed ed25519)", path, len(seed), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// configPayload adalah bentuk `/config` layanan baca NYX (`server/kt-query/query.go`).
type configPayload struct {
	Mode            int      `json:"mode"`
	SignatureKey    string   `json:"signatureKey"`
	VRFKey          string   `json:"vrfKey"`
	AuditorKeys     []string `json:"auditorKeys"`
	SearchKeyPrefix string   `json:"searchKeyPrefix"`
}

// fetchPublicConfig membangun `transparency.PublicConfig` dari `/config` dan
// memastikan dua hal yang menentukan apakah auditor ini berguna:
//
//  1. mode layanan **3** (`ThirdPartyAuditing`) — di mode lain `SetAuditorHead`
//     ditolak upstream, jadi menjalankan auditor hanya membuang waktu;
//  2. kunci publik auditor ini benar-benar terdaftar — nama saja tidak cukup,
//     dan salah kunci berarti tanda tangan akan ditolak `FailedPrecondition`.
func fetchPublicConfig(base, name string, publicKey ed25519.PublicKey) (*transparency.PublicConfig, error) {
	client := &http.Client{Timeout: httpTimeout}
	response, err := client.Get(strings.TrimRight(base, "/") + "/config")
	if err != nil {
		return nil, fmt.Errorf("GET /config: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("GET /config: status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload configPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("GET /config: urai JSON: %w", err)
	}
	if transparency.DeploymentMode(payload.Mode) != transparency.ThirdPartyAuditing {
		return nil, fmt.Errorf("layanan berjalan di mode %d, bukan 3 (ThirdPartyAuditing) — "+
			"tambahkan auditor ke `api.auditors` di config log lalu restart layanan", payload.Mode)
	}

	sigKey, err := hex.DecodeString(payload.SignatureKey)
	if err != nil {
		return nil, fmt.Errorf("signatureKey bukan hex: %w", err)
	}
	if len(sigKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("signatureKey %d byte, ingin %d", len(sigKey), ed25519.PublicKeySize)
	}
	vrfRaw, err := hex.DecodeString(payload.VRFKey)
	if err != nil {
		return nil, fmt.Errorf("vrfKey bukan hex: %w", err)
	}
	verifier, err := edvrf.NewVRFVerifier(ed25519.PublicKey(vrfRaw))
	if err != nil {
		return nil, fmt.Errorf("vrfKey tidak sah: %w", err)
	}

	auditors := make(map[string]ed25519.PublicKey, len(payload.AuditorKeys))
	found := false
	for index, value := range payload.AuditorKeys {
		raw, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("auditorKeys[%d] bukan hex: %w", index, err)
		}
		if len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("auditorKeys[%d] %d byte, ingin %d", index, len(raw), ed25519.PublicKeySize)
		}
		key := ed25519.PublicKey(raw)
		// Endpoint /config hanya mengirim kunci, bukan nama; kunci kita sendiri
		// didaftarkan dengan nama auditor ini agar penanda-tanganan bisa memakainya.
		if key.Equal(publicKey) {
			found = true
			auditors[name] = key
			continue
		}
		auditors[fmt.Sprintf("config-%d", index)] = key
	}
	if !found {
		return nil, fmt.Errorf("kunci publik auditor ini tidak ada di %d kunci yang terdaftar di config log — "+
			"periksa entri `api.auditors` untuk %q", len(payload.AuditorKeys), name)
	}

	return &transparency.PublicConfig{
		Mode:        transparency.ThirdPartyAuditing,
		SigKey:      ed25519.PublicKey(sigKey),
		AuditorKeys: auditors,
		VrfKey:      verifier,
	}, nil
}

// dialAuditor menyambung layanan auditor log (loopback plaintext) dan menambahkan
// nama auditor di setiap panggilan.
func dialAuditor(addr, name string) (*grpc.ClientConn, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithUnaryInterceptor(func(ctx context.Context, method string, request, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
			return invoker(metadata.AppendToOutgoingContext(ctx, auditorNameMetadataKey, name), method, request, reply, cc, opts...)
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("sambung layanan auditor %s: %w", addr, err)
	}
	return conn, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envUint(name string, fallback uint64) uint64 {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := parseUint(raw)
	if err != nil {
		log.Printf("env %s tidak sah (%q), memakai %d", name, raw, fallback)
		return fallback
	}
	return parsed
}

func parseUint(raw string) (uint64, error) {
	var parsed uint64
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &parsed); err != nil {
		return 0, err
	}
	return parsed, nil
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		log.Printf("env %s tidak sah (%q), memakai %s", name, raw, fallback)
		return fallback
	}
	return parsed
}
