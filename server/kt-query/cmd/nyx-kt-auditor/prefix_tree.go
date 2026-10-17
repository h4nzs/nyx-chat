// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Port Go dari `org.signal.keytransparency.audit.CondensedPrefixTree` di
// `signalapp/key-transparency-auditor` (AGPL-3.0, Copyright 2024 Signal
// Messenger, LLC).
//
// Inilah bagian yang membuat auditor "pihak ketiga" benar-benar memverifikasi:
// setiap update membawa bukti (`newTree`/`differentKey`/`sameKey`) yang harus
// membangun kembali **root hash prefix tree lama** yang disimpan auditor. Kalau
// layanan log mencoba mengubah riwayat (mengganti nilai, menyisipkan, atau
// memindahkan entri), root lama tidak akan cocok dan update ditolak.
//
// Prefix tree adalah Merkle tree biner 256 level yang ditelusuri memakai
// commitment index (keluaran VRF 256 bit). Berbeda dengan pohon log, di sini
// **root = level 0 dan daun = level 256**. Auditor hanya menyimpan root hash-nya;
// sisanya dihitung dari bukti + `standInHashSeed` (cabang yang belum "dijelajahi").

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	prefixLeafNodeDomainIndicator         = byte(0x00)
	prefixIntermediateNodeDomainIndicator = byte(0x01)
	prefixStandInNodeDomainIndicator      = byte(0x02)

	prefixRootLevel = 0
	prefixLeafLevel = 256
)

type condensedPrefixTree struct {
	// rootHash nil = auditor belum pernah melihat update (pohon kosong).
	rootHash []byte
}

// apply memverifikasi root hash awal update terhadap state auditor, lalu
// menyimpan root hash baru.
func (t *condensedPrefixTree) apply(update auditorUpdate, numLogEntries uint64) error {
	if err := t.verifyStartingRootHash(update, numLogEntries); err != nil {
		return err
	}

	var newRoot []byte
	var err error
	if update.real {
		newRoot, err = calculateNewRootHashForRealUpdate(update, numLogEntries)
	} else {
		newRoot, err = calculateNewRootHashForFakeUpdate(update)
	}
	if err != nil {
		return err
	}
	t.rootHash = newRoot
	return nil
}

// verifyStartingRootHash memeriksa bahwa update berangkat dari root hash yang
// sama dengan yang dipegang auditor.
func (t *condensedPrefixTree) verifyStartingRootHash(update auditorUpdate, numLogEntries uint64) error {
	if update.proof.kind == proofNewTree {
		if numLogEntries != 0 || len(t.rootHash) != 0 {
			return invalidProof("auditor harus punya nol entri log dan tanpa root hash untuk proof newTree")
		}
		return nil
	}

	if len(t.rootHash) == 0 {
		if numLogEntries == 0 {
			return invalidProof("proof pertama harus bertipe newTree")
		}
		// Tidak seharusnya terjadi: hanya NewTree yang boleh diproses tanpa root.
		return invalidProof("tidak ada root hash tersimpan untuk proof ini")
	}

	var rootHashFromProof []byte
	switch update.proof.kind {
	case proofDifferentKey:
		// Seed lama menghitung stand-in hash di ujung copath, lalu kita naik ke root
		// dari level nilai copath terakhir. Seed lama hanya dipakai di sini.
		startingHash, err := calculateStandInHash(update.proof.oldSeed, len(update.proof.copath))
		if err != nil {
			return err
		}
		rootHashFromProof, err = calculateRootHash(startingHash, update.proof.oldSeed, update.commitmentIndex,
			update.proof.copath, len(update.proof.copath))
		if err != nil {
			return err
		}
	case proofSameKey:
		startingHash, err := calculatePrefixLeafHash(update.commitmentIndex, int32(update.proof.counter),
			update.proof.firstLogTreePosition)
		if err != nil {
			return err
		}
		rootHashFromProof, err = calculateRootHash(startingHash, update.seed, update.commitmentIndex,
			update.proof.copath, prefixLeafLevel)
		if err != nil {
			return err
		}
	default:
		return invalidProof("tipe proof tidak dikenal: %d", update.proof.kind)
	}

	if !bytes.Equal(t.rootHash, rootHashFromProof) {
		return invalidProof("root hash prefix tree awal auditor tidak cocok dengan yang diberikan layanan log "+
			"(update ke-%d): ingin %x, dapat %x", numLogEntries, t.rootHash, rootHashFromProof)
	}
	return nil
}

