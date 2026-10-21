// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Runner auditor: menarik batch update dari layanan log, memverifikasi
// satu-per-satu secara berurutan, lalu secara berkala menandatangani tree head
// yang sudah ia verifikasi dan mengirimkannya balik (`SetAuditorHead`).
//
// Urutan langkah mengikuti `Auditor.auditKeyTransparencyService` di referensi
// Java: verifikasi root prefix tree → tambahkan daun pohon log → naikkan
// penghitung → (kalau jatuh tempo) kirim tree head + simpan state. Perbedaan
// yang penting: **state hanya disimpan setelah `SetAuditorHead` sukses**, jadi
// tanda tangan yang tidak sampai ke layanan log tidak pernah membuat auditor
// "melompat" posisi saat restart.
//
// Bila verifikasi gagal, runner berhenti pada update itu: state in-memory tetap
// konsisten sampai posisi terakhir yang sah, tree head tidak dikirim, dan
// percobaan berikutnya gagal di titik yang sama (deterministik) sampai layanan
// log menyajikan riwayat yang bisa diverifikasi. Inilah perilaku "auditor
// berhenti menandatangani saat menemukan inkonsistensi".

package main

import (
	"context"
	"crypto/mldsa"
	"errors"
	"fmt"
	"time"

	"github.com/signalapp/keytransparency/cmd/kt-server/pb"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	transparency "github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
)

// auditMaxBatchSize = batas upstream `Tree.Audit` (1000) — permintaan dengan
// limit lebih besar ditolak `InvalidArgument`, jadi runner membatasinya lebih
// awal dengan pesan yang jelas.
const auditMaxBatchSize = 1000

type auditorRunner struct {
	name       string
	privateKey *mldsa.PrivateKey
	// config adalah PublicConfig v2 layanan log (mode 3 + kunci ML-DSA-65 log
	// dan kunci auditor yang terkonfigurasi). Dipakai `transparency.SignNewAuditorHead`.
	config *transparency.PublicConfig
	client pb.KeyTransparencyAuditorServiceClient
	state  stateStore

	batchSize         uint64
	interval          time.Duration
	signatureInterval time.Duration
	signaturePageSize uint64

	now  func() time.Time
	logf func(format string, args ...any)

	// metrics adalah exporter loopback auditor (docs/30 WS-G, `metrics.go`).
	// Instance selalu dibangun oleh `newAuditorRunner`; metodenya aman dipanggil
	// pada receiver nil supaya runner yang disusun langsung di test tetap jalan.
	metrics *auditorMetrics

	prefix                condensedPrefixTree
	log                   condensedLogTree
	totalUpdatesProcessed uint64
	lastHeadSent          time.Time
	updatesSinceHead      uint64
}

func newAuditorRunner(
	name string,
	privateKey *mldsa.PrivateKey,
	config *transparency.PublicConfig,
	client pb.KeyTransparencyAuditorServiceClient,
	state stateStore,
	batchSize uint64,
	interval time.Duration,
	signatureInterval time.Duration,
	signaturePageSize uint64,
	now func() time.Time,
	logf func(format string, args ...any),
) (*auditorRunner, error) {
	if name == "" {
		return nil, errors.New("nama auditor wajib diisi")
	}
	if batchSize == 0 || batchSize > auditMaxBatchSize {
		return nil, fmt.Errorf("batch size harus 1..%d, dapat %d", auditMaxBatchSize, batchSize)
	}
	if config == nil || config.Mode != transparency.ThirdPartyAuditing {
		return nil, errors.New("config layanan bukan mode ThirdPartyAuditing (3) — auditor tidak akan bisa mengirim tree head")
	}
	if config.AuditorKeys[name] == nil {
		return nil, fmt.Errorf("kunci publik auditor %q tidak ada di config layanan", name)
	}
	if interval <= 0 {
		return nil, errors.New("interval audit harus lebih besar dari 0")
	}

	runner := &auditorRunner{
		name:              name,
		privateKey:        privateKey,
		config:            config,
		client:            client,
		state:             state,
		batchSize:         batchSize,
		interval:          interval,
		signatureInterval: signatureInterval,
		signaturePageSize: signaturePageSize,
		now:               now,
		logf:              logf,
		metrics:           newAuditorMetrics(),
		// Seperti referensi: jam "tree head terakhir" dimulai dari sekarang, jadi
		// tanda tangan pertama menunggu irama (atau jumlah update) tercapai.
		lastHeadSent: now(),
	}
	// Umur proses dicatat dari jam yang SAMA dengan `lastHeadSent`: itulah yang
	// membuat alert "head basi" bisa membedakan proses baru (head pertama memang
	// masih menunggu irama) dari proses lama yang tidak pernah menandatangani.
	runner.metrics.markStarted(now())
	return runner, nil
}

