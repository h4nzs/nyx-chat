//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

// Package ed25519 implements ECVRF-EDWARDS25519-SHA512-TAI from RFC 9381 (https://www.ietf.org/rfc/rfc9381.html).
package ed25519

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"errors"
	"slices"

	"filippo.io/edwards25519"

	"github.com/signalapp/keytransparency/crypto/vrf"
)

var (
	ed25519IdentityPoint = edwards25519.NewIdentityPoint()

	hashAlgo = sha512.New

	// ErrInvalidPrivateKey occurs when a private key is the wrong size.
	ErrInvalidPrivateKey = errors.New("invalid private key")
	// ErrInvalidPublicKey occurs when a public key is the wrong size or has low order
	ErrInvalidPublicKey = errors.New("invalid public key")
	// ErrInvalidVRF occurs when the VRF does not validate.
	ErrInvalidVRF = errors.New("invalid VRF proof")
)

// PublicKey holds a public VRF key.
type PublicKey struct {
	inner ed25519.PublicKey
}

// PrivateKey holds a private VRF key.
type PrivateKey struct {
	inner []byte
}

// GenerateKey generates a fresh keypair for this VRF.
func GenerateKey() (vrf.PrivateKey, vrf.PublicKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil
	}
	return &PrivateKey{inner: priv.Seed()}, &PublicKey{inner: pub}
}

func encodeToCurve(salt, data []byte) (p *edwards25519.Point) {
	h := hashAlgo()
	for i := 0; i < 100; {
		h.Reset()
		h.Write([]byte{0x03, 0x01})
		h.Write(salt)
		h.Write(data)
		h.Write([]byte{byte(i), 0x00})

		r := h.Sum(nil)
		p = interpretHashValueAsPoint(r[:32])
		if p != nil {
			p.MultByCofactor(p)
			// Check that we're not returning the identity point
			if ed25519IdentityPoint.Equal(p) != 1 {
				return
			}
		}
		i++
	}
	// This is practically unreachable
	panic("No curve point found")
}

// interpretHashValueAsPoint checks if a 32-byte hash can be interpreted as a point on the edwards 25519 curve
// as defined in [Section 5.1.3 of RFC8032](https://www.rfc-editor.org/rfc/rfc8032#section-5.1.3)
// and returns that point if so.
func interpretHashValueAsPoint(hash []byte) *edwards25519.Point {
	// Validate that the hash is 32 bytes
	if len(hash) != 32 {
		return nil
	}

	// If the input bytes are such that bytes 1 to 30 have value 255, byte 31 has value 255 or 127,
	// and byte 0 has value 255 - i for value i in the (0, 2, 3, 4, 8, 9, 12, 13, 14, 15) list, then
	// the encoding is invalid.
	invalidBytes1To30 := true
	for _, b := range hash[1:31] {
		if b != 255 {
			invalidBytes1To30 = false
			break
		}
	}

	invalidByte31 := hash[31] == 255 || hash[31] == 127

	set := []uint8{0, 2, 3, 4, 8, 9, 12, 13, 14, 15}
	invalidByte0 := slices.Contains(set, 255-hash[0])

	if invalidByte0 && invalidBytes1To30 && invalidByte31 {
		return nil
	}

	// the only error is if len(hash) != 32, which we validate above, so it is safe to ignore
	p, _ := new(edwards25519.Point).SetBytes(hash)
	return p
}

func generateNonce(x, data []byte) *edwards25519.Scalar {
	h := hashAlgo()
	h.Write(x)
	h.Write(data)
	kStr := h.Sum(nil)

	k, err := new(edwards25519.Scalar).SetUniformBytes(kStr)
	if err != nil {
		panic(err)
	}
	return k
}

func generateChallenge(p1, p2, p3, p4, p5 []byte) []byte {
	h := hashAlgo()
	h.Write([]byte{0x03, 0x02})
	h.Write(p1)
	h.Write(p2)
	h.Write(p3)
	h.Write(p4)
	h.Write(p5)
	h.Write([]byte{0x00})
	cStr := h.Sum(nil)

	return cStr[:16]
}

func proofToHash(Gamma *edwards25519.Point) [32]byte {
	h := hashAlgo()
	h.Write([]byte{0x03, 0x03})
	h.Write(new(edwards25519.Point).MultByCofactor(Gamma).Bytes())
	h.Write([]byte{0x00})

	index := [32]byte{}
	copy(index[:], h.Sum(nil))
	return index
}

