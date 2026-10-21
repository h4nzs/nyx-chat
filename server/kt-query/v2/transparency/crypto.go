//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// NYX KT v2 fork: ML-DSA-65 tree-head authentication, no VRF.
// The tree structure, commitments, and proof formats are inherited unchanged
// from the upstream package; only the log authentication primitives differ.

package transparency

import (
	"bytes"
	"crypto/aes"
	"crypto/mldsa"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/signalapp/keytransparency/crypto/commitments"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/transparency/pb"
)

const (
	// IndexDomain is prefixed to every search key before hashing. It separates
	// the v2 index from any other SHA-256 use in the protocol.
	IndexDomain = "nyx-kt-v2-index"

	// HeadContext and AuditorContext are the ML-DSA domain-separation contexts
	// (FIPS 204 external context) for service and auditor tree heads.
	HeadContext    = "NYX-KT-V2-HEAD"
	AuditorContext = "NYX-KT-V2-AUDITOR"

	// CiphersuiteV2 is written at the start of every signed tree head.
	CiphersuiteV2 uint16 = 0x0002

	// MLDSA65PublicKeySize is the encoded size of an ML-DSA-65 public key.
	MLDSA65PublicKeySize = 1952
	// MLDSA65SignatureSize is the encoded size of an ML-DSA-65 signature.
	MLDSA65SignatureSize = 3309
)

// Index derives the v2 prefix-tree index for a search key.
//
// v1 used an ECVRF output here, which made the index privately computable by
// the log operator. v2 has no VRF: the index is a public hash. That removes a
// classical primitive at the cost of exposing the search key to anyone who
// sees the index (documented residual: docs/35 §35.7 Fase 7).
func Index(searchKey []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte(IndexDomain))
	h.Write(searchKey)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// ErrAuditorSignatureVerificationFailed is the v2 counterpart of the upstream
// error. It carries byte slices rather than ed25519 key types on purpose.
type ErrAuditorSignatureVerificationFailed struct {
	DataToBeSigned           []byte
	AuditorPublicKey         []byte
	AuditorProvidedSignature []byte
}

func (e *ErrAuditorSignatureVerificationFailed) Error() string {
	return fmt.Sprintf("auditor signature verification failed.\ndataToBeSigned: %x\n, auditorPublicKey:%x\n, auditorSig: %x",
		e.DataToBeSigned, e.AuditorPublicKey, e.AuditorProvidedSignature)
}

func mldsaOptions(context string) *mldsa.Options {
	return &mldsa.Options{Context: context}
}

func signMLDSA(key *mldsa.PrivateKey, message []byte, context string) ([]byte, error) {
	if key == nil {
		return nil, errors.New("missing ML-DSA private key")
	}
	return key.Sign(nil, message, mldsaOptions(context))
}

func verifyMLDSA(key *mldsa.PublicKey, message, signature []byte, context string) error {
	if key == nil {
		return errors.New("missing ML-DSA public key")
	}
	return mldsa.Verify(key, message, signature, mldsaOptions(context))
}

// computeOpening returns the opening for the commitment stored at position
// `pos` in the transparency tree.
func computeOpening(key []byte, pos uint64) []byte {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}

	data := make([]byte, block.BlockSize())
	binary.BigEndian.PutUint64(data[len(data)-8:], pos)
	block.Encrypt(data, data)
	return data
}

// fakeCommitment returns the commitment to use at a given position in the
// transparency log for fake updates.
func fakeCommitment(key []byte, pos uint64) ([]byte, error) {
	commitment, err := commitments.Commit(nil, nil, computeOpening(key, pos))
	if err != nil {
		return nil, err
	}
	return commitment, nil
}

// leafHash returns the hash of the leaf of the transparency tree.
func leafHash(prefixRoot, commitment []byte) []byte {
	s := sha256.New()
	s.Write(prefixRoot)
	s.Write(commitment)
	return s.Sum(nil)
}

