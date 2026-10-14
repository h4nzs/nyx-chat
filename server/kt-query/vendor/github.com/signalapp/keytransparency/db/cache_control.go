//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import (
	"bytes"
	"fmt"

	"github.com/hashicorp/go-metrics"
)

func countPrefixCacheControlHit(hit bool) {
	lbls := []metrics.Label{{Name: "cache_hit", Value: fmt.Sprint(hit)}}
	metrics.IncrCounterWithLabels([]string{"prefix_cache_control"}, 1, lbls)
}

// PrefixCacheControl is used to minimize database requests during update operations
// by fetching and caching the necessary prefix tree data beforehand.
// Blocking the update critical path on network requests to the database can significantly degrade performance.
// This cache is separate from the LRU cache because the LRU cache can end up evicting data needed for the update prematurely.
type PrefixCacheControl struct {
	db PrefixStore

	tracking bool
	data     map[uint64][]byte
}

func NewPrefixCacheControl(db PrefixStore) *PrefixCacheControl {
	return &PrefixCacheControl{db: db}
}

// StartTracking begins keeping a copy of all data fetched.
func (p *PrefixCacheControl) StartTracking() {
	p.tracking = true
	p.data = make(map[uint64][]byte)
}

// StopTracking stops keeping copies of data fetched and clears the data stored.
func (p *PrefixCacheControl) StopTracking() {
	p.tracking = false
	p.data = nil
}

// ExportCache returns the set of database entries cached.
func (p *PrefixCacheControl) ExportCache() map[uint64][]byte {
	return p.data
}

// ImportCache adds a set of cached database lookups to the current store's
// cache.
func (p *PrefixCacheControl) ImportCache(data map[uint64][]byte) error {
	if p.data == nil {
		p.data = make(map[uint64][]byte)
	}
	for key, val := range data {
		if existing, ok := p.data[key]; ok {
			if !bytes.Equal(val, existing) {
				return fmt.Errorf("different values found for the same prefix tree key: %v", key)
			}
		} else {
			p.data[key] = val
		}
	}
	return nil
}

// BatchGet fetches a batch of keys by first checking the cache and then the underlying datastore.
func (p *PrefixCacheControl) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	remaining := make([]uint64, 0)
	data := make(map[uint64][]byte)

	for _, key := range keys {
		if val, ok := p.data[key]; ok {
			countPrefixCacheControlHit(true)
			data[key] = dup(val)
		} else {
			countPrefixCacheControlHit(false)
			remaining = append(remaining, key)
		}
	}

	if len(remaining) > 0 {
		partial, err := p.db.BatchGet(remaining)
		if err != nil {
			return nil, err
		}
		for key, val := range partial {
			if p.tracking {
				p.data[key] = dup(val)
			}
			data[key] = val
		}
	}

	return data, nil
}

func (p *PrefixCacheControl) GetCached(key uint64) []byte {
	if val, ok := p.data[key]; ok {
		countPrefixCacheControlHit(true)
		return dup(val)
	}
	countPrefixCacheControlHit(false)
	val := p.db.GetCached(key)
	if val != nil && p.tracking {
		p.data[key] = dup(val)
	}
	return val
}

// Put stores the given key-value pair in the underlying datastore and caches it if tracking is enabled.
func (p *PrefixCacheControl) Put(key uint64, val []byte) {
	if p.tracking {
		p.data[key] = dup(val)
	} else if _, ok := p.data[key]; ok {
		p.data[key] = dup(val)
	}
	p.db.Put(key, val)
}
