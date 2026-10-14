//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package prefix

import (
	"bytes"
	"errors"
	"fmt"
	"slices"

	"google.golang.org/protobuf/proto"

	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/prefix/pb"
)

type failedSearch struct {
	copath []*pb.ParentNode
	// The first log position of the index
	// that created the stand-in hash at the prefix tree level
	// where the search hit a dead end.
	firstUpdatePosition uint64
}

// Search is a single, in-progress search for a commitment index in the prefix tree. It can
// be batched with several other searches to use fewer database lookups.
type Search struct {
	index      []byte
	ptr        uint64
	commitment []byte
	copath     []*pb.ParentNode
}

func (s *Search) start() uint64 { return s.ptr }

// step executes the next step in a search.  It returns one of:
//   - uint64: This search is not complete; continue by looking at the given ID next.
//   - *cachedLogEntry: Reached the final step in the search, and found this entry.
//   - *failedSearch: Reached the final step in the search, and found nothing.
func (s *Search) step(trace bool, cached *cachedLogEntry) interface{} {
	entry := cached.inner

	// If this is the first entry we've looked up, and it has a commitment value,
	// save that value for later in case this search is being conducted for SearchProof generation.
	if len(s.copath) == 0 && entry.Leaf != nil {
		s.commitment = entry.Leaf.Commitment
	}

	// If this is not a fake entry, which would have a nil Leaf, and the index we're
	// searching for equals the index stored at this entry, then we're at the final step
	// of our search. Construct the finished LogEntry and return.
	if entry.Leaf != nil && bytes.Equal(entry.Index, s.index) {
		return &cachedLogEntry{
			inner: &pb.LogEntry{
				Index:               entry.Index,
				Copath:              combineCopaths(s.copath, entry.Copath),
				FirstUpdatePosition: entry.FirstUpdatePosition,
				Leaf: &pb.LeafNode{
					Ctr:        entry.Leaf.Ctr,
					Commitment: s.commitment,
				},
			},
			aesKey: cached.aesKey,

			seed:     cached.seed,
			standIns: cached.standIns,
		}
	}

	// This is not the final step of our search. Take as many steps as we
	// can with this log entry before finding the next one to load.
	for {
		if len(s.copath) < len(entry.Copath) {
			parent := entry.Copath[len(s.copath)]

			if getBit(entry.Index, len(s.copath)) == getBit(s.index, len(s.copath)) {
				s.copath = append(s.copath, parent)
			} else {
				var hash []byte
				if !trace {
					hash = cached.rollup(len(s.copath) + 1)
				}
				ptr2 := s.ptr
				s.copath = append(s.copath, &pb.ParentNode{Hash: hash, Ptr: &ptr2})
				if parent.Ptr == nil {
					// The search reached a dead end because this node
					// is a stand-in hash. Return the copath we've built and the
					// log position when this stand-in hash was created.
					// The position is provided in auditor proofs to recompute the stand-in hash value.
					return &failedSearch{copath: s.copath, firstUpdatePosition: *parent.FirstUpdatePosition}
				}
				s.ptr = *parent.Ptr
				return s.ptr
			}
		} else if entry.Leaf == nil {
			// This is a fake log entry and there are no more copath entries
			// to consider recursing into.
			return &failedSearch{copath: s.copath, firstUpdatePosition: entry.FirstUpdatePosition}
		} else if getBit(entry.Index, len(s.copath)) == getBit(s.index, len(s.copath)) {
			// The index that we're searching for doesn't exist, but shares
			// a prefix of len(s.copath)+1 with an existing index,
			// so we need to add the existing index's stand-in value at that level to our copath.
			var hash []byte
			if !trace {
				hash = cached.standIn(len(s.copath) + 1)
			}
			firstUpdatePosition := entry.FirstUpdatePosition
			parent := &pb.ParentNode{Hash: hash, FirstUpdatePosition: &firstUpdatePosition}
			s.copath = append(s.copath, parent)
		} else {
			var hash []byte
			if !trace {
				hash = cached.rollup(len(s.copath) + 1)
			}
			ptr2 := s.ptr
			s.copath = append(s.copath, &pb.ParentNode{Hash: hash, Ptr: &ptr2})
			// entry.firstUpdatePosition is the value needed to recompute the stand-in hash
			// at the level where the search terminated
			return &failedSearch{copath: s.copath, firstUpdatePosition: entry.FirstUpdatePosition}
		}
	}
}

