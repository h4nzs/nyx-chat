// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Port test unit `CondensedPrefixTreeTest` (implementasi auditor referensi
// Signal) ke Go, plus pengecekan panjang field update (bean validation Java
// `@Size`).

package main

import (
	"bytes"
	"errors"
	"testing"
)

func randomBytes(length int) []byte {
	out := make([]byte, length)
	for index := range out {
		out[index] = byte(index*7 + length)
	}
	return out
}

func realUpdate(proof auditorProof) auditorUpdate {
	return auditorUpdate{
		real:            true,
		commitmentIndex: randomBytes(32),
		seed:            randomBytes(16),
		commitment:      randomBytes(32),
		proof:           proof,
	}
}

func TestVerifyStartingRootHashProofNewTreeKeduaDitolak(t *testing.T) {
	tree := &condensedPrefixTree{}
	first := realUpdate(auditorProof{kind: proofNewTree})
	second := realUpdate(auditorProof{kind: proofNewTree})

	if err := tree.apply(first, 0); err != nil {
		t.Fatalf("update pertama ditolak: %v", err)
	}
	if err := tree.verifyStartingRootHash(second, 1); err == nil {
		t.Fatal("proof newTree kedua diterima — seharusnya ditolak")
	}
}

func TestVerifyStartingRootHashTanpaPohonKosong(t *testing.T) {
	tree := &condensedPrefixTree{}
	update := realUpdate(auditorProof{kind: proofDifferentKey, copath: [][]byte{randomBytes(32)}, oldSeed: randomBytes(16)})
	if err := tree.apply(update, 0); err == nil {
		t.Fatal("proof differentKey sebagai update pertama diterima — seharusnya ditolak")
	}
}

func TestVerifyStartingRootHashSameKeyTidakCocok(t *testing.T) {
	tree := &condensedPrefixTree{}
	first := realUpdate(auditorProof{kind: proofNewTree})
	second := realUpdate(auditorProof{kind: proofDifferentKey, copath: [][]byte{randomBytes(32)}, oldSeed: randomBytes(16)})

	if err := tree.apply(first, 0); err != nil {
		t.Fatalf("update pertama ditolak: %v", err)
	}
	if err := tree.verifyStartingRootHash(second, 1); !errors.Is(err, errInvalidProof) {
		t.Fatalf("error = %v, ingin errInvalidProof (root lama tidak cocok)", err)
	}
}

func TestVerifyStartingRootHashTanpaRootHash(t *testing.T) {
	tree := &condensedPrefixTree{}
	update := realUpdate(auditorProof{kind: proofUnknown})
	if err := tree.verifyStartingRootHash(update, 1); err == nil {
		t.Fatal("update tanpa root hash tersimpan diterima — seharusnya ditolak")
	}
}

func TestNewRootHashProofTidakDikenalDitolak(t *testing.T) {
	update := realUpdate(auditorProof{kind: proofUnknown})
	if _, err := calculateNewRootHashForRealUpdate(update, 0); err == nil {
		t.Fatal("proof tidak dikenal diterima pada update nyata")
	}
	if _, err := calculateNewRootHashForFakeUpdate(update); err == nil {
		t.Fatal("proof tidak dikenal diterima pada update palsu")
	}
}

func TestNewRootHashUntukUpdatePalsuMenolakNewTreeDanSameKey(t *testing.T) {
	if _, err := calculateNewRootHashForFakeUpdate(realUpdate(auditorProof{kind: proofNewTree})); !errors.Is(err, errInvalidProof) {
		t.Fatalf("newTree untuk update palsu: error = %v, ingin errInvalidProof", err)
	}
	sameKey := realUpdate(auditorProof{kind: proofSameKey, copath: [][]byte{randomBytes(32)}, counter: 0, firstLogTreePosition: 1})
	if _, err := calculateNewRootHashForFakeUpdate(sameKey); !errors.Is(err, errInvalidProof) {
		t.Fatalf("sameKey untuk update palsu: error = %v, ingin errInvalidProof", err)
	}
}

func TestCalculateRootHashInputTidakSah(t *testing.T) {
	validHash := randomBytes(32)
	validSeed := randomBytes(16)
	validIndex := randomBytes(32)
	validCopath := [][]byte{randomBytes(32)}

	tooLongCopath := make([][]byte, 257)
	for index := range tooLongCopath {
		tooLongCopath[index] = randomBytes(32)
	}

	cases := []struct {
		name          string
		startingHash  []byte
		seed          []byte
		index         []byte
		copath        [][]byte
		startingLevel int
	}{
		{"starting hash 31 byte", randomBytes(31), validSeed, validIndex, validCopath, 25},
		{"seed 15 byte", validHash, randomBytes(15), validIndex, validCopath, 25},
		{"commitment index 31 byte", validHash, validSeed, randomBytes(31), validCopath, 25},
		{"hash copath 31 byte", validHash, validSeed, validIndex, [][]byte{randomBytes(31)}, 25},
		{"copath lebih dari 256", validHash, validSeed, validIndex, tooLongCopath, 25},
		{"level awal 0", validHash, validSeed, validIndex, validCopath, 0},
		{"level awal 257", validHash, validSeed, validIndex, validCopath, 257},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := calculateRootHash(testCase.startingHash, testCase.seed, testCase.index, testCase.copath, testCase.startingLevel); err == nil {
				t.Fatal("input tidak sah diterima")
			}
		})
	}
}