// calculateNewRootHashForRealUpdate menghitung root hash prefix tree setelah
// update nyata: hash daun baru digabung dengan copath/stand-in hash sampai root.
func calculateNewRootHashForRealUpdate(update auditorUpdate, numLogEntries uint64) ([]byte, error) {
	var leafHash []byte
	var copath [][]byte
	var err error

	switch update.proof.kind {
	case proofNewTree:
		leafHash, err = calculatePrefixLeafHash(update.commitmentIndex, 0, numLogEntries)
		copath = nil
	case proofDifferentKey:
		leafHash, err = calculatePrefixLeafHash(update.commitmentIndex, 0, numLogEntries)
		copath = update.proof.copath
	case proofSameKey:
		leafHash, err = calculatePrefixLeafHash(update.commitmentIndex, int32(update.proof.counter)+1, update.proof.firstLogTreePosition)
		copath = update.proof.copath
	default:
		return nil, invalidProof("tipe proof tidak dikenal untuk update nyata: %d", update.proof.kind)
	}
	if err != nil {
		return nil, err
	}

	return calculateRootHash(leafHash, update.seed, update.commitmentIndex, copath, prefixLeafLevel)
}

// calculateNewRootHashForFakeUpdate menghitung root hash prefix tree setelah
// update palsu: nilai barunya adalah stand-in hash (bukan daun berisi data).
func calculateNewRootHashForFakeUpdate(update auditorUpdate) ([]byte, error) {
	var standInHash []byte
	var copath [][]byte
	var err error

	switch update.proof.kind {
	case proofNewTree:
		return nil, invalidProof("proof newTree tidak boleh diberikan untuk update palsu")
	case proofDifferentKey:
		standInHash, err = calculateStandInHash(update.seed, len(update.proof.copath))
		if err != nil {
			return nil, err
		}
		copath = update.proof.copath
	case proofSameKey:
		return nil, invalidProof("proof sameKey tidak boleh diberikan untuk update palsu")
	default:
		return nil, invalidProof("tipe proof tidak dikenal untuk update palsu: %d", update.proof.kind)
	}

	return calculateRootHash(standInHash, update.seed, update.commitmentIndex, copath, len(copath))
}

// calculateRootHash menaiki prefix tree dari `startingHash` (level
// `startingLevel`) sampai level 0. Sibling di luar copath dihitung sebagai
// stand-in hash dari `seed` — begitulah bagian pohon yang belum dijelajahi
// direpresentasikan tanpa menyimpan seluruh pohon.
func calculateRootHash(startingHash, seed, commitmentIndex []byte, copath [][]byte, startingLevel int) ([]byte, error) {
	if len(startingHash) != 32 {
		return nil, errors.New("starting hash harus 32 byte")
	}
	if len(seed) != 16 {
		return nil, errors.New("seed harus 16 byte")
	}
	if len(commitmentIndex) != 32 {
		return nil, errors.New("commitment index harus 32 byte")
	}
	for _, hash := range copath {
		if len(hash) != 32 {
			return nil, errors.New("hash simpul antara harus 32 byte")
		}
	}
	if len(copath) > prefixLeafLevel || startingLevel <= prefixRootLevel || startingLevel > prefixLeafLevel {
		return nil, errors.New("ukuran copath atau level awal tidak sah")
	}

	hash := startingHash
	var err error
	for level := startingLevel; level > prefixRootLevel; level-- {
		// Di bagian "padat" pakai nilai copath; di bagian kosong hitung stand-in.
		var siblingHash []byte
		if level <= len(copath) {
			siblingHash = copath[level-1]
		} else {
			siblingHash, err = calculateStandInHash(seed, level)
			if err != nil {
				return nil, err
			}
		}

		var left, right []byte
		if isCommitmentBitSet(commitmentIndex, level) {
			left, right = siblingHash, hash
		} else {
			left, right = hash, siblingHash
		}
		hash, err = calculatePrefixParentHash(left, right)
		if err != nil {
			return nil, err
		}
	}
	return hash, nil
}

