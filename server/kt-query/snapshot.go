// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency"
)

// ---------------------------------------------------------------------------
// Snapshot log KT (docs/10 §10.13 · docs/30 WS-A)
// ---------------------------------------------------------------------------
//
// Log Key Transparency adalah **satu-satunya** salinan riwayat kunci pengguna
// NYX: kalau basis datanya hilang, tidak ada cara memulihkan klaim "kunci lama
// X" — klien yang sudah menyimpan anchor akan melihat log yang tidak konsisten
// selamanya (lebih buruk daripada log kosong). Karena itu salinan harian adalah
// syarat operasional, bukan kenyamanan.
//
// Kenapa snapshot ini tidak sekadar `cp -r` dari cron:
//
//  1. **LevelDB hidup tidak boleh disalin tanpa jeda.** Manifest/journal-nya
//     ditulis sambil berjalan, jadi salinan bisa berakhir pada keadaan yang tidak
//     bisa dibuka. Di sini penulisan dihentikan dulu (`mu` yang sama dengan
//     `updateService`/`auditorService`), baru direktori disalin.
//  2. **Salinan diverifikasi sebelum dianggap sah.** Setelah disalin, basis data
//     hasil salinan dibuka ulang lewat `db.NewLDBTransparencyStore` (yang memakai
//     `RecoverFile` bila perlu), pohonnya dibangun, dan **tree head + root**-nya
//     dibandingkan dengan pohon hidup. Beda → arsip dibuang dan langkah itu
//     dilaporkan gagal. Snapshot yang belum diverifikasi tidak pernah ditulis ke
//     `latest.json`, jadi pengunggah tidak pernah mengirim sampah.
//  3. **Satu berkas arsip.** Direktori hasil verifikasi dibungkus `tar.gz`
//     (`kt-snapshot-<waktu>.tar.gz`), sehingga pengunggah hanya perlu satu
//     operasi tulis objek dan retensi cukup menghapus berkas lama.
//
// Yang **tidak** dilakukan modul ini: tidak mengunggah ke R2 (kredensial objek
// tidak boleh ada di proses log — lihat `server/src/jobs/ktSnapshot.ts`) dan
// tidak menyentuh kripto apa pun.

const (
	// snapshotPrefix menandai berkas arsip milik modul ini.
	snapshotPrefix = "kt-snapshot-"
	// snapshotSuffix = bentuk arsip yang diunggah.
	snapshotSuffix = ".tar.gz"
	// manifestName = berkas penunjuk arsip terbaru (dibaca pengunggah).
	manifestName = "latest.json"
	// defaultSnapshotKeep = berapa arsip terakhir yang disimpan lokal.
	defaultSnapshotKeep = 7
)

// snapshotManifest adalah isi `latest.json`. Berisi angka verifikasi supaya
// operator (dan pengunggah) bisa melihat snapshot mana yang sah tanpa membuka
// arsipnya.
type snapshotManifest struct {
	File      string `json:"file"`
	CreatedAt string `json:"createdAt"`
	TreeSize  uint64 `json:"treeSize"`
	Root      string `json:"root"`
	Bytes     int64  `json:"bytes"`
}

type snapshotter struct {
	cfg    *transparency.PrivateConfig
	store  db.TransparencyStore
	dbFile string
	// mu adalah mutex yang sama dengan penulis pohon: selama salinan dibuat,
	// tidak ada update yang boleh menulis ke basis data.
	mu   *sync.Mutex
	dir  string
	keep int

	// nowFn/copyTree/logf bisa disuntik di test.
	nowFn    func() time.Time
	copyTree func(src, dst string) error
	logf     func(format string, args ...any)
}

