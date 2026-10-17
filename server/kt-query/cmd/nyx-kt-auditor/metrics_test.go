// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Test exporter metrik auditor (docs/30 WS-G). Yang diuji di sini bukan "apakah
// angka naik", melainkan tiga hal yang membuat metrik layak dipercaya:
//
//  1. deklarasinya konsisten (nama sah, label sah, terdaftar) — deret waktu
//     tidak boleh lahir dari nilai runtime;
//  2. penjaga privasi benar-benar MENOLAK nilai label berbentuk identitas, dan
//     penolakannya terlihat di `nyx_kt_auditor_metrics_rejected_total`;
//  3. eksposisi mengikuti format teks Prometheus 0.0.4 (HELP/TYPE + escaping).

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDeklarasiMetrikAuditorKonsisten(t *testing.T) {
	if len(auditorMetricDefs) != len(declaredAuditorMetrics) {
		t.Fatalf("%d metrik di daftar render, %d terdaftar", len(auditorMetricDefs), len(declaredAuditorMetrics))
	}

	seen := map[string]bool{}
	for _, def := range auditorMetricDefs {
		if !metricNamePattern.MatchString(def.name) {
			t.Errorf("nama metrik tidak sah: %s", def.name)
		}
		if seen[def.name] {
			t.Errorf("metrik dideklarasikan dua kali: %s", def.name)
		}
		seen[def.name] = true
		if def.help == "" {
			t.Errorf("metrik %s tanpa help", def.name)
		}
		if def.kind != counterKind && def.kind != gaugeKind {
			t.Errorf("metrik %s punya kind tidak dikenal: %q", def.name, def.kind)
		}
		if _, ok := declaredAuditorMetrics[def.name]; !ok {
			t.Errorf("metrik %s tidak ada di registri deklarasi", def.name)
		}
		for _, label := range def.labels {
			if !metricLabelPattern.MatchString(label) {
				t.Errorf("metrik %s punya label tidak sah: %q", def.name, label)
			}
		}
	}

	// Nama yang dipakai hook runner WAJIB ada di daftar deklarasi — salah tulis
	// nama berarti deret waktunya tidak pernah lahir (aturan alert jadi diam).
	for _, def := range []metricDef{
		metricRoundsTotal, metricUpdatesVerifiedTotal, metricHeadSendsTotal,
		metricTreeSize, metricLastRoundTimestamp, metricLastConsistentTimestamp,
		metricLastHeadTimestamp, metricHeadTreeSize, metricUptimeSeconds,
		metricMetricsRejected,
	} {
		if _, ok := declaredAuditorMetrics[def.name]; !ok {
			t.Errorf("metrik %s dipakai runner tetapi tidak dideklarasikan", def.name)
		}
	}
}