// isCommitmentBitSet melaporkan apakah bit pada `level` (1-based, big-endian)
// bernilai 1.
func isCommitmentBitSet(commitmentIndex []byte, level int) bool {
	bitIndex := level - 1
	nthByte := commitmentIndex[bitIndex/8]
	rightShift := uint(7 - bitIndex%8)
	return ((nthByte >> rightShift) & 1) == 1
}

// calculatePrefixLeafHash menghitung hash daun prefix tree:
// SHA256(0x00 || commitmentIndex || BE32(updateCount) || BE64(logTreePosition)).
func calculatePrefixLeafHash(commitmentIndex []byte, updateCount int32, logTreePosition uint64) ([]byte, error) {
	if len(commitmentIndex) != 32 {
		return nil, errors.New("commitment index harus 32 byte")
	}
	if updateCount < 0 {
		return nil, errors.New("update count tidak boleh negatif")
	}

	var countAndPosition [12]byte
	binary.BigEndian.PutUint32(countAndPosition[0:4], uint32(updateCount))
	binary.BigEndian.PutUint64(countAndPosition[4:12], logTreePosition)

	digest := sha256.New()
	digest.Write([]byte{prefixLeafNodeDomainIndicator})
	digest.Write(commitmentIndex)
	digest.Write(countAndPosition[:])
	return digest.Sum(nil), nil
}

// calculatePrefixParentHash menghitung hash simpul dalam: SHA256(0x01 || left || right).
func calculatePrefixParentHash(left, right []byte) ([]byte, error) {
	if len(left) != 32 || len(right) != 32 {
		return nil, errors.New("hash anak harus 32 byte")
	}
	digest := sha256.New()
	digest.Write([]byte{prefixIntermediateNodeDomainIndicator})
	digest.Write(left)
	digest.Write(right)
	return digest.Sum(nil), nil
}

// calculateStandInHash menghitung hash stand-in untuk level tertentu:
// SHA256(0x02 || seed || byte(level-1)).
func calculateStandInHash(seed []byte, level int) ([]byte, error) {
	if len(seed) != 16 {
		return nil, errors.New("seed harus 16 byte")
	}
	if level <= prefixRootLevel || level > prefixLeafLevel {
		return nil, errors.New("level harus lebih besar dari 0 dan maksimal 256")
	}

	digest := sha256.New()
	digest.Write([]byte{prefixStandInNodeDomainIndicator})
	digest.Write(seed)
	// level-1 karena kita tidak pernah menghitung stand-in untuk level 0 (root),
	// dan nilainya harus muat dalam satu byte.
	digest.Write([]byte{byte(level - 1)})
	return digest.Sum(nil), nil
}

// validateUpdateShape memeriksa panjang field update seperti bean validation di
// referensi Java (@Size 32/16/32). Tanpa ini, layanan log yang rusak/jahat bisa
// membuat auditor membandingkan hash dengan panjang salah dan "lolos" tanpa
// verifikasi yang berarti.
func validateUpdateShape(update auditorUpdate) error {
	if len(update.commitmentIndex) != 32 {
		return fmt.Errorf("index update harus 32 byte, dapat %d", len(update.commitmentIndex))
	}
	if len(update.seed) != 16 {
		return fmt.Errorf("seed update harus 16 byte, dapat %d", len(update.seed))
	}
	if len(update.commitment) != 32 {
		return fmt.Errorf("commitment update harus 32 byte, dapat %d", len(update.commitment))
	}
	return nil
}
