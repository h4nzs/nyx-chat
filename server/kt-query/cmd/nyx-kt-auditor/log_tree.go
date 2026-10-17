// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Port Go dari `org.signal.keytransparency.audit.CondensedLogTree` di
// `signalapp/key-transparency-auditor` (AGPL-3.0, Copyright 2024 Signal
// Messenger, LLC) — implementasi auditor referensi Signal. Yang diport adalah
// **verifikasi sisi auditor**, yang tidak ada di `key-transparency-server`
// (upstream Go hanya punya generator `Audit` + `cmd/generate-auditing-test-vectors`).
// Perilaku, nama fungsi, dan urutan operasi sengaja dibuat sama supaya bisa
// dibandingkan baris-per-baris dengan referensi; yang berbeda hanya gaya Go
// (mengembalikan error, bukan melempar exception).
//
// Pohon log adalah Merkle tree biner *left-balanced*: simpul dengan ID genap
// adalah daun (level 0), simpul ganjil adalah simpul dalam, dan root selalu
// simpul dari subtree penuh paling kiri-turun. Auditor menyimpan **hanya**
// simpul-simpul akar subtree penuh (`nodes`), yang cukup untuk merekonstruksi
// root hash — itulah "condensed"-nya.

package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

const (
	// Domain indicator pemisah domain hash (sama dengan referensi Java).
	logLeafNodeDomainIndicator         = byte(0x00)
	logIntermediateNodeDomainIndicator = byte(0x01)
)

type logTreeNode struct {
	id   uint64
	hash []byte
}

type condensedLogTree struct {
	// nodes terurut menaik berdasarkan ID; hanya akar subtree penuh.
	nodes []logTreeNode
}

// newCondensedLogTree memulihkan pohon dari state tersimpan. Node diberikan
// dalam urutan apa pun (referensi Java mengurutkannya lebih dulu), lalu
// konsistensinya diperiksa terhadap jumlah entri.
func newCondensedLogTree(nodes []logTreeNode, numLogEntries uint64) (*condensedLogTree, error) {
	sorted := make([]logTreeNode, len(nodes))
	copy(sorted, nodes)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].id < sorted[j].id })

	maxLeafNodeID, err := logTreeMaxLeafNodeID(numLogEntries)
	if err != nil {
		return nil, err
	}
	if err := verifyLogTreeConsistentState(sorted, maxLeafNodeID); err != nil {
		return nil, err
	}
	return &condensedLogTree{nodes: sorted}, nil
}

// logTreeMaxLeafNodeID mengembalikan ID daun paling kanan untuk pohon berisi
// `numLogEntries` entri (entri ke-p ada di simpul 2p).
func logTreeMaxLeafNodeID(numLogEntries uint64) (uint64, error) {
	if numLogEntries == 0 {
		return 0, errors.New("jumlah entri pohon log harus lebih besar dari 0")
	}
	return (numLogEntries - 1) * 2, nil
}

// addLeafNode menambahkan satu daun dan menyimpan akar subtree penuh terbesar
// yang terbentuk; simpul antara yang tidak lagi dibutuhkan dibuang. `position`
// adalah posisi entri di log (0-based), sama dengan `numLogEntries` di referensi.
func (t *condensedLogTree) addLeafNode(commitment, prefixTreeRootHash []byte, position uint64) error {
	if len(commitment) != 32 {
		return fmt.Errorf("commitment harus 32 byte, dapat %d", len(commitment))
	}
	if len(prefixTreeRootHash) != 32 {
		return fmt.Errorf("root prefix tree harus 32 byte, dapat %d", len(prefixTreeRootHash))
	}

	maxLeafNodeID := position * 2 // ID daun untuk posisi ini
	currentHash := logTreeLeafHash(prefixTreeRootHash, commitment)
	currentNodeID := maxLeafNodeID
	currentLevel := uint64(0)

	// Selama simpul terakhir yang tersimpan selevel, keduanya membentuk subtree
	// penuh dan bisa digantikan induknya.
	for len(t.nodes) > 0 && logTreeLevel(t.nodes[len(t.nodes)-1].id) == currentLevel {
		node := t.nodes[len(t.nodes)-1]
		t.nodes = t.nodes[:len(t.nodes)-1]

		domain := logIntermediateNodeDomainIndicator
		if currentLevel == 0 {
			domain = logLeafNodeDomainIndicator
		}
		digest := sha256.New()
		digest.Write([]byte{domain})
		digest.Write(node.hash)
		digest.Write([]byte{domain})
		digest.Write(currentHash)
		currentHash = digest.Sum(nil)

		parent, err := logTreeParent(node.id, maxLeafNodeID)
		if err != nil {
			return err
		}
		currentNodeID = parent
		currentLevel++
	}

	t.nodes = append(t.nodes, logTreeNode{id: currentNodeID, hash: currentHash})
	return nil
}

