//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

// Package math implements the mathematical operations for the implicit binary
// search tree, formed by arranging the log entries in a left-balanced binary search formation.
package math

import (
	"github.com/signalapp/keytransparency/tree/sharedmath"
)

// moveWithin takes as input an entryId, a lower bound start, and an upper bound treeSize.
// It returns the result of starting from entryId and moving left or right in the tree
// until entryId falls within [start, treeSize).
func moveWithin(entryId, start, treeSize uint64) uint64 {
	for entryId < start || entryId >= treeSize {
		if entryId < start {
			entryId = sharedmath.RightStep(entryId)
		} else {
			entryId = sharedmath.Left(entryId)
		}
	}
	return entryId
}

// Root returns the entry ID of the root node of a search by starting
// from the global root node and moving left or right until it encounters the first node
// that falls within [start, treeSize).
func Root(start, treeSize uint64) uint64 {
	globalRoot := uint64((1 << sharedmath.Log2(treeSize)) - 1)
	return moveWithin(globalRoot, start, treeSize)
}

// Left traverses the left subtree of the given log entry ID until it encounters the first node
// that falls within [start, treeSize).
func Left(entryId, start, treeSize uint64) uint64 {
	return moveWithin(sharedmath.Left(entryId), start, treeSize)
}

// Right traverses the right subtree of the given log entry ID until it encounters the first node
// that falls within [start, treeSize).
func Right(entryId, start, treeSize uint64) uint64 {
	return moveWithin(sharedmath.RightStep(entryId), start, treeSize)
}

// directPath returns the direct path to the given log entry ID, starting from the leaf
// and going up to the shared root node that falls within [start, treeSize).
func directPath(entryId, start, treeSize uint64) []uint64 {
	rootId := Root(start, treeSize)
	if entryId == rootId {
		return []uint64{}
	}

	d := []uint64{}
	for entryId != rootId {
		entryId = sharedmath.Parent(entryId, treeSize)
		d = append(d, entryId)
	}
	return d
}

// MonitoringPath returns the list of parent nodes to be checked as part of
// monitoring an index. Specifically, these are nodes in the direct path to the given
// log entry ID that have a larger ID.
func MonitoringPath(entryId, start, treeSize uint64) []uint64 {
	var path []uint64

	for _, parent := range directPath(entryId, start, treeSize) {
		if parent > entryId {
			path = append(path, parent)
		}
	}

	return path
}

// monitoringFrontier takes in a map of entry IDs and returns the set of frontier nodes
// greater than all the given entry IDs, sorted in increasing order.
// Frontier nodes are the nodes that lie along the right edge of the implicit binary search tree, including the root.
func monitoringFrontier(entryIds map[uint64]struct{}, start, treeSize uint64) []uint64 {
	frontier := []uint64{Root(start, treeSize)}
	for frontier[len(frontier)-1] != treeSize-1 {
		frontier = append(frontier, Right(frontier[len(frontier)-1], start, treeSize))
	}

	// Return the frontier node IDs that are greater than all the ones in the entryIds map
	for i := len(frontier) - 1; i >= 0; i-- {
		if _, ok := entryIds[frontier[i]]; ok {
			return frontier[i+1:]
		}
	}
	panic("unreachable")
}

// FullMonitoringPath returns the full set of entry IDs that should be checked as
// part of monitoring an index.
func FullMonitoringPath(entryId uint64, start, treeSize uint64) []uint64 {
	var path []uint64
	dedup := make(map[uint64]struct{})

	for _, x := range MonitoringPath(entryId, start, treeSize) {
		if _, ok := dedup[x]; ok {
			continue
		}
		dedup[x] = struct{}{}

		path = append(path, x)
	}
	dedup[entryId] = struct{}{}

	for _, x := range monitoringFrontier(dedup, start, treeSize) {
		path = append(path, x)
	}

	return path
}
