// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Port test unit `CondensedLogTreeTest` (implementasi auditor referensi Signal)
// ke Go. Kasus dengan ID negatif tidak diport: tipe `uint64` membuatnya mustahil
// di Go (di Java itu `long`).

package main

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

func TestNewCondensedLogTreeMengurutkanSimpul(t *testing.T) {
	nodes := []logTreeNode{
		{id: 9, hash: make([]byte, 32)},
		{id: 12, hash: make([]byte, 32)},
		{id: 3, hash: make([]byte, 32)},
	}
	tree, err := newCondensedLogTree(nodes, 7)
	if err != nil {
		t.Fatalf("newCondensedLogTree: %v", err)
	}

	want := []uint64{3, 9, 12}
	if len(tree.nodes) != len(want) {
		t.Fatalf("jumlah simpul = %d, ingin %d", len(tree.nodes), len(want))
	}
	for index, id := range want {
		if tree.nodes[index].id != id {
			t.Fatalf("simpul ke-%d = %d, ingin %d", index, tree.nodes[index].id, id)
		}
	}
}

func TestCondensedLogTreeRootHashKosongDitolak(t *testing.T) {
	tree := &condensedLogTree{}
	if _, err := tree.rootHash(); err == nil {
		t.Fatal("root hash pohon log kosong diterima — seharusnya ditolak")
	}
}

func TestAddLeafNodeDanRootHash(t *testing.T) {
	tree := &condensedLogTree{}
	digest := sha256.New()

	firstCommitment := bytes.Repeat([]byte{0x11}, 32)
	firstRoot := bytes.Repeat([]byte{0x22}, 32)
	if err := tree.addLeafNode(firstCommitment, firstRoot, 0); err != nil {
		t.Fatalf("tambah daun 1: %v", err)
	}
	digest.Reset()
	digest.Write(firstRoot)
	digest.Write(firstCommitment)
	expectedFirstLeaf := digest.Sum(nil)

	if len(tree.nodes) != 1 || tree.nodes[0].id != 0 {
		t.Fatalf("simpul setelah daun 1 = %+v, ingin satu simpul id=0", tree.nodes)
	}
	if !bytes.Equal(tree.nodes[0].hash, expectedFirstLeaf) {
		t.Fatalf("hash simpul pertama tidak sesuai hitungan manual")
	}
	root, err := tree.rootHash()
	if err != nil {
		t.Fatalf("rootHash: %v", err)
	}
	if !bytes.Equal(root, expectedFirstLeaf) {
		t.Fatalf("root hash pohon satu daun harus sama dengan hash daunnya")
	}

	secondCommitment := bytes.Repeat([]byte{0x33}, 32)
	secondRoot := bytes.Repeat([]byte{0x44}, 32)
	if err := tree.addLeafNode(secondCommitment, secondRoot, 1); err != nil {
		t.Fatalf("tambah daun 2: %v", err)
	}
	digest.Reset()
	digest.Write(secondRoot)
	digest.Write(secondCommitment)
	expectedSecondLeaf := digest.Sum(nil)

	digest.Reset()
	digest.Write([]byte{logLeafNodeDomainIndicator})
	digest.Write(expectedFirstLeaf)
	digest.Write([]byte{logLeafNodeDomainIndicator})
	digest.Write(expectedSecondLeaf)
	expectedSecondRoot := digest.Sum(nil)

	if len(tree.nodes) != 1 || tree.nodes[0].id != 1 {
		t.Fatalf("simpul setelah daun 2 = %+v, ingin satu simpul id=1", tree.nodes)
	}
	if !bytes.Equal(tree.nodes[0].hash, expectedSecondRoot) {
		t.Fatal("hash simpul setelah daun 2 tidak sesuai hitungan manual")
	}

	thirdCommitment := bytes.Repeat([]byte{0x55}, 32)
	thirdRoot := bytes.Repeat([]byte{0x66}, 32)
	if err := tree.addLeafNode(thirdCommitment, thirdRoot, 2); err != nil {
		t.Fatalf("tambah daun 3: %v", err)
	}
	digest.Reset()
	digest.Write(thirdRoot)
	digest.Write(thirdCommitment)
	expectedThirdLeaf := digest.Sum(nil)

	digest.Reset()
	digest.Write([]byte{logIntermediateNodeDomainIndicator})
	digest.Write(expectedSecondRoot)
	digest.Write([]byte{logLeafNodeDomainIndicator})
	digest.Write(expectedThirdLeaf)
	expectedThirdRoot := digest.Sum(nil)

	if len(tree.nodes) != 2 || tree.nodes[0].id != 1 || tree.nodes[1].id != 4 {
		t.Fatalf("simpul setelah daun 3 = %+v, ingin id 1 dan 4", tree.nodes)
	}
	if !bytes.Equal(tree.nodes[0].hash, expectedSecondRoot) {
		t.Fatal("hash simpul id=1 berubah setelah daun ketiga")
	}
	if !bytes.Equal(tree.nodes[1].hash, expectedThirdLeaf) {
		t.Fatal("hash simpul id=4 bukan hash daun ketiga")
	}
	root, err = tree.rootHash()
	if err != nil {
		t.Fatalf("rootHash: %v", err)
	}
	if !bytes.Equal(root, expectedThirdRoot) {
		t.Fatal("root hash setelah tiga daun tidak sesuai hitungan manual")
	}
}