// logTreeLeafHash menghitung hash daun pohon log: SHA256(rootPrefix || commitment)
// — tanpa domain indicator, sama dengan referensi.
func logTreeLeafHash(prefixTreeRootHash, commitment []byte) []byte {
	digest := sha256.New()
	digest.Write(prefixTreeRootHash)
	digest.Write(commitment)
	return digest.Sum(nil)
}

// rootHash merekonstruksi root hash pohon log dari simpul tersimpan.
func (t *condensedLogTree) rootHash() ([]byte, error) {
	switch {
	case len(t.nodes) == 0:
		return nil, errors.New("tidak bisa menghitung root hash pohon log kosong")
	case len(t.nodes) == 1:
		return t.nodes[0].hash, nil
	}

	mostRecent := t.nodes[len(t.nodes)-1]
	rootHash := mostRecent.hash
	// Hanya simpul terakhir yang mungkin daun (subtree penuh terakhir).
	isLeaf := logTreeIsLeafNode(mostRecent.id)

	for index := len(t.nodes) - 2; index >= 0; index-- {
		node := t.nodes[index]
		digest := sha256.New()
		digest.Write([]byte{logIntermediateNodeDomainIndicator})
		digest.Write(node.hash)
		if isLeaf {
			digest.Write([]byte{logLeafNodeDomainIndicator})
		} else {
			digest.Write([]byte{logIntermediateNodeDomainIndicator})
		}
		digest.Write(rootHash)
		rootHash = digest.Sum(nil)
		isLeaf = false
	}
	return rootHash, nil
}

// verifyLogTreeConsistentState memastikan ID simpul tersimpan sama dengan
// himpunan akar subtree penuh yang diharapkan untuk ukuran pohon itu.
func verifyLogTreeConsistentState(nodes []logTreeNode, maxLeafNodeID uint64) error {
	expected, err := logTreeFullSubtreeRootNodeIDs(maxLeafNodeID)
	if err != nil {
		return err
	}
	if len(expected) != len(nodes) {
		return fmt.Errorf("jumlah simpul tersimpan %d, ingin %d untuk pohon berukuran ini", len(nodes), len(expected))
	}
	for index, id := range expected {
		if nodes[index].id != id {
			return fmt.Errorf("ID simpul ke-%d = %d, ingin %d (state tidak konsisten dengan ukuran pohon)", index, nodes[index].id, id)
		}
	}
	return nil
}

// logTreeIsFullSubtree melaporkan apakah simpul `nodeID` adalah akar subtree penuh.
func logTreeIsFullSubtree(nodeID, maxLeafNodeID uint64) (bool, error) {
	if nodeID > maxLeafNodeID {
		return false, errors.New("simpul tidak ada di pohon berukuran ini")
	}
	expectedMaxLeafNodeID := nodeID + (uint64(1) << logTreeLevel(nodeID)) - 1
	return expectedMaxLeafNodeID <= maxLeafNodeID, nil
}

