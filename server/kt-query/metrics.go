// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// [docs/30 WS-G(7)] Metrik proses **log** Key Transparency (`nyx-kt-query`).
//
// Sampai berkas ini ada, `nyx-kt-query` — satu-satunya proses yang memegang
// riwayat kunci seluruh pengguna — tidak punya `/metrics` sama sekali. Yang
// terlihat hanya auditor (proses lain) dan sisi server NYX, dan keduanya
// **tidak** melihat hal-hal berikut:
//
//   - tulisan log yang GAGAL di dalam proses ini (sisi server hanya tahu
//     kegagalan yang ia lihat di gRPC: `nyx_kt_writes_total{result="error"}`),
//   - snapshot lokal yang berhenti dibuat (pemulihan log bergantung padanya,
//     docs/10 §10.13),
//   - kunci `distinguished` yang berhenti berputar — anchor satu-satunya bagi
//     klien yang belum mengenal kontak mana pun (docs/34 §34.5),
//   - laju baca per operasi (`/search`, `/distinguished`, `/monitor`).
//
// Aturan label mengikuti `server/src/utils/metrics.ts` dan auditor
// (`cmd/nyx-kt-auditor/metrics.go`), tetapi ditegakkan dengan bentuk yang lebih
// murah di sini: metrik WAJIB dideklarasikan lebih dulu, dan SETIAP nilai label
// divalidasi terhadap tabel `allowedLabelValues` — nilai di luar tabel ditolak
// dan dihitung di `nyx_kt_query_metrics_rejected_total`. Jadi menaruh
// userId/IP/base64 ke metrik bukan cuma "tidak dilakukan", melainkan tidak bisa.
//
// Endpoint ini **bukan** pengganti liveness: `up{job="nyx-kt-query"}` sudah
// menutupi proses yang mati. Yang diukur di sini adalah proses yang hidup tetapi
// berhenti membuat kemajuan.
//
// Tanpa dependency baru: eksposisi teks Prometheus 0.0.4 ditulis di sini (modul
// ini ter-vendor penuh dan tidak menambah library demi satu endpoint teks).

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Deklarasi metrik (docs/30 WS-G(7)). Semua nama label = enum pendek.
//
// Bentuk penulisannya sengaja `= defineCounter("nyx_…",` pada SATU baris:
// `scripts/drill-alerts.sh` (lapis 3) membaca deklarasi dari berkas ini untuk
// memastikan setiap metrik yang dirujuk `ops/prometheus/alerts.yml` benar-benar
// ada. Nama yang pindah ke baris berikutnya akan terbaca sebagai "tidak
// dideklarasikan" — dan aturan yang merujuk metrik tak dikenal tidak pernah
// menyala tanpa mengeluarkan error apa pun.
// ============================================================================

