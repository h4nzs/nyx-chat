//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package log

import (
	"fmt"
	"slices"

	"github.com/signalapp/keytransparency/tree/log/math"
	"github.com/signalapp/keytransparency/tree/sharedmath"
)

// The log tree implementation is designed to work with a standard key-value
// database. The tree is stored in the database in "chunks", which are
// 8-node-wide (or 4-node-deep) subtrees. Chunks are addressed by the id of the
// root node in the chunk. Only the leaf values of each chunk are stored, which
// in the context of the full tree is either a leaf or a cached intermediate
// hash. These values are stored concatenated.

// nodeData is the primary wrapper struct for representing a single node (leaf
// or intermediate) in the tree.
type nodeData struct {
	leaf  bool
	value []byte
}

// validate checks that value is the expected length
func (nd *nodeData) validate() error {
	if len(nd.value) != 32 {
		return fmt.Errorf("node value is wrong length: %v", len(nd.value))
	}
	return nil
}

// marshal returns a slice with the node's value for hashing
func (nd *nodeData) marshal() []byte {
	out := make([]byte, 33)
	if !nd.leaf {
		out[0] = 1
	}
	copy(out[1:33], nd.value)
	return out
}

func (nd *nodeData) isEmpty() bool {
	return nd.value == nil
}

// nodeChunk is a helper struct that handles computing/caching the intermediate
// nodes of a chunk.
type nodeChunk struct {
	ids   []uint64
	nodes []*nodeData
}

func newChunk(chunkRootNodeId uint64, data []byte) (*nodeChunk, error) {
	// Create a map that shows the node id represented by each element of the
	// nodes array. This code is a little bit verbose, but I like that it's easy
	// to check it's correct: run with id = 7 and the output is [0, 1, ..., 14].
	ids := make([]uint64, 15)
	ids[7] = chunkRootNodeId
	ids[3] = sharedmath.Left(ids[7])
	ids[1] = sharedmath.Left(ids[3])
	ids[0] = sharedmath.Left(ids[1])
	ids[2] = sharedmath.RightStep(ids[1])
	ids[5] = sharedmath.RightStep(ids[3])
	ids[4] = sharedmath.Left(ids[5])
	ids[6] = sharedmath.RightStep(ids[5])
	ids[11] = sharedmath.RightStep(ids[7])
	ids[9] = sharedmath.Left(ids[11])
	ids[8] = sharedmath.Left(ids[9])
	ids[10] = sharedmath.RightStep(ids[9])
	ids[13] = sharedmath.RightStep(ids[11])
	ids[12] = sharedmath.Left(ids[13])
	ids[14] = sharedmath.RightStep(ids[13])

	// Parse the serialized data.
	leafChunk := sharedmath.Level(chunkRootNodeId) == 3
	nodes := make([]*nodeData, 0, 15)

	for len(data) > 0 {
		if len(data) < 32 {
			return nil, fmt.Errorf("unable to parse chunk")
		}
		if len(nodes) > 0 {
			nodes = append(nodes, &nodeData{leaf: false, value: nil})
		}
		nodes = append(nodes, &nodeData{
			leaf:  leafChunk,
			value: data[:32],
		})
		data = data[32:]
	}
	for len(nodes) < 15 {
		// if the chunk is not full, initialize remainder with stub data
		nodes = append(nodes, &nodeData{
			leaf:  sharedmath.IsLeaf(ids[len(nodes)]),
			value: nil,
		})
	}
	if len(nodes) != 15 {
		return nil, fmt.Errorf("unable to parse chunk")
	}

	return &nodeChunk{ids: ids, nodes: nodes}, nil
}

// findIndex returns the index of the node ID in the chunk's ids slice
func (c *nodeChunk) findIndex(nodeId uint64) uint64 {
	// Since c.ids is sorted in increasing order, we can just BinarySearch it.
	// This should be a little faster than iterating over IDs.
	if n, found := slices.BinarySearch(c.ids, nodeId); found {
		return uint64(n)
	}
	panic("requested hash not available in this chunk")
}