func TestAuditorMetricsMenolakLabelTidakSah(t *testing.T) {
	cases := []struct {
		nama   string
		def    metricDef
		labels map[string]string
		kind   string
		reason string
	}{
		{
			nama:   "metrik tidak dikenal",
			def:    metricDef{name: "nyx_kt_auditor_tidak_ada", kind: counterKind},
			labels: nil,
			kind:   "counter",
			reason: reasonUnknownMetric,
		},
		{
			nama:   "label tidak dideklarasikan",
			def:    metricRoundsTotal,
			labels: map[string]string{"result": resultOK, "userId": "abc"},
			kind:   "counter",
			reason: reasonUnknownLabel,
		},
		{
			nama:   "label kurang",
			def:    metricRoundsTotal,
			labels: nil,
			kind:   "counter",
			reason: reasonUnknownLabel,
		},
		{
			nama:   "nilai UUID",
			def:    metricRoundsTotal,
			labels: map[string]string{"result": "3f1b0d1e-6a3a-4a2b-9c8f-1d2e3f4a5b6c"},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai heksadesimal panjang",
			def:    metricRoundsTotal,
			labels: map[string]string{"result": strings.Repeat("ab", 32)},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai base64url panjang",
			def:    metricRoundsTotal,
			labels: map[string]string{"result": "QWxhZGRpbjpvcGVuIHNlc2FtZQ"},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai IPv4",
			def:    metricHeadSendsTotal,
			labels: map[string]string{"result": "203.0.113.7"},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai email",
			def:    metricHeadSendsTotal,
			labels: map[string]string{"result": "user@example.com"},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai kosong",
			def:    metricHeadSendsTotal,
			labels: map[string]string{"result": ""},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "nilai terlalu panjang (25 karakter)",
			def:    metricHeadSendsTotal,
			labels: map[string]string{"result": strings.Repeat("a", 25)},
			kind:   "counter",
			reason: reasonLabelValue,
		},
		{
			nama:   "gauge diisi lewat counter",
			def:    metricTreeSize,
			labels: nil,
			kind:   "counter",
			reason: reasonWrongKind,
		},
		{
			nama:   "counter diisi lewat gauge",
			def:    metricRoundsTotal,
			labels: map[string]string{"result": resultOK},
			kind:   "gauge",
			reason: reasonWrongKind,
		},
	}

	for _, kasus := range cases {
		t.Run(kasus.nama, func(t *testing.T) {
			metrics := newAuditorMetrics()
			switch kasus.kind {
			case "counter":
				metrics.add(kasus.def, kasus.labels, 1)
			case "gauge":
				metrics.set(kasus.def, kasus.labels, 1)
			}

			if _, ok := metrics.value(kasus.def, kasus.labels); ok {
				t.Fatalf("deret %s%v dibuat padahal label ditolak", kasus.def.name, kasus.labels)
			}
			got, ok := metrics.value(metricMetricsRejected, map[string]string{"reason": kasus.reason})
			if !ok || got != 1 {
				t.Fatalf("nyx_kt_auditor_metrics_rejected_total{reason=%q} = %v (ada=%v), ingin 1",
					kasus.reason, got, ok)
			}
		})
	}

	t.Run("nilai NaN dan delta nol ditolak", func(t *testing.T) {
		metrics := newAuditorMetrics()
		metrics.set(metricTreeSize, nil, math.NaN())
		metrics.add(metricRoundsTotal, map[string]string{"result": resultOK}, 0)
		if _, ok := metrics.value(metricTreeSize, nil); ok {
			t.Error("gauge NaN diterima")
		}
		if _, ok := metrics.value(metricRoundsTotal, map[string]string{"result": resultOK}); ok {
			t.Error("counter dengan delta 0 diterima")
		}
		if got, _ := metrics.value(metricMetricsRejected, map[string]string{"reason": reasonWrongValue}); got != 2 {
			t.Errorf("penolakan kind/nilai = %v, ingin 2", got)
		}
	})

	t.Run("nilai enum yang sah diterima", func(t *testing.T) {
		metrics := newAuditorMetrics()
		metrics.recordRound(time.Unix(1_700_000_000, 0), resultInconsistent)
		if got, ok := metrics.value(metricRoundsTotal, map[string]string{"result": resultInconsistent}); !ok || got != 1 {
			t.Fatalf("deret result=inconsistent tidak tercatat: %v (ada=%v)", got, ok)
		}
		if _, ok := metrics.value(metricMetricsRejected, map[string]string{"reason": reasonLabelValue}); ok {
			t.Error("nilai enum sah malah ditolak")
		}
	})
}