var (
	// Tulisan log: `ok` (entri baru masuk), `duplicate` (update yang sama diulang
	// — idempoten, bukan kegagalan), `invalid` (permintaan klien salah, mis.
	// consistency kosong), `error` (pohon/basis data gagal: kegagalan nyata).
	metricWritesTotal = defineCounter("nyx_kt_query_writes_total",
		"Penulisan entri log KT di proses log, per hasil",
		"result",
	)

	// Operasi baca per hasil. `not_found` dipisah dari `invalid`: \"search key
	// belum ada di log\" adalah jawaban sah (klien harus bisa membedakannya dari
	// layanan mati, docs/34 §34.6), sedangkan `invalid`/`error` tidak.
	metricReadsTotal = defineCounter("nyx_kt_query_reads_total",
		"Operasi baca log KT, per operasi dan hasil",
		"op", "result",
	)

	// Snapshot lokal: `ok` = arsip tersimpan DAN terverifikasi, `error` = langkah
	// mana pun gagal (salinan, verifikasi tree head/root, arsip).
	metricSnapshotTotal = defineCounter("nyx_kt_query_snapshot_total",
		"Percobaan snapshot lokal basis data log KT, per hasil",
		"result",
	)

	// Ukuran pohon menurut proses log itu sendiri (bukan auditor).
	metricTreeSize = defineGauge("nyx_kt_query_tree_size",
		"Ukuran pohon log KT menurut proses log (jumlah update)",
	)

	// Unix timestamp snapshot lokal terakhir yang berhasil Diverifikasi.
	// Hanya lahir setelah snapshot pertama sukses → alert memakai
	// `absent_over_time` (lihat ops/prometheus/alerts.yml).
	metricSnapshotLastTimestamp = defineGauge("nyx_kt_query_snapshot_last_timestamp_seconds",
		"Unix timestamp snapshot lokal terakhir yang tersimpan dan terverifikasi (tidak ada sebelum snapshot pertama)",
	)

	// Unix timestamp nilai kunci `distinguished` yang tersimpan. Dibaca dari log
	// saat start (jadi tidak hilang saat restart) dan diperbarui setiap putaran
	// `runDistinguished`: seri ini basi bila loop itu berhenti berputar.
	metricDistinguishedTimestamp = defineGauge("nyx_kt_query_distinguished_timestamp_seconds",
		"Unix timestamp kunci distinguished yang tersimpan di log (anchor klien tanpa kontak)",
	)

	// Umur proses log. Dipakai alert \"proses berulang kali restart\" untuk
	// membedakan restart cepat dari proses yang memang baru hidup.
	metricUptimeSeconds = defineGauge("nyx_kt_query_uptime_seconds",
		"Umur proses log KT dalam detik (sejak proses start)",
	)

	// Penjaga privasi: label di luar enum yang dideklarasikan. Harus SELALU 0.
	metricMetricsRejected = defineCounter("nyx_kt_query_metrics_rejected_total",
		"Percobaan mencatat metrik log KT dengan label tidak sah (indikasi kebocoran identitas ke metrik)",
		"reason",
	)
)

// queryMetricDefs adalah urutan deklarasi (urutan render eksposisi).
var queryMetricDefs = []metricDef{
	metricWritesTotal,
	metricReadsTotal,
	metricSnapshotTotal,
	metricTreeSize,
	metricSnapshotLastTimestamp,
	metricDistinguishedTimestamp,
	metricUptimeSeconds,
	metricMetricsRejected,
}

// Nilai label yang sah — satu-satunya pintu masuk nilai ke time series.
//
// "result" dipakai beberapa metrik dengan himpunan hasil yang berbeda (tulis log
// vs baca vs snapshot), jadi tabel ini gabungannya; setiap metrik tetap hanya
// memakai subset yang masuk akal (dijaga oleh nama fungsi pemanggilnya).
var allowedLabelValues = map[string]map[string]bool{
	"result": {
		"ok":        true,
		"duplicate": true,
		"invalid":   true,
		"cancelled": true,
		"error":     true,
		"not_found": true,
	},
	"op": {
		"search":        true,
		"distinguished": true,
		"monitor":       true,
		"head":          true,
		"config":        true,
		"health":        true,
	},
	"reason": {
		"unknown_label_value": true,
		"unknown_metric":      true,
		"wrong_kind":          true,
	},
}

// Hasil tulis log (nilai label `result` pada `nyx_kt_query_writes_total`).
const (
	writeResultOK        = "ok"
	writeResultDuplicate = "duplicate"
	writeResultInvalid   = "invalid"
	// writeResultCancelled = konteks gRPC batal/deadline lewat SEBELUM menulis:
	// bukan kegagalan pohon, jadi tidak boleh menaikkan `error` (yang berarti
	// basis data/pohon bermasalah).
	writeResultCancelled = "cancelled"
	writeResultError     = "error"
)

// Hasil snapshot lokal (nilai label `result` pada `nyx_kt_query_snapshot_total`).
const (
	snapshotResultOK    = "ok"
	snapshotResultError = "error"
)

// Hasil baca (nilai label `result` pada `nyx_kt_query_reads_total`).
const (
	readResultOK = "ok"
	// readErrorNotFound = \"tidak ada di log\" — jawaban sah, bukan kegagalan.
	readErrorNotFound = "not_found"
	// readErrorInvalid = permintaan klien salah (400/405).
	readErrorInvalid = "invalid"
	// readErrorError = kegagalan layanan (5xx).
	readErrorError = "error"
)

// Operasi baca (nilai label `op`).
const (
	readOpSearch        = "search"
	readOpDistinguished = "distinguished"
	readOpMonitor       = "monitor"
	readOpHead          = "head"
	readOpConfig        = "config"
	readOpHealth        = "health"
)

