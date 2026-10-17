// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Yang dijaga test ini: setiap metrik yang dirujuk aturan Prometheus benar-benar
// terekspos (nama salah tulis = aturan diam), nilai label di luar enum DITOLAK,
// exporter tidak pernah bisa mendengarkan di alamat non-loopback, dan operasi
// baca tercatat lewat pembungkus rute (termasuk `not_found`, yang harus
// dibedakan dari kegagalan layanan).

func TestQueryMetricsRenderMencakupSemuaDeklarasi(t *testing.T) {
	text := queryMetrics.render()

	for _, def := range queryMetricDefs {
		if !strings.Contains(text, "# TYPE "+def.name+" "+string(def.kind)) {
			t.Errorf("metrik %s tidak terekspos sebagai %s", def.name, def.kind)
		}
		if !strings.Contains(text, "# HELP "+def.name+" ") {
			t.Errorf("metrik %s tidak punya HELP", def.name)
		}
		if !strings.HasPrefix(def.name, "nyx_") {
			t.Errorf("nama metrik harus berawalan nyx_: %s", def.name)
		}
	}
	if !strings.Contains(text, metricUptimeSeconds.name+" ") {
		t.Error("umur proses tidak terekspos")
	}
}

func TestQueryMetricsLabelDiLuarEnumDitolak(t *testing.T) {
	state := newQueryMetrics()

	// Nilai yang bisa memetakan metrik kembali ke user/perangkat: TIDAK boleh
	// muncul sebagai deret waktu, dalam bentuk apa pun.
	forbidden := []string{
		"3f2504e0-4f89-11d3-9a0c-0305e82c3301",
		strings.Repeat("a", 64),
		"han@nyx-app.my.id",
		"203.0.113.7",
		"operasi-tidak-dikenal",
	}
	for _, value := range forbidden {
		state.read(value, readResultOK)
		state.write(value)
	}

	text := state.render()
	for _, value := range forbidden {
		if strings.Contains(text, value) {
			t.Fatalf("nilai terlarang bocor ke /metrics: %s", value)
		}
	}
	// Penolakan justru TERLIHAT (bukan hilang) di metrik penjaganya.
	if !strings.Contains(text, metricMetricsRejected.name+`{reason="unknown_label_value"} 10`) {
		t.Fatalf("penolakan label tidak tercatat:\n%s", text)
	}
}

func TestQueryMetricsNilaiPeristiwaSesuaiHarapan(t *testing.T) {
	state := newQueryMetrics()
	state.write(writeResultOK)
	state.write(writeResultDuplicate)
	state.write(writeResultError)
	state.read(readOpSearch, readResultOK)
	state.read(readOpSearch, readErrorNotFound)
	state.snapshotFailed()
	state.snapshotStored(time.Unix(1700000000, 0))
	state.setTreeSize(517)
	state.setDistinguishedTimestamp(time.Unix(1700000123, 0))

	text := state.render()
	for _, expected := range []string{
		metricWritesTotal.name + `{result="ok"} 1`,
		metricWritesTotal.name + `{result="duplicate"} 1`,
		metricWritesTotal.name + `{result="error"} 1`,
		metricWritesTotal.name + `{result="invalid"} 0`,
		metricReadsTotal.name + `{op="search",result="ok"} 1`,
		metricReadsTotal.name + `{op="search",result="not_found"} 1`,
		metricSnapshotTotal.name + `{result="ok"} 1`,
		metricSnapshotTotal.name + `{result="error"} 1`,
		metricSnapshotLastTimestamp.name + " 1700000000",
		metricTreeSize.name + " 517",
		metricDistinguishedTimestamp.name + " 1700000123",
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("hilang: %s\n%s", expected, text)
		}
	}
}

