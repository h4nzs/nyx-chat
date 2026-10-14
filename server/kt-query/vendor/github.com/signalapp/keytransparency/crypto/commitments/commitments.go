// Copyright 2016 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package commitments implements a cryptographic commitment.
//
// Commitment scheme is as follows:
// T = HMAC(fixedKey, 16 byte nonce || message)
// message is defined as: len(searchKey) || searchKey || len(data) || data
package commitments

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

var (
	hashAlgo = sha256.New
	// key is publicly known random fixed key for use in the HMAC function.
	// This fixed key allows the commitment scheme to be modeled as a random oracle.
	fixedKey = []byte{0xd8, 0x21, 0xf8, 0x79, 0x0d, 0x97, 0x70, 0x97, 0x96, 0xb4, 0xd7, 0x90, 0x33, 0x57, 0xc3, 0xf5}
	// ErrInvalidCommitment occurs when the commitment doesn't match the profile.
	ErrInvalidCommitment = errors.New("invalid commitment")
	// ErrInvalidNonce occurs when the nonce is not 16 bytes.
	ErrInvalidNonce = errors.New("invalid nonce")
)

// Commit returns an HMAC over the provided search key, data, and nonce using the SHA256 algorithm.
// Returns an error if the length of the provided nonce is not 16.
func Commit(searchKey, data, nonce []byte) ([]byte, error) {
	if len(nonce) != 16 {
		return nil, ErrInvalidNonce
	}

	mac := hmac.New(hashAlgo, fixedKey)
	mac.Write(nonce)
	if len(searchKey) >= 1<<16 {
		panic("search key too large")
	}

	// An error is not possible from any of the following Write() calls:
	//   1. binary.Write() delegates to mac.Write()
	//   2. mac is a hash.Hash, which is documented as never returning an error from Write()
	_ = binary.Write(mac, binary.BigEndian, uint16(len(searchKey)))
	mac.Write(searchKey)
	if len(data) >= 1<<32 {
		panic("data too large")
	}
	_ = binary.Write(mac, binary.BigEndian, uint32(len(data)))
	mac.Write(data)

	return mac.Sum(nil), nil
}

func Verify(searchKey, commitment, data, nonce []byte) error {
	got, err := Commit(searchKey, data, nonce)
	if err != nil {
		return err
	}
	if !hmac.Equal(got, commitment) {
		return ErrInvalidCommitment
	}
	return nil
}
