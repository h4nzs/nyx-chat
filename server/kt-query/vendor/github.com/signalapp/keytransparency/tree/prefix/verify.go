//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package prefix

import (
	"bytes"
	"errors"
	"fmt"
)

func evaluateProof(index, value []byte, proof [][]byte) ([]byte, error) {
	if len(proof) != 8*IndexLength {
		return nil, errors.New("proof is malformed")
	}
	for i := 0; i < len(proof); i++ {
		n := len(proof) - i - 1
		b := index[n/8] >> (7 - (n % 8)) & 1

		if len(proof[i]) != 32 {
			return nil, errors.New("proof is malformed")
		}
		if b == 0 {
			value = parentHash(value, proof[i])
		} else {
			value = parentHash(proof[i], value)
		}
	}

	return value, nil
}

// Evaluate takes a search result `res` as input, which was returned by
// searching for `index`, and returns the root that would make the proof valid.
// `pos` is the position of the first instance of `index` in the log.
func Evaluate(index []byte, pos uint64, res *SearchResult) ([]byte, error) {
	if len(index) != IndexLength {
		return nil, fmt.Errorf("index length must be %v bytes", IndexLength)
	}
	leaf := leafHash(index, res.Counter, pos)
	return evaluateProof(index, leaf, res.Proof)
}

// Verify takes a search result `res` as input, which was returned by searching
// for `index` in a tree with root `root`, and returns an error if it's invalid.
func Verify(root, index []byte, pos uint64, res *SearchResult) error {
	if len(root) != 32 {
		return errors.New("root length must be 32 bytes")
	}
	cand, err := Evaluate(index, pos, res)
	if err != nil {
		return err
	} else if !bytes.Equal(root, cand) {
		return errors.New("root does not match proof")
	}
	return nil
}