func TestQueryMetricsAlamatNonLoopbackDitolak(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "127.8.8.8", "::1", "localhost"} {
		if !isLoopbackHost(host) {
			t.Errorf("%s seharusnya dianggap loopback", host)
		}
	}
	// Kesalahan yang paling mudah terjadi — dan yang paling mahal.
	for _, host := range []string{"0.0.0.0", "192.168.1.10", "10.0.0.1", "nyx-app.my.id"} {
		if isLoopbackHost(host) {
			t.Errorf("%s TIDAK boleh dianggap loopback", host)
		}
	}

	silent := func(string, ...any) {}
	if _, err := startQueryMetrics(t.Context(), "0.0.0.0:9467", newQueryMetrics(), silent); err == nil {
		t.Error("exporter menerima alamat non-loopback")
	}
	if _, err := startQueryMetrics(t.Context(), "bukan-alamat", newQueryMetrics(), silent); err == nil {
		t.Error("exporter menerima alamat tanpa port")
	}
	// "0" = dimatikan dengan sengaja (bukan error).
	if addr, err := startQueryMetrics(t.Context(), "0", newQueryMetrics(), silent); err != nil || addr != nil {
		t.Errorf("alamat \"0\" harus mematikan exporter tanpa error: addr=%v err=%v", addr, err)
	}
}

func TestQueryMetricsEndpointLoopback(t *testing.T) {
	state := newQueryMetrics()
	state.write(writeResultOK)

	addr, err := startQueryMetrics(t.Context(), "127.0.0.1:0", state, func(string, ...any) {})
	if err != nil {
		t.Fatalf("startQueryMetrics: %v", err)
	}
	if addr == nil {
		t.Fatal("exporter tidak mengembalikan alamat")
	}
	base := "http://" + addr.(*net.TCPAddr).String()

	response, err := http.Get(base + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics = %d, ingin 200", response.StatusCode)
	}
	if !strings.Contains(string(body), metricWritesTotal.name+`{result="ok"} 1`) {
		t.Fatalf("nilai metrik tidak ikut terekspos:\n%s", body)
	}

	// Metode selain GET tidak dilayani (endpoint ini hanya untuk Prometheus).
	posted, err := http.Post(base+"/metrics", "text/plain", strings.NewReader(""))
	if err != nil {
		t.Fatalf("POST /metrics: %v", err)
	}
	posted.Body.Close()
	if posted.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /metrics = %d, ingin 405", posted.StatusCode)
	}
}

// TestQueryServerMencatatBaca membuktikan pembungkus `observeRead` menyimpulkan
// hasil dari kode status respons: `ok` untuk bukti yang tersedia, dan
// `not_found` untuk search key yang belum ada di log.
func TestQueryServerMencatatBaca(t *testing.T) {
	state := newQueryMetrics()
	previous := queryMetrics
	queryMetrics = state
	defer func() { queryMetrics = previous }()

	server, _, hash := newTestServer(t)
	defer server.Close()

	get := func(path string) int {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response.StatusCode
	}

	if status := get("/search?hash=" + base64.RawURLEncoding.EncodeToString(hash)); status != http.StatusOK {
		t.Fatalf("search hash terdaftar = %d, ingin 200", status)
	}
	if status := get("/search?hash=" + base64.RawURLEncoding.EncodeToString(usernameHash(0x99))); status != http.StatusNotFound {
		t.Fatalf("search hash tak terdaftar = %d, ingin 404", status)
	}

	text := state.render()
	for _, expected := range []string{
		metricReadsTotal.name + `{op="search",result="ok"} 1`,
		metricReadsTotal.name + `{op="search",result="not_found"} 1`,
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("hilang: %s\n%s", expected, text)
		}
	}
	// Operasi lain ada di keluaran (semua kombinasi label lahir dengan 0 supaya
	// dashboard tidak menampilkan "No data") — tetapi TIDAK boleh ikut terhitung.
	if !strings.Contains(text, metricReadsTotal.name+`{op="monitor",result="ok"} 0`) {
		t.Errorf("operasi yang tidak dipanggil seharusnya tetap 0:\n%s", text)
	}
}
