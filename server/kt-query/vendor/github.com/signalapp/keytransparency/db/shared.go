//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import "encoding/json"

func deserializeStoredTreeHead(raw []byte) (*TransparencyTreeHead, map[string]*AuditorTreeHead, error) {
	data := &storedTreeHead{}
	if err := json.Unmarshal(raw, data); err != nil {
		return nil, nil, err
	}
	if data.AuditorHeads == nil {
		data.AuditorHeads = make(map[string]*AuditorTreeHead)
	}
	return data.TreeHead, data.AuditorHeads, nil
}
