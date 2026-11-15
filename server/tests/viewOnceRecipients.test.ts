// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [PASS-2 residual lanjutan — view-once: daftar penerima per pesan]
 *
 * Yang dikunci di sini:
 *  - penerima yang dicatat = id yang LOLOS bukti peserta server, minus pengirim
 *    (id karangan klien tidak boleh menambah hitungan), dan tag-nya
 *    `conversationScopedTag` — bukan userId asli;
 *  - baris pesan hanya dihapus saat `count(opens) >= count(recipients)`;
 *    pembukaan pertama di grup TIDAK boleh menghapus pesan anggota lain;
 *  - pesan tanpa daftar penerima (baris lama) tidak pernah "selesai" secara
 *    tebakan — tetap menunggu `expiresAt`/unsend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAtRestSecretCacheForTests,
  conversationScopedTag,
  sealAtRest,
} from '../src/utils/atRestSecrets.js';
import {
  finalizeViewOnceIfAllOpened,
  recordViewOnceRecipients,
  type ViewOnceRecipientDb,
} from '../src/utils/viewOnceRecipients.js';

process.env.NYX_AT_REST_PEPPER = 'viewonce-test-pepper-'.padEnd(64, 'p');
clearAtRestSecretCacheForTests();

const CONV = 'c1';

interface FakeOpts {
  /** Anggota menurut baris keanggotaan server (nilai ter-seal). */
  members?: string[];
  /** User yang punya receipt di percakapan ini. */
  receipts?: string[];
  /** User yang punya session key perangkat di percakapan ini. */
  sessionKeys?: string[];
  /** Pesan yang sudah dibuka (satu entri per pembukaan). */
  openedBy?: string[];
  /** Tag penerima yang sudah tercatat (baris lama = tanpa daftar). */
  existingRecipients?: string[];
}

async function makeDb (opts: FakeOpts = {}) {
  const sealed = new Map<string, string>();
  for (const member of opts.members ?? []) sealed.set(await sealAtRest(member), member);
  const receipts = new Set((opts.receipts ?? []).map((u) => conversationScopedTag(CONV, u)));
  const sessionKeys = new Set(opts.sessionKeys ?? []);

  const recipients: Array<{ messageId: string; recipientTag: string }> =
    (opts.existingRecipients ?? []).map((recipientTag) => ({ messageId: 'm1', recipientTag }));
  const opens: string[] = [...(opts.openedBy ?? [])];
  const deletes: string[] = [];

  const db = {
    userHiddenConversation: {
      async findMany (args: { where: { conversationId?: string; userId?: { in?: string[] } } }) {
        const { where } = args;
        if (where.conversationId !== CONV) return [];
        return (where.userId?.in ?? [])
          .filter((candidate) => sealed.has(candidate))
          .map((userId) => ({ userId }));
      },
      async findFirst () { return null; },
    },
    messageStatus: {
      async findFirst (args: { where: { userId?: string; message?: { conversationId?: string } } }) {
        const { where } = args;
        return where.message?.conversationId === CONV && receipts.has(where.userId ?? '')
          ? { id: 'receipt-1' }
          : null;
      },
    },
    sessionKey: {
      async findFirst (args: { where: { conversationId?: string; device?: { userId?: string } } }) {
        const { where } = args;
        return where.conversationId === CONV && sessionKeys.has(where.device?.userId ?? '')
          ? { id: 'sk-1' }
          : null;
      },
    },
    messageViewOnceRecipient: {
      async createMany ({ data, skipDuplicates }: {
        data: Array<{ messageId: string; recipientTag: string }>;
        skipDuplicates?: boolean;
      }) {
        let count = 0;
        for (const row of data) {
          const exists = recipients.some(
            (r) => r.messageId === row.messageId && r.recipientTag === row.recipientTag
          );
          if (exists && skipDuplicates) continue;
          recipients.push(row);
          count += 1;
        }
        return { count };
      },
      async count ({ where }: { where: { messageId?: string } }) {
        return recipients.filter((r) => r.messageId === where.messageId).length;
      },
    },
    messageViewOnceOpen: {
      async count ({ where }: { where: { messageId?: string } }) {
        return opens.filter((id) => id === where.messageId).length;
      },
    },
    message: {
      async delete ({ where }: { where: { id: string } }) {
        deletes.push(where.id);
        return {};
      },
    },
  };

  return {
    db: db as unknown as ViewOnceRecipientDb,
    recipients,
    opens,
    deletes,
    /** Simulasikan pembukaan berikutnya (satu baris per penerima). */
    addOpen: (messageId: string) => { opens.push(messageId); },
  };
}

