//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

// Package sharedmath implements some shared operations when working
// with a left-balanced binary search tree
package sharedmath

// IsLeaf returns true if nodeId is the id of a leaf node.
func IsLeaf(nodeId uint64) bool {
	return (nodeId & 1) == 0
}

// Log2 returns the exponent of the largest power of 2 less than x.
func Log2(x uint64) uint64 {
	if x == 0 {
		return 0
	}

	k := uint64(0)
	for (x >> k) > 0 {
		k += 1
	}
	return k - 1
}

// Level returns the level of a node in the tree. Leaves are level 0, their
// parents are level 1, and so on.
func Level(nodeId uint64) uint64 {
	if IsLeaf(nodeId) {
		return 0
	}

	level := uint64(0)
	for ((nodeId >> level) & 1) == 1 {
		level += 1
	}
	return level
}

// Left returns the left child of an intermediate node.
// It will panic if nodeId is a leaf node because it cannot return a valid left child.
func Left(nodeId uint64) uint64 {
	level := Level(nodeId)
	if level == 0 {
		panic("leaf node has no children")
	}
	return nodeId ^ (1 << (level - 1))
}

// RightStep returns the right child of an intermediate node — assuming it is a full subtree —
// for nodeId values < 2^64 - 1 (the max uint64 value).
// It will panic if nodeId is a leaf node or has level 64 because it cannot return a valid right step in either case.
func RightStep(nodeId uint64) uint64 {
	level := Level(nodeId)
	if level == 0 {
		panic("leaf node has no children")
	}
	if level == 64 {
		panic("nodeId has level 64")
	}
	return nodeId ^ (3 << (level - 1))
}

// ParentStep returns the parent node, assuming it is a full subtree.
// It will panic if nodeId has level 64 because it cannot return a valid parent step.
func ParentStep(nodeId uint64) uint64 {
	level := Level(nodeId)
	if level == 64 {
		panic("nodeId has level 64")
	}
	// The binary tree has some useful properties. Right children always have the bit at 2^(level+1) set, and
	// can be identified using the following bitwise AND:
	isRightChild := (nodeId >> (level + 1)) & 1
	// Further, for a given level, nodes in that level have their IDs increment by 2^(level+1), and the bit at position
	// 2^level is never set.
	//
	//  3                      0111
	//                   /              \
	//  2           0011                 1011
	//             /    \               /    \
	//  1      0001      0101       1001     1101
	//         /  \      /  \       /  \     /  \
	//  0   0000 0010 0100 0110  1000 1010 1100 1110`
	//
	// For left children, the parent is nodeId + 2^level, while for right children, it's nodeId - 2^level. Bitwise OR
	// makes this straightforward for left children. If we apply the same bitwise OR to right children, then we need to
	// subtract 2^level twice, which we can do by clearing the bit we know is set at 2^(level+1).
	parentNodeIfLeftChild := nodeId | (1 << level)
	subtractIfRightChild := isRightChild << (level + 1)
	return parentNodeIfLeftChild ^ subtractIfRightChild
}

// Parent returns the id of the parent node, if there are treeSize nodes in the tree.
// It will panic if nodeId has level 64 because it cannot return a valid parent.
func Parent(nodeId, treeSize uint64) uint64 {
	p := ParentStep(nodeId)
	for p >= treeSize {
		p = ParentStep(p)
	}
	return p
}
