// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// [docs/30 WS-G] Metrik auditor Key Transparency — **loopback only**.
//
// Sampai file ini ada, auditor mode 3 adalah kotak hitam: satu-satunya jejaknya
// ada di journal (`tree head DIKIRIM …`). Kalau auditor mati, berhenti
// menandatangani, atau ditolak layanan log, tidak ada yang tahu sampai klien
// menolak auditor head yang basi (batas 7 hari) — dan itu berarti log KT
// efektif kehilangan jaminan auditasnya. Metrik di bawah menutup celah itu:
// umur tree head terakhir yang DITERIMA log, hasil tiap putaran verifikasi, dan
// (khususnya) putaran yang menemukan riwayat tidak konsisten.
//
// Aturan yang sama dengan `server/src/utils/metrics.ts` (docs/30 §30.1 poin 4):
//
//  1. Metrik WAJIB dideklarasikan lebih dulu (`defineCounter`/`defineGauge`) —
//     deret waktu tidak boleh lahir dari nilai runtime.
//  2. Nama label WAJIB ada di deklarasi metrik.
//  3. Nilai label WAJIB lolos `isSafeLabelValue()`: pendek, dan tidak berbentuk
//     UUID / heksadesimal panjang / base64url panjang / IP / email. Pelanggaran
//     ditolak + dihitung di `nyx_kt_auditor_metrics_rejected_total`.
//
// Tidak ada dependency baru: eksposisi teks Prometheus 0.0.4 ditulis di sini —
// sama seperti sisi server TS. Modul `server/kt-query` ter-vendor penuh dan
// sengaja tidak menambah library demi satu endpoint teks (docs/32 §32.8).
//
// Endpoint ini **bukan** pengganti liveness proses: `up{job="nyx-kt-auditor"}`
// di Prometheus sudah menutupi kematian proses. Yang tidak tertutupi oleh `up`
// adalah proses yang hidup tetapi berhenti membuat kemajuan — itulah yang
// diukur di sini.

package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Deklarasi metrik auditor (docs/30 WS-G). Semua nama label = enum pendek.
//
// Bentuk penulisannya sengaja `= defineCounter("nyx_…",` pada SATU baris:
// `scripts/drill-alerts.sh` (lapis 3) membaca deklarasi dari file ini untuk
// memastikan setiap metrik yang dirujuk `ops/prometheus/alerts.yml` benar-benar
// ada. Nama yang pindah ke baris berikutnya akan terbaca sebagai "tidak
// dideklarasikan" — dan aturan yang merujuk metrik tak dikenal TIDAK pernah
// menyala tanpa mengeluarkan error apa pun.
// ============================================================================

