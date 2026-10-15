// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/signalapp/keytransparency/tree/transparency"
)

// newSnapshotFixture menyiapkan basis data LevelDB nyata (bukan in-memory:
// justru perilaku "salin direktori sambil hidup" yang diuji di sini) + layanan
// tulis dan snapshotter di atasnya.
func newSnapshotFixture(t *testing.T, keep int) (*snapshotter, *updateService, string, *transparency.PrivateConfig) {
	t.Helper()
	config := testPrivateConfig(t)
	dbDir := filepath.Join(t.TempDir(), "ktdb")
	store, err := openStore(dbDir)
	if err != nil {
		t.Fatalf("buka store: %v", err)
	}
	mu := &sync.Mutex{}
	updates := &updateService{cfg: config, store: store, mu: mu}
	snapshotDir := filepath.Join(t.TempDir(), "snapshots")
	return newSnapshotter(config, store, dbDir, mu, snapshotDir, keep), updates, snapshotDir, config
}

func readManifestFile(t *testing.T, dir string) snapshotManifest {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		t.Fatalf("baca manifest: %v", err)
	}
	var manifest snapshotManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatalf("urai manifest: %v", err)
	}
	return manifest
}

func countArchives(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		// Direktori belum dibuat = belum ada snapshot sama sekali.
		return nil
	}
	if err != nil {
		t.Fatalf("baca direktori snapshot: %v", err)
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), snapshotPrefix) && strings.HasSuffix(entry.Name(), snapshotSuffix) {
			out = append(out, entry.Name())
		}
	}
	return out
}

// Inti fitur: arsip yang dihasilkan harus benar-benar berisi basis data yang
// **sama** dengan yang hidup (ukuran + root), bukan salinan yang kebetulan bisa
// dibuka.
func TestSnapshotMenghasilkanArsipYangTreeHeadnyaSama(t *testing.T) {
	snapshotter, updates, dir, _ := newSnapshotFixture(t, defaultSnapshotKeep)
	writeNyxEntry(t, updates, usernameHash(0x51), 1)
	writeNyxEntry(t, updates, usernameHash(0x52), 2)

	manifest, err := snapshotter.runOnce(context.Background())
	if err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	if manifest.TreeSize != 2 {
		t.Fatalf("treeSize manifest = %d, ingin 2", manifest.TreeSize)
	}
	if len(manifest.Root) != 64 {
		t.Fatalf("root manifest = %q, ingin hex 64 karakter", manifest.Root)
	}
	if manifest.Bytes <= 0 {
		t.Fatalf("ukuran arsip = %d, ingin > 0", manifest.Bytes)
	}

	// Manifest yang tertulis harus identik dengan nilai kembalian (pengunggah
	// memakai berkas, bukan memori).
	if got := readManifestFile(t, dir); got != manifest {
		t.Fatalf("manifest berkas %+v != %+v", got, manifest)
	}

	// Direktori kerja tidak boleh tertinggal.
	if _, err := os.Stat(filepath.Join(dir, "in-progress")); !os.IsNotExist(err) {
		t.Fatalf("direktori kerja masih ada (err=%v)", err)
	}

	// Ekstrak arsip dan buka sebagai basis data: head harus sama dengan manifest.
	extracted := filepath.Join(t.TempDir(), "extracted")
	extractArchive(t, filepath.Join(dir, manifest.File), extracted)
	store, err := openStore(extracted)
	if err != nil {
		t.Fatalf("buka arsip hasil snapshot: %v", err)
	}
	tree, err := transparency.NewTree(snapshotter.cfg, store)
	if err != nil {
		t.Fatalf("bangun pohon dari arsip: %v", err)
	}
	head := tree.GetTransparencyTreeHead()
	if head.TreeSize != manifest.TreeSize {
		t.Fatalf("treeSize arsip = %d, ingin %d", head.TreeSize, manifest.TreeSize)
	}
	root, err := tree.GetLogTree().GetRoot(head.TreeSize)
	if err != nil {
		t.Fatalf("root arsip: %v", err)
	}
	if got := hexString(root); got != manifest.Root {
		t.Fatalf("root arsip = %s, ingin %s", got, manifest.Root)
	}
}