func dedupValues(m map[int]uint64) []uint64 {
	dedup := make(map[uint64]struct{})
	for _, v := range m {
		dedup[v] = struct{}{}
	}
	out := make([]uint64, 0)
	for v := range dedup {
		out = append(out, v)
	}
	slices.Sort(out)
	return out
}

// searchBatch combines several Search structures together, so they can be
// executed in batch.
type searchBatch struct {
	aesKey   []byte
	tx       db.PrefixStore
	searches []*Search
}

func newSearchBatch(aesKey []byte, tx db.PrefixStore, searches []*Search) *searchBatch {
	return &searchBatch{
		aesKey:   aesKey,
		tx:       tx,
		searches: searches,
	}
}

// exec progresses the search batch with as few database lookups as possible and
// returns the set of results.
// Returns a list of final positions of each search and a list of results,
// where a result is either
//   - *cachedLogEntry
//   - *failedSearch
func (sb *searchBatch) exec(trace bool) ([]uint64, []interface{}, error) {
	requested := make(map[int]uint64)
	for i, search := range sb.searches { // Find the starting position of each search.
		requested[i] = search.start()
	}

	var (
		pos     = make([]uint64, len(sb.searches))      // List of the final position of each search.
		results = make([]interface{}, len(sb.searches)) // List of results compiled.
		cache   = make(map[uint64]*cachedLogEntry)
	)
	for {
		if len(requested) == 0 {
			return pos, results, nil
		}

		// Try to advance the search with only cached entries.
		usedCache := false
		for i, id := range requested {
			entry := cache[id]
			if entry == nil {
				// Check if an unparsed version is in the database cache.
				raw := sb.tx.GetCached(id)
				if raw == nil {
					continue
				}
				temp := &pb.LogEntry{}
				if err := proto.Unmarshal(raw, temp); err != nil {
					return nil, nil, fmt.Errorf("parsing cached raw LogEntry: %w", err)
				}
				entry = &cachedLogEntry{inner: temp, aesKey: sb.aesKey}
				cache[id] = entry
			}

			// Advance search.
			res := sb.searches[i].step(trace, entry)
			if newId, ok := res.(uint64); ok {
				requested[i] = newId
			} else { // We got a final result.
				delete(requested, i)
				pos[i], results[i] = id, res
			}

			usedCache = true
		}
		if usedCache {
			continue
		}

		// None of the searches can be progressed with cache data. Make the next
		// batch database lookup.
		data, err := sb.tx.BatchGet(dedupValues(requested))
		if err != nil {
			return nil, nil, err
		}
		for i, id := range requested {
			entry := cache[id]
			if entry == nil { // Parse raw log entry if necessary.
				raw, ok := data[id]
				if !ok {
					return nil, nil, errors.New("not all requested data was provided")
				}
				temp := &pb.LogEntry{}
				if err := proto.Unmarshal(raw, temp); err != nil {
					return nil, nil, fmt.Errorf("unmarshal of requested LogEntry: %w", err)
				}
				entry = &cachedLogEntry{inner: temp, aesKey: sb.aesKey}
				cache[id] = entry
			}

			// Advance search.
			res := sb.searches[i].step(trace, entry)
			if newId, ok := res.(uint64); ok {
				requested[i] = newId
			} else { // We got a final result.
				delete(requested, i)
				pos[i], results[i] = id, res
			}
		}
	}
}
