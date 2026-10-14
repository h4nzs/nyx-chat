//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import "errors"

type memoryTransparencyStore struct {
	latest   *TransparencyTreeHead
	auditors map[string]*AuditorTreeHead
	top      map[uint64][]byte
	log      map[uint64][]byte
	prefix   map[uint64][]byte
}

func NewMemoryTransparencyStore() TransparencyStore {
	return &memoryTransparencyStore{
		latest:   &TransparencyTreeHead{},
		top:      make(map[uint64][]byte),
		log:      make(map[uint64][]byte),
		prefix:   make(map[uint64][]byte),
		auditors: make(map[string]*AuditorTreeHead),
	}
}

func (m *memoryTransparencyStore) Clone() TransparencyStore { panic("not implemented") }

func (m *memoryTransparencyStore) GetHead() (*TransparencyTreeHead, map[string]*AuditorTreeHead, error) {
	return m.latest, m.auditors, nil
}

func (m *memoryTransparencyStore) Get(key uint64) ([]byte, error) {
	return m.top[key], nil
}

func (m *memoryTransparencyStore) Put(key uint64, data []byte) {
	m.top[key] = data
}

func (m *memoryTransparencyStore) LogStore() LogStore {
	return &memoryLogStore{data: m.log}
}

func (m *memoryTransparencyStore) PrefixStore() PrefixStore {
	return &memoryPrefixStore{data: m.prefix}
}

func (m *memoryTransparencyStore) StreamStore() StreamStore { panic("not implemented") }

func (m *memoryTransparencyStore) Commit(head *TransparencyTreeHead, auditors map[string]*AuditorTreeHead) error {
	m.latest = head
	m.auditors = auditors
	return nil
}

type memoryLogStore struct {
	data map[uint64][]byte
}

func (m *memoryLogStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	out := make(map[uint64][]byte)

	for _, key := range keys {
		if d, ok := m.data[key]; ok {
			out[key] = d
		}
	}

	return out, nil
}

func (m *memoryLogStore) BatchPut(data map[uint64][]byte) {
	for key, d := range data {
		buf := make([]byte, len(d))
		copy(buf, d)
		m.data[key] = buf
	}
}

type memoryPrefixStore struct {
	data map[uint64][]byte
}

func (m *memoryPrefixStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	out := make(map[uint64][]byte)

	for _, key := range keys {
		value, ok := m.data[key]
		if !ok {
			return nil, errors.New("not found")
		}
		out[key] = value
	}

	return out, nil
}

func (m *memoryPrefixStore) GetCached(key uint64) []byte { return nil }

func (m *memoryPrefixStore) Put(key uint64, data []byte) {
	buf := make([]byte, len(data))
	copy(buf, data)
	m.data[key] = buf
}