func newSnapshotter(cfg *transparency.PrivateConfig, store db.TransparencyStore, dbFile string, mu *sync.Mutex, dir string, keep int) *snapshotter {
	if keep <= 0 {
		keep = defaultSnapshotKeep
	}
	return &snapshotter{
		cfg:      cfg,
		store:    store,
		dbFile:   dbFile,
		mu:       mu,
		dir:      dir,
		keep:     keep,
		nowFn:    time.Now,
		copyTree: copyDirectory,
		logf:     func(format string, args ...any) { fmt.Printf("[kt-query] "+format+"\n", args...) },
	}
}

// runOnce membuat satu snapshot. Kegagalan **tidak** menggagalkan layanan:
// pemanggil mencatatnya dan mencoba lagi pada interval berikutnya.
func (s *snapshotter) runOnce(ctx context.Context) (snapshotManifest, error) {
	var manifest snapshotManifest

	if err := ctx.Err(); err != nil {
		return manifest, err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return manifest, fmt.Errorf("siapkan direktori snapshot: %w", err)
	}

	// 1. Jeda penulisan, lalu baca keadaan pohon HIDUP — inilah pembanding
	//    verifikasi. Dipegang sampai salinan selesai.
	s.mu.Lock()
	defer s.mu.Unlock()

	liveTree, err := transparency.NewTree(s.cfg, s.store)
	if err != nil {
		return manifest, fmt.Errorf("bangun pohon hidup: %w", err)
	}
	liveHead := liveTree.GetTransparencyTreeHead()
	if liveHead == nil {
		return manifest, fmt.Errorf("tree head hilang")
	}
	liveRoot, err := liveTree.GetLogTree().GetRoot(liveHead.TreeSize)
	if err != nil {
		return manifest, fmt.Errorf("ambil root hidup: %w", err)
	}

	// 2. Salin direktori basis data sementara penulisan dijeda.
	stamp := s.nowFn().UTC()
	copyDir := filepath.Join(s.dir, "in-progress")
	if err := os.RemoveAll(copyDir); err != nil {
		return manifest, fmt.Errorf("bersihkan direktori kerja: %w", err)
	}
	if err := s.copyTree(s.dbFile, copyDir); err != nil {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("salin basis data: %w", err)
	}

	// 3. Verifikasi salinan: buka ulang (RecoverFile bila perlu) dan bandingkan
	//    tree head + root dengan pohon hidup. Beda = salinan tidak layak diunggah.
	copyStore, err := db.NewLDBTransparencyStore(copyDir)
	if err != nil {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("buka salinan: %w", err)
	}
	copyTree, err := transparency.NewTree(s.cfg, copyStore)
	if err != nil {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("bangun pohon salinan: %w", err)
	}
	copyHead := copyTree.GetTransparencyTreeHead()
	if copyHead == nil {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("tree head salinan hilang")
	}
	copyRoot, err := copyTree.GetLogTree().GetRoot(copyHead.TreeSize)
	if err != nil {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("ambil root salinan: %w", err)
	}
	if copyHead.TreeSize != liveHead.TreeSize || !strings.EqualFold(hex.EncodeToString(copyRoot), hex.EncodeToString(liveRoot)) {
		_ = os.RemoveAll(copyDir)
		return manifest, fmt.Errorf("salinan tidak konsisten: ukuran %d/%d, root %s/%s",
			copyHead.TreeSize, liveHead.TreeSize, hex.EncodeToString(copyRoot), hex.EncodeToString(liveRoot))
	}

	// 4. Bungkus jadi satu arsip, buang direktori kerja.
	archive := filepath.Join(s.dir, fmt.Sprintf("%s%s%s", snapshotPrefix, stamp.Format("20060102T150405Z"), snapshotSuffix))
	archivedBytes, err := archiveDirectory(copyDir, archive)
	_ = os.RemoveAll(copyDir)
	if err != nil {
		_ = os.Remove(archive)
		return manifest, fmt.Errorf("bungkus arsip: %w", err)
	}

	manifest = snapshotManifest{
		File:      filepath.Base(archive),
		CreatedAt: stamp.Format(time.RFC3339),
		TreeSize:  liveHead.TreeSize,
		Root:      hex.EncodeToString(liveRoot),
		Bytes:     archivedBytes,
	}
	// 5. Tulis manifest secara atomik (file sementara + rename): pengunggah
	//    tidak boleh melihat manifest separuh tertulis.
	if err := writeManifest(filepath.Join(s.dir, manifestName), manifest); err != nil {
		return manifest, fmt.Errorf("tulis manifest: %w", err)
	}

	s.pruneSnapshots()
	s.logf("snapshot tersimpan %s (treeSize=%d, %d byte)", manifest.File, manifest.TreeSize, manifest.Bytes)
	return manifest, nil
}