var (
	// Putaran audit yang selesai, per hasil. `inconsistent` = bukti dari layanan
	// log tidak konsisten dengan pandangan auditor sendiri (peristiwa keamanan,
	// bukan gangguan operasional).
	metricRoundsTotal = defineCounter("nyx_kt_auditor_rounds_total",
		"Putaran audit auditor KT yang selesai, per hasil",
		"result",
	)

	// Update log yang berhasil diverifikasi. Lajunya adalah "detak" log KT:
	// datar berarti tidak ada tulisan baru (wajar saat sepi) ATAU auditor
	// tertinggal (tidak wajar).
	metricUpdatesVerifiedTotal = defineCounter("nyx_kt_auditor_updates_verified_total",
		"Update log KT yang berhasil diverifikasi auditor, sejak proses hidup",
	)

	// Percobaan mengirim tree head bertanda tangan ke layanan log, per hasil.
	// `error` di sini = `SetAuditorHead` ditolak/mati (mode bukan 3, kunci tidak
	// terdaftar, layanan log tidak menjawab) — head tidak pernah sampai.
	metricHeadSendsTotal = defineCounter("nyx_kt_auditor_head_sends_total",
		"Pengiriman tree head auditor ke layanan log, per hasil",
		"result",
	)

	// Ukuran pohon log menurut pandangan auditor (jumlah update terverifikasi).
	metricTreeSize = defineGauge("nyx_kt_auditor_tree_size",
		"Ukuran pohon log KT menurut auditor (jumlah update yang sudah diverifikasi)",
	)

	// Unix timestamp putaran audit terakhir yang selesai (sukses maupun gagal).
	// Dipakai untuk membedakan \"proses hidup tapi macet\" dari \"proses mati\"
	// (`up` hanya menangkap yang kedua).
	metricLastRoundTimestamp = defineGauge("nyx_kt_auditor_last_round_timestamp_seconds",
		"Unix timestamp putaran audit terakhir yang selesai (hasil apa pun)",
	)

	// Unix timestamp putaran terakhir yang seluruh buktinya konsisten. Seri ini
	// yang basi saat auditor menemukan riwayat tidak konsisten.
	metricLastConsistentTimestamp = defineGauge("nyx_kt_auditor_last_consistent_timestamp_seconds",
		"Unix timestamp putaran audit terakhir yang seluruh buktinya konsisten",
	)

	// Unix timestamp tree head terakhir yang DITERIMA layanan log. Seri ini
	// hanya lahir setelah kiriman pertama berhasil, jadi operator harus memakai
	// `absent`/`absent_over_time` (lihat ops/prometheus/alerts.yml) — dan alert-nya
	// dijaga `nyx_kt_auditor_tree_size > 0` supaya deployment sepi (belum ada
	// entri untuk ditandatangani) tidak salah alarm.
	metricLastHeadTimestamp = defineGauge("nyx_kt_auditor_last_head_timestamp_seconds",
		"Unix timestamp tree head auditor terakhir yang diterima layanan log (tidak ada sebelum kiriman pertama)",
	)

	// Ukuran pohon pada tree head terakhir yang diterima layanan log. Selisihnya
	// dengan `nyx_kt_auditor_tree_size` adalah pekerjaan yang belum ditandatangani
	// (batas praktisnya `NYX_KT_AUDITOR_SIGNATURE_PAGE_SIZE`).
	metricHeadTreeSize = defineGauge("nyx_kt_auditor_head_tree_size",
		"Ukuran pohon pada tree head auditor terakhir yang diterima layanan log",
	)

	// Umur proses auditor. Bukan hiasan: `nyx_kt_auditor_last_head_timestamp_seconds`
	// hanya lahir SETELAH kiriman tree head pertama diterima, sedangkan head
	// pertama sengaja menunggu irama tanda tangan (`NYX_KT_AUDITOR_SIGNATURE_INTERVAL`,
	// default 1 jam). Tanpa umur proses, alert "head basi" tidak bisa membedakan
	// proses YANG BARU START (normal: belum ada yang ditandatangani) dari proses
	// LAMA yang tidak pernah berhasil menandatangani — dan setiap restart auditor
	// akan menghasilkan alarm palsu.
	metricUptimeSeconds = defineGauge("nyx_kt_auditor_uptime_seconds",
		"Umur proses auditor dalam detik (sejak proses start)",
	)

	// Penjaga privasi auditor — cermin `nyx_metrics_rejected_total` di
	// `server/src/utils/metrics.ts`. Harus SELALU 0.
	metricMetricsRejected = defineCounter("nyx_kt_auditor_metrics_rejected_total",
		"Percobaan mencatat metrik auditor dengan label tidak sah (indikasi kebocoran identitas ke metrik)",
		"reason",
	)
)

// auditorMetricDefs adalah urutan deklarasi (urutan render eksposisi).
var auditorMetricDefs = []metricDef{
	metricRoundsTotal,
	metricUpdatesVerifiedTotal,
	metricHeadSendsTotal,
	metricTreeSize,
	metricLastRoundTimestamp,
	metricLastConsistentTimestamp,
	metricLastHeadTimestamp,
	metricHeadTreeSize,
	metricUptimeSeconds,
	metricMetricsRejected,
}

