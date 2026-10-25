// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.6] Kebijakan rotasi era — murni, tanpa I/O.
 *
 * Yang dikunci: umur 24 jam, 500 pesan sejak rotasi terakhir, catatan lokal
 * menang atas jam server, dan data yang tidak lengkap TIDAK memicu rotasi
 * massal (fallback `now`).
 */
import { describe, expect, it } from 'vitest';
import {
  GROUP_EPOCH_MAX_AGE_MS,
  GROUP_EPOCH_MAX_MESSAGES,
  decideEpochRotation,
} from '@lib/groupEpochPolicy';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

describe('decideEpochRotation', () => {
  it('era baru tidak dirotasi', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { rotatedAt: NOW - 60_000, createdAt: NOW - 3_600_000, messageSeq: 10 },
      local: { rotatedAt: NOW - 60_000, messageSeq: 5 },
    })).toEqual({ rotate: false, reason: 'fresh' });
  });

  it('umur melewati 24 jam → rotasi (reason age)', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { rotatedAt: NOW - GROUP_EPOCH_MAX_AGE_MS - 1, messageSeq: 3 },
      local: { rotatedAt: NOW - GROUP_EPOCH_MAX_AGE_MS - 1, messageSeq: 1 },
    })).toEqual({ rotate: true, reason: 'age' });
  });

  it('500 pesan sejak baseline → rotasi (reason messages), walau umur muda', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { rotatedAt: NOW - 60_000, messageSeq: 620 },
      local: { rotatedAt: NOW - 60_000, messageSeq: 120 },
    })).toEqual({ rotate: true, reason: 'messages' });
  });

  it('catatan lokal yang lebih baru menahan rotasi walau jam server lebih tua', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { rotatedAt: null, createdAt: NOW - 5 * GROUP_EPOCH_MAX_AGE_MS, messageSeq: 50 },
      local: { rotatedAt: NOW - 10_000, messageSeq: 45 },
    })).toEqual({ rotate: false, reason: 'fresh' });
  });

  it('tanpa data umur sama sekali → tidak dirotasi (fallback now)', () => {
    expect(decideEpochRotation({ now: NOW, server: { messageSeq: 0 } }))
      .toEqual({ rotate: false, reason: 'fresh' });
  });

  it('createdAt dipakai sebagai anchor saat belum pernah ada rotasi', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { createdAt: NOW - 2_000, rotatedAt: null, messageSeq: 10 },
      local: null,
    })).toEqual({ rotate: false, reason: 'fresh' });

    expect(decideEpochRotation({
      now: NOW,
      server: { createdAt: NOW - GROUP_EPOCH_MAX_AGE_MS - 5, rotatedAt: null, messageSeq: 10 },
    })).toEqual({ rotate: true, reason: 'age' });
  });

  it('ambang bisa di-override (dipakai test/deploy khusus)', () => {
    expect(decideEpochRotation({
      now: NOW,
      server: { rotatedAt: NOW - 1_000, messageSeq: 4 },
      local: { rotatedAt: NOW - 1_000, messageSeq: 1 },
      maxAgeMs: 500,
      maxMessages: 3,
    })).toEqual({ rotate: true, reason: 'messages' });
  });

  it('default sama dengan angka dokumen (24 jam / 500 pesan)', () => {
    expect(GROUP_EPOCH_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(GROUP_EPOCH_MAX_MESSAGES).toBe(500);
  });
});
