// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Bentuk update sisi auditor. Di referensi Java ini record `AuditorUpdate` (+
// interface `AuditorProof` dengan tiga implementasi). Di Go bentuknya satu
// struct dengan tag `kind` supaya saklar `switch` di pohon prefix bisa dibaca
// berdampingan dengan referensinya.

package main

import (
	"errors"
	"fmt"

	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"
)

// errInvalidProof menandai bukti yang tidak konsisten dengan state auditor —
// peristiwa yang membuat auditor berhenti mengirim tree head (panggilan itu
// tidak pernah dijalankan setelah error ini).
var errInvalidProof = errors.New("bukti audit tidak sah")

func invalidProof(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errInvalidProof, fmt.Sprintf(format, args...))
}

type proofKind uint8

const (
	proofUnknown proofKind = iota
	proofNewTree
	proofDifferentKey
	proofSameKey
)

func (k proofKind) String() string {
	switch k {
	case proofNewTree:
		return "newTree"
	case proofDifferentKey:
		return "differentKey"
	case proofSameKey:
		return "sameKey"
	default:
		return "unknown"
	}
}

// auditorProof mengikuti tiga bentuk proof di protobuf upstream:
//   - newTree      : update pertama ketika pohon masih kosong (hanya update nyata);
//   - differentKey : update tidak menyentuh daun yang sudah ada (oldSeed + copath);
//   - sameKey      : update menyentuh daun yang sudah ada (counter + position + copath).
type auditorProof struct {
	kind                 proofKind
	copath               [][]byte
	oldSeed              []byte // differentKey saja
	counter              uint32 // sameKey saja
	firstLogTreePosition uint64 // sameKey saja
}

// auditorUpdate adalah data yang dibutuhkan auditor untuk memverifikasi satu update.
type auditorUpdate struct {
	real            bool
	commitmentIndex []byte // keluaran VRF (32 byte)
	seed            []byte // 16 byte
	commitment      []byte // 32 byte
	proof           auditorProof
}

func (u auditorUpdate) String() string {
	return fmt.Sprintf("AuditorUpdate{real=%v index=%x seed=%x commitment=%x proof=%s copath=%d}",
		u.real, u.commitmentIndex, u.seed, u.commitment, u.proof.kind, len(u.proof.copath))
}

// auditorUpdateFromProto mengubah update protobuf menjadi bentuk verifikasi.
// Panjang field diperiksa (bean validation referensi: index 32, seed 16,
// commitment 32) supaya update cacat ditolak sebelum menyentuh state.
func auditorUpdateFromProto(raw *tpb.AuditorUpdate) (auditorUpdate, error) {
	var out auditorUpdate
	if raw == nil {
		return out, errors.New("update audit kosong")
	}

	out = auditorUpdate{
		real:            raw.GetReal(),
		commitmentIndex: raw.GetIndex(),
		seed:            raw.GetSeed(),
		commitment:      raw.GetCommitment(),
	}

	switch proof := raw.GetProof().GetProof().(type) {
	case *tpb.AuditorProof_NewTree_:
		out.proof = auditorProof{kind: proofNewTree}
	case *tpb.AuditorProof_DifferentKey_:
		out.proof = auditorProof{
			kind:    proofDifferentKey,
			copath:  proof.DifferentKey.GetCopath(),
			oldSeed: proof.DifferentKey.GetOldSeed(),
		}
	case *tpb.AuditorProof_SameKey_:
		out.proof = auditorProof{
			kind:                 proofSameKey,
			copath:               proof.SameKey.GetCopath(),
			counter:              proof.SameKey.GetCounter(),
			firstLogTreePosition: proof.SameKey.GetPosition(),
		}
	default:
		return out, errors.New("tipe proof tidak dikenal (mungkin proof tidak diisi)")
	}

	if err := validateUpdateShape(out); err != nil {
		return out, err
	}
	if out.proof.kind == proofDifferentKey && len(out.proof.oldSeed) != 16 {
		return out, fmt.Errorf("old seed proof differentKey harus 16 byte, dapat %d", len(out.proof.oldSeed))
	}
	return out, nil
}