// Hasil putaran/pengiriman head — nilai label enum (aman, tanpa identitas).
const (
	resultOK           = "ok"
	resultError        = "error"
	resultInconsistent = "inconsistent"
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

// Alasan penolakan — enum pendek (nilainya dipakai sebagai label).
const (
	reasonUnknownMetric = "unknown_metric"
	reasonUnknownLabel  = "unknown_label"
	reasonLabelValue    = "label_value"
	reasonWrongKind     = "wrong_kind"
	reasonWrongValue    = "wrong_value"
)

// maxMetricLabelValueLength = panjang maksimum nilai label — enum pendek,
// bukan identifier (port dari metrics.ts).
const maxMetricLabelValueLength = 24

var (
	metricNamePattern  = regexp.MustCompile(`^nyx_[a-z0-9_]+$`)
	metricLabelPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

	// Bentuk yang DILARANG muncul sebagai nilai label — port dari metrics.ts.
	forbiddenMetricLabelValues = []*regexp.Regexp{
		// UUID (userId, conversationId, deviceId).
		regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
		// Heksadesimal panjang: 32 byte (usernameHash/identityKey) ke atas.
		regexp.MustCompile(`(?i)^[0-9a-f]{32,}$`),
		// base64url panjang: hashId / token / key.
		regexp.MustCompile(`^[A-Za-z0-9_-]{22,}$`),
		// IPv4.
		regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`),
		// IPv6 (setidaknya dua blok titik-dua).
		regexp.MustCompile(`(?i)(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}`),
		// Email.
		regexp.MustCompile(`@`),
	}
)

// declaredAuditorMetrics terisi saat var init — deklarasi ganda = panic, karena
// itu kesalahan programmer yang lebih baik terlihat saat start daripada jadi
// deret waktu ganda yang membingungkan.
var declaredAuditorMetrics = map[string]metricDef{}

func defineMetric(kind metricKind, name, help string, labels []string) metricDef {
	if !metricNamePattern.MatchString(name) {
		panic("nama metrik tidak sah (harus nyx_<snake_case>): " + name)
	}
	if _, exists := declaredAuditorMetrics[name]; exists {
		panic("metrik sudah dideklarasikan: " + name)
	}
	for _, label := range labels {
		if !metricLabelPattern.MatchString(label) {
			panic("nama label tidak sah pada " + name + ": " + label)
		}
	}
	def := metricDef{name: name, kind: kind, help: help, labels: labels}
	declaredAuditorMetrics[name] = def
	return def
}

func defineCounter(name, help string, labels ...string) metricDef {
	return defineMetric(counterKind, name, help, labels)
}

func defineGauge(name, help string, labels ...string) metricDef {
	return defineMetric(gaugeKind, name, help, labels)
}

// isSafeLabelValue menolak nilai yang bisa memetakan metrik kembali ke
// user/perangkat: terlalu panjang, atau berbentuk UUID/heks/base64/IP/email.
func isSafeLabelValue(value string) bool {
	if value == "" || len(value) > maxMetricLabelValueLength {
		return false
	}
	for _, pattern := range forbiddenMetricLabelValues {
		if pattern.MatchString(value) {
			return false
		}
	}
	return true
}

// ============================================================================
// Registri deret waktu
// ============================================================================

type metricSeries struct {
	labels map[string]string
	value  float64
}

type auditorMetrics struct {
	mu     sync.Mutex
	series map[string]map[string]*metricSeries // nama metrik → kunci label → deret
	// startedAt + now: umur proses (`nyx_kt_auditor_uptime_seconds`) dirender dari
	// jam yang bisa diinjeksi, supaya test-nya deterministik.
	startedAt time.Time
	now       func() time.Time
}

func newAuditorMetrics() *auditorMetrics {
	return &auditorMetrics{series: map[string]map[string]*metricSeries{}, now: time.Now}
}

// markStarted mencatat waktu start proses. Dipanggil sekali oleh runner; sebelum
// itu deret umur proses tidak dirender (auditor yang belum punya jam start tidak
// boleh melaporkan umur yang salah).
func (m *auditorMetrics) markStarted(moment time.Time) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.startedAt = moment
}

// inc menambahkan satu ke counter (hanya untuk kind counter).
func (m *auditorMetrics) inc(def metricDef, labels map[string]string) {
	m.add(def, labels, 1)
}

// add menambahkan delta ke counter. Delta ≤ 0 atau NaN ditolak: counter yang bisa
// turun membuat `rate()`/`increase()` menghasilkan nilai negatif di alert.
func (m *auditorMetrics) add(def metricDef, labels map[string]string, delta float64) {
	if def.kind != counterKind {
		m.reject(reasonWrongKind)
		return
	}
	if math.IsNaN(delta) || math.IsInf(delta, 0) || delta <= 0 {
		m.reject(reasonWrongValue)
		return
	}
	series, ok := m.lookup(def, labels)
	if !ok {
		return
	}
	series.value += delta
}

// set menetapkan nilai gauge.
func (m *auditorMetrics) set(def metricDef, labels map[string]string, value float64) {
	if def.kind != gaugeKind {
		m.reject(reasonWrongKind)
		return
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		m.reject(reasonWrongValue)
		return
	}
	series, ok := m.lookup(def, labels)
	if !ok {
		return
	}
	series.value = value
}

// setTimestamp mencatat waktu sebagai Unix detik (dengan pecahan).
func (m *auditorMetrics) setTimestamp(def metricDef, labels map[string]string, moment time.Time) {
	m.set(def, labels, float64(moment.UnixMilli())/1000)
}

func (m *auditorMetrics) lookup(def metricDef, labels map[string]string) (*metricSeries, bool) {
	if m == nil {
		return nil, false
	}
	if _, declared := declaredAuditorMetrics[def.name]; !declared {
		m.reject(reasonUnknownMetric)
		return nil, false
	}
	if len(labels) != len(def.labels) {
		m.reject(reasonUnknownLabel)
		return nil, false
	}
	for name, value := range labels {
		if !containsString(def.labels, name) {
			m.reject(reasonUnknownLabel)
			return nil, false
		}
		if !isSafeLabelValue(value) {
			m.reject(reasonLabelValue)
			return nil, false
		}
	}

	key := seriesKey(labels)
	m.mu.Lock()
	defer m.mu.Unlock()
	byName, exists := m.series[def.name]
	if !exists {
		byName = map[string]*metricSeries{}
		m.series[def.name] = byName
	}
	series, exists := byName[key]
	if !exists {
		copied := make(map[string]string, len(labels))
		for name, value := range labels {
			copied[name] = value
		}
		series = &metricSeries{labels: copied}
		byName[key] = series
	}
	return series, true
}

// reject mencatat penolakan. Ia menulis LANGSUNG ke deret metrik penolakan
// (bukan lewat lookup) supaya tidak bisa memicu penolakan rekursif.
func (m *auditorMetrics) reject(reason string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	byName, exists := m.series[metricMetricsRejected.name]
	if !exists {
		byName = map[string]*metricSeries{}
		m.series[metricMetricsRejected.name] = byName
	}
	key := seriesKey(map[string]string{"reason": reason})
	series, exists := byName[key]
	if !exists {
		series = &metricSeries{labels: map[string]string{"reason": reason}}
		byName[key] = series
	}
	series.value++
}

// value membaca nilai satu deret (dipakai test).
func (m *auditorMetrics) value(def metricDef, labels map[string]string) (float64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	byName, exists := m.series[def.name]
	if !exists {
		return 0, false
	}
	series, exists := byName[seriesKey(labels)]
	if !exists {
		return 0, false
	}
	return series.value, true
}

// ============================================================================
// Hook auditor (dipakai runner.go)
// ============================================================================

// recordRound mencatat hasil satu putaran audit: counter per hasil, timestamp
// putaran terakhir, dan (bila bersih) timestamp putaran konsisten terakhir.
func (m *auditorMetrics) recordRound(moment time.Time, result string) {
	if m == nil {
		return
	}
	m.inc(metricRoundsTotal, map[string]string{"result": result})
	m.setTimestamp(metricLastRoundTimestamp, nil, moment)
	if result == resultOK {
		m.setTimestamp(metricLastConsistentTimestamp, nil, moment)
	}
}

// recordHeadSent mencatat hasil pengiriman tree head ke layanan log. Timestamp
// tree head terakhir hanya diisi saat kiriman DITERIMA — itulah angka yang
// dipakai alert \"head basi\".
func (m *auditorMetrics) recordHeadSent(moment time.Time, result string, treeSize uint64) {
	if m == nil {
		return
	}
	m.inc(metricHeadSendsTotal, map[string]string{"result": result})
	if result == resultOK {
		m.setTimestamp(metricLastHeadTimestamp, nil, moment)
		m.set(metricHeadTreeSize, nil, float64(treeSize))
	}
}

// ============================================================================
// Eksposisi teks Prometheus 0.0.4
// ============================================================================

func seriesKey(labels map[string]string) string {
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, name+"="+labels[name])
	}
	return strings.Join(parts, ",")
}

func escapeMetricLabelValue(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return replacer.Replace(value)
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func formatMetricSample(name string, labels map[string]string, value float64) string {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return name + " " + formatMetricNumber(value)
	}
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+`="`+escapeMetricLabelValue(labels[key])+`"`)
	}
	return name + "{" + strings.Join(parts, ",") + "} " + formatMetricNumber(value)
}

// formatMetricNumber memakai bentuk desimal terpendek ('f') supaya bilangan
// bulat tidak ditulis sebagai 3.0000000 DAN timestamp Unix tidak jatuh ke
// notasi ilmiah (1.7e+09) — bentuk yang sah menurut format Prometheus, tapi
// menyulitkan pembacaan manual dan menyamarkan kesalahan skala (detik vs mili).
func formatMetricNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// renderMetricsText menghasilkan eksposisi deterministik: metrik mengikuti
// urutan deklarasi, deret di dalamnya urut menurut kunci label.
func (m *auditorMetrics) renderMetricsText() string {
	m.syncUptime()
	var builder strings.Builder
	for _, def := range auditorMetricDefs {
		builder.WriteString("# HELP " + def.name + " " + strings.ReplaceAll(def.help, "\n", " ") + "\n")
		builder.WriteString("# TYPE " + def.name + " " + string(def.kind) + "\n")
		if m == nil {
			continue
		}
		m.mu.Lock()
		byName := m.series[def.name]
		keys := make([]string, 0, len(byName))
		for key := range byName {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			series := byName[key]
			builder.WriteString(formatMetricSample(def.name, series.labels, series.value) + "\n")
		}
		m.mu.Unlock()
	}
	return builder.String()
}

// syncUptime memperbarui deret umur proses tepat SEBELUM render. Umur sengaja
// tidak dihitung saat putaran audit: bila loop-nya macet, angka itu akan membeku
// — justru kasus yang harus terlihat dari luar (alert `…RoundStalled`).
func (m *auditorMetrics) syncUptime() {
	if m == nil {
		return
	}
	m.mu.Lock()
	startedAt := m.startedAt
	m.mu.Unlock()
	if startedAt.IsZero() {
		return
	}
	now := m.now
	if now == nil {
		now = time.Now
	}
	if elapsed := now().Sub(startedAt); elapsed > 0 {
		m.set(metricUptimeSeconds, nil, elapsed.Seconds())
	}
}

// ============================================================================
// Listener loopback
// ============================================================================

// errMetricsAddrNotLoopback menandai alamat metrik yang bukan loopback.
var errMetricsAddrNotLoopback = errors.New("alamat metrik harus loopback (127.0.0.1 / ::1)")

// startAuditorMetrics menjalankan exporter di alamat loopback. Nilai kosong atau
// "0" mematikan exporter (auditor tetap berjalan — hanya visibilitas yang
// hilang, dan itu pilihan sadar operator).
//
// Host non-loopback DITOLAK, bukan diperingatkan: metrik internal memetakan
// infrastruktur (ukuran log, irama tanda tangan), dan satu alamat salah tulis
// cukup untuk membocorkannya ke jaringan (docs/30 WS-G — pola yang sama dengan
// `server/src/utils/metricsEndpoint.ts`).
// Alamat hasil (net.Addr) dikembalikan supaya pemanggil — termasuk test — tahu
// port sebenarnya (alamat `:0` memilih port bebas). Nilai nil = exporter mati.
func startAuditorMetrics(ctx context.Context, addr string, metrics *auditorMetrics, logf func(string, ...any)) (net.Addr, error) {
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
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body := metrics.renderMetricsText()
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = writer.Write([]byte(body))
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("metrik: exporter berhenti: %v", err)
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logf("metrik: http://%s/metrics (loopback)", listener.Addr().String())
	return listener.Addr(), nil
}

func isLoopbackHost(host string) bool {
	switch host {
	case "localhost":
		return true
	case "":
		return false
	}
	if parsed := net.ParseIP(host); parsed != nil {
		return parsed.IsLoopback()
	}
	return false
}
