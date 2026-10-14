//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package transparency

import (
	"bytes"
	"errors"
	"slices"
	"time"

	"github.com/signalapp/keytransparency/crypto/commitments"
	"github.com/signalapp/keytransparency/db"
	"github.com/signalapp/keytransparency/tree/log"
	"github.com/signalapp/keytransparency/tree/prefix"
	"github.com/signalapp/keytransparency/tree/transparency/math"
	"github.com/signalapp/keytransparency/tree/transparency/pb"
)

const (
	timeMaxAhead         = 10 * time.Second   // The max amount of time that a timestamp can be ahead of the current time.
	timeMaxBehind        = 1 * 24 * time.Hour // The max amount of time that a timestamp can be behind the current time.
	timeAuditorMaxBehind = 7 * 24 * time.Hour // The max amount of time that an auditor timestamp can be behind the current time.
	entriesMaxBehind     = 10000000           // The max number of entries that an auditor tree head can be behind the current tree head.
)

// MonitoringData is the structure retained for each key in the KT server being
// monitored.
type MonitoringData struct {
	Index []byte            // The VRF output on the search key.
	Pos   uint64            // The initial position of the key in the log.
	Ptrs  map[uint64]uint32 // Map from position in log to observed ctr value.
	Owned bool              // Whether this client owns the key.
}

func (md *MonitoringData) Entries() (out []uint64) {
	for entry := range md.Ptrs {
		out = append(out, entry)
	}
	slices.Sort(out)
	return
}

// ClientStorage is the interface implemented by clients for storing local
// monitoring data.
type ClientStorage interface {
	PublicConfig() *PublicConfig

	GetLastTreeHead() (head *db.TransparencyTreeHead, root []byte, err error)
	SetLastTreeHead(head *db.TransparencyTreeHead, root []byte) error

	GetData(key []byte) (*MonitoringData, error)
	SetData(key []byte, data *MonitoringData) error
}

// verifyFullTreeHead checks that a FullTreeHead structure is valid. It stores
// the tree head for later requests if it succeeds.
func verifyFullTreeHead(storage ClientStorage, fth *pb.FullTreeHead, root []byte) error {
	last, lastRoot, err := storage.GetLastTreeHead()
	if err != nil {
		return err
	}
	if last == nil {
		if fth.Last != nil {
			return errors.New("consistency proof provided when not expected")
		}
	} else if last.TreeSize == fth.TreeHead.TreeSize {
		if ok := bytes.Equal(lastRoot, root); !ok {
			return errors.New("root is different but tree size is same")
		} else if fth.TreeHead.Timestamp < last.Timestamp {
			return errors.New("current timestamp is less than previous timestamp")
		} else if fth.Last != nil {
			return errors.New("consistency proof provided when not expected")
		}
	} else {
		// Verify tree size and timestamp are greater than or equal to before.
		if fth.TreeHead.Timestamp < last.Timestamp {
			return errors.New("current timestamp is less than previous timestamp")
		} else if fth.TreeHead.TreeSize < last.TreeSize {
			return errors.New("current tree size is less than previous tree size")
		}
		// Verify consistency proof.
		err := log.VerifyConsistencyProof(last.TreeSize, fth.TreeHead.TreeSize, fth.Last, lastRoot, root)
		if err != nil {
			return err
		}
	}

	// Verify the signature.
	publicConfig := storage.PublicConfig()
	if err := verifyTreeHead(publicConfig, fth.TreeHead, root); err != nil {
		return err
	}

	// Verify the timestamp is sufficiently recent.
	now, then := time.Now().UnixMilli(), fth.TreeHead.Timestamp
	if now > then && now-then > timeMaxBehind.Milliseconds() {
		return errors.New("timestamp is too far behind current time")
	} else if now < then && then-now > timeMaxAhead.Milliseconds() {
		return errors.New("timestamp is too far ahead of current time")
	}

	// Verify third-party auditing root.
	if publicConfig.Mode == ThirdPartyAuditing {
		if len(fth.FullAuditorTreeHeads) == 0 {
			return errors.New("auditor tree head not provided even though auditing is required")
		}
		for _, auditorTreeHead := range fth.FullAuditorTreeHeads {
			// Verify that auditor root is sufficiently recent.
			then := auditorTreeHead.TreeHead.Timestamp
			if now > then && now-then > timeAuditorMaxBehind.Milliseconds() {
				return errors.New("auditor timestamp is too far behind current time")
			} else if now < then && then-now > timeMaxAhead.Milliseconds() {
				return errors.New("auditor timestamp is too far ahead of current time")
			}
			// Verify that auditor root is sufficiently close to main tree head.
			treeSize := fth.TreeHead.TreeSize
			auditorTreeSize := auditorTreeHead.TreeHead.TreeSize
			if auditorTreeSize > treeSize {
				return errors.New("auditor tree head may not be further along than service tree head")
			} else if treeSize-auditorTreeSize > entriesMaxBehind {
				return errors.New("auditor tree head is too far behind service tree head")
			}
			// Verify consistency proof.
			if treeSize > auditorTreeSize {
				if err := log.VerifyConsistencyProof(
					auditorTreeSize,
					treeSize,
					auditorTreeHead.Consistency,
					auditorTreeHead.RootValue,
					root,
				); err != nil {
					return err
				}
			} else {
				if auditorTreeHead.Consistency != nil {
					return errors.New("consistency proof provided when not expected")
				} else if auditorTreeHead.RootValue != nil {
					return errors.New("explicit root value provided when not expected")
				}
			}

			// Verify auditor signature.
			if err := verifyAuditorTreeHead(publicConfig, auditorTreeHead, root, auditorTreeHead.GetPublicKey()); err != nil {
				return err
			}

		}

	}

	signatures := make([]*db.Signature, len(fth.TreeHead.Signatures))
	for _, signature := range fth.TreeHead.Signatures {
		signatures = append(signatures, &db.Signature{Signature: signature.Signature, AuditorPublicKey: signature.AuditorPublicKey})
	}

	return storage.SetLastTreeHead(&db.TransparencyTreeHead{
		TreeSize:   fth.TreeHead.TreeSize,
		Timestamp:  fth.TreeHead.Timestamp,
		Signatures: signatures,
	}, root)
}

