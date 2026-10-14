//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

var (
	UnidentifiedAccessKey = []byte("unidentifiedAccessKey")
)

type MockAccountDB struct{}

func (m *MockAccountDB) GetAccountByAci(aci []byte) (*Account, error) {
	return &Account{DiscoverableByPhoneNumber: true, UnidentifiedAccessKey: UnidentifiedAccessKey}, nil
}