// signNewHead returns a new signed transparency tree head.
func signNewHead(config *PrivateConfig, treeSize uint64, root []byte) (*db.TransparencyTreeHead, error) {
	tbs := &treeHeadTbs{
		TreeSize:  treeSize,
		Timestamp: config.nowMillis(),
		Root:      root,
	}

	keys := config.AuditorKeys
	if len(keys) == 0 {
		// Create a placeholder mapping for the auditor key since it won't be
		// marshaled anyway.
		keys = map[string]*mldsa.PublicKey{"": nil}
	}

	var signatures []*db.Signature
	for _, key := range keys {
		raw, err := tbs.Marshal(config.Public(), publicKeyBytes(key))
		if err != nil {
			return nil, err
		}
		sig, err := signMLDSA(config.SigKey, raw, HeadContext)
		if err != nil {
			return nil, err
		}
		signature := &db.Signature{Signature: sig, AuditorPublicKey: publicKeyBytes(key)}
		signatures = append(signatures, signature)
	}

	return &db.TransparencyTreeHead{
		TreeSize:   treeSize,
		Timestamp:  tbs.Timestamp,
		Signatures: signatures,
	}, nil
}

// SignNewAuditorHead returns a new signed transparency tree head from an
// auditor. It is only used for testing purposes.
func SignNewAuditorHead(sigKey *mldsa.PrivateKey, config *PublicConfig, treeSize uint64, root []byte, auditorName string) (*db.AuditorTransparencyTreeHead, []byte, error) {
	tbs := &treeHeadTbs{
		TreeSize:  treeSize,
		Timestamp: config.nowMillis(),
		Root:      root,
	}
	auditorPublicKey := config.AuditorKeys[auditorName]
	raw, err := tbs.Marshal(config, publicKeyBytes(auditorPublicKey))
	if err != nil {
		return nil, nil, err
	}
	sig, err := signMLDSA(sigKey, raw, AuditorContext)
	if err != nil {
		return nil, nil, err
	}
	return &db.AuditorTransparencyTreeHead{
		TreeSize:  treeSize,
		Timestamp: tbs.Timestamp,
		Signature: sig,
	}, raw, nil
}

// verifyTreeHead checks the signature on the provided transparency tree head.
func verifyTreeHead(config *PublicConfig, head *pb.TreeHead, root []byte) error {
	tbs := &treeHeadTbs{
		TreeSize:  head.TreeSize,
		Timestamp: head.Timestamp,
		Root:      root,
	}

	if len(head.Signatures) == 0 {
		return errors.New("expected at least one key transparency service signature")
	}

	for _, signature := range head.Signatures {
		if config.Mode == ThirdPartyAuditing {
			if err := verifyAuditorPublicKey(config.AuditorKeys, signature.AuditorPublicKey); err != nil {
				return err
			}
		}
		raw, err := tbs.Marshal(config, signature.AuditorPublicKey)
		if err != nil {
			return err
		} else if err := verifyMLDSA(config.SigKey, raw, signature.Signature, HeadContext); err != nil {
			return errors.New("failed to verify tree head signature")
		}
	}

	return nil
}

// verifyAuditorPublicKey checks that the provided public key exists in the map
// of known auditor public keys and returns an error if not.
func verifyAuditorPublicKey(configAuditorMap map[string]*mldsa.PublicKey, auditorPublicKey []byte) error {
	for _, knownPublicKey := range configAuditorMap {
		if knownPublicKey != nil && bytes.Equal(knownPublicKey.Bytes(), auditorPublicKey) {
			return nil
		}
	}
	return errors.New("provided auditor public key does not match set of known auditor public keys")
}

