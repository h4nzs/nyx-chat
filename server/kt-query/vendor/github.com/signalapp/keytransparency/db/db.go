//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

// Package db implements database wrappers that match a common interface.
package db

import consumer "github.com/harlow/kinesis-consumer"

// LogStore is the interface a log tree uses to communicate with its database.
type LogStore interface {
	BatchGet(keys []uint64) (data map[uint64][]byte, err error)
	BatchPut(data map[uint64][]byte)
}

// PrefixStore is the interface a prefix tree uses to communicate with its
// database.
type PrefixStore interface {
	BatchGet(keys []uint64) (data map[uint64][]byte, err error)
	// GetCached gets a value if and only if it's cached. If the requested value
	// is not cached, it returns nil.
	GetCached(key uint64) []byte

	Put(key uint64, data []byte)
}

// Account contains the account info necessary to verify a phone number search
type Account struct {
	DiscoverableByPhoneNumber bool   `dynamodbav:"C"`
	UnidentifiedAccessKey     []byte `dynamodbav:"UAK"`
}

type AccountDB interface {
	// GetAccountByAci returns the Account struct corresponding to the ACI, or nil if none exists
	GetAccountByAci(aci []byte) (*Account, error)
}

// storedTreeHead represents the key transparency service's signed transparency tree head, as well as
// any auditor-signed tree heads.
type storedTreeHead struct {
	TreeHead     *TransparencyTreeHead       `json:"head"`
	AuditorHeads map[string]*AuditorTreeHead `json:"auditor-heads,omitempty"`
}

// Signature represents the key transparency service's signature over the head of a transparency tree.
// The signed data includes the auditor public key, so the service generates one Signature for each auditor.
type Signature struct {
	Signature        []byte
	AuditorPublicKey []byte
}

// TransparencyTreeHead is used by the key transparency service to represent the signed head of a transparency tree.
type TransparencyTreeHead struct {
	TreeSize   uint64       `json:"n"`
	Timestamp  int64        `json:"ts"`
	Signatures []*Signature `json:"sigs"`
}

// AuditorTransparencyTreeHead is used by a third-party auditor to represent its signed view of the transparency tree.
type AuditorTransparencyTreeHead struct {
	TreeSize  uint64 `json:"n"`
	Timestamp int64  `json:"ts"`
	Signature []byte `json:"sig,omitempty"`
}

func (a *AuditorTransparencyTreeHead) Clone() *AuditorTransparencyTreeHead {
	if a == nil {
		return nil
	}

	return &AuditorTransparencyTreeHead{
		TreeSize:  a.TreeSize,
		Timestamp: a.Timestamp,
		Signature: dup(a.Signature),
	}
}

func (h *TransparencyTreeHead) Clone() *TransparencyTreeHead {
	if h == nil {
		return nil
	}
	return &TransparencyTreeHead{
		TreeSize:   h.TreeSize,
		Timestamp:  h.Timestamp,
		Signatures: cloneTransparencyTreeHeadSignatures(h.Signatures),
	}
}

func cloneTransparencyTreeHeadSignatures(original []*Signature) []*Signature {
	if original == nil {
		return nil
	}

	var clonedSignatures []*Signature
	for _, sig := range original {
		if sig == nil {
			continue
		}

		newSignature := &Signature{dup(sig.Signature), dup(sig.AuditorPublicKey)}
		clonedSignatures = append(clonedSignatures, newSignature)
	}
	return clonedSignatures
}

// AuditorTreeHead represents the signed head of a transparency tree, from a
// third-party auditor.
type AuditorTreeHead struct {
	AuditorTransparencyTreeHead
	RootValue   []byte   `json:"root"`
	Consistency [][]byte `json:"consistency"`
}

func (h *AuditorTreeHead) Clone() *AuditorTreeHead {
	if h == nil {
		return nil
	}
	var consistency [][]byte
	if h.Consistency != nil {
		consistency = make([][]byte, len(h.Consistency))
		for i, val := range h.Consistency {
			consistency[i] = dup(val)
		}
	}
	return &AuditorTreeHead{
		AuditorTransparencyTreeHead: *h.AuditorTransparencyTreeHead.Clone(),
		RootValue:                   dup(h.RootValue),
		Consistency:                 consistency,
	}
}

func cloneAuditorTreeHeadMap(original map[string]*AuditorTreeHead) map[string]*AuditorTreeHead {
	if original == nil {
		return nil
	}

	clonedAuditorTreeHeads := make(map[string]*AuditorTreeHead)
	for key, value := range original {
		clonedAuditorTreeHeads[key] = value.Clone()
	}
	return clonedAuditorTreeHeads
}

type StreamStore consumer.Store

// TransparencyStore is the interface a transparency tree uses to communicate
// with its database.
type TransparencyStore interface {
	// Clone returns a read-only clone of the current transparency store,
	// suitable for distributing to child goroutines.
	Clone() TransparencyStore

	// GetHead returns the most recent tree head, or the zero value of
	// TransparencyTreeHead if there hasn't been a signed head yet.
	// It also returns a map of auditor name to the corresponding most recently set auditor tree head.
	// The auditor map must not be nil if err is nil.
	GetHead() (*TransparencyTreeHead, map[string]*AuditorTreeHead, error)

	Get(key uint64) ([]byte, error)
	Put(key uint64, data []byte)

	LogStore() LogStore
	PrefixStore() PrefixStore
	StreamStore() StreamStore

	Commit(head *TransparencyTreeHead, auditors map[string]*AuditorTreeHead) error
}