func TestAuditorMetricsRenderFormatPrometheus(t *testing.T) {
	metrics := newAuditorMetrics()
	metrics.inc(metricUpdatesVerifiedTotal, nil)
	metrics.inc(metricUpdatesVerifiedTotal, nil)
	metrics.set(metricTreeSize, nil, 10)
	metrics.recordRound(time.Unix(1_700_000_000, 500_000_000), resultOK)
	metrics.recordRound(time.Unix(1_700_000_060, 0), resultError)
	metrics.recordHeadSent(time.Unix(1_700_000_060, 0), resultOK, 9)
	// Nilai label dengan kutip/backslash: menguji escaping eksposisi.
	metrics.inc(metricRoundsTotal, map[string]string{"result": `a"b\c`})

	body := metrics.renderMetricsText()

	// Setiap metrik terdeklarasi HARUS muncul sebagai HELP/TYPE, bahkan tanpa
	// sampel: keluarga metrik yang hilang membuat panel Grafana kosong tanpa
	// penjelasan.
	for _, def := range auditorMetricDefs {
		if !strings.Contains(body, "# HELP "+def.name+" ") {
			t.Errorf("render tanpa # HELP %s", def.name)
		}
		if !strings.Contains(body, "# TYPE "+def.name+" "+string(def.kind)+"\n") {
			t.Errorf("render tanpa # TYPE %s", def.name)
		}
	}

	wajibAda := []string{
		"nyx_kt_auditor_updates_verified_total 2\n",
		"nyx_kt_auditor_tree_size 10\n",
		`nyx_kt_auditor_rounds_total{result="a\"b\\c"} 1`,
		`nyx_kt_auditor_rounds_total{result="ok"} 1`,
		`nyx_kt_auditor_rounds_total{result="error"} 1`,
		`nyx_kt_auditor_head_sends_total{result="ok"} 1`,
		"nyx_kt_auditor_last_head_timestamp_seconds 1700000060\n",
		"nyx_kt_auditor_head_tree_size 9\n",
	}
	for _, line := range wajibAda {
		if !strings.Contains(body, line) {
			t.Errorf("render tidak memuat %q\n---\n%s", line, body)
		}
	}

	// Gauge timestamp ditulis dengan pecahan detik (UnixMilli/1000).
	if !strings.Contains(body, "nyx_kt_auditor_last_round_timestamp_seconds 1700000060\n") {
		t.Errorf("timestamp putaran terakhir tidak sesuai:\n%s", body)
	}

	// Render harus deterministik: urutan deklarasi + kunci label terurut.
	if body != metrics.renderMetricsText() {
		t.Error("dua render berurutan berbeda (urutan tidak deterministik)")
	}
	if !strings.HasSuffix(body, "\n") {
		t.Error("eksposisi harus diakhiri newline")
	}
}

func TestStartAuditorMetricsMenolakAlamatBukanLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:9466", "10.0.0.5:9466", "[::]:9466", "172.17.0.1:9466"} {
		if _, err := startAuditorMetrics(context.Background(), addr, newAuditorMetrics(), func(string, ...any) {}); !errors.Is(err, errMetricsAddrNotLoopback) {
			t.Errorf("alamat %q: error = %v, ingin errMetricsAddrNotLoopback", addr, err)
		}
	}

	for _, addr := range []string{"9466", "127.0.0.1"} {
		if _, err := startAuditorMetrics(context.Background(), addr, newAuditorMetrics(), func(string, ...any) {}); err == nil {
			t.Errorf("alamat %q diterima padahal tidak sah", addr)
		}
	}

	t.Run("dimatikan dengan 0", func(t *testing.T) {
		addr, err := startAuditorMetrics(context.Background(), "0", newAuditorMetrics(), func(string, ...any) {})
		if err != nil {
			t.Fatalf("matikan exporter: %v", err)
		}
		if addr != nil {
			t.Fatalf("exporter mati tapi mengembalikan alamat %v", addr)
		}
	})
}