// verifySearch is the shared implementation of VerifySearch and VerifyUpdate.
func verifySearch(storage ClientStorage, req *pb.TreeSearchRequest, res *pb.TreeSearchResponse, update bool) error {
	// Evaluate VRF proof.
	index, err := storage.PublicConfig().VrfKey.ECVRFVerify(req.SearchKey, res.VrfProof)
	if err != nil {
		return err
	}

	// Evaluate the search proof.
	treeSize := res.TreeHead.TreeHead.TreeSize
	i := 0
	leaves := make(map[uint64][]byte)
	stepMap := make(map[uint64]*pb.ProofStep)

	guide := mostRecentProofGuide(res.Search.Pos, treeSize)

	for {
		done, err := guide.done()
		if err != nil {
			return err
		} else if done {
			break
		} else if i >= len(res.Search.Steps) {
			return errors.New("unexpected number of steps in search proof")
		}
		id := guide.next()
		step := res.Search.Steps[i]

		// Unlike during search proof generation, we use the actual version of the index during search proof verification.
		guide.insert(id, step.Prefix.Counter)

		// Evaluate the prefix proof and combine it with the commitment to get
		// the value stored in the log.
		proof := &prefix.SearchResult{Proof: step.Prefix.Proof, Counter: step.Prefix.Counter}
		prefixRoot, err := prefix.Evaluate(index[:], res.Search.Pos, proof)
		if err != nil {
			return err
		}
		leaves[id] = leafHash(prefixRoot, step.Commitment)
		stepMap[id] = step

		i++
	}
	if i != len(res.Search.Steps) {
		return errors.New("unexpected number of steps in search proof")
	}

	// Verify commitment opening.
	final := guide.final()
	if final == -1 {
		return errors.New("failed to find expected ctr value of key")
	}
	commitment := res.Search.Steps[final].Commitment

	value, err := marshalUpdateValue(res.Value)
	if err != nil {
		return err
	}
	if err := commitments.Verify(req.SearchKey, commitment, value, res.Opening); err != nil {
		return err
	}

	// Evaluate the inclusion proof to get a candidate root value.
	var ids []uint64
	for id := range leaves {
		ids = append(ids, id)
	}
	slices.Sort(ids)

	var values [][]byte
	for _, id := range ids {
		values = append(values, leaves[id])
	}

	root, err := log.EvaluateBatchProof(ids, treeSize, values, res.Search.Inclusion)
	if err != nil {
		return err
	}

	// Verify the tree head with the candidate root.
	if err := verifyFullTreeHead(storage, res.TreeHead, root); err != nil {
		return err
	}

	// Update stored monitoring data.
	if update || storage.PublicConfig().Mode == ContactMonitoring {
		err := startMonitoring(
			storage,
			req.SearchKey,
			index[:],
			res.Search.Pos,
			guide.ids[final],
			treeSize,
			res.Search.Steps[final].Prefix.Counter,
			update,
		)
		if err != nil {
			return err
		}
	}
	if err := monitorUpdate(storage, treeSize, req.SearchKey, stepMap); err != nil {
		return err
	}
	return nil
}