func TestHashHelperInputTidakSah(t *testing.T) {
	t.Run("leaf hash", func(t *testing.T) {
		if _, err := calculatePrefixLeafHash(randomBytes(31), 0, 0); err == nil {
			t.Fatal("commitment index 31 byte diterima")
		}
		if _, err := calculatePrefixLeafHash(randomBytes(32), -1, 0); err == nil {
			t.Fatal("update count negatif diterima")
		}
	})

	t.Run("parent hash", func(t *testing.T) {
		got, err := calculatePrefixParentHash(randomBytes(32), randomBytes(32))
		if err != nil {
			t.Fatalf("hash induk menolak input sah: %v", err)
		}
		if len(got) != 32 {
			t.Fatalf("hash induk menghasilkan %d byte", len(got))
		}
		if _, err := calculatePrefixParentHash(randomBytes(31), randomBytes(32)); err == nil {
			t.Fatal("hash anak 31 byte diterima")
		}
	})

	t.Run("stand-in hash", func(t *testing.T) {
		if _, err := calculateStandInHash(randomBytes(16), 0); err == nil {
			t.Fatal("level 0 diterima")
		}
		if _, err := calculateStandInHash(randomBytes(16), 257); err == nil {
			t.Fatal("level 257 diterima")
		}
		if _, err := calculateStandInHash(randomBytes(15), 1); err == nil {
			t.Fatal("seed 15 byte diterima")
		}
	})
}

func TestIsCommitmentBitSet(t *testing.T) {
	index := []byte{1, 1, 1}
	cases := []struct {
		level    int
		expected bool
	}{
		{3, false},
		{17, false},
		{8, true},
		{16, true},
	}
	for _, testCase := range cases {
		if got := isCommitmentBitSet(index, testCase.level); got != testCase.expected {
			t.Fatalf("isCommitmentBitSet(%v, %d) = %v, ingin %v", index, testCase.level, got, testCase.expected)
		}
	}
}

func TestValidateUpdateShape(t *testing.T) {
	valid := auditorUpdate{
		commitmentIndex: randomBytes(32),
		seed:            randomBytes(16),
		commitment:      randomBytes(32),
	}
	if err := validateUpdateShape(valid); err != nil {
		t.Fatalf("update sah ditolak: %v", err)
	}

	badIndex := valid
	badIndex.commitmentIndex = randomBytes(31)
	if err := validateUpdateShape(badIndex); err == nil {
		t.Fatal("index 31 byte diterima")
	}

	badSeed := valid
	badSeed.seed = randomBytes(15)
	if err := validateUpdateShape(badSeed); err == nil {
		t.Fatal("seed 15 byte diterima")
	}

	badCommitment := valid
	badCommitment.commitment = randomBytes(33)
	if err := validateUpdateShape(badCommitment); err == nil {
		t.Fatal("commitment 33 byte diterima")
	}
}

// TestRootHashBerubahSaatNilaiBerubah memastikan verifikasi benar-benar mengikat
// data: nilai commitment yang berbeda menghasilkan root prefix tree yang berbeda,
// sehingga update yang "dipindahkan" tidak bisa lolos dengan root lama.
func TestRootHashBerubahSaatNilaiBerubah(t *testing.T) {
	seed := randomBytes(16)
	index := randomBytes(32)
	copath := [][]byte{randomBytes(32), randomBytes(32), randomBytes(32)}

	first, err := calculatePrefixLeafHash(index, 0, 0)
	if err != nil {
		t.Fatalf("leaf hash: %v", err)
	}
	second, err := calculatePrefixLeafHash(index, 1, 0)
	if err != nil {
		t.Fatalf("leaf hash: %v", err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("hash daun sama untuk counter berbeda")
	}

	rootFirst, err := calculateRootHash(first, seed, index, copath, 25)
	if err != nil {
		t.Fatalf("root hash: %v", err)
	}
	rootSecond, err := calculateRootHash(second, seed, index, copath, 25)
	if err != nil {
		t.Fatalf("root hash: %v", err)
	}
	if bytes.Equal(rootFirst, rootSecond) {
		t.Fatal("root hash sama untuk daun berbeda")
	}
}
