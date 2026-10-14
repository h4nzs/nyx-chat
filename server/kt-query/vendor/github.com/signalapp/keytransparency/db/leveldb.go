//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import (
	"encoding/json"
	"fmt"

	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/errors"
)

// ldbConn is a wrapper around a base LevelDB database that handles batching
// writes between commits transparently.
//
// In this service, it is intended to be used for local development.
type ldbConn struct {
	conn     *leveldb.DB
	readonly bool
	batch    map[string][]byte
}

func newLDBConn(conn *leveldb.DB) *ldbConn {
	return &ldbConn{conn, false, make(map[string][]byte)}
}

func (c *ldbConn) Get(key string) ([]byte, error) {
	if value, ok := c.batch[key]; ok {
		return dup(value), nil
	}
	return c.conn.Get([]byte(key), nil)
}

func (c *ldbConn) Put(key string, value []byte) {
	if c.readonly {
		panic("connection is readonly")
	}
	c.batch[key] = dup(value)
}

func (c *ldbConn) Commit() error {
	if c.readonly {
		panic("connection is readonly")
	}

	defer func() {
		c.batch = make(map[string][]byte)
	}()

	b := new(leveldb.Batch)
	for key, value := range c.batch {
		if key == "root" {
			continue
		}
		b.Put([]byte(key), value)
	}
	if err := c.conn.Write(b, nil); err != nil {
		return err
	}
	if value, ok := c.batch["root"]; ok {
		if err := c.conn.Put([]byte("root"), value, nil); err != nil {
			return err
		}
	}

	return nil
}

// ldbTransparencyStore implements the TransparencyStore interface over a
// LevelDB database.
type ldbTransparencyStore struct {
	conn *ldbConn
}

func NewLDBTransparencyStore(file string) (TransparencyStore, error) {
	conn, err := leveldb.OpenFile(file, nil)
	if errors.IsCorrupted(err) {
		conn, err = leveldb.RecoverFile(file, nil)
	}
	if err != nil {
		return nil, err
	}
	return &ldbTransparencyStore{newLDBConn(conn)}, nil
}

func (ldb *ldbTransparencyStore) Clone() TransparencyStore {
	return &ldbTransparencyStore{&ldbConn{ldb.conn.conn, true, nil}}
}

func (ldb *ldbTransparencyStore) GetHead() (*TransparencyTreeHead, map[string]*AuditorTreeHead, error) {
	latest, err := ldb.conn.Get("root")
	if err == leveldb.ErrNotFound {
		return &TransparencyTreeHead{}, make(map[string]*AuditorTreeHead), nil
	} else if err != nil {
		return nil, nil, err
	}
	return deserializeStoredTreeHead(latest)
}

func (ldb *ldbTransparencyStore) Get(key uint64) ([]byte, error) {
	return ldb.conn.Get("t" + fmt.Sprint(key))
}

func (ldb *ldbTransparencyStore) Put(key uint64, data []byte) {
	ldb.conn.Put("t"+fmt.Sprint(key), data)
}

func (ldb *ldbTransparencyStore) LogStore() LogStore {
	return &ldbLogStore{ldb.conn}
}

func (ldb *ldbTransparencyStore) PrefixStore() PrefixStore {
	return &ldbPrefixStore{ldb.conn}
}

func (ldb *ldbTransparencyStore) StreamStore() StreamStore {
	return &ldbStreamStore{ldb.conn.conn}
}

func (ldb *ldbTransparencyStore) Commit(head *TransparencyTreeHead, auditors map[string]*AuditorTreeHead) error {
	raw, err := json.Marshal(&storedTreeHead{head, auditors})
	if err != nil {
		panic(err)
	}
	ldb.conn.Put("root", raw)
	return ldb.conn.Commit()
}

// ldbLogStore implements the LogStore interface over LevelDB.
type ldbLogStore struct {
	conn *ldbConn
}

func (ls *ldbLogStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	out := make(map[uint64][]byte)

	for _, key := range keys {
		value, err := ls.conn.Get("l" + fmt.Sprint(key))
		if err == leveldb.ErrNotFound {
			continue
		} else if err != nil {
			return nil, err
		}
		out[key] = value
	}

	return out, nil
}

func (ls *ldbLogStore) BatchPut(data map[uint64][]byte) {
	for key, value := range data {
		ls.conn.Put("l"+fmt.Sprint(key), value)
	}
}

// ldbPrefixStore implements the PrefixStore interface over LevelDB.
type ldbPrefixStore struct {
	conn *ldbConn
}

func (ps *ldbPrefixStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	out := make(map[uint64][]byte)

	for _, key := range keys {
		value, err := ps.conn.Get("p" + fmt.Sprint(key))
		if err != nil {
			return nil, err
		}
		out[key] = value
	}

	return out, nil
}

func (ps *ldbPrefixStore) GetCached(key uint64) []byte {
	if value, ok := ps.conn.batch["p"+fmt.Sprint(key)]; ok {
		return dup(value)
	}
	return nil
}

func (ps *ldbPrefixStore) Put(key uint64, data []byte) {
	ps.conn.Put("p"+fmt.Sprint(key), data)
}

// ldbStreamStore implements the StreamStore interface over LevelDB.
type ldbStreamStore struct {
	conn *leveldb.DB
}

func (ss *ldbStreamStore) key(streamName, shardID string) []byte {
	return []byte(fmt.Sprintf("stream=%v,shardID=%v", streamName, shardID))
}

func (ss *ldbStreamStore) GetCheckpoint(streamName, shardID string) (string, error) {
	val, err := ss.conn.Get(ss.key(streamName, shardID), nil)
	if err == leveldb.ErrNotFound {
		return "", nil
	} else if err != nil {
		return "", err
	}
	return string(val), nil
}

func (ss *ldbStreamStore) SetCheckpoint(streamName, shardID, sequenceNumber string) error {
	return ss.conn.Put(ss.key(streamName, shardID), []byte(sequenceNumber), nil)
}