// run menjalankan snapshot berkala sampai konteks dibatalkan. Langkah pertama
// dijalankan segera setelah layanan siap (bukan menunggu interval pertama):
// snapshot yang belum pernah dibuat adalah risiko yang sudah berjalan sekarang.
func (s *snapshotter) run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		s.logf("snapshot nonaktif (interval %s)", interval)
		return
	}
	s.logf("snapshot KT aktif: setiap %s ke %s (simpan %d arsip terakhir)", interval, s.dir, s.keep)

	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if _, err := s.runOnce(ctx); err != nil {
				// Terlihat di log operator; langkah berikutnya tetap dijadwalkan.
				s.logf("snapshot gagal: %v", err)
			}
			timer.Reset(interval)
		}
	}
}

// pruneSnapshots menyisakan `keep` arsip terbaru. Berkas asing di direktori ini
// tidak disentuh (operator bisa menyimpan salinan manual di sana).
func (s *snapshotter) pruneSnapshots() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	archives := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, snapshotPrefix) || !strings.HasSuffix(name, snapshotSuffix) {
			continue
		}
		archives = append(archives, name)
	}
	if len(archives) <= s.keep {
		return
	}
	// Nama arsip berisi waktu UTC dengan lebar tetap → urutan leksikal = urutan waktu.
	sort.Sort(sort.Reverse(sort.StringSlice(archives)))
	for _, name := range archives[s.keep:] {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil {
			s.logf("gagal menghapus arsip lama %s: %v", name, err)
			continue
		}
		s.logf("arsip lama dihapus: %s", name)
	}
}

func writeManifest(path string, manifest snapshotManifest) error {
	payload, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// copyDirectory menyalin direktori basis data LevelDB apa adanya (berkas +
// subdirektori). Izin 0700: isi log KT tidak boleh terbaca user lain di host.
func copyDirectory(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, relative)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !info.Mode().IsRegular() {
			// LevelDB tidak memakai symlink/device; melewatinya lebih aman
			// daripada mengikuti tautan keluar direktori.
			return nil
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	// Ukuran baris LevelDB kecil, tapi berkas table bisa puluhan MB: salin
	// dengan buffer tetap, bukan `io.ReadAll`.
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// archiveDirectory membungkus satu direktori menjadi `tar.gz` dan mengembalikan
// ukuran arsip. Dua lapis: jalur relatif di dalam arsip (supaya bisa di-ekstrak
// ke mana saja) dan gzip (log KT sebagian besar teks/protobuf biner pendek).
func archiveDirectory(src, archive string) (int64, error) {
	out, err := os.OpenFile(archive, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	walkErr := filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		if info.IsDir() {
			header.Name += "/"
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.Copy(tw, file)
		return err
	})

	if walkErr == nil {
		walkErr = tw.Close()
	} else {
		_ = tw.Close()
	}
	if err := gz.Close(); err != nil && walkErr == nil {
		walkErr = err
	}
	if err := out.Sync(); err != nil && walkErr == nil {
		walkErr = err
	}
	if err := out.Close(); err != nil && walkErr == nil {
		walkErr = err
	}
	if walkErr != nil {
		return 0, walkErr
	}
	info, err := os.Stat(archive)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