// logTreeFullSubtreeRootNodeIDs mengembalikan ID akar subtree penuh, dari akar
// pohon menuruni sisi kanan (pohon left-balanced: kalau anak kanan ada, subtree
// kiri pasti penuh).
func logTreeFullSubtreeRootNodeIDs(maxLeafNodeID uint64) ([]uint64, error) {
	rootNodeID := logTreeRoot(maxLeafNodeID)
	var out []uint64
	for {
		full, err := logTreeIsFullSubtree(rootNodeID, maxLeafNodeID)
		if err != nil {
			return nil, err
		}
		if full {
			break
		}
		left, err := logTreeLeftChild(rootNodeID)
		if err != nil {
			return nil, err
		}
		out = append(out, left)
		right, err := logTreeRightChild(rootNodeID, maxLeafNodeID)
		if err != nil {
			return nil, err
		}
		rootNodeID = right
	}
	return append(out, rootNodeID), nil
}

// logTreeParent mengembalikan ID induk simpul dalam pohon berukuran ini.
func logTreeParent(nodeID, maxLeafNodeID uint64) (uint64, error) {
	if nodeID > maxLeafNodeID {
		return 0, errors.New("simpul tidak ada di pohon berukuran ini")
	}
	if nodeID == logTreeRoot(maxLeafNodeID) {
		return 0, errors.New("simpul akar tidak punya induk")
	}

	parentNodeID := logTreeRoot(maxLeafNodeID)
	for {
		var childNodeID uint64
		if nodeID < parentNodeID {
			left, err := logTreeLeftChild(parentNodeID)
			if err != nil {
				return 0, err
			}
			childNodeID = left
		} else {
			right, err := logTreeRightChild(parentNodeID, maxLeafNodeID)
			if err != nil {
				return 0, err
			}
			childNodeID = right
		}
		if childNodeID == nodeID {
			return parentNodeID, nil
		}
		parentNodeID = childNodeID
	}
}

// logTreeLeftChild mengembalikan ID anak kiri simpul dalam.
func logTreeLeftChild(nodeID uint64) (uint64, error) {
	if logTreeIsLeafNode(nodeID) {
		return 0, errors.New("daun tidak punya anak")
	}
	return nodeID - (uint64(1) << (logTreeLevel(nodeID) - 1)), nil
}

// logTreeRightChild mengembalikan ID anak kanan simpul dalam dalam pohon berukuran
// ini (kalau anak kanan "seharusnya" di luar pohon, turun ke kiri sampai ketemu).
func logTreeRightChild(nodeID, maxLeafNodeID uint64) (uint64, error) {
	if logTreeIsLeafNode(nodeID) {
		return 0, errors.New("daun tidak punya anak")
	}
	if nodeID > maxLeafNodeID {
		return 0, errors.New("pohon tidak memuat simpul dalam ini")
	}

	rightNodeID := nodeID + (uint64(1) << (logTreeLevel(nodeID) - 1))
	for rightNodeID > maxLeafNodeID {
		left, err := logTreeLeftChild(rightNodeID)
		if err != nil {
			return 0, err
		}
		rightNodeID = left
	}
	return rightNodeID, nil
}

// logTreeRoot mengembalikan ID akar pohon log berukuran ini.
func logTreeRoot(maxLeafNodeID uint64) uint64 {
	if maxLeafNodeID == 0 {
		return 0
	}
	// Long.highestOneBit(maxLeafNodeID) - 1
	return (uint64(1) << uint(bits.Len64(maxLeafNodeID)-1)) - 1
}

// logTreeLevel mengembalikan level simpul (daun = 0, induk = level anak + 1).
func logTreeLevel(nodeID uint64) uint64 {
	if logTreeIsLeafNode(nodeID) {
		return 0
	}
	return uint64(bits.TrailingZeros64(^nodeID))
}

// logTreeIsLeafNode melaporkan apakah ID simpul adalah daun (ID genap).
func logTreeIsLeafNode(nodeID uint64) bool {
	return nodeID%2 == 0
}