// VerifySearch checks that the output of a Search operation is valid and
// update's the client's stored data.
//
// res.Value.Value may only be consumed by the application if this function
// returns successfully.
func VerifySearch(storage ClientStorage, req *pb.TreeSearchRequest, res *pb.TreeSearchResponse) error {
	return verifySearch(storage, req, res, false)
}

// VerifyUpdate checks that the output of an Update operation is valid and
// update's the client's stored data.
func VerifyUpdate(storage ClientStorage, req *pb.UpdateRequest, res *pb.UpdateResponse) error {
	return verifySearch(
		storage,
		&pb.TreeSearchRequest{
			SearchKey:   req.SearchKey,
			Consistency: req.Consistency,
		},
		&pb.TreeSearchResponse{
			TreeHead: res.TreeHead,
			VrfProof: res.VrfProof,
			Search:   res.Search,

			Opening: res.Opening,
			Value:   &pb.UpdateValue{Value: req.Value},
		},
		true,
	)
}

// VerifyMonitor checks that the output of a Monitor operation is valid and
// updates the client's stored data.
func VerifyMonitor(storage ClientStorage, req *pb.MonitorRequest, res *pb.MonitorResponse) error {
	// Verify proof responses are the expected lengths.
	if len(req.Keys) != len(res.Proofs) {
		return errors.New("monitoring response is malformed: wrong number of key proofs")
	}

	treeSize := res.TreeHead.TreeHead.TreeSize

	// Verify all of the individual MonitorProof structures.
	md := newMonitorData(storage, treeSize)
	for i, key := range req.Keys {
		if err := md.verify(key, res.Proofs[i]); err != nil {
			return err
		}
	}

	// Evaluate the inclusion proof to get a candidate root value.
	var ids []uint64
	for id := range md.leaves {
		ids = append(ids, id)
	}
	slices.Sort(ids)

	var values [][]byte
	for _, id := range ids {
		values = append(values, md.leaves[id])
	}

	root, err := log.EvaluateBatchProof(ids, treeSize, values, res.Inclusion)
	if err != nil {
		return err
	}

	// Verify the tree head with the candidate root.
	if err := verifyFullTreeHead(storage, res.TreeHead, root); err != nil {
		return err
	}

	// Update monitoring data.
	for i, key := range req.Keys {
		if err := monitorUpdate(storage, treeSize, key.SearchKey, md.entries[i]); err != nil {
			return err
		}
	}

	return nil
}

type monitorData struct {
	storage  ClientStorage
	treeSize uint64
	leaves   map[uint64][]byte
	entries  []map[uint64]*pb.ProofStep
}

func newMonitorData(storage ClientStorage, treeSize uint64) *monitorData {
	return &monitorData{
		storage:  storage,
		treeSize: treeSize,
		leaves:   make(map[uint64][]byte),
	}
}

