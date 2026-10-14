//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

// Package math implements the mathematical operations for a log-based Merkle
// tree.
package math

import (
	"slices"

	"github.com/signalapp/keytransparency/tree/sharedmath"
)

// NodeWidth returns the number of nodes needed to store a tree with n leaves.
func NodeWidth(numLeaves uint64) uint64 {
	if numLeaves == 0 {
		return 0
	}
	return 2*(numLeaves-1) + 1
}

// Root returns the id of the root node of a tree with n leaves.
func Root(numLeaves uint64) uint64 {
	w := NodeWidth(numLeaves)
	return (1 << sharedmath.Log2(w)) - 1
}

// Right returns the right child of an intermediate node.
func Right(nodeId, numLeaves uint64) uint64 {
	r := sharedmath.RightStep(nodeId)
	w := NodeWidth(numLeaves)
	for r >= w {
		r = sharedmath.Left(r)
	}
	return r
}

// Parent returns the id of the parent node, if there are n leaves in the tree
// total.
func Parent(nodeId, numLeaves uint64) uint64 {
	if nodeId == Root(numLeaves) {
		panic("root node has no parent")
	}

	width := NodeWidth(numLeaves)
	return sharedmath.Parent(nodeId, width)
}

// Sibling returns the other child of the node's parent.
func Sibling(nodeId, numLeaves uint64) uint64 {
	p := Parent(nodeId, numLeaves)
	if nodeId < p {
		return Right(p, numLeaves)
	} else {
		return sharedmath.Left(p)
	}
}

// DirectPath returns the direct path of a node, ordered from leaf to root.
func DirectPath(nodeId, numLeaves uint64) []uint64 {
	rootNodeId := Root(numLeaves)
	if nodeId == rootNodeId {
		return []uint64{}
	}

	d := []uint64{}
	for nodeId != rootNodeId {
		nodeId = Parent(nodeId, numLeaves)
		d = append(d, nodeId)
	}
	return d
}

// Copath returns the copath of a node, ordered from leaf to root.
func Copath(nodeId, numLeaves uint64) []uint64 {
	if nodeId > 2*(numLeaves-1) {
		panic("nodeId does not exist in the given tree")
	}
	if nodeId == Root(numLeaves) {
		return []uint64{}
	}

	d := append([]uint64{nodeId}, DirectPath(nodeId, numLeaves)...)
	// remove the root
	d = d[:len(d)-1]
	for i := 0; i < len(d); i++ {
		// replace with the sibling
		d[i] = Sibling(d[i], numLeaves)
	}

	return d
}

// IsFullSubtree returns true if nodeId represents a full subtree.
func IsFullSubtree(nodeId, numLeaves uint64) bool {
	rightmost := 2 * (numLeaves - 1)
	expected := nodeId + (1 << sharedmath.Level(nodeId)) - 1

	return expected <= rightmost
}

// FullSubtrees returns the list of full subtree root node IDs, starting from nodeId and traversing down the right side.
func FullSubtrees(nodeId, numLeaves uint64) []uint64 {
	out := []uint64{}

	for !IsFullSubtree(nodeId, numLeaves) {
		out = append(out, sharedmath.Left(nodeId))
		nodeId = Right(nodeId, numLeaves)
	}
	out = append(out, nodeId)
	return out
}

// ConsistencyProof returns the list of node ids to return for a consistency
// proof between m and n, based on the algorithm from RFC 6962.
func ConsistencyProof(m, n uint64) []uint64 {
	return subProof(m, n, true)
}

// subProof implements the algorithm from RFC 6962. `b` indicates that `m` is the value for which the proof was
// originally requested, since `m` might change during recursive calls to generate subProofs
func subProof(m, n uint64, b bool) []uint64 {
	if m == n {
		if b {
			return []uint64{}
		}
		// m must be a power of two if it is not its original value, because k (now n) is always a power of 2
		return []uint64{Root(m)}
	}

	k := uint64(1) << sharedmath.Log2(n)
	if k == n {
		k = k / 2
	}
	if m <= k {
		proof := subProof(m, k, b)
		proof = append(proof, Right(Root(n), n))
		return proof
	}

	proof := subProof(m-k, n-k, false)
	for i := 0; i < len(proof); i++ {
		proof[i] = proof[i] + 2*k
	}
	proof = append([]uint64{sharedmath.Left(Root(n))}, proof...)
	return proof
}

// BatchCopath returns the copath nodes of a batch of leaves. The input leaves are *log entry* IDs, not *node* IDs, sorted in increasing order.
func BatchCopath(leaves []uint64, numLeaves uint64) []uint64 {
	// Convert the leaf indices to node indices.
	nodes := make([]uint64, len(leaves))
	for i, x := range leaves {
		nodes[i] = 2 * x
	}
	slices.Sort(nodes)

	// Iteratively combine nodes until there's only one entry in the list (being
	// the root), keeping track of the extra nodes we needed to get there.
	out := make([]uint64, 0)
	root := Root(numLeaves)
	for {
		if len(nodes) == 1 && nodes[0] == root {
			break
		}

		nextLevel := make([]uint64, 0)
		for len(nodes) > 1 {
			p := Parent(nodes[0], numLeaves)
			if Right(p, numLeaves) == nodes[1] { // Sibling is already here.
				nodes = nodes[2:]
			} else { // Need to fetch sibling.
				out = append(out, Sibling(nodes[0], numLeaves))
				nodes = nodes[1:]
			}
			nextLevel = append(nextLevel, p)
		}
		if len(nodes) == 1 {
			if len(nextLevel) > 0 && sharedmath.Level(Parent(nodes[0], numLeaves)) > sharedmath.Level(nextLevel[0]) {
				// the parent of the last, rightmost, node skips one or more levels, so we must hold on to it until
				// the current level contains its parent's sibling
				nextLevel = append(nextLevel, nodes[0])
			} else {
				out = append(out, Sibling(nodes[0], numLeaves))
				nextLevel = append(nextLevel, Parent(nodes[0], numLeaves))
			}
		}

		nodes = nextLevel
	}
	slices.Sort(out)

	return out
}

// Chunk takes a node id as input and returns the id of the chunk that the node
// would be stored in, in the database.
//
// Chunks store 8 consecutive nodes from the same level of the tree,
// representing a subtree of height 4. The chunk is identified by the root of
// this subtree.
func Chunk(nodeId uint64) uint64 {
	c := nodeId
	for sharedmath.Level(c)%4 != 3 {
		c = sharedmath.ParentStep(c)
	}
	return c
}
