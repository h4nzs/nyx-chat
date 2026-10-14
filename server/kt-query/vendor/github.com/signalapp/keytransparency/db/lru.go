//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import (
	"fmt"
	"sync/atomic"

	"github.com/hashicorp/go-metrics"
	lru "github.com/hashicorp/golang-lru/v2"
)

func countCacheHit(typ string, hit, clone bool) {
	lbls := []metrics.Label{
		{Name: "type", Value: typ},
		{Name: "write_path", Value: fmt.Sprint(!clone)},
	}
	var name []string
	if hit {
		name = []string{"lru", "cache_hit"}
	} else {
		name = []string{"lru", "cache_miss"}
	}
	metrics.IncrCounterWithLabels(name, 1, lbls)
}

const (
	TransparencyCache = 1 << iota
	LogCache
	PrefixCache
	HeadCache
)

type headPair struct {
	tree     *TransparencyTreeHead
	auditors map[string]*AuditorTreeHead
}

type cachedTransparencyStore struct {
	db    TransparencyStore
	clone bool

	head        *atomic.Value
	topCache    *lru.Cache[uint64, []byte]
	logCache    *lru.Cache[uint64, []byte]
	prefixCache *lru.Cache[uint64, []byte]
}

type Bitmask uint32

func NewCachedTransparencyStore(db TransparencyStore, cachesToEnable Bitmask, topCacheSize, logCacheSize, prefixCacheSize int) TransparencyStore {
	cache := &cachedTransparencyStore{db: db, clone: false}

	var err error
	if cachesToEnable&TransparencyCache != 0 {
		cache.topCache, err = lru.New[uint64, []byte](topCacheSize)
		if err != nil {
			panic(err)
		}
	}

	if cachesToEnable&LogCache != 0 {
		cache.logCache, err = lru.New[uint64, []byte](logCacheSize)
		if err != nil {
			panic(err)
		}
	}

	if cachesToEnable&PrefixCache != 0 {
		cache.prefixCache, err = lru.New[uint64, []byte](prefixCacheSize)
		if err != nil {
			panic(err)
		}
	}

	if cachesToEnable&HeadCache != 0 {
		cache.head = &atomic.Value{}
	}

	return cache
}

func (c *cachedTransparencyStore) Clone() TransparencyStore {
	return &cachedTransparencyStore{
		db:    c.db.Clone(),
		clone: true,

		head:        c.head,
		topCache:    c.topCache,
		logCache:    c.logCache,
		prefixCache: c.prefixCache,
	}
}

func (c *cachedTransparencyStore) GetHead() (*TransparencyTreeHead, map[string]*AuditorTreeHead, error) {
	if c.head != nil {
		if head, ok := c.head.Load().(headPair); ok {
			countCacheHit("head", true, c.clone)
			return head.tree.Clone(), cloneAuditorTreeHeadMap(head.auditors), nil
		}
		countCacheHit("head", false, c.clone)
	}

	head, auditors, err := c.db.GetHead()
	if err != nil {
		return nil, nil, err
	}

	if c.head != nil {
		c.head.Store(headPair{head.Clone(), cloneAuditorTreeHeadMap(auditors)})
	}

	return head, auditors, nil
}

func (c *cachedTransparencyStore) Get(key uint64) ([]byte, error) {
	if c.topCache != nil {
		if val, ok := c.topCache.Get(key); ok {
			countCacheHit("transparency", true, c.clone)
			return dup(val), nil
		}
		countCacheHit("transparency", false, c.clone)
	}

	val, err := c.db.Get(key)
	if err != nil {
		return nil, err
	}

	if c.topCache != nil {
		c.topCache.ContainsOrAdd(key, dup(val))
	}

	return val, nil
}

func (c *cachedTransparencyStore) Put(key uint64, data []byte) {
	if c.topCache != nil {
		c.topCache.Add(key, dup(data))
	}
	c.db.Put(key, data)
}

func (c *cachedTransparencyStore) LogStore() LogStore {
	return &cachedLogStore{
		db:    c.db.LogStore(),
		clone: c.clone,
		cache: c.logCache,
	}
}

func (c *cachedTransparencyStore) PrefixStore() PrefixStore {
	return &cachedPrefixStore{
		db:    c.db.PrefixStore(),
		clone: c.clone,
		cache: c.prefixCache,
	}
}

func (c *cachedTransparencyStore) StreamStore() StreamStore { return c.db.StreamStore() }

func (c *cachedTransparencyStore) Commit(head *TransparencyTreeHead, auditors map[string]*AuditorTreeHead) error {
	err := c.db.Commit(head, auditors)
	if err == nil && c.head != nil {
		c.head.Store(headPair{head.Clone(), cloneAuditorTreeHeadMap(auditors)})
	}
	return err
}

type cachedLogStore struct {
	db    LogStore
	clone bool
	cache *lru.Cache[uint64, []byte]
}

func (c *cachedLogStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	remaining := make([]uint64, 0)
	data := make(map[uint64][]byte)

	if c.cache != nil {
		for _, key := range keys {
			if val, ok := c.cache.Get(key); ok {
				countCacheHit("log", true, c.clone)
				data[key] = dup(val)
			} else {
				countCacheHit("log", false, c.clone)
				remaining = append(remaining, key)
			}
		}
	} else {
		remaining = keys
	}

	if len(remaining) > 0 {
		partial, err := c.db.BatchGet(remaining)
		if err != nil {
			return nil, err
		}

		var readonly bool
		switch ls := c.db.(type) {
		case *ldbLogStore:
			readonly = ls.conn.readonly
		case *ddbLogStore:
			readonly = ls.conn.readonly
		default:
			readonly = true
		}

		for key, val := range partial {
			// Only cache fully-formed trees, or trees from a write-enabled connection
			// because it does not allow concurrent reads and writes.
			cacheable := len(val) == 256 || !readonly
			if cacheable && c.cache != nil {
				c.cache.ContainsOrAdd(key, dup(val))
			}
			data[key] = val
		}
	}

	return data, nil
}

func (c *cachedLogStore) BatchPut(data map[uint64][]byte) {
	if c.cache != nil {
		for key, val := range data {
			c.cache.Add(key, dup(val))
		}
	}
	c.db.BatchPut(data)
}

type cachedPrefixStore struct {
	db    PrefixStore
	clone bool
	cache *lru.Cache[uint64, []byte]
}

func (c *cachedPrefixStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	remaining := make([]uint64, 0)
	data := make(map[uint64][]byte)

	if c.cache != nil {
		for _, key := range keys {
			if val, ok := c.cache.Get(key); ok {
				countCacheHit("prefix", true, c.clone)
				data[key] = dup(val)
			} else {
				countCacheHit("prefix", false, c.clone)
				remaining = append(remaining, key)
			}
		}
	} else {
		remaining = keys
	}

	if len(remaining) > 0 {
		partial, err := c.db.BatchGet(remaining)
		if err != nil {
			return nil, err
		}
		for key, val := range partial {
			if c.cache != nil {
				c.cache.ContainsOrAdd(key, dup(val))
			}
			data[key] = val
		}
	}

	return data, nil
}

func (c *cachedPrefixStore) GetCached(key uint64) []byte {
	if c.cache != nil {
		if val, ok := c.cache.Get(key); ok {
			countCacheHit("prefix", true, c.clone)
			return dup(val)
		}
		countCacheHit("prefix", false, c.clone)
	}

	return c.db.GetCached(key)
}

func (c *cachedPrefixStore) Put(key uint64, data []byte) {
	if c.cache != nil {
		c.cache.Add(key, dup(data))
	}
	c.db.Put(key, data)
}