// Salinan yang tidak konsisten HARUS ditolak: lebih baik tidak ada snapshot
// daripada snapshot yang terlihat sah tetapi berisi pohon lain.
func TestSnapshotMenolakSalinanTidakKonsisten(t *testing.T) {
	snapshotter, updates, dir, _ := newSnapshotFixture(t, defaultSnapshotKeep)
	writeNyxEntry(t, updates, usernameHash(0x61), 1)

	// Tiruan salinan yang "berhasil" secara I/O tetapi bukan basis data kita.
	snapshotter.copyTree = func(_, dst string) error {
		if err := os.MkdirAll(dst, 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, "CURRENT"), []byte("MANIFEST-000001\n"), 0o600)
	}

	_, err := snapshotter.runOnce(context.Background())
	if err == nil {
		t.Fatal("runOnce lolos padahal salinan tidak bisa dibuka")
	}
	if archives := countArchives(t, dir); len(archives) != 0 {
		t.Fatalf("arsip terbentuk %v padahal verifikasi gagal", archives)
	}
	if _, err := os.Stat(filepath.Join(dir, manifestName)); !os.IsNotExist(err) {
		t.Fatalf("manifest ditulis padahal verifikasi gagal (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "in-progress")); !os.IsNotExist(err) {
		t.Fatalf("direktori kerja tertinggal (err=%v)", err)
	}
}

func TestSnapshotMenghapusArsipLamaDanMenyimpanYangTerbaru(t *testing.T) {
	snapshotter, updates, dir, _ := newSnapshotFixture(t, 2)

	base := time.Date(2026, 10, 14, 3, 0, 0, 0, time.UTC)
	for index := 0; index < 3; index++ {
		writeNyxEntry(t, updates, usernameHash(byte(0x70+index)), byte(index+1))
		stamp := base.Add(time.Duration(index) * 24 * time.Hour)
		snapshotter.nowFn = func() time.Time { return stamp }
		if _, err := snapshotter.runOnce(context.Background()); err != nil {
			t.Fatalf("snapshot ke-%d: %v", index, err)
		}
	}

	archives := countArchives(t, dir)
	if len(archives) != 2 {
		t.Fatalf("arsip tersimpan = %v, ingin 2", archives)
	}
	// Arsip tertua (hari pertama) sudah dibuang; manifest menunjuk yang terbaru.
	manifest := readManifestFile(t, dir)
	if manifest.TreeSize != 3 {
		t.Fatalf("treeSize manifest = %d, ingin 3", manifest.TreeSize)
	}
	for _, name := range archives {
		if strings.Contains(name, "20261014") {
			t.Fatalf("arsip tertua %s seharusnya sudah dihapus", name)
		}
	}
}

func TestSnapshotIntervalNolTidakMenjalankanApaPun(t *testing.T) {
	snapshotter, _, dir, _ := newSnapshotFixture(t, defaultSnapshotKeep)
	snapshotter.run(context.Background(), 0)
	if archives := countArchives(t, dir); len(archives) != 0 {
		t.Fatalf("arsip terbentuk tanpa interval: %v", archives)
	}
}

func TestSnapshotBerhentiSaatKonteksDibatalkan(t *testing.T) {
	snapshotter, updates, dir, _ := newSnapshotFixture(t, defaultSnapshotKeep)
	writeNyxEntry(t, updates, usernameHash(0x81), 1)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		snapshotter.run(ctx, time.Hour)
	}()

	// Langkah pertama dijalankan tanpa menunggu interval.
	deadline := time.Now().Add(5 * time.Second)
	for len(countArchives(t, dir)) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(countArchives(t, dir)) == 0 {
		t.Fatal("snapshot pertama tidak dijalankan saat start")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run tidak berhenti setelah konteks dibatalkan")
	}
}

func hexString(bytes []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(bytes)*2)
	for _, b := range bytes {
		out = append(out, digits[b>>4], digits[b&0x0f])
	}
	return string(out)
}

// extractArchive membuka `tar.gz` hasil snapshot ke direktori tujuan.
func extractArchive(t *testing.T, archive, dst string) {
	t.Helper()
	file, err := os.Open(archive)
	if err != nil {
		t.Fatalf("buka arsip: %v", err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatalf("baca entri tar: %v", err)
		}
		target := filepath.Join(dst, filepath.FromSlash(header.Name))
		if header.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				t.Fatalf("mkdir %s: %v", target, err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(target), err)
		}
		out, err := os.Create(target)
		if err != nil {
			t.Fatalf("buat %s: %v", target, err)
		}
		if _, err := io.Copy(out, reader); err != nil {
			out.Close()
			t.Fatalf("salin %s: %v", target, err)
		}
		if err := out.Close(); err != nil {
			t.Fatalf("tutup %s: %v", target, err)
		}
	}
}