test('penerima view-once: hanya id yang lolos bukti peserta, tanpa pengirim, bertag opaque', async () => {
  // u2 anggota lewat keanggotaan, u3 hanya punya session key, u-evil tanpa bukti.
  const { db, recipients } = await makeDb({ members: ['u2'], sessionKeys: ['u3'] });

  const count = await recordViewOnceRecipients(db, {
    conversationId: CONV,
    messageId: 'm1',
    senderId: 'u-sender',
    recipients: ['u2', 'u3', 'u-evil', 'u-sender', 'u2'],
  });

  assert.equal(count, 2, 'hanya peserta sah yang dicatat (duplikat digabung)');
  const tags = recipients.map((r) => r.recipientTag).sort();
  assert.deepEqual(
    tags,
    [conversationScopedTag(CONV, 'u2'), conversationScopedTag(CONV, 'u3')].sort(),
    'tag = HMAC per percakapan, bukan userId'
  );
  for (const tag of tags) {
    assert.ok(!tag.includes('u2') && !tag.includes('u3'), 'tag tidak memuat userId');
  }
  assert.notEqual(
    conversationScopedTag(CONV, 'u2'),
    conversationScopedTag('c2', 'u2'),
    'tag berbeda antar percakapan (tidak bisa dikorelasikan lintas chat)'
  );
  assert.equal(
    recipients.filter((r) => r.recipientTag === conversationScopedTag(CONV, 'u-sender')).length,
    0,
    'pengirim tidak pernah dihitung sebagai penerima'
  );
});

test('penerima view-once: tanpa anggota terverifikasi tidak ada yang dicatat', async () => {
  const { db, recipients } = await makeDb({});
  const count = await recordViewOnceRecipients(db, {
    conversationId: CONV,
    messageId: 'm1',
    senderId: 'u1',
    recipients: ['u-evil'],
  });
  assert.equal(count, 0);
  assert.equal(recipients.length, 0);
});

test('finalize: grup baru terhapus setelah SEMUA penerima membuka', async () => {
  const { db, deletes, addOpen } = await makeDb({
    members: ['u2', 'u3'],
    existingRecipients: [conversationScopedTag(CONV, 'u2'), conversationScopedTag(CONV, 'u3')],
    openedBy: ['m1'],
  });

  assert.equal(await finalizeViewOnceIfAllOpened(db, { messageId: 'm1' }), false);
  assert.deepEqual(deletes, [], 'pembukaan pertama tidak boleh menghapus pesan anggota lain');

  addOpen('m1'); // penerima terakhir membuka
  assert.equal(await finalizeViewOnceIfAllOpened(db, { messageId: 'm1' }), true);
  assert.deepEqual(deletes, ['m1']);
});

test('finalize: pesan tanpa daftar penerima tidak ditebak (baris lama)', async () => {
  const { db, deletes } = await makeDb({ openedBy: ['m1', 'm1', 'm1'] });
  assert.equal(await finalizeViewOnceIfAllOpened(db, { messageId: 'm1' }), false);
  assert.deepEqual(deletes, [], 'tanpa daftar penerima, keputusan diserahkan ke expiresAt/unsend');
});
