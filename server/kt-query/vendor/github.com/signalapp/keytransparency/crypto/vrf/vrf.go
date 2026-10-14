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

// Package vrf defines the interface to a verifiable random function.
package vrf

import (
	"crypto"
)

// PrivateKey supports evaluating the VRF function.
type PrivateKey interface {
	// ECVRFProve returns the output of H(f_k(m)) and its proof.
	ECVRFProve(m []byte) (index [32]byte, proof []byte)
	// Public returns the corresponding public key.
	Public() crypto.PublicKey
}

// PublicKey supports verifying output from the VRF function.
type PublicKey interface {
	// ECVRFVerify verifies the NP-proof supplied by Proof and outputs Index.
	ECVRFVerify(m, proof []byte) (index [32]byte, err error)
}