// loadState memuat state bertanda tangan dan memulihkan pohon auditor.
func (a *auditorRunner) loadState() error {
	stored, err := a.state.load()
	if err != nil {
		return err
	}
	if stored == nil {
		a.logf("state: belum ada state tersimpan — mulai dari pohon kosong")
		return nil
	}

	tree, err := newCondensedLogTree(stored.logTreeNodes, stored.totalUpdatesProcessed)
	if err != nil {
		return fmt.Errorf("state tersimpan tidak konsisten: %w", err)
	}
	a.log = *tree
	a.prefix = condensedPrefixTree{rootHash: stored.prefixTreeRootHash}
	a.totalUpdatesProcessed = stored.totalUpdatesProcessed
	a.metrics.set(metricTreeSize, nil, float64(a.totalUpdatesProcessed))
	a.logf("state: dipulihkan treeSize=%d rootPrefix=%x simpul=%d",
		a.totalUpdatesProcessed, stored.prefixTreeRootHash, len(a.log.nodes))
	return nil
}

// runOnce memproses semua update yang tersedia lalu (bila jatuh tempo) mengirim
// satu tree head. Mengembalikan jumlah update yang diverifikasi pada putaran ini.
func (a *auditorRunner) runOnce(ctx context.Context) (int, error) {
	return a.runOnceWith(ctx, false)
}

// runOnceForceHead sama dengan runOnce tetapi **selalu** mengirim tepat satu tree
// head di akhir, tanpa menunggu irama. Dipakai mode `-once` (drill/verifikasi
// pemasangan): tanpa ini, pengaturan irama 0 akan menandatangani setiap update —
// yang berarti satu commit state per update ke log untuk audit 10 ribu entri.
func (a *auditorRunner) runOnceForceHead(ctx context.Context) (int, error) {
	return a.runOnceWith(ctx, true)
}

func (a *auditorRunner) runOnceWith(ctx context.Context, forceHead bool) (int, error) {
	processed := 0

	for {
		response, err := a.client.Audit(ctx, &pb.AuditRequest{
			Start: a.totalUpdatesProcessed,
			Limit: a.batchSize,
		})
		if err != nil {
			return processed, fmt.Errorf("Audit(start=%d): %w", a.totalUpdatesProcessed, err)
		}

		updates := response.GetUpdates()
		for _, raw := range updates {
			if err := a.applyUpdate(raw); err != nil {
				return processed, err
			}
			processed++
			if forceHead {
				continue
			}
			if err := a.maybeSendHead(ctx); err != nil {
				return processed, err
			}
		}

		if !response.GetMore() {
			break
		}
		if len(updates) == 0 {
			// Layanan menjawab "masih ada" tanpa update: berhenti daripada berputar.
			return processed, errors.New("layanan log menjawab more=true tanpa satu pun update")
		}
	}

	if forceHead {
		return processed, a.sendHead(ctx)
	}

	// Tetap kirim tree head (dan simpan state) saat tidak ada update baru, bila
	// irama waktu sudah tercapai — sama dengan referensi.
	if err := a.maybeSendHead(ctx); err != nil {
		return processed, err
	}
	return processed, nil
}

// applyUpdate memverifikasi satu update dan memasukkannya ke state auditor.
func (a *auditorRunner) applyUpdate(raw *tpb.AuditorUpdate) error {
	update, err := auditorUpdateFromProto(raw)
	if err != nil {
		return err
	}

	position := a.totalUpdatesProcessed
	if err := a.prefix.apply(update, position); err != nil {
		return fmt.Errorf("update ke-%d (%s): %w", position, update, err)
	}
	if len(a.prefix.rootHash) != 32 {
		return fmt.Errorf("update ke-%d: root prefix tree tidak 32 byte setelah verifikasi", position)
	}
	if err := a.log.addLeafNode(update.commitment, a.prefix.rootHash, position); err != nil {
		return fmt.Errorf("update ke-%d: %w", position, err)
	}

	a.totalUpdatesProcessed++
	a.updatesSinceHead++
	a.metrics.inc(metricUpdatesVerifiedTotal, nil)
	a.metrics.set(metricTreeSize, nil, float64(a.totalUpdatesProcessed))
	return nil
}