func TestCondensedLogTreeBatasNolDitolak(t *testing.T) {
	if _, err := logTreeMaxLeafNodeID(0); err == nil {
		t.Fatal("jumlah entri 0 diterima — seharusnya ditolak")
	}
	if _, err := newCondensedLogTree([]logTreeNode{{id: 0, hash: make([]byte, 32)}}, 0); err == nil {
		t.Fatal("state tanpa entri diterima — seharusnya ditolak")
	}
}

func TestIsFullSubtree(t *testing.T) {
	cases := []struct {
		nodeID        uint64
		maxLeafNodeID uint64
		expected      bool
	}{
		{0, 0, true},
		{3, 4, false},
		{3, 12, true},
		{9, 12, true},
	}
	for _, testCase := range cases {
		got, err := logTreeIsFullSubtree(testCase.nodeID, testCase.maxLeafNodeID)
		if err != nil {
			t.Fatalf("isFullSubtree(%d, %d): %v", testCase.nodeID, testCase.maxLeafNodeID, err)
		}
		if got != testCase.expected {
			t.Fatalf("isFullSubtree(%d, %d) = %v, ingin %v", testCase.nodeID, testCase.maxLeafNodeID, got, testCase.expected)
		}
	}

	if _, err := logTreeIsFullSubtree(5, 4); err == nil {
		t.Fatal("simpul di luar pohon diterima — seharusnya ditolak")
	}
}

func TestFullSubtreeRootNodeIDs(t *testing.T) {
	cases := []struct {
		maxLeafNodeID uint64
		expected      []uint64
	}{
		{0, []uint64{0}},
		{2, []uint64{1}},
		{4, []uint64{1, 4}},
		{6, []uint64{3}},
		{8, []uint64{3, 8}},
		{12, []uint64{3, 9, 12}},
	}
	for _, testCase := range cases {
		got, err := logTreeFullSubtreeRootNodeIDs(testCase.maxLeafNodeID)
		if err != nil {
			t.Fatalf("fullSubtreeRootNodeIDs(%d): %v", testCase.maxLeafNodeID, err)
		}
		if len(got) != len(testCase.expected) {
			t.Fatalf("fullSubtreeRootNodeIDs(%d) = %v, ingin %v", testCase.maxLeafNodeID, got, testCase.expected)
		}
		for index, id := range testCase.expected {
			if got[index] != id {
				t.Fatalf("fullSubtreeRootNodeIDs(%d) = %v, ingin %v", testCase.maxLeafNodeID, got, testCase.expected)
			}
		}
	}
}

func TestMaxLeafNodeID(t *testing.T) {
	cases := []struct {
		numLogEntries uint64
		expected      uint64
	}{
		{1, 0},
		{2, 2},
		{3, 4},
		{6, 10},
	}
	for _, testCase := range cases {
		got, err := logTreeMaxLeafNodeID(testCase.numLogEntries)
		if err != nil {
			t.Fatalf("maxLeafNodeID(%d): %v", testCase.numLogEntries, err)
		}
		if got != testCase.expected {
			t.Fatalf("maxLeafNodeID(%d) = %d, ingin %d", testCase.numLogEntries, got, testCase.expected)
		}
	}
}

func TestVerifyLogTreeConsistentState(t *testing.T) {
	node := func(id uint64) logTreeNode { return logTreeNode{id: id, hash: make([]byte, 32)} }

	cases := []struct {
		nodes         []logTreeNode
		maxLeafNodeID uint64
		consistent    bool
	}{
		{[]logTreeNode{node(0)}, 0, true},
		{[]logTreeNode{node(1)}, 2, true},
		{[]logTreeNode{node(1), node(4)}, 4, true},
		{[]logTreeNode{node(3), node(9), node(12)}, 12, true},
		{[]logTreeNode{node(3), node(9)}, 12, false},           // simpul kurang
		{[]logTreeNode{node(3), node(12), node(9)}, 12, false}, // urutan salah
	}
	for index, testCase := range cases {
		err := verifyLogTreeConsistentState(testCase.nodes, testCase.maxLeafNodeID)
		if testCase.consistent && err != nil {
			t.Fatalf("kasus ke-%d: state konsisten ditolak: %v", index, err)
		}
		if !testCase.consistent && err == nil {
			t.Fatalf("kasus ke-%d: state tidak konsisten diterima", index)
		}
	}
}