func verifyAuditorTreeHead(config *PublicConfig, head *pb.FullAuditorTreeHead, root []byte, auditorPublicKey []byte) error {
	if err := verifyAuditorPublicKey(config.AuditorKeys, auditorPublicKey); err != nil {
		return err
	}
	var auditorRoot []byte
	if head.RootValue == nil {
		auditorRoot = root
	} else {
		auditorRoot = head.RootValue
	}
	tbs := &treeHeadTbs{
		TreeSize:  head.TreeHead.TreeSize,
		Timestamp: head.TreeHead.Timestamp,
		Root:      auditorRoot,
	}
	raw, err := tbs.Marshal(config, auditorPublicKey)
	if err != nil {
		return err
	}
	key, err := parsePublicKey(auditorPublicKey)
	if err != nil {
		return err
	}
	if err := verifyMLDSA(key, raw, head.TreeHead.Signature, AuditorContext); err != nil {
		return &ErrAuditorSignatureVerificationFailed{
			DataToBeSigned:           raw,
			AuditorPublicKey:         auditorPublicKey,
			AuditorProvidedSignature: head.TreeHead.Signature,
		}
	}
	return nil
}

func parsePublicKey(raw []byte) (*mldsa.PublicKey, error) {
	if len(raw) != MLDSA65PublicKeySize {
		return nil, errors.New("ML-DSA public key has wrong size")
	}
	return mldsa.NewPublicKey(mldsa.MLDSA65(), raw)
}

func publicKeyBytes(key *mldsa.PublicKey) []byte {
	if key == nil {
		return nil
	}
	return key.Bytes()
}

func marshalUpdateValue(uv *pb.UpdateValue) ([]byte, error) {
	buf := &bytes.Buffer{}

	if len(uv.Value) >= 1<<32 {
		return nil, errors.New("value is too long to be encoded")
	}
	binary.Write(buf, binary.BigEndian, uint32(len(uv.Value)))
	buf.Write(uv.Value)

	return buf.Bytes(), nil
}

func unmarshalUpdateValue(raw []byte) (*pb.UpdateValue, error) {
	buf := bytes.NewBuffer(raw)

	var valLen uint32
	if err := binary.Read(buf, binary.BigEndian, &valLen); err != nil {
		return nil, err
	} else if int(valLen) != buf.Len() {
		return nil, errors.New("failed to decode update value")
	}

	return &pb.UpdateValue{Value: buf.Bytes()}, nil
}

type treeHeadTbs struct {
	TreeSize  uint64
	Timestamp int64
	Root      []byte
}

// Marshal a treeHeadTbs structure using the given auditor's public key.
//
// v2 layout (all integers big-endian):
//
//	u16 ciphersuite (0x0002)
//	u8  deployment mode
//	u16 len || log ML-DSA-65 public key
//	[third-party modes only] u16 len || auditor ML-DSA-65 public key
//	u64 tree size
//	i64 timestamp (ms)
//	32B root
//
// There is deliberately no VRF public key field: v2 has no VRF.
func (tbs *treeHeadTbs) Marshal(config *PublicConfig, auditorKey []byte) ([]byte, error) {
	buf := &bytes.Buffer{}

	binary.Write(buf, binary.BigEndian, CiphersuiteV2)
	buf.Write([]byte{byte(config.Mode)})

	// Signature public key (ML-DSA-65).
	sigKey := publicKeyBytes(config.SigKey)
	if len(sigKey) != MLDSA65PublicKeySize {
		return nil, errors.New("signature key has wrong size")
	}
	binary.Write(buf, binary.BigEndian, uint16(len(sigKey)))
	buf.Write(sigKey)

	// Third-party auditor public key.
	if config.Mode == ThirdPartyAuditing {
		if len(auditorKey) != MLDSA65PublicKeySize {
			return nil, errors.New("auditor public key has wrong size")
		}
		binary.Write(buf, binary.BigEndian, uint16(len(auditorKey)))
		buf.Write(auditorKey)
	}

	binary.Write(buf, binary.BigEndian, tbs.TreeSize)  // Tree size
	binary.Write(buf, binary.BigEndian, tbs.Timestamp) // Timestamp

	// Root hash
	if len(tbs.Root) != 32 {
		return nil, errors.New("root is wrong length")
	}
	buf.Write(tbs.Root)

	return buf.Bytes(), nil
}