func TestStartAuditorMetricsMenyajikanEksposisi(t *testing.T) {
	metrics := newAuditorMetrics()
	metrics.recordRound(time.Now(), resultOK)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var (
		logsMu sync.Mutex
		logs   []string
	)
	addr, err := startAuditorMetrics(ctx, "127.0.0.1:0", metrics, func(format string, args ...any) {
		logsMu.Lock()
		defer logsMu.Unlock()
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("start exporter: %v", err)
	}
	if addr == nil {
		t.Fatal("exporter tidak mengembalikan alamat")
	}
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		t.Fatalf("alamat exporter tidak sah: %v", err)
	}
	if !isLoopbackHost(host) {
		t.Fatalf("exporter listen di %s, bukan loopback", host)
	}
	base := "http://" + net.JoinHostPort(host, port)
	logsMu.Lock()
	reported := append([]string(nil), logs...)
	logsMu.Unlock()
	if len(reported) == 0 || !strings.Contains(reported[0], "/metrics (loopback)") {
		t.Errorf("exporter tidak melaporkan alamat loopback: %v", reported)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(base + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics = %d, ingin 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/plain; version=0.0.4") {
		t.Errorf("Content-Type = %q", got)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, ingin no-store", got)
	}
	if !strings.Contains(string(body), `nyx_kt_auditor_rounds_total{result="ok"} 1`) {
		t.Errorf("eksposisi tidak memuat deret putaran:\n%s", body)
	}

	t.Run("path lain 404 dan metode lain 405", func(t *testing.T) {
		notFound, err := client.Get(base + "/")
		if err != nil {
			t.Fatalf("GET /: %v", err)
		}
		notFound.Body.Close()
		if notFound.StatusCode != http.StatusNotFound {
			t.Errorf("GET / = %d, ingin 404", notFound.StatusCode)
		}

		posted, err := client.Post(base+"/metrics", "text/plain", strings.NewReader(""))
		if err != nil {
			t.Fatalf("POST /metrics: %v", err)
		}
		posted.Body.Close()
		if posted.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("POST /metrics = %d, ingin 405", posted.StatusCode)
		}
	})

	t.Run("exporter berhenti saat konteks dibatalkan", func(t *testing.T) {
		cancel()
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := client.Get(base + "/metrics"); err != nil {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("exporter masih menerima permintaan setelah konteks dibatalkan")
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
}

func TestRunnerMencatatMetrikAudit(t *testing.T) {
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

	metrics := fixture.runner.metrics
	if got, _ := metrics.value(metricUpdatesVerifiedTotal, nil); got != 10 {
		t.Errorf("updates_verified_total = %v, ingin 10", got)
	}
	if got, _ := metrics.value(metricTreeSize, nil); got != 10 {
		t.Errorf("tree_size = %v, ingin 10", got)
	}
	if got, _ := metrics.value(metricHeadSendsTotal, map[string]string{"result": resultOK}); got != 3 {
		t.Errorf("head_sends_total{result=ok} = %v, ingin 3", got)
	}
	// Timestamp head hanya diisi kiriman yang DITERIMA; tree size head terakhir = 9.
	if got, ok := metrics.value(metricLastHeadTimestamp, nil); !ok || got != 0 {
		t.Errorf("last_head_timestamp = %v (ada=%v), ingin 0 (clock test Unix(0,0))", got, ok)
	}
	if got, _ := metrics.value(metricHeadTreeSize, nil); got != 9 {
		t.Errorf("head_tree_size = %v, ingin 9", got)
	}
}

func TestRunnerMencatatHeadDitolakDanPutaran(t *testing.T) {
	updates := successVectorUpdates(t)

	t.Run("SetAuditorHead ditolak", func(t *testing.T) {
		fixture := newRunnerFixture(t, updates, 1, time.Hour)
		fixture.client.headErr = errors.New("auditor tidak terkonfigurasi")
		if err := fixture.runner.loadState(); err != nil {
			t.Fatalf("loadState: %v", err)
		}

		jalankanSampaiPutaranTercatat(t, fixture.runner)

		metrics := fixture.runner.metrics
		if got, _ := metrics.value(metricHeadSendsTotal, map[string]string{"result": resultError}); got < 1 {
			t.Errorf("head_sends_total{result=error} = %v, ingin >= 1", got)
		}
		if _, ok := metrics.value(metricLastHeadTimestamp, nil); ok {
			t.Error("last_head_timestamp terisi padahal semua tree head ditolak")
		}
		if got, _ := metrics.value(metricRoundsTotal, map[string]string{"result": resultError}); got < 1 {
			t.Errorf("rounds_total{result=error} = %v, ingin >= 1", got)
		}
		if _, ok := metrics.value(metricLastConsistentTimestamp, nil); ok {
			t.Error("putaran konsisten terakhir terisi padahal putarannya gagal")
		}
	})

	t.Run("putaran konsisten", func(t *testing.T) {
		fixture := newRunnerFixture(t, updates, 1000, 0)
		if err := fixture.runner.loadState(); err != nil {
			t.Fatalf("loadState: %v", err)
		}

		jalankanSampaiPutaranTercatat(t, fixture.runner)

		metrics := fixture.runner.metrics
		if got, _ := metrics.value(metricRoundsTotal, map[string]string{"result": resultOK}); got < 1 {
			t.Errorf("rounds_total{result=ok} = %v, ingin >= 1", got)
		}
		if _, ok := metrics.value(metricLastConsistentTimestamp, nil); !ok {
			t.Error("last_consistent_timestamp tidak terisi pada putaran bersih")
		}
		if _, ok := metrics.value(metricRoundsTotal, map[string]string{"result": resultInconsistent}); ok {
			t.Error("rounds_total{result=inconsistent} terisi pada riwayat yang sah")
		}
	})
}

// jalankanSampaiPutaranTercatat menjalankan `run` (loop produksi) sampai satu
// putaran tercatat di metrik, lalu menghentikannya lewat pembatalan konteks —
// supaya jalur kode yang benar-benar dipakai daemon yang diuji, bukan hanya
// `runOnce`.
func jalankanSampaiPutaranTercatat(t *testing.T, runner *auditorRunner) {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := runner.run(ctx); err != nil {
			t.Errorf("run: %v", err)
		}
	}()

	deadline := time.Now().Add(5 * time.Second)
	for totalRoundCount(runner.metrics) == 0 {
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("tidak ada putaran audit yang tercatat di metrik")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
}

// Umur proses adalah penjaga alarm palsu "head basi" (ops/prometheus/alerts.yml):
// head pertama memang menunggu irama tanda tangan, jadi `absent(last_head)`
// HARUS bisa dibedakan dari "proses lama yang tidak pernah menandatangani".
func TestUptimeProsesDirenderDariJamStart(t *testing.T) {
	metrics := newAuditorMetrics()

	// Sebelum jam start dicatat, deret umur TIDAK boleh lahir: umur yang tidak
	// diketahui bukan 0 detik. Nilai 0 justru berarti "proses baru saja start".
	if _, ok := metrics.value(metricUptimeSeconds, nil); ok {
		t.Fatal("uptime terisi sebelum markStarted")
	}

	started := time.Unix(1_000_000, 0)
	metrics.markStarted(started)
	metrics.now = func() time.Time { return started.Add(90 * time.Minute) }

	body := metrics.renderMetricsText()
	if !strings.Contains(body, "nyx_kt_auditor_uptime_seconds 5400\n") {
		t.Fatalf("eksposisi tidak memuat umur proses 5400 detik:\n%s", body)
	}
	if got, _ := metrics.value(metricUptimeSeconds, nil); got != 5400 {
		t.Errorf("uptime = %v, ingin 5400", got)
	}
}

// Runner WAJIB mencatat jam start, kalau tidak deret `uptime` tidak pernah ada
// dan penjaga di alert "head basi" tidak pernah berlaku (aturan diam).
func TestRunnerMencatatJamStartProses(t *testing.T) {
	fixture := newRunnerFixture(t, successVectorUpdates(t), 1, time.Hour)

	// Fixture memakai clock Unix(0,0); dari titik itulah umur dihitung.
	fixture.runner.metrics.now = func() time.Time { return time.Unix(120, 0) }
	body := fixture.runner.metrics.renderMetricsText()
	if !strings.Contains(body, "nyx_kt_auditor_uptime_seconds 120\n") {
		t.Fatalf("eksposisi tidak memuat umur proses dari jam start runner:\n%s", body)
	}
}

func totalRoundCount(metrics *auditorMetrics) float64 {
	total := 0.0
	for _, result := range []string{resultOK, resultError, resultInconsistent} {
		if value, ok := metrics.value(metricRoundsTotal, map[string]string{"result": result}); ok {
			total += value
		}
	}
	return total
}
