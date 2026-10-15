// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Test perilaku `jobs/cleanup.ts` — kebijakan pembersihan tanpa Postgres/Redis.
 *
 * Yang dijaga di sini bukan "fungsi dipanggil", melainkan **keputusan**:
 * ambang waktu yang dikirim ke Prisma, akun mana yang dihancurkan, apa yang
 * terjadi bila satu tabel gagal (langkah lain tetap jalan), dan bahwa laporan
 * tidak memuat identitas akun.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDeadManSwitchDue,
  runCleanup,
  STALE_SESSION_KEY_MS,
  type CleanupDb,
} from '../src/jobs/cleanup.js';

type Where = Record<string, unknown>;

interface Recorder {
  refreshTokenWhere?: Where;
  sessionKeyWhere?: Where;
  subscriptionWhere?: Where;
  storyWhere?: Where;
  userFindWhere?: Where;
  deletedUserIds: string[];
  purgeCalls: string[];
}

interface FakeOptions {
  refreshTokens?: number;
  sessionKeys?: number;
  users?: Array<{ id: string; lastActiveDay: Date; autoDestructDays: number | null }>;
  subscriptions?: number;
  stories?: number;
  purgeFailsFor?: string[];
  failStep?: 'refresh_token' | 'session_key' | 'subscription' | 'story';
}

function makeDb(options: FakeOptions = {}): { db: CleanupDb; rec: Recorder } {
  const rec: Recorder = { deletedUserIds: [], purgeCalls: [] };

  const db: CleanupDb = {
    refreshToken: {
      async deleteMany(args) {
        if (options.failStep === 'refresh_token') throw new Error('refresh token table tidak ada');
        rec.refreshTokenWhere = args.where as Where;
        return { count: options.refreshTokens ?? 0 };
      },
    },
    sessionKey: {
      async deleteMany(args) {
        if (options.failStep === 'session_key') throw new Error('session key table tidak ada');
        rec.sessionKeyWhere = args.where as Where;
        return { count: options.sessionKeys ?? 0 };
      },
    },
    user: {
      async findMany(args) {
        rec.userFindWhere = args.where as Where;
        return options.users ?? [];
      },
      async updateMany(args) {
        if (options.failStep === 'subscription') throw new Error('user table tidak ada');
        rec.subscriptionWhere = args.where as Where;
        return { count: options.subscriptions ?? 0 };
      },
      async deleteMany(args) {
        const where = args.where as { id: string };
        rec.deletedUserIds.push(where.id);
        return { count: 1 };
      },
    },
    story: {
      async deleteMany(args) {
        if (options.failStep === 'story') throw new Error('story table tidak ada');
        rec.storyWhere = args.where as Where;
        return { count: options.stories ?? 0 };
      },
    },
  };

  return { db, rec };
}

const NOW = new Date('2026-10-14T00:00:00.000Z');

test('runCleanup: refresh token kadaluarsa DAN yang sudah di-revoke dihapus', async () => {
  const { db, rec } = makeDb({ refreshTokens: 3 });
  const report = await runCleanup(db, { now: NOW });

  assert.equal(report.refreshTokens, 3);
  assert.deepEqual(rec.refreshTokenWhere, {
    OR: [{ expiresAt: { lte: NOW } }, { revokedAt: { not: null } }],
  });
  assert.deepEqual(report.errors, []);
});

test('runCleanup: session key pakai ambang eksplisit + basi 30 hari dari `now`', async () => {
  const { db, rec } = makeDb({ sessionKeys: 5 });
  const report = await runCleanup(db, { now: NOW });

  assert.equal(report.sessionKeys, 5);
  assert.deepEqual(rec.sessionKeyWhere, {
    OR: [
      { expiresAt: { not: null, lte: NOW } },
      { createdAt: { lte: new Date(NOW.getTime() - STALE_SESSION_KEY_MS) } },
    ],
  });
  assert.equal(STALE_SESSION_KEY_MS, 30 * 24 * 60 * 60 * 1000);
});

test('runCleanup: langganan jatuh tempo diturunkan ke FREE, bukan dihapus', async () => {
  const { db, rec } = makeDb({ subscriptions: 2 });
  const report = await runCleanup(db, { now: NOW });

  assert.equal(report.subscriptions, 2);
  assert.deepEqual(rec.subscriptionWhere, {
    subscriptionTier: 'SUBSCRIBER',
    subscriptionExpiresAt: { lt: NOW },
  });
});