// maybeSendHead mengirim tree head bila irama waktu atau jumlah update tercapai.
func (a *auditorRunner) maybeSendHead(ctx context.Context) error {
	if a.now().Before(a.lastHeadSent.Add(a.signatureInterval)) && a.updatesSinceHead < a.signaturePageSize {
		return nil
	}
	return a.sendHead(ctx)
}

// sendHead menandatangani tree head yang sudah diverifikasi dengan kunci auditor
// (memakai `transparency.SignNewAuditorHead` upstream — bukan penyusunan ulang
// format tanda tangan sendiri) lalu mengirimnya, dan baru setelah itu menyimpan state.
func (a *auditorRunner) sendHead(ctx context.Context) error {
	if a.totalUpdatesProcessed == 0 {
		// Belum ada satu pun update terverifikasi: tidak ada yang bisa ditandatangani.
		a.logf("tree head belum bisa dikirim: belum ada update terverifikasi")
		return nil
	}

	root, err := a.log.rootHash()
	if err != nil {
		return err
	}

	head, raw, err := transparency.SignNewAuditorHead(a.privateKey, a.config, a.totalUpdatesProcessed, root, a.name)
	if err != nil {
		return fmt.Errorf("tandatangani tree head: %w", err)
	}

	if _, err := a.client.SetAuditorHead(ctx, &tpb.AuditorTreeHead{
		TreeSize:  head.TreeSize,
		Timestamp: head.Timestamp,
		Signature: head.Signature,
	}); err != nil {
		// Metrik dicatat SEBELUM state disimpan: head yang ditolak layanan log
		// adalah peristiwa yang harus terlihat (alert NyxKtAuditorHeadRejected),
		// sedangkan state sengaja tidak berubah (lihat catatan di atas sendHead).
		a.metrics.recordHeadSent(a.now(), resultError, 0)
		return fmt.Errorf("SetAuditorHead(treeSize=%d): %w", head.TreeSize, err)
	}
	// Head DITERIMA layanan log — inilah angka yang dipakai alert "head basi".
	a.metrics.recordHeadSent(a.now(), resultOK, head.TreeSize)

	if err := a.state.store(&auditorState{
		totalUpdatesProcessed: a.totalUpdatesProcessed,
		prefixTreeRootHash:    a.prefix.rootHash,
		logTreeNodes:          a.log.nodes,
	}); err != nil {
		return fmt.Errorf("simpan state setelah tree head diterima: %w", err)
	}

	a.lastHeadSent = a.now()
	a.updatesSinceHead = 0
	a.logf("tree head DIKIRIM treeSize=%d timestamp=%d root=%s (panjang tbs=%d)",
		head.TreeSize, head.Timestamp, shortHex(root), len(raw))
	return nil
}

// run menjalankan putaran audit terus-menerus sampai konteks dibatalkan.
func (a *auditorRunner) run(ctx context.Context) error {
	if err := a.loadState(); err != nil {
		return err
	}
	a.logf("auditor %q aktif — treeSize awal=%d batch=%d interval=%s irama-tanda-tangan=%s",
		a.name, a.totalUpdatesProcessed, a.batchSize, a.interval, a.signatureInterval)

	for {
		processed, err := a.runOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			result := resultError
			if errors.Is(err, errInvalidProof) {
				// Ini peristiwa yang harus terlihat operator: layanan log menyajikan
				// riwayat yang tidak konsisten dengan yang sudah diverifikasi auditor.
				result = resultInconsistent
				a.logf("TIDAK KONSISTEN — tree head tidak dikirim: %v", err)
			} else {
				a.logf("putaran audit gagal (tree head tidak dikirim): %v", err)
			}
			a.metrics.recordRound(a.now(), result)
		} else {
			// Putaran bersih = pandangan auditor masih konsisten dengan layanan log.
			a.metrics.recordRound(a.now(), resultOK)
			if processed > 0 {
				a.logf("putaran audit selesai: %d update diverifikasi, treeSize=%d", processed, a.totalUpdatesProcessed)
			}
		}

		timer := time.NewTimer(a.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			a.logf("auditor berhenti (sinyal)")
			return nil
		case <-timer.C:
		}
	}
}

// shortHex meringkas nilai 32 byte jadi 12 byte pertama hex — cukup untuk
// dibandingkan di log tanpa menyalin hash penuh.
func shortHex(value []byte) string {
	const limit = 12
	if len(value) <= limit {
		return fmt.Sprintf("%x", value)
	}
	return fmt.Sprintf("%x…", value[:limit])
}
