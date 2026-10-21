// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// Verifikasi port auditor terhadap **vektor uji resmi Signal**
// (`testdata/katie_test_vectors.pb`, lihat testdata/README.md):
//
//   - `should_succeed`: 10 update berurutan harus diterima, dan root hash pohon
//     log setelah **setiap** update harus sama dengan yang diharapkan vektor;
//   - `should_fail`: lima rangkaian update yang harus ditolak (proof pertama bukan
//     newTree, newTree untuk pohon tidak kosong, differentKey/sameKey tidak cocok
//     dengan root lama, sameKey untuk update palsu);
// Bagian `signature` vektor resmi **tidak** dipakai: vektor itu menandatangani
// format tree head v1 (Ed25519 + VRF). Untuk v2, test terakhir menyusun ulang
// byte TBS v2 (ML-DSA-65, tanpa VRF) dan mengikatnya ke
// `transparency.SignNewAuditorHead` — fungsi yang benar-benar dipakai runner.

package main

import (
	"bytes"
	"crypto/mldsa"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"

	transparency "github.com/h4nzs/nyx-chat/server/kt-query/v2/transparency"
)

type vectorShouldFail struct {
	description string
	updates     []*tpb.AuditorUpdate
}

type vectorUpdateAndHash struct {
	update  *tpb.AuditorUpdate
	logRoot []byte
}

type testVectors struct {
	shouldFail    []vectorShouldFail
	shouldSucceed []vectorUpdateAndHash
}

type protoField struct {
	number   protowire.Number
	varint   uint64
	bytes    []byte
	isVarint bool
}

// walkFields menelusuri field protobuf secara dangkal. Vektor uji hanya berisi
// field panjang-tetap dan varint, jadi tidak perlu mesin protobuf penuh — tapi
// pesan `kt.AuditorUpdate` di dalamnya tetap diurai protobuf asli
// supaya test tidak "menafsirkan" bentuk bukti dengan caranya sendiri.
func walkFields(t *testing.T, raw []byte, visit func(field protoField)) {
	t.Helper()
	for len(raw) > 0 {
		number, typ, tagLength := protowire.ConsumeTag(raw)
		if tagLength < 0 {
			t.Fatalf("tag protobuf tidak sah: %v", protowire.ParseError(tagLength))
		}
		raw = raw[tagLength:]

		switch typ {
		case protowire.BytesType:
			value, length := protowire.ConsumeBytes(raw)
			if length < 0 {
				t.Fatalf("field %d terpotong: %v", number, protowire.ParseError(length))
			}
			visit(protoField{number: number, bytes: value})
			raw = raw[length:]
		case protowire.VarintType:
			value, length := protowire.ConsumeVarint(raw)
			if length < 0 {
				t.Fatalf("varint field %d terpotong: %v", number, protowire.ParseError(length))
			}
			visit(protoField{number: number, varint: value, isVarint: true})
			raw = raw[length:]
		default:
			length := protowire.ConsumeFieldValue(number, typ, raw)
			if length < 0 {
				t.Fatalf("field %d tidak bisa dilewati: %v", number, protowire.ParseError(length))
			}
			raw = raw[length:]
		}
	}
}

func decodeAuditorUpdate(t *testing.T, raw []byte) *tpb.AuditorUpdate {
	t.Helper()
	update := &tpb.AuditorUpdate{}
	if err := proto.Unmarshal(raw, update); err != nil {
		t.Fatalf("urai kt.AuditorUpdate: %v", err)
	}
	return update
}

func decodeShouldFail(t *testing.T, raw []byte) vectorShouldFail {
	t.Helper()
	var out vectorShouldFail
	walkFields(t, raw, func(field protoField) {
		switch field.number {
		case 1:
			out.description = string(field.bytes)
		case 2:
			out.updates = append(out.updates, decodeAuditorUpdate(t, field.bytes))
		}
	})
	return out
}

func decodeShouldSucceed(t *testing.T, raw []byte) []vectorUpdateAndHash {
	t.Helper()
	var out []vectorUpdateAndHash
	walkFields(t, raw, func(field protoField) {
		if field.number != 1 {
			return
		}
		var entry vectorUpdateAndHash
		walkFields(t, field.bytes, func(inner protoField) {
			switch inner.number {
			case 1:
				entry.update = decodeAuditorUpdate(t, inner.bytes)
			case 2:
				entry.logRoot = inner.bytes
			}
		})
		out = append(out, entry)
	})
	return out
}

func loadTestVectors(t *testing.T) testVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "katie_test_vectors.pb"))
	if err != nil {
		t.Fatalf("baca vektor: %v", err)
	}

	var out testVectors
	walkFields(t, raw, func(field protoField) {
		switch field.number {
		case 1:
			out.shouldFail = append(out.shouldFail, decodeShouldFail(t, field.bytes))
		case 2:
			out.shouldSucceed = decodeShouldSucceed(t, field.bytes)
		}
	})
	return out
}

func writeUint16LengthPrefixed(buffer *bytes.Buffer, value []byte) {
	_ = binary.Write(buffer, binary.BigEndian, uint16(len(value)))
	buffer.Write(value)
}