test('runCleanup: story kadaluarsa dihapus fisik', async () => {
  const { db, rec } = makeDb({ stories: 4 });
  const report = await runCleanup(db, { now: NOW });

  assert.equal(report.stories, 4);
  assert.deepEqual(rec.storyWhere, { expiresAt: { lte: NOW } });
});

test('runCleanup: dead man switch hanya untuk akun yang lewat tenggat', async () => {
  const due = { id: 'user-due', lastActiveDay: new Date('2026-09-01T00:00:00.000Z'), autoDestructDays: 30 };
  const notDue = { id: 'user-fresh', lastActiveDay: new Date('2026-10-13T00:00:00.000Z'), autoDestructDays: 30 };
  const noSwitch = { id: 'user-keep', lastActiveDay: new Date('2020-01-01T00:00:00.000Z'), autoDestructDays: null };

  const { db, rec } = makeDb({ users: [due, notDue, noSwitch] });
  const purged: string[] = [];
  const report = await runCleanup(db, {
    now: NOW,
    purgeUser: async (id) => { purged.push(id); },
  });

  assert.equal(report.accounts, 1);
  assert.deepEqual(purged, ['user-due']);
  assert.deepEqual(rec.deletedUserIds, ['user-due']);
  // Hanya kandidat ber-`autoDestructDays` yang pernah dibaca.
  assert.deepEqual(rec.userFindWhere, { autoDestructDays: { not: null } });
});

test('runCleanup: kegagalan purge satu akun tidak menahan akun lain dan tidak membocorkan id', async () => {
  const users = [
    { id: 'user-broken', lastActiveDay: new Date('2026-08-01T00:00:00.000Z'), autoDestructDays: 7 },
    { id: 'user-ok', lastActiveDay: new Date('2026-08-01T00:00:00.000Z'), autoDestructDays: 7 },
  ];
  const { db, rec } = makeDb({ users });
  const report = await runCleanup(db, {
    now: NOW,
    purgeUser: async (id) => {
      if (id === 'user-broken') throw new Error('baris ter-seal rusak');
    },
  });

  assert.equal(report.accounts, 1);
  assert.deepEqual(rec.deletedUserIds, ['user-ok']);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /^account: baris ter-seal rusak$/);
  // Identitas akun TIDAK masuk laporan (docs/28: laporan tidak boleh jadi jalur
  // kebocoran baru).
  assert.ok(!report.errors.join(' ').includes('user-broken'));
});

test('runCleanup: kegagalan satu langkah tidak menghentikan langkah berikutnya', async () => {
  const { db, rec } = makeDb({ refreshTokens: 1, sessionKeys: 1, stories: 1, failStep: 'refresh_token' });
  const report = await runCleanup(db, { now: NOW });

  assert.equal(report.refreshTokens, 0, 'langkah yang gagal tidak melaporkan hitungan palsu');
  assert.equal(report.sessionKeys, 1);
  assert.equal(report.stories, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!, /^refresh_token: /);
  assert.deepEqual(rec.deletedUserIds, []);
});

test('runCleanup: database bersih → nol, tanpa error', async () => {
  const { db } = makeDb();
  const report = await runCleanup(db, { now: NOW });

  assert.deepEqual(
    {
      refreshTokens: report.refreshTokens,
      sessionKeys: report.sessionKeys,
      accounts: report.accounts,
      subscriptions: report.subscriptions,
      stories: report.stories,
      errors: report.errors,
    },
    { refreshTokens: 0, sessionKeys: 0, accounts: 0, subscriptions: 0, stories: 0, errors: [] }
  );
});

test('isDeadManSwitchDue: batas tepat di tenggat belum dihancurkan', () => {
  const user = { lastActiveDay: new Date('2026-09-14T00:00:00.000Z'), autoDestructDays: 30 };
  // 2026-09-14 + 30 hari = 2026-10-14 → `now > deadline` harus false di titik itu.
  assert.equal(isDeadManSwitchDue(user, new Date('2026-10-14T00:00:00.000Z')), false);
  assert.equal(isDeadManSwitchDue(user, new Date('2026-10-14T00:00:00.001Z')), true);
  assert.equal(isDeadManSwitchDue({ ...user, autoDestructDays: null }, new Date('2030-01-01T00:00:00.000Z')), false);
  assert.equal(isDeadManSwitchDue({ ...user, autoDestructDays: 0 }, new Date('2030-01-01T00:00:00.000Z')), false);
});