// Alasan penolakan label — enum pendek.
const (
	rejectUnknownLabelValue = "unknown_label_value"
	rejectUnknownMetric     = "unknown_metric"
	rejectWrongKind         = "wrong_kind"
)

// ============================================================================
// Jenis metrik + deklarasi
// ============================================================================

type metricKind string

const (
	counterKind metricKind = "counter"
	gaugeKind   metricKind = "gauge"
)

type metricDef struct {
	name   string
	kind   metricKind
	help   string
	labels []string
}

func defineMetric(name string, kind metricKind, help string, labels ...string) metricDef {
	if !strings.HasPrefix(name, "nyx_") {
		panic("nama metrik harus berawalan nyx_: " + name)
	}
	for _, label := range labels {
		if _, known := allowedLabelValues[label]; !known {
			panic("nama label tanpa tabel nilai: " + label)
		}
	}
	return metricDef{name: name, kind: kind, help: help, labels: labels}
}

func defineCounter(name, help string, labels ...string) metricDef {
	return defineMetric(name, counterKind, help, labels...)
}

func defineGauge(name, help string, labels ...string) metricDef {
	return defineMetric(name, gaugeKind, help, labels...)
}

// ============================================================================
// Nilai
// ============================================================================

type queryMetricsState struct {
	started time.Time

	mu sync.Mutex
	// series: nama metrik → kunci label → nilai. Kunci label dibangun dari label
	// yang sudah tervalidasi, jadi deret waktu tidak bisa lahir dari nilai runtime.
	series map[string]map[string]float64
}

func newQueryMetrics() *queryMetricsState {
	state := &queryMetricsState{started: time.Now(), series: map[string]map[string]float64{}}
	for _, def := range queryMetricDefs {
		state.series[def.name] = map[string]float64{}
		// Semua kombinasi label yang sah lahir dengan nilai 0. Dashboard harus
		// menampilkan 0 — bukan "No data" — untuk hasil yang belum pernah terjadi
		// (mis. `result="error"`); pola yang sama dipakai sidecar WebTransport.
		// Kardinalitasnya kecil karena setiap nilai label adalah enum.
		for _, values := range labelCombinations(def.labels) {
			state.series[def.name][seriesKey(values)] = 0
		}
	}
	return state
}

// labelCombinations menghasilkan seluruh kombinasi nilai label yang sah untuk
// satu metrik (urut sesuai deklarasi label).
func labelCombinations(labels []string) [][]string {
	acc := [][]string{{}}
	for _, label := range labels {
		next := make([][]string, 0, len(acc))
		for _, prefix := range acc {
			for value := range allowedLabelValues[label] {
				combination := make([]string, 0, len(prefix)+1)
				combination = append(combination, prefix...)
				next = append(next, append(combination, value))
			}
		}
		acc = next
	}
	return acc
}

// queryMetrics adalah instans tunggal per proses (dipakai penulis, pembaca,
// snapshotter, dan exporter).
var queryMetrics = newQueryMetrics()

func seriesKey(values []string) string {
	return strings.Join(values, "\x00")
}