func TestVectorsShouldSucceed(t *testing.T) {
	vectors := loadTestVectors(t)
	if len(vectors.shouldSucceed) != 10 {
		t.Fatalf("vektor should_succeed berisi %d update, ingin 10", len(vectors.shouldSucceed))
	}

	prefix := &condensedPrefixTree{}
	tree := &condensedLogTree{}

	for index, entry := range vectors.shouldSucceed {
		if entry.update == nil {
			t.Fatalf("update ke-%d kosong di vektor", index)
		}
		update, err := auditorUpdateFromProto(entry.update)
		if err != nil {
			t.Fatalf("update ke-%d tidak bisa dibaca: %v", index, err)
		}
		if err := prefix.apply(update, uint64(index)); err != nil {
			t.Fatalf("update ke-%d ditolak: %v", index, err)
		}
		if err := tree.addLeafNode(update.commitment, prefix.rootHash, uint64(index)); err != nil {
			t.Fatalf("update ke-%d: %v", index, err)
		}

		root, err := tree.rootHash()
		if err != nil {
			t.Fatalf("update ke-%d: %v", index, err)
		}
		if !bytes.Equal(root, entry.logRoot) {
			t.Fatalf("root pohon log setelah update ke-%d tidak cocok dengan vektor:\ndapat %x\ningin %x",
				index, root, entry.logRoot)
		}
	}
}

func TestVectorsShouldFail(t *testing.T) {
	vectors := loadTestVectors(t)
	if len(vectors.shouldFail) == 0 {
		t.Fatal("vektor should_fail kosong")
	}

	for _, vector := range vectors.shouldFail {
		t.Run(vector.description, func(t *testing.T) {
			prefix := &condensedPrefixTree{}
			tree := &condensedLogTree{}

			var failure error
			for index, raw := range vector.updates {
				update, err := auditorUpdateFromProto(raw)
				if err == nil {
					if err = prefix.apply(update, uint64(index)); err == nil {
						err = tree.addLeafNode(update.commitment, prefix.rootHash, uint64(index))
					}
				}
				if err != nil {
					failure = err
					break
				}
			}
			if failure == nil {
				t.Fatalf("rangkaian update %q DITERIMA — seharusnya ditolak auditor", vector.description)
			}
		})
	}
}

func TestV2TreeHeadSignature(t *testing.T) {
	const (
		auditorName = "auditor-vektor"
		treeSize    = uint64(7)
		nowMs       = int64(1_793_000_000_000)
	)
	root := bytes.Repeat([]byte{0x5a}, 32)

	logKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci log: %v", err)
	}
	auditorKey, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		t.Fatalf("buat kunci auditor: %v", err)
	}
	config := &transparency.PublicConfig{
		Mode:        transparency.ThirdPartyAuditing,
		SigKey:      logKey.PublicKey(),
		AuditorKeys: map[string]*mldsa.PublicKey{auditorName: auditorKey.PublicKey()},
		Now:         func() int64 { return nowMs },
	}

	head, raw, err := transparency.SignNewAuditorHead(auditorKey, config, treeSize, root, auditorName)
	if err != nil {
		t.Fatalf("SignNewAuditorHead: %v", err)
	}
	if head.TreeSize != treeSize || head.Timestamp != nowMs {
		t.Fatalf("head treeSize=%d timestamp=%d, ingin %d/%d", head.TreeSize, head.Timestamp, treeSize, nowMs)
	}
	if len(head.Signature) != transparency.MLDSA65SignatureSize {
		t.Fatalf("panjang tanda tangan = %d, ingin %d", len(head.Signature), transparency.MLDSA65SignatureSize)
	}

	// TBS v2: u16 cipher suite, u8 mode, kunci log, kunci auditor, tree size,
	// timestamp, root. Disusun di test (bukan memanggil Marshal) supaya layout
	// yang disepakati terkunci di sini.
	buffer := &bytes.Buffer{}
	_ = binary.Write(buffer, binary.BigEndian, transparency.CiphersuiteV2)
	buffer.Write([]byte{byte(transparency.ThirdPartyAuditing)})
	writeUint16LengthPrefixed(buffer, logKey.PublicKey().Bytes())
	writeUint16LengthPrefixed(buffer, auditorKey.PublicKey().Bytes())
	_ = binary.Write(buffer, binary.BigEndian, treeSize)
	_ = binary.Write(buffer, binary.BigEndian, nowMs)
	buffer.Write(root)
	expectedInput := buffer.Bytes()

	if len(expectedInput) != 3959 {
		t.Fatalf("panjang byte yang ditandatangani = %d, ingin 3959", len(expectedInput))
	}
	if !bytes.Equal(expectedInput, raw) {
		t.Fatalf("byte yang ditandatangani tidak cocok:\ndapat %x\ningin %x", raw, expectedInput)
	}
	if err := mldsa.Verify(auditorKey.PublicKey(), raw, head.Signature, &mldsa.Options{Context: transparency.AuditorContext}); err != nil {
		t.Fatalf("tanda tangan auditor tidak bisa diverifikasi: %v", err)
	}

	// Root yang diubah harus menolak tanda tangan yang sama.
	tampered := append([]byte(nil), raw...)
	tampered[len(tampered)-1] ^= 0xff
	if err := mldsa.Verify(auditorKey.PublicKey(), tampered, head.Signature, &mldsa.Options{Context: transparency.AuditorContext}); err == nil {
		t.Fatal("tanda tangan diterima untuk byte yang diubah")
	}
}
