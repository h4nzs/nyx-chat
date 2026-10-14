//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package prefix

import (
	"bytes"
	"crypto/aes"
	"crypto/sha256"
	"encoding/binary"

	"github.com/signalapp/keytransparency/tree/prefix/pb"
)

// getBit gets the nth bit from the given byte slice and returns a bool indicating whether it is 1
func getBit(data []byte, bit int) bool {
	return (data[bit/8]>>(7-(bit%8)))&1 == 1
}

// combineCopaths is used for finding the full copath of a search.
func combineCopaths(primary, secondary []*pb.ParentNode) []*pb.ParentNode {
	if len(secondary) <= len(primary) {
		return primary
	}
	out := make([]*pb.ParentNode, len(secondary))
	copy(out[:len(primary)], primary)
	copy(out[len(primary):], secondary[len(primary):])
	return out
}

// computeSeed returns the "seed" for computing the stand-in values of an entry.
// Instead of choosing the seed randomly, it's computed by applying a pseudorandom permutation to a
// counter to save space in the database.
func computeSeed(aesKey []byte, ctr uint64) []byte {
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		panic(err)
	}

	buf := &bytes.Buffer{}
	if err := binary.Write(buf, binary.BigEndian, ctr); err != nil {
		panic(err)
	}
	data := make([]byte, block.BlockSize())
	copy(data[len(data)-buf.Len():], buf.Bytes())

	block.Encrypt(data, data)
	return data
}

func leafHash(index []byte, ctr uint32, firstUpdatePosition uint64) []byte {
	if len(index) != IndexLength {
		panic("index is wrong length")
	}

	h := sha256.New()
	if _, err := h.Write([]byte{0x00}); err != nil {
		panic(err)
	} else if _, err := h.Write(index); err != nil {
		panic(err)
	} else if err := binary.Write(h, binary.BigEndian, ctr); err != nil {
		panic(err)
	} else if err := binary.Write(h, binary.BigEndian, firstUpdatePosition); err != nil {
		panic(err)
	}
	return h.Sum(nil)
}

func parentHash(left, right []byte) []byte {
	if len(left) != 32 {
		panic("left hash is wrong length")
	} else if len(right) != 32 {
		panic("right hash is wrong length")
	}

	buf := make([]byte, 65)
	buf[0] = 0x01
	copy(buf[1:33], left)
	copy(buf[33:65], right)
	h := sha256.Sum256(buf)
	return h[:]
}

func standInHash(seed []byte, level int) []byte {
	if len(seed) != 16 {
		panic("seed is wrong length")
	} else if level < 0 || level > 255 {
		panic("level is out of bounds")
	}

	buf := make([]byte, 18)
	buf[0] = 0x02
	copy(buf[1:17], seed)
	buf[17] = byte(level)
	h := sha256.Sum256(buf)
	return h[:]
}

type cachedLogEntry struct {
	// The value that gets serialized and stored in a persistent data store.
	inner *pb.LogEntry

	// A 32-byte secret value passed in at startup and used to compute seed.
	aesKey []byte

	// The seed for generating stand-in hashes.
	seed []byte

	// The stand-in hashes for the prefix tree associated with this log entry,
	// where the value for level i is stored in index i-1.
	// We never calculate a stand-in hash for level 0 (the root node).
	standIns [256][]byte

	// The parent hashes for the prefix tree path associated with this log entry,
	// where the value at index i corresponds to the parent hash at level i.
	parents [256][]byte
}

// standIn returns the stand-in hash for the entry at the specified level.
func (c *cachedLogEntry) standIn(level int) []byte {
	if len(c.standIns[level-1]) > 0 {
		return c.standIns[level-1]
	} else if len(c.seed) == 0 {
		c.seed = computeSeed(c.aesKey, c.inner.FirstUpdatePosition)
	}
	c.standIns[level-1] = standInHash(c.seed, level-1)
	return c.standIns[level-1]
}

// getCopath returns the version of the copath that can be shown to a user.
func (c *cachedLogEntry) getCopath() [][]byte {
	out := make([][]byte, 0)

	for _, parent := range c.inner.Copath {
		out = append(out, parent.Hash)
	}
	for len(out) < 8*IndexLength {
		out = append(out, c.standIn(len(out)+1))
	}

	// Reverse slice.
	for i := 0; i < len(out)/2; i++ {
		out[i], out[len(out)-i-1] = out[len(out)-i-1], out[i]
	}
	return out
}

// hasLongCopath returns if this log entry has a copath longer than 32 entries.
func (c *cachedLogEntry) hasLongCopath() bool {
	return c.inner.Leaf != nil || len(c.inner.Copath) > 32
}

// precompute sets the Precomputed32 value in the inner log entry.
func (c *cachedLogEntry) precompute() {
	c.inner.Precomputed32 = nil
	if c.hasLongCopath() {
		c.inner.Precomputed32 = c.rollup(32)
	}
}

// rollup returns the hash at the specified level in the prefix tree of a log entry.
// The root is level 0 and leaves are level 256.
func (c *cachedLogEntry) rollup(level int) []byte {
	var (
		curr int
		acc  []byte
	)
	if level <= 32 && len(c.inner.Precomputed32) > 0 && c.hasLongCopath() {
		curr = 32
		acc = c.inner.Precomputed32
	} else if c.inner.Leaf != nil {
		curr = 8 * IndexLength
		acc = leafHash(c.inner.Index, c.inner.Leaf.Ctr, c.inner.FirstUpdatePosition)
	} else {
		curr = len(c.inner.Copath)
		acc = c.standIn(len(c.inner.Copath))
	}

	for curr > level {
		curr--

		if c.parents[curr] != nil {
			acc = c.parents[curr]
			continue
		}

		var temp []byte
		if curr < len(c.inner.Copath) {
			temp = c.inner.Copath[curr].Hash
		} else {
			temp = c.standIn(curr + 1)
		}
		if getBit(c.inner.Index, curr) {
			acc = parentHash(temp, acc)
		} else {
			acc = parentHash(acc, temp)
		}

		c.parents[curr] = acc
	}

	return acc
}
