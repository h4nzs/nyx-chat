// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

// State auditor: cukup untuk melanjutkan verifikasi setelah restart — jumlah
// update yang sudah diterima, root hash prefix tree terakhir, dan simpul pohon
// log yang dibutuhkan untuk merekonstruksi root hash-nya.
//
// Sama seperti referensi (`AuditorStateAndSignature`), state **ditandatangani
// kunci privat auditor** dan tanda tangannya diperiksa saat dimuat: berkas state
// yang diubah tangan (atau berasal dari kunci lain) ditolak, bukan diam-diam
// dipakai untuk melanjutkan audit dari posisi palsu. Referensi memakai protobuf
// untuk serialisasi; di sini JSON — keputusan gaya supaya operator bisa
// membacanya, sedangkan jaminannya tetap dari tanda tangan ML-DSA-65.

package main

import (
	"crypto/mldsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type auditorState struct {
	totalUpdatesProcessed uint64
	prefixTreeRootHash    []byte
	logTreeNodes          []logTreeNode
}

type stateStore interface {
	// load mengembalikan nil (tanpa error) bila belum ada state tersimpan.
	load() (*auditorState, error)
	store(state *auditorState) error
}

type stateNodeFile struct {
	ID   uint64 `json:"id"`
	Hash string `json:"hash"`
}

// statePayload adalah bagian yang ditandatangani; `Signature` tidak ikut karena
// tidak mungkin menandatangani tanda tangannya sendiri.
type statePayload struct {
	TotalUpdatesProcessed uint64          `json:"totalUpdatesProcessed"`
	PrefixTreeRootHash    string          `json:"prefixTreeRootHash"`
	LogTreeNodes          []stateNodeFile `json:"logTreeNodes"`
}

type stateFile struct {
	statePayload
	Signature string `json:"signature"`
}

type fileStateStore struct {
	path       string
	privateKey *mldsa.PrivateKey
	publicKey  *mldsa.PublicKey
}

func newFileStateStore(path string, privateKey *mldsa.PrivateKey) *fileStateStore {
	return &fileStateStore{
		path:       path,
		privateKey: privateKey,
		publicKey:  privateKey.PublicKey(),
	}
}

// Tanda tangan state memakai konteks kosong (pure ML-DSA-65). Konteks ini lokal
// untuk berkas state auditor — tidak pernah dikirim ke log, jadi tidak terikat
// ke `AuditorContext` milik protokol.
func signState(key *mldsa.PrivateKey, message []byte) ([]byte, error) {
	return key.Sign(nil, message, &mldsa.Options{})
}

func verifyState(key *mldsa.PublicKey, message, signature []byte) bool {
	return mldsa.Verify(key, message, signature, &mldsa.Options{}) == nil
}

func (s *fileStateStore) load() (*auditorState, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("baca state %s: %w", s.path, err)
	}

	var file stateFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("urai state %s: %w", s.path, err)
	}

	signature, err := base64.StdEncoding.DecodeString(file.Signature)
	if err != nil {
		return nil, fmt.Errorf("tanda tangan state bukan base64: %w", err)
	}
	signed, err := json.Marshal(file.statePayload)
	if err != nil {
		return nil, err
	}
	if !verifyState(s.publicKey, signed, signature) {
		return nil, fmt.Errorf("tanda tangan state %s tidak sah — state diubah atau berasal dari kunci auditor lain", s.path)
	}

	if file.TotalUpdatesProcessed == 0 {
		return nil, errors.New("state tersimpan menyatakan nol update — tidak konsisten dengan adanya state")
	}
	rootHash, err := hex.DecodeString(file.PrefixTreeRootHash)
	if err != nil {
		return nil, fmt.Errorf("root prefix tree state bukan hex: %w", err)
	}
	if len(rootHash) != 32 {
		return nil, fmt.Errorf("root prefix tree state %d byte, ingin 32", len(rootHash))
	}

	nodes := make([]logTreeNode, 0, len(file.LogTreeNodes))
	for index, node := range file.LogTreeNodes {
		hash, err := hex.DecodeString(node.Hash)
		if err != nil {
			return nil, fmt.Errorf("hash simpul ke-%d bukan hex: %w", index, err)
		}
		if len(hash) != 32 {
			return nil, fmt.Errorf("hash simpul ke-%d %d byte, ingin 32", index, len(hash))
		}
		nodes = append(nodes, logTreeNode{id: node.ID, hash: hash})
	}

	return &auditorState{
		totalUpdatesProcessed: file.TotalUpdatesProcessed,
		prefixTreeRootHash:    rootHash,
		logTreeNodes:          nodes,
	}, nil
}

func (s *fileStateStore) store(state *auditorState) error {
	payload := statePayload{
		TotalUpdatesProcessed: state.totalUpdatesProcessed,
		PrefixTreeRootHash:    hex.EncodeToString(state.prefixTreeRootHash),
		LogTreeNodes:          make([]stateNodeFile, 0, len(state.logTreeNodes)),
	}
	for _, node := range state.logTreeNodes {
		payload.LogTreeNodes = append(payload.LogTreeNodes, stateNodeFile{
			ID:   node.id,
			Hash: hex.EncodeToString(node.hash),
		})
	}

	signed, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	signature, err := signState(s.privateKey, signed)
	if err != nil {
		return fmt.Errorf("tandatangani state: %w", err)
	}
	raw, err := json.Marshal(stateFile{
		statePayload: payload,
		Signature:    base64.StdEncoding.EncodeToString(signature),
	})
	if err != nil {
		return err
	}

	// Tulis-lalu-rename: state setengah tertulis tidak boleh terlihat sebagai
	// state yang sah (auditor akan menolaknya karena tanda tangan, tapi berkas
	// rusak juga membuat restart berikutnya bingung).
	directory := filepath.Dir(s.path)
	temporary, err := os.CreateTemp(directory, ".kt-auditor-state-*")
	if err != nil {
		return fmt.Errorf("buat berkas state sementara: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if _, err := temporary.Write(append(raw, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("tulis state %s: %w", temporaryPath, err)
	}
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("ubah mode state %s: %w", temporaryPath, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("tutup state %s: %w", temporaryPath, err)
	}
	if err := os.Rename(temporaryPath, s.path); err != nil {
		return fmt.Errorf("pindahkan state ke %s: %w", s.path, err)
	}
	return nil
}