func (md *monitorData) verify(key *pb.MonitorKey, proof *pb.MonitorProof) error {
	// Get the existing monitoring data from storage and check that it matches
	// the request.
	data, err := md.storage.GetData(key.SearchKey)
	if err != nil {
		return err
	} else if data == nil {
		return errors.New("unable to process monitoring response for unknown search key")
	}

	// Compute which entry in the log each proof is supposed to correspond to.
	entries := math.FullMonitoringPath(key.EntryPosition, data.Pos, md.treeSize)
	if len(entries) != len(proof.Steps) {
		return errors.New("monitoring response is malformed: wrong number of proof steps")
	}

	// Evaluate each proof step to get the candidate leaf values.
	stepMap := make(map[uint64]*pb.ProofStep)
	for i, entry := range entries {
		step := proof.Steps[i]

		proof := &prefix.SearchResult{Proof: step.Prefix.Proof, Counter: step.Prefix.Counter}
		prefixRoot, err := prefix.Evaluate(data.Index, data.Pos, proof)
		if err != nil {
			return err
		}
		leaf := leafHash(prefixRoot, step.Commitment)

		if other, ok := md.leaves[entry]; ok {
			if !bytes.Equal(leaf, other) {
				return errors.New("monitoring response is malformed: multiple values for same leaf")
			}
		} else {
			md.leaves[entry] = leaf
		}

		stepMap[entry] = step
	}
	md.entries = append(md.entries, stepMap)

	return nil
}

// startMonitoring adds a key to the database of keys to monitor, if it's not
// already present.
func startMonitoring(storage ClientStorage, searchKey []byte, index []byte, firstUpdatePosition, latestUpdatePosition, treeSize uint64, targetCtr uint32, owned bool) error {
	data, err := storage.GetData(searchKey)
	if err != nil {
		return err
	} else if data == nil { // This is the first ctr value of the key that we're monitoring.
		return storage.SetData(searchKey, &MonitoringData{
			Index: index,
			Pos:   firstUpdatePosition,
			Ptrs:  map[uint64]uint32{latestUpdatePosition: targetCtr},
			Owned: owned,
		})
	}

	// Some ctr value(s) of this key is already being monitored. Check that the
	// provided data is consistent with what's already stored, and update as
	// appropriate.
	if !bytes.Equal(index, data.Index) {
		return errors.New("given search key index does not match database")
	} else if firstUpdatePosition != data.Pos {
		return errors.New("given search start position does not match database")
	}

	if ver, ok := data.Ptrs[latestUpdatePosition]; ok {
		if ver != targetCtr {
			return errors.New("different ctr values of key recorded at same position")
		}
	} else {
		found := false
		for _, x := range math.MonitoringPath(latestUpdatePosition, firstUpdatePosition, treeSize) {
			if ver, ok := data.Ptrs[x]; ok {
				if ver < targetCtr {
					return errors.New("prefix tree has unexpectedly low counter")
				}
				found = true
				break
			}
		}
		if !found {
			data.Ptrs[latestUpdatePosition] = targetCtr
		}
	}

	data.Owned = data.Owned || owned
	return storage.SetData(searchKey, data)
}

// monitorUpdate updates the internal monitoring data for a key as much as
// possible given a set of ProofStep structures. It should only be called after
// verifyFullHead has succeeded to ensure that we don't store updated monitoring
// data tied to a tree head that isn't valid.
func monitorUpdate(storage ClientStorage, treeSize uint64, searchKey []byte, entries map[uint64]*pb.ProofStep) error {
	data, err := storage.GetData(searchKey)
	if err != nil {
		return err
	} else if data == nil { // Key isn't being monitored.
		return nil
	}

	changed := false
	ptrs := make(map[uint64]uint32)

	for entry, ver := range data.Ptrs {
		for _, x := range math.MonitoringPath(entry, data.Pos, treeSize) {
			step, ok := entries[x]
			if !ok {
				break
			} else if step.Prefix.Counter < ver {
				return errors.New("prefix tree has unexpectedly low counter")
			}
			changed = true
			entry, ver = x, step.Prefix.Counter
		}

		if other, ok := ptrs[entry]; ok && ver != other {
			return errors.New("inconsistent ctrs found")
		}
		ptrs[entry] = ver
	}

	if changed {
		data.Ptrs = ptrs
		return storage.SetData(searchKey, data)
	}
	return nil
}