// get returns the data of nodeId with the value populated.
func (c *nodeChunk) get(nodeId, numLeaves uint64, set *chunkSet) *nodeData {
	i := c.findIndex(nodeId)
	if !sharedmath.IsLeaf(nodeId) && c.nodes[i].isEmpty() {
		l, r := sharedmath.Left(nodeId), math.Right(nodeId, numLeaves)
		c.nodes[i].value = treeHash(set.get(l), set.get(r))
	}
	return c.nodes[i]
}

// set updates nodeId to contain the given value and, if necessary, nullifies the values stored by its parent nodes
func (c *nodeChunk) set(nodeId uint64, value []byte) {
	nd := &nodeData{
		leaf:  sharedmath.IsLeaf(nodeId),
		value: value,
	}

	i := c.findIndex(nodeId)
	c.nodes[i] = nd
	for i != 7 {
		i = sharedmath.ParentStep(i)
		c.nodes[i].value = nil
	}
}

// marshal returns the serialized chunk.
func (c *nodeChunk) marshal() []byte {
	out := make([]byte, 0)

	for i := 0; i < len(c.nodes); i += 2 { // += 2 because only leaves get serialized

		if c.nodes[i].isEmpty() {
			// We've reached an empty leaf. Because this is a left-balanced tree, the remaining leaves must also be
			// empty, so check that there are no other populated nodes.
			for ; i < len(c.nodes); i++ {
				if !c.nodes[i].isEmpty() {
					panic("chunk has gaps")
				}
			}

			// The invariant is true, and there's nothing left to write, so we can exit now
			break
		}

		out = append(out, c.nodes[i].value...)
	}

	return out
}

// chunkSet is a helper struct for directing operations to the correct nodeChunk
// in a set.
type chunkSet struct {
	numLeaves uint64 // The number of leaves in the log tree when this chunk set was initialized
	chunks    map[uint64]*nodeChunk
	modified  map[uint64]struct{} // tracks all chunkIds that have been modified and need to be persisted
}

// newChunkSet creates a new chunkSet from a raw LogStore.BatchGet() response. numLeaves is the number of leaves in
// the *full* tree. Each []byte slice in data is the concatenated data for the nodes in that chunk.
func newChunkSet(numLeaves uint64, data map[uint64][]byte) (*chunkSet, error) {
	chunks := make(map[uint64]*nodeChunk, len(data))
	for id, raw := range data {
		c, err := newChunk(id, raw)
		if err != nil {
			return nil, err
		}
		chunks[id] = c
	}

	return &chunkSet{
		numLeaves: numLeaves,
		chunks:    chunks,
		modified:  make(map[uint64]struct{}),
	}, nil
}

// get returns node x.
func (s *chunkSet) get(nodeId uint64) *nodeData {
	c, ok := s.chunks[math.Chunk(nodeId)]
	if !ok {
		panic("requested hash is not available in this chunk set")
	}
	return c.get(nodeId, s.numLeaves, s)
}

// add initializes a new empty chunk for node x.
func (s *chunkSet) add(nodeId uint64) {
	chunkId := math.Chunk(nodeId)
	if _, ok := s.chunks[chunkId]; ok {
		panic("cannot add chunk that already exists in set")
	}
	c, err := newChunk(chunkId, make([]byte, 0))
	if err != nil {
		panic(err)
	}
	s.chunks[chunkId] = c
}

// set changes node to the given value.
func (s *chunkSet) set(nodeId uint64, value []byte) {
	chunkId := math.Chunk(nodeId)
	c, ok := s.chunks[chunkId]
	if !ok {
		panic("requested hash is not available in this chunk set")
	}
	c.set(nodeId, value)
	s.modified[chunkId] = struct{}{}
}

// marshalChanges returns the set of changes that have been done on this chunkSet
// since its creation, for persisting back in our storage medium.
func (s *chunkSet) marshalChanges() map[uint64][]byte {
	out := make(map[uint64][]byte, 0)
	for id := range s.modified {
		out[id] = s.chunks[id].marshal()
	}
	return out
}
