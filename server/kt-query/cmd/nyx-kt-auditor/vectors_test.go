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
//   - `signature`: `signature_input` + tanda tangan tree head harus cocok
//     byte-per-byte dengan yang dihasilkan implementasi referensi.
//
// Uji terakhir juga mengikat format tanda tangan versi test ini ke
// `transparency.SignNewAuditorHead` — fungsi upstream yang benar-benar dipakai
// runner saat runtime.

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	edvrf "github.com/signalapp/keytransparency/crypto/vrf/ed25519"
	"github.com/signalapp/keytransparency/tree/transparency"
	tpb "github.com/signalapp/keytransparency/tree/transparency/pb"
)

type vectorShouldFail struct {
	description string
	updates     []*tpb.AuditorUpdate
}

type vectorUpdateAndHash struct {
	update  *tpb.AuditorUpdate
	logRoot []byte
}

type vectorSignature struct {
	mode               uint32
	signaturePublicKey []byte
	vrfPublicKey       []byte
	treeSize           uint64
	timestamp          int64
	root               []byte
	signature          []byte
	auditorPrivateKey  []byte
	auditorPublicKey   []byte
	signatureInput     []byte
}

type testVectors struct {
	shouldFail    []vectorShouldFail
	shouldSucceed []vectorUpdateAndHash
	signature     vectorSignature
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

func decodeSignature(t *testing.T, raw []byte) vectorSignature {
	t.Helper()
	var out vectorSignature
	walkFields(t, raw, func(field protoField) {
		switch field.number {
		case 1:
			out.mode = uint32(field.varint)
		case 2:
			out.signaturePublicKey = field.bytes
		case 3:
			out.vrfPublicKey = field.bytes
		case 4:
			out.treeSize = field.varint
		case 5:
			out.timestamp = int64(field.varint)
		case 6:
			out.root = field.bytes
		case 7:
			out.signature = field.bytes
		case 8:
			out.auditorPrivateKey = field.bytes
		case 9:
			out.auditorPublicKey = field.bytes
		case 10:
			out.signatureInput = field.bytes
		}
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
		case 3:
			out.signature = decodeSignature(t, field.bytes)
		}
	})
	return out
}

// treeHeadTbsBytes menyusun byte yang ditandatangani auditor (mode 3).
// Implementasi referensi (`Auditor.generateTreeHeadSignature` Java) dan upstream
// Go (`treeHeadTbs.Marshal`) menyusun byte yang sama; di sini disalin **khusus
// untuk test** supaya vektor resmi bisa dibandingkan tanpa bergantung pada jam
// sistem (upstream mengambil timestamp sendiri dari `time.Now()`).
func treeHeadTbsBytes(sigKey, vrfKey, auditorKey []byte, treeSize uint64, timestamp int64, root []byte) []byte {
	buffer := &bytes.Buffer{}
	buffer.Write([]byte{0x00, 0x00}) // cipher suite
	buffer.Write([]byte{0x03})       // mode ThirdPartyAuditing
	writeUint16LengthPrefixed(buffer, sigKey)
	writeUint16LengthPrefixed(buffer, vrfKey)
	writeUint16LengthPrefixed(buffer, auditorKey)
	_ = binary.Write(buffer, binary.BigEndian, treeSize)
	_ = binary.Write(buffer, binary.BigEndian, timestamp)
	buffer.Write(root)
	return buffer.Bytes()
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

func TestVectorsSignature(t *testing.T) {
	vectors := loadTestVectors(t)
	vector := vectors.signature

	if vector.mode != 3 {
		t.Fatalf("mode vektor = %d, ingin 3 (ThirdPartyAuditing)", vector.mode)
	}

	privateKeyRaw, err := x509.ParsePKCS8PrivateKey(vector.auditorPrivateKey)
	if err != nil {
		t.Fatalf("urai kunci privat auditor: %v", err)
	}
	auditorPrivateKey, ok := privateKeyRaw.(ed25519.PrivateKey)
	if !ok {
		t.Fatalf("kunci privat vektor bertipe %T, ingin ed25519.PrivateKey", privateKeyRaw)
	}

	publicKeyOf := func(name string, raw []byte) ed25519.PublicKey {
		t.Helper()
		parsed, err := x509.ParsePKIXPublicKey(raw)
		if err != nil {
			t.Fatalf("urai kunci publik %s: %v", name, err)
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			t.Fatalf("kunci publik %s bertipe %T, ingin ed25519.PublicKey", name, parsed)
		}
		return key
	}
	auditorPublicKey := publicKeyOf("auditor", vector.auditorPublicKey)
	signaturePublicKey := publicKeyOf("layanan (tanda tangan)", vector.signaturePublicKey)
	vrfPublicKey := publicKeyOf("layanan (VRF)", vector.vrfPublicKey)

	expectedInput := treeHeadTbsBytes(signaturePublicKey, vrfPublicKey, auditorPublicKey,
		vector.treeSize, vector.timestamp, vector.root)
	if len(expectedInput) != 153 {
		t.Fatalf("panjang byte yang ditandatangani = %d, ingin 153", len(expectedInput))
	}
	if !bytes.Equal(expectedInput, vector.signatureInput) {
		t.Fatalf("byte yang ditandatangani tidak cocok dengan vektor:\ndapat %x\ningin %x",
			expectedInput, vector.signatureInput)
	}

	// Ed25519 deterministik: tanda tangan atas masukan yang sama harus identik.
	if produced := ed25519.Sign(auditorPrivateKey, vector.signatureInput); !bytes.Equal(produced, vector.signature) {
		t.Fatalf("tanda tangan tree head tidak cocok dengan vektor:\ndapat %x\ningin %x", produced, vector.signature)
	}

	// Ikat format test ini ke fungsi yang dipakai runtime: `SignNewAuditorHead`
	// milik upstream (dipakai runner) harus menghasilkan byte yang sama untuk
	// timestamp yang ia pakai sendiri.
	verifier, err := edvrf.NewVRFVerifier(vrfPublicKey)
	if err != nil {
		t.Fatalf("bangun verifier VRF: %v", err)
	}
	head, raw, err := transparency.SignNewAuditorHead(auditorPrivateKey, &transparency.PublicConfig{
		Mode:        transparency.ThirdPartyAuditing,
		SigKey:      signaturePublicKey,
		AuditorKeys: map[string]ed25519.PublicKey{"auditor-vektor": auditorPublicKey},
		VrfKey:      verifier,
	}, vector.treeSize, vector.root, "auditor-vektor")
	if err != nil {
		t.Fatalf("SignNewAuditorHead: %v", err)
	}

	upstreamInput := treeHeadTbsBytes(signaturePublicKey, vrfPublicKey, auditorPublicKey,
		head.TreeSize, head.Timestamp, vector.root)
	if !bytes.Equal(upstreamInput, raw) {
		t.Fatalf("format test tidak sama dengan upstream:\ntest     %x\nupstream %x", upstreamInput, raw)
	}
	if !ed25519.Verify(auditorPublicKey, raw, head.Signature) {
		t.Fatal("tanda tangan upstream tidak bisa diverifikasi dengan kunci publik auditor")
	}
}