// add menambah (counter) atau menulis (gauge) nilai satu metrik. Nilai label
// divalidasi terhadap `allowedLabelValues`; pelanggaran DITOLAK dan dihitung.
func (m *queryMetricsState) add(def metricDef, delta float64, values ...string) {
	if len(values) != len(def.labels) {
		m.reject(rejectUnknownLabelValue)
		return
	}
	for i, value := range values {
		if !allowedLabelValues[def.labels[i]][value] {
			m.reject(rejectUnknownLabelValue)
			return
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	bucket, known := m.series[def.name]
	if !known {
		m.rejectLocked(rejectUnknownMetric)
		return
	}
	if def.kind == gaugeKind {
		bucket[seriesKey(values)] = delta
		return
	}
	bucket[seriesKey(values)] += delta
}

func (m *queryMetricsState) reject(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rejectLocked(reason)
}

func (m *queryMetricsState) rejectLocked(reason string) {
	if !allowedLabelValues["reason"][reason] {
		reason = rejectUnknownLabelValue
	}
	m.series[metricMetricsRejected.name][seriesKey([]string{reason})]++
}

// --- Pembungkus per peristiwa (dipakai pemanggil; tanpa nilai label bebas) ---

func (m *queryMetricsState) write(result string) {
	m.add(metricWritesTotal, 1, result)
}

func (m *queryMetricsState) read(op string, result string) {
	m.add(metricReadsTotal, 1, op, result)
}

func (m *queryMetricsState) snapshot(result string) {
	m.add(metricSnapshotTotal, 1, result)
}

func (m *queryMetricsState) snapshotFailed() {
	m.add(metricSnapshotTotal, 1, snapshotResultError)
}

func (m *queryMetricsState) snapshotStored(at time.Time) {
	m.add(metricSnapshotTotal, 1, snapshotResultOK)
	m.add(metricSnapshotLastTimestamp, float64(at.Unix()))
}

func (m *queryMetricsState) setTreeSize(size uint64) {
	m.add(metricTreeSize, float64(size))
}

func (m *queryMetricsState) setDistinguishedTimestamp(at time.Time) {
	m.add(metricDistinguishedTimestamp, float64(at.Unix()))
}

// render menghasilkan eksposisi teks Prometheus 0.0.4 (deterministik: seri
// diurutkan, supaya test bisa membandingkan keluaran).
func (m *queryMetricsState) render() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var out strings.Builder
	for _, def := range queryMetricDefs {
		out.WriteString("# HELP " + def.name + " " + def.help + "\n")
		out.WriteString("# TYPE " + def.name + " " + string(def.kind) + "\n")

		if def.name == metricUptimeSeconds.name {
			out.WriteString(def.name + " " + strconv.FormatInt(int64(time.Since(m.started).Seconds()), 10) + "\n")
			continue
		}

		keys := make([]string, 0, len(m.series[def.name]))
		for key := range m.series[def.name] {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			labels := ""
			if len(def.labels) > 0 {
				parts := strings.Split(key, "\x00")
				pairs := make([]string, 0, len(parts))
				for i, value := range parts {
					pairs = append(pairs, def.labels[i]+`="`+value+`"`)
				}
				labels = "{" + strings.Join(pairs, ",") + "}"
			}
			out.WriteString(def.name + labels + " " + strconv.FormatFloat(m.series[def.name][key], 'f', -1, 64) + "\n")
		}
	}
	return out.String()
}

// ============================================================================
// Listener loopback
// ============================================================================

// errMetricsAddrNotLoopback menandai alamat metrik yang bukan loopback.
var errMetricsAddrNotLoopback = errors.New("alamat metrik harus loopback (127.0.0.1 / ::1)")

// isLoopbackHost menerima "localhost", "::1", dan seluruh 127.0.0.0/8.
func isLoopbackHost(host string) bool {
	if host == "localhost" || host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// startQueryMetrics menjalankan exporter di alamat loopback. Nilai kosong atau
// "0" mematikan exporter (log tetap berjalan — hanya visibilitas yang hilang,
// dan itu pilihan sadar operator).
//
// Host non-loopback DITOLAK, bukan diperingatkan: metrik ini memetakan
// infrastruktur (ukuran log, irama snapshot, laju baca), dan satu alamat salah
// tulis cukup untuk membocorkannya ke jaringan — pola yang sama dengan
// `server/src/utils/metricsEndpoint.ts` dan auditor KT.
func startQueryMetrics(ctx context.Context, addr string, metrics *queryMetricsState, logf func(string, ...any)) (net.Addr, error) {
	if addr == "" || addr == "0" {
		logf("metrik: dimatikan (alamat %q)", addr)
		return nil, nil
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("alamat metrik %q tidak sah: %w", addr, err)
	}
	if !isLoopbackHost(host) {
		return nil, fmt.Errorf("%w: %s", errMetricsAddrNotLoopback, addr)
	}

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("metrik tidak bisa listen di %s: %w", addr, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.Header().Set("Allow", http.MethodGet)
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = writer.Write([]byte(metrics.render()))
	})
	mux.HandleFunc("/healthz", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = writer.Write([]byte("ok\n"))
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			logf("metrik berhenti: %v", err)
		}
	}()

	// Berhenti bersama proses log: port dilepas rapi supaya restart tidak
	// bertabrakan dengan socket lama.
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logf("metrik: http://%s/metrics (loopback)", listener.Addr().String())
	return listener.Addr(), nil
}