// ECVRFProve returns the verifiable random function evaluated at m
func (k PrivateKey) ECVRFProve(m []byte) (index [32]byte, proof []byte) {
	h := hashAlgo()
	h.Write(k.inner)
	hashedSk := h.Sum(nil)
	x, err := new(edwards25519.Scalar).SetBytesWithClamping(hashedSk[:32])
	if err != nil {
		panic(err)
	}
	Y := k.Public().([]byte)

	H := encodeToCurve(Y, m)
	hStr := H.Bytes()

	Gamma := new(edwards25519.Point).ScalarMult(x, H)
	gammaStr := Gamma.Bytes()

	nonce := generateNonce(hashedSk[32:], hStr)
	kB := new(edwards25519.Point).ScalarBaseMult(nonce)
	kH := new(edwards25519.Point).ScalarMult(nonce, H)
	cStr := generateChallenge(Y, hStr, gammaStr, kB.Bytes(), kH.Bytes())

	c, err := new(edwards25519.Scalar).SetCanonicalBytes(append(cStr, make([]byte, 16)...))
	if err != nil {
		panic(err)
	}
	s := new(edwards25519.Scalar).MultiplyAdd(c, x, nonce)

	proof = append(append(gammaStr, cStr...), s.Bytes()...)

	return proofToHash(Gamma), proof
}

// ECVRFVerify checks that proof is correct for m and outputs index. It only supports key validation.
func (pk PublicKey) ECVRFVerify(m, proof []byte) ([32]byte, error) {
	nilIndex := [32]byte{}
	if len(proof) != 80 {
		return nilIndex, ErrInvalidVRF
	}
	Gamma, err := new(edwards25519.Point).SetBytes(proof[:32])
	if err != nil {
		return nilIndex, ErrInvalidVRF
	}
	cStr := proof[32:48]
	cFull := make([]byte, 32)
	copy(cFull[:16], cStr)
	c, err := new(edwards25519.Scalar).SetCanonicalBytes(cFull)
	if err != nil {
		return nilIndex, ErrInvalidVRF
	}
	s, err := new(edwards25519.Scalar).SetCanonicalBytes(proof[48:80])
	if err != nil {
		return nilIndex, ErrInvalidVRF
	}

	H := encodeToCurve(pk.inner, m)

	U := new(edwards25519.Point).ScalarBaseMult(s)
	temp, err := new(edwards25519.Point).SetBytes(pk.inner)
	if err != nil {
		return nilIndex, ErrInvalidVRF
	}
	temp.ScalarMult(c, temp)
	U.Subtract(U, temp)

	V := new(edwards25519.Point).ScalarMult(s, H)
	temp.ScalarMult(c, Gamma)
	V.Subtract(V, temp)

	cPrime := generateChallenge(pk.inner, H.Bytes(), proof[:32], U.Bytes(), V.Bytes())
	if !bytes.Equal(cStr, cPrime) {
		return nilIndex, ErrInvalidVRF
	}

	return proofToHash(Gamma), nil
}

func (pk PublicKey) Bytes() []byte { return pk.inner }

// NewVRFSigner creates a signer object from a private key.
func NewVRFSigner(key []byte) (vrf.PrivateKey, error) {
	if len(key) != 32 {
		return nil, ErrInvalidPrivateKey
	}
	return &PrivateKey{inner: key}, nil
}

// Public returns the corresponding public key as bytes.
func (k PrivateKey) Public() crypto.PublicKey {
	pub := ed25519.NewKeyFromSeed(k.inner).Public()
	return []byte(pub.(ed25519.PublicKey))
}

// NewVRFVerifier creates a verifier object from a public key.
func NewVRFVerifier(key ed25519.PublicKey) (vrf.PublicKey, error) {
	if len(key) != 32 {
		return nil, ErrInvalidPublicKey
	}

	// Reject a public key with low order
	p, err := new(edwards25519.Point).SetBytes(key)
	if err != nil {
		return nil, ErrInvalidPublicKey
	}
	p.MultByCofactor(p)
	if ed25519IdentityPoint.Equal(p) == 1 {
		return nil, ErrInvalidPublicKey
	}

	return &PublicKey{inner: key}, nil
}
