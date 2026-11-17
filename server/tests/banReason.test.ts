// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.4 R3] `User.banReason` hanya boleh berisi kode enum.
 *
 * Tes ini mengunci bahwa kalimat bebas dari dashboard admin tidak pernah
 * tersimpan apa adanya: yang tersimpan selalu salah satu nilai `BanReason`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BanReason } from '@prisma/client';
import { toBanReason } from '../src/utils/banReason.js';

const ALL = Object.values(BanReason) as string[];

describe('toBanReason', () => {
  it('kode enum yang sudah valid diteruskan apa adanya', () => {
    for (const code of ALL) {
      assert.equal(toBanReason(code), code);
    }
  });

  it('kalimat bebas dipetakan ke enum, kalimatnya tidak ikut tersimpan', () => {
    assert.equal(toBanReason('spam massal di DM'), BanReason.SPAM);
    assert.equal(toBanReason('Harassment of another user'), BanReason.ABUSE);
    assert.equal(toBanReason('impersonating a staff account'), BanReason.IMPERSONATION);
    assert.equal(toBanReason('account security: credential leak'), BanReason.SECURITY);
    assert.equal(toBanReason('Violation of TOS'), BanReason.TOS_VIOLATION);
  });

  it('tanpa alasan → TOS_VIOLATION, alasan tak dikenal → OTHER', () => {
    assert.equal(toBanReason(undefined), BanReason.TOS_VIOLATION);
    assert.equal(toBanReason('   '), BanReason.TOS_VIOLATION);
    assert.equal(toBanReason('laporan #4821 dari pelapor a@b.c'), BanReason.OTHER);
  });

  it('hasilnya selalu anggota enum (tidak ada teks bebas lolos)', () => {
    for (const input of ['x', '', 'TOS_VIOLATION ', '  spam', 'nama pelapor: Budi']) {
      assert.ok(ALL.includes(toBanReason(input)), `input ${JSON.stringify(input)} menghasilkan nilai di luar enum`);
    }
  });
});
