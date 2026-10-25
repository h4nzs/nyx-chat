// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.2] Mailbox grup: validasi, TTL, filter epoch, cursor, GC.
 *
 * Yang dijaga test ini: item tidak pernah membawa identitas pengirim, item era
 * lama tidak muncul untuk era baru, dan pull tidak bisa dipakai untuk membaca
 * sampai keyspace/DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAILBOX_MAX_ITEMS_PER_POST,
  MAILBOX_MAX_PAYLOAD_BYTES,
  MAILBOX_TTL_MS,
  parseMailboxCursor,
  postMailboxItems,
  pullMailboxItems,
  purgeExpiredMailbox,
  validateMailboxItems,
  type MailboxDb,
  type MailboxRow,
} from '../src/utils/groupMailbox.js';

const TAG = 'A'.repeat(43);
const PAYLOAD = Buffer.from('ciphertext').toString('base64url');

function makeDb (rows: MailboxRow[] = []): { db: MailboxDb; rows: MailboxRow[]; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const db: MailboxDb = {
    groupMailboxItem: {
      create: async ({ data }) => {
        created.push(data);
        const row = {
          id: `item-${rows.length + 1}`,
          ...data,
        } as MailboxRow;
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({ where, take }) => {
        const w = where as {
          conversationId: string;
          epoch: number;
          expiresAt: { gt: Date };
          OR?: Array<{
            createdAt: Date | { gt: Date };
            id?: { gt: string };
          }>;
        };
        const afterCursor = (row: MailboxRow): boolean => {
          if (!w.OR) return true;
          return w.OR.some((cond) => {
            if (cond.createdAt instanceof Date) {
              return new Date(row.createdAt).getTime() === cond.createdAt.getTime()
                && (cond.id ? row.id > cond.id.gt : true);
            }
            return new Date(row.createdAt).getTime() > cond.createdAt.gt.getTime();
          });
        };
        return rows
          .filter((row) => row.conversationId === w.conversationId)
          .filter((row) => row.epoch === w.epoch)
          .filter((row) => new Date(row.expiresAt).getTime() > w.expiresAt.gt.getTime())
          .filter(afterCursor)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, take);
      },
      deleteMany: async ({ where }) => {
        const w = where as { expiresAt: { lte: Date } };
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (new Date(rows[i]!.expiresAt).getTime() <= w.expiresAt.lte.getTime()) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
  return { db, rows, created };
}

test('validasi: kind tertutup, tag 43-char, payload base64url ≤ 8 KB', () => {
  assert.equal(validateMailboxItems([]).ok, false);
  assert.deepEqual(
    validateMailboxItems([{ kind: 'CHAT', payload: PAYLOAD }]),
    { ok: false, reason: 'unknown_kind' }
  );
  assert.deepEqual(
    validateMailboxItems([{ kind: 'KEY_ENVELOPE', tag: 'short', payload: PAYLOAD }]),
    { ok: false, reason: 'bad_tag' }
  );
  assert.deepEqual(
    validateMailboxItems([{ kind: 'KEY_ENVELOPE', payload: 'bukan+base64url' }]),
    { ok: false, reason: 'payload_not_base64url' }
  );
  const tooBig = 'A'.repeat(Math.ceil((MAILBOX_MAX_PAYLOAD_BYTES + 10) * 4 / 3));
  assert.deepEqual(
    validateMailboxItems([{ kind: 'META', payload: tooBig }]),
    { ok: false, reason: 'payload_too_large' }
  );
  const many = Array.from({ length: MAILBOX_MAX_ITEMS_PER_POST + 1 }, () => ({ kind: 'COVER', payload: PAYLOAD }));
  assert.deepEqual(validateMailboxItems(many), { ok: false, reason: 'too_many_items' });

  const ok = validateMailboxItems([{ kind: 'KEY_ENVELOPE', tag: TAG, payload: PAYLOAD }]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.items[0], { kind: 'KEY_ENVELOPE', tag: TAG, payload: PAYLOAD });
});

test('post: TTL 7 hari, epoch dari pemanggil, TIDAK ada kolom pengirim', async () => {
  const { db, created } = makeDb();
  const now = new Date('2026-10-24T00:00:00Z');
  const written = await postMailboxItems(db, {
    conversationId: 'conv-1',
    epoch: 3,
    items: [{ kind: 'KEY_REQUEST', tag: TAG, payload: PAYLOAD }],
    now,
  });

  assert.equal(written, 1);
  assert.equal(created.length, 1);
  const data = created[0]!;
  assert.equal(data.conversationId, 'conv-1');
  assert.equal(data.epoch, 3);
  assert.equal(data.tag, TAG);
  assert.equal(new Date(data.expiresAt as Date).getTime(), now.getTime() + MAILBOX_TTL_MS);
  assert.ok(!('senderId' in data) && !('userId' in data), 'mailbox tidak boleh menyimpan pengirim');
});

test('pull: hanya epoch berjalan, TTL dihormati, cursor maju', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const { db } = makeDb([
    {
      id: 'old-era',
      conversationId: 'conv-1',
      epoch: 1,
      kind: 'KEY_ENVELOPE',
      tag: TAG,
      payload: PAYLOAD,
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'expired',
      conversationId: 'conv-1',
      epoch: 2,
      kind: 'KEY_ENVELOPE',
      tag: TAG,
      payload: PAYLOAD,
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 1),
    },
    {
      id: 'current-1',
      conversationId: 'conv-1',
      epoch: 2,
      kind: 'KEY_ENVELOPE',
      tag: TAG,
      payload: PAYLOAD,
      createdAt: new Date(now.getTime() - 30_000),
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'current-2',
      conversationId: 'conv-1',
      epoch: 2,
      kind: 'KEY_REQUEST',
      tag: TAG,
      payload: PAYLOAD,
      createdAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ]);

  const first = await pullMailboxItems(db, { conversationId: 'conv-1', epoch: 2, now });
  assert.deepEqual(first.items.map((item) => item.id), ['current-1', 'current-2']);
  assert.equal(first.truncated, false);
  assert.ok(first.nextCursor);

  const second = await pullMailboxItems(db, {
    conversationId: 'conv-1',
    epoch: 2,
    cursor: parseMailboxCursor(first.nextCursor!)!,
    now,
  });
  assert.deepEqual(second.items, [], 'cursor maju tidak mengulang item');
});

test('pull: cursor komposit tidak melewati item dengan createdAt sama', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const sameTime = new Date(now.getTime() - 60_000);
  const { db } = makeDb([
    {
      id: 'item-a',
      conversationId: 'conv-1',
      epoch: 0,
      kind: 'COVER',
      tag: null,
      payload: PAYLOAD,
      createdAt: sameTime,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'item-b',
      conversationId: 'conv-1',
      epoch: 0,
      kind: 'COVER',
      tag: null,
      payload: PAYLOAD,
      createdAt: sameTime,
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ]);

  const first = await pullMailboxItems(db, { conversationId: 'conv-1', epoch: 0, limit: 1, now });
  assert.deepEqual(first.items.map((item) => item.id), ['item-a']);
  assert.equal(first.truncated, true);

  const second = await pullMailboxItems(db, {
    conversationId: 'conv-1',
    epoch: 0,
    limit: 1,
    cursor: parseMailboxCursor(first.nextCursor!)!,
    now,
  });
  assert.deepEqual(second.items.map((item) => item.id), ['item-b'], 'batch createdAt sama tidak boleh terlewat');
});

test('pull: batas byte memotong halaman (truncated=true)', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  // 40 × 10.000 char base64 (~7,5 KB) = ~300 KB > batas pull 256 KB.
  const big = 'A'.repeat(10_000);
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `item-${index}`,
    conversationId: 'conv-1',
    epoch: 0,
    kind: 'COVER',
    tag: null,
    payload: big,
    createdAt: new Date(now.getTime() - 60_000 + index * 1000),
    expiresAt: new Date(now.getTime() + 60_000),
  }));
  const { db } = makeDb(rows);

  const page = await pullMailboxItems(db, { conversationId: 'conv-1', epoch: 0, now });
  assert.ok(page.items.length < rows.length, 'halaman dipotong di bawah jumlah item');
  assert.equal(page.truncated, true);
  assert.ok(page.items.reduce((sum, item) => sum + item.payload.length, 0) <= 262_144);
});

test('GC: hapus hanya item yang sudah kedaluwarsa', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const { db, rows } = makeDb([
    {
      id: 'fresh',
      conversationId: 'conv-1',
      epoch: 0,
      kind: 'META',
      tag: null,
      payload: PAYLOAD,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'stale',
      conversationId: 'conv-1',
      epoch: 0,
      kind: 'META',
      tag: null,
      payload: PAYLOAD,
      createdAt: now,
      expiresAt: new Date(now.getTime() - 1),
    },
  ]);

  assert.equal(await purgeExpiredMailbox(db, now), 1);
  assert.deepEqual(rows.map((row) => row.id), ['fresh']);
});