func TestNavigasiPohonLog(t *testing.T) {
	t.Run("left child", func(t *testing.T) {
		cases := map[uint64]uint64{1: 0, 3: 1, 7: 3, 9: 8}
		for nodeID, expected := range cases {
			got, err := logTreeLeftChild(nodeID)
			if err != nil {
				t.Fatalf("leftChild(%d): %v", nodeID, err)
			}
			if got != expected {
				t.Fatalf("leftChild(%d) = %d, ingin %d", nodeID, got, expected)
			}
		}
		if _, err := logTreeLeftChild(4); err == nil {
			t.Fatal("daun diterima sebagai simpul dalam")
		}
	})

	t.Run("right child", func(t *testing.T) {
		cases := []struct {
			nodeID, maxLeafNodeID, expected uint64
		}{
			{1, 2, 2},
			{3, 4, 4},
			{3, 6, 5},
			{7, 8, 8},
			{7, 10, 9},
		}
		for _, testCase := range cases {
			got, err := logTreeRightChild(testCase.nodeID, testCase.maxLeafNodeID)
			if err != nil {
				t.Fatalf("rightChild(%d, %d): %v", testCase.nodeID, testCase.maxLeafNodeID, err)
			}
			if got != testCase.expected {
				t.Fatalf("rightChild(%d, %d) = %d, ingin %d", testCase.nodeID, testCase.maxLeafNodeID, got, testCase.expected)
			}
		}
		if _, err := logTreeRightChild(4, 4); err == nil {
			t.Fatal("daun diterima sebagai simpul dalam")
		}
		if _, err := logTreeRightChild(5, 4); err == nil {
			t.Fatal("simpul di luar pohon diterima")
		}
	})

	t.Run("parent", func(t *testing.T) {
		cases := []struct {
			nodeID, maxLeafNodeID, expected uint64
		}{
			{0, 2, 1},
			{2, 4, 1},
			{3, 10, 7},
			{7, 16, 15},
		}
		for _, testCase := range cases {
			got, err := logTreeParent(testCase.nodeID, testCase.maxLeafNodeID)
			if err != nil {
				t.Fatalf("parent(%d, %d): %v", testCase.nodeID, testCase.maxLeafNodeID, err)
			}
			if got != testCase.expected {
				t.Fatalf("parent(%d, %d) = %d, ingin %d", testCase.nodeID, testCase.maxLeafNodeID, got, testCase.expected)
			}
		}
		if _, err := logTreeParent(3, 4); err == nil {
			t.Fatal("akar diterima sebagai simpul yang punya induk")
		}
		if _, err := logTreeParent(11, 10); err == nil {
			t.Fatal("simpul di luar pohon diterima")
		}
	})

	t.Run("root", func(t *testing.T) {
		cases := map[uint64]uint64{0: 0, 2: 1, 4: 3, 6: 3, 10: 7}
		for maxLeafNodeID, expected := range cases {
			if got := logTreeRoot(maxLeafNodeID); got != expected {
				t.Fatalf("root(%d) = %d, ingin %d", maxLeafNodeID, got, expected)
			}
		}
	})

	t.Run("level", func(t *testing.T) {
		cases := map[uint64]uint64{0: 0, 2: 0, 1: 1, 5: 1, 3: 2, 11: 2, 7: 3}
		for nodeID, expected := range cases {
			if got := logTreeLevel(nodeID); got != expected {
				t.Fatalf("level(%d) = %d, ingin %d", nodeID, got, expected)
			}
		}
	})

	t.Run("leaf node", func(t *testing.T) {
		cases := map[uint64]bool{0: true, 16: true, 1: false, 15: false}
		for nodeID, expected := range cases {
			if got := logTreeIsLeafNode(nodeID); got != expected {
				t.Fatalf("isLeafNode(%d) = %v, ingin %v", nodeID, got, expected)
			}
		}
	})
}

func TestAddLeafNodeMenolakHashPendek(t *testing.T) {
	tree := &condensedLogTree{}
	if err := tree.addLeafNode(make([]byte, 31), make([]byte, 32), 0); err == nil {
		t.Fatal("commitment 31 byte diterima")
	}
	if err := tree.addLeafNode(make([]byte, 32), make([]byte, 31), 0); err == nil {
		t.Fatal("root prefix tree 31 byte diterima")
	}
}
