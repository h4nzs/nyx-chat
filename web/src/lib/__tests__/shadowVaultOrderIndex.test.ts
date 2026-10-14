/**
 * [docs/30 WS-F] Test perilaku vault setelah kolom pengurutan (`createdAt`)
 * di-seal dan range-scan pindah ke indeks bucket.
 *
 * Konvensi repo: Dexie + crypto di-stub (tidak butuh Postgres/Redis/IndexedDB).
 * Tabel palsu di bawah meniru `where('[conversationId+orderBucketMs]').equals([conv, bucket])`
 * seolah-olah IndexedDB, jadi yang diverifikasi di sini adalah **logika pembaca**
 * (loop bucket mundur, pemangkasan presisi, kursor, perbaikan baris lama) —
 * bukan semantik indeks Dexie yang sesungguhnya (butuh browser).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MIN = 60 * 1000;
const BUCKET = 15 * MIN;
const B0 = Math.floor(Date.now() / BUCKET) * BUCKET - 4 * BUCKET;

type Row = {
  id: string;
  conversationId: string;
  content: string | null;
  createdAt: string | Date | null;
  createdAtSealed?: string | null;
  orderBucketMs?: number | null;
  expiresAt?: string | number | null;
  seq?: number | string;
  // [docs/30 WS-F langkah 3] kolom struktur yang di-seal di tempat: baris baru
  // berbentuk envelope `ENC1:`, baris lama masih boolean/string plaintext.
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderAvatarUrl?: string;
  isDeletedLocal?: boolean | string;
  isViewOnce?: boolean | string;
  repliedToId?: string;
  repliedTo?: string;
  fileMeta?: string;
};

const messageRows = new Map<string, Row>();
const deletedIds: string[] = [];

const fakeMessages = {
  toArray: async () => [...messageRows.values()],
  get: async (id: string) => messageRows.get(id),
  bulkPut: async (items: Row[]) => {
    for (const item of items) messageRows.set(item.id, item);
  },
  bulkDelete: async (ids: string[]) => {
    for (const id of ids) messageRows.delete(id);
  },
  delete: async (id: string) => {
    deletedIds.push(id);
    messageRows.delete(id);
  },
  where: (selector: string) => {
    if (selector === '[conversationId+orderBucketMs]') {
      const owned = (conversationId: string) =>
        [...messageRows.values()].filter(
          (r) => r.conversationId === conversationId && typeof r.orderBucketMs === 'number'
        );
      return {
        equals: ([conversationId, bucket]: [string, number]) => ({
          toArray: async () => owned(conversationId).filter((r) => r.orderBucketMs === bucket),
        }),
        // Rentang penuh (`minKey..maxKey`) + `.reverse().limit(1)` → baris
        // dengan bucket tertinggi (dipakai pembaca halaman pertama).
        between: ([conversationId]: [string, unknown], _upper: [string, unknown]) => {
          let limitCount: number | null = null;
          const api = {
            reverse: () => api,
            limit: (n: number) => {
              limitCount = n;
              return api;
            },
            toArray: async () => {
              const rows = owned(conversationId).sort(
                (a, b) => (b.orderBucketMs as number) - (a.orderBucketMs as number)
              );
              return limitCount === null ? rows : rows.slice(0, limitCount);
            },
          };
          return api;
        },
      };
    }
    return {
      equals: (conversationId: string) => {
        const owned = () => [...messageRows.values()].filter((r) => r.conversationId === conversationId);
        return {
          toArray: async () => owned(),
          primaryKeys: async () => owned().map((r) => r.id),
          filter: (fn: (row: Row) => boolean) => ({
            primaryKeys: async () => owned().filter(fn).map((r) => r.id),
          }),
          delete: async () => {
            for (const row of owned()) messageRows.delete(row.id);
          },
        };
      },
    };
  },
};

const conversationRows = new Map<string, Record<string, unknown>>();
// [docs/30 WS-F §30.10] Migrasi juga menyegel kolom waktu kontak & cache profil
// → fake db harus punya tabelnya (kalau tidak, migrasi gagal dan test lolos
// palsu karena error-nya ditelan).
const contactRows = new Map<string, Record<string, unknown>>();
const profileRows = new Map<string, Record<string, unknown>>();

vi.mock('../db', () => ({
  db: {
    messages: fakeMessages,
    contacts: {
      toArray: async () => [...contactRows.values()],
      bulkPut: async (items: { userId: string }[]) => {
        for (const item of items) contactRows.set(String(item.userId), item as unknown as Record<string, unknown>);
      },
    },
    profileCache: {
      toArray: async () => [...profileRows.values()],
      bulkPut: async (items: { id: string }[]) => {
        for (const item of items) profileRows.set(String(item.id), item as unknown as Record<string, unknown>);
      },
    },
    conversations: {
      put: async (row: { id: string }) => {
        conversationRows.set(String(row.id), row as unknown as Record<string, unknown>);
      },
      bulkPut: async (items: { id: string }[]) => {
        for (const item of items) {
          conversationRows.set(String(item.id), item as unknown as Record<string, unknown>);
        }
      },
      toArray: async () => [...conversationRows.values()],
      delete: async (id: string) => {
        conversationRows.delete(String(id));
      },
    },
    ratchetSessions: {},
    groupSenderStates: {},
    groupReceiverStates: {},
  },
}));

// Vault crypto di-stub: isi konten juga, supaya round-trip tulis→baca kolom
// struktur (langkah 3) bisa diuji tanpa masterSeed/crypto worker.
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    crypto_generichash: () => new Uint8Array(32),
    to_base64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  })),
}));
vi.mock('@utils/crypto', () => ({
  getMyEncryptionKeyPair: vi.fn(async () => ({ privateKey: new Uint8Array(32) })),
}));
vi.mock('@lib/crypto-worker-proxy', () => ({
  workerXChaChaSeal: vi.fn(async (_key: string, text: string) =>
    'VAULT:' + Buffer.from(text, 'utf8').toString('base64')
  ),
  workerXChaChaOpen: vi.fn(async (_key: string, encrypted: string) =>
    encrypted.startsWith('VAULT:') ? Buffer.from(encrypted.slice(6), 'base64').toString('utf8') : null
  ),
}));

// Lapis at-rest di-stub: envelope `ENC1:` + angka (mirror bentuk nyata).
vi.mock('../localAtRest', () => ({
  AT_REST_PREFIX: 'ENC1:',
  LOCAL_TIME_BUCKET_MS: 15 * 60 * 1000,
  bucketLocalTimestamp: (value: string | Date | null | undefined) =>
    value === null || value === undefined || value === '' ? null : new Date(value).toISOString(),
  sealLocalNumber: vi.fn(async (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value)
      ? 'ENC1:' + Buffer.from(String(value), 'utf8').toString('base64')
      : null
  ),
  openLocalNumber: vi.fn(async (raw: number | string | null | undefined) => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string' || !raw.startsWith('ENC1:')) return null;
    const payload = Buffer.from(raw.slice(5), 'base64').toString('utf8');
    if (payload.length === 0) return null;
    const parsed = Number(payload);
    return Number.isFinite(parsed) ? parsed : null;
  }),
  // [docs/30 WS-F langkah 3] kodek kolom struktur (teks & flag).
  sealLocalText: vi.fn(async (value: string | null | undefined) =>
    typeof value === 'string' && value.length > 0
      ? 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')
      : null
  ),
  openLocalText: vi.fn(async (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!raw.startsWith('ENC1:')) return raw; // baris lama plaintext
    const payload = Buffer.from(raw.slice(5), 'base64').toString('utf8');
    return payload.length > 0 ? payload : null;
  }),
  sealLocalFlag: vi.fn(async (value: boolean | null | undefined) =>
    typeof value === 'boolean'
      ? 'ENC1:' + Buffer.from(value ? 'true' : 'false', 'utf8').toString('base64')
      : null
  ),
  openLocalFlag: vi.fn(async (raw: unknown) => {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const payload = raw.startsWith('ENC1:')
      ? Buffer.from(raw.slice(5), 'base64').toString('utf8')
      : raw;
    if (payload === 'true') return true;
    if (payload === 'false') return false;
    return null;
  }),
}));

const { shadowVault } = await import('../shadowVaultDb');
const { sealOrderFields } = await import('../localOrderKey');

/** Baris baru (bentuk v9): bucket + presisi ter-seal, plaintext dikosongkan. */
async function sealedRow(id: string, conversationId: string, ms: number, extra: Partial<Row> = {}): Promise<Row> {
  const fields = await sealOrderFields(ms);
  return { id, conversationId, content: null, createdAt: null, ...fields, ...extra };
}

beforeEach(() => {
  messageRows.clear();
  conversationRows.clear();
  deletedIds.length = 0;
});

describe('shadowVault.normalizeOrderIndex', () => {
  it('memperbaiki baris lama hasil restore: bucket diisi, presisi di-seal, plaintext dilepas', async () => {
    // Baris dari arsip klien pra-v9: createdAt plaintext, tanpa bucket.
    messageRows.set('old1', {
      id: 'old1',
      conversationId: 'conv_1',
      content: null,
      createdAt: new Date(B0 + 3 * MIN).toISOString(),
    });

    const repaired = await shadowVault.normalizeOrderIndex();
    expect(repaired).toBe(1);

    const row = messageRows.get('old1')!;
    expect(row.orderBucketMs).toBe(B0);
    expect(row.createdAtSealed).toMatch(/^ENC1:/);
    expect(row.createdAt).toBeNull();

    // Idempoten: jalan kedua tidak menyentuh apa pun.
    await expect(shadowVault.normalizeOrderIndex()).resolves.toBe(0);
  });

  it('baris yang sudah ber-indeks dan ter-seal tidak ditulis ulang', async () => {
    messageRows.set('new1', await sealedRow('new1', 'conv_1', B0 + MIN));
    await expect(shadowVault.normalizeOrderIndex()).resolves.toBe(0);
  });

  it('baris tanpa waktu sama sekali dibiarkan (tidak bisa diberi bucket)', async () => {
    messageRows.set('broken', { id: 'broken', conversationId: 'conv_1', content: null, createdAt: null });
    await expect(shadowVault.normalizeOrderIndex()).resolves.toBe(0);
    expect(messageRows.get('broken')!.orderBucketMs ?? null).toBeNull();
  });
});

describe('shadowVault.importDatabase', () => {
  it('baris impor diberi bucket sehingga muncul di query', async () => {
    const legacy = { id: 'imp1', conversationId: 'conv_1', content: null, createdAt: new Date(B0 + 2 * MIN).toISOString() };
    await shadowVault.importDatabase(JSON.stringify({ messages: [legacy] }));

    const row = messageRows.get('imp1')!;
    expect(row.orderBucketMs).toBe(B0);
    await expect(shadowVault.getMessagesByConversation('conv_1', 10)).resolves.toHaveLength(1);
  });
});

describe('[langkah 3] kolom struktur di-seal di tempat', () => {
  const liveTombstone = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    conversationId: 'c1',
    content: null,
    createdAt: new Date(B0 + MIN).toISOString(),
    senderId: 'u_sender',
    isDeletedLocal: true,
    ...extra,
  });

  it('menulis senderId/isDeletedLocal ter-seal, bukan plaintext', async () => {
    await shadowVault.upsertMessages([liveTombstone('m1') as never]);

    const raw = messageRows.get('m1')!;
    expect(typeof raw.senderId).toBe('string');
    expect(String(raw.senderId).startsWith('ENC1:')).toBe(true);
    expect(raw.senderId).not.toBe('u_sender');
    expect(typeof raw.isDeletedLocal).toBe('string');
    expect(raw.isDeletedLocal).not.toBe(true);

    // …dan tetap terbaca benar setelah dibuka.
    const page = await shadowVault.getMessagesByConversation('c1', 10);
    expect(page[0]!.senderId).toBe('u_sender');
    expect(page[0]!.isDeletedLocal).toBe(true);
    expect(page[0]!.sender?.id).toBe('u_sender');
  });

  it('baris lama plaintext (belum ditulis ulang) tetap terbaca', async () => {
    messageRows.set('legacy', {
      id: 'legacy',
      conversationId: 'c1',
      content: null,
      createdAt: new Date(B0).toISOString(),
      orderBucketMs: B0,
      senderId: 'u_legacy',
      isDeletedLocal: true,
      isViewOnce: false,
      repliedToId: 'msg_parent',
    });

    const page = await shadowVault.getMessagesByConversation('c1', 10);
    expect(page.map((m) => m.id)).toEqual(['legacy']);
    expect(page[0]!.senderId).toBe('u_legacy');
    expect(page[0]!.isDeletedLocal).toBe(true);
    expect(page[0]!.isViewOnce).toBe(false);
    expect(page[0]!.repliedToId).toBe('msg_parent');
  });

  it('expiresAt ter-seal tetap menyaring pesan kedaluwarsa (dan tetap dipertahankan saat pesan ditulis ulang)', async () => {
    const aliveExpiry = new Date(Date.now() + 60 * MIN).toISOString();
    await shadowVault.upsertMessages([
      liveTombstone('expired', { expiresAt: new Date(Date.now() - MIN).toISOString() }) as never,
      liveTombstone('alive', { expiresAt: aliveExpiry }) as never,
    ]);
    expect(String(messageRows.get('expired')!.expiresAt).startsWith('ENC1:')).toBe(true);

    const page = await shadowVault.getMessagesByConversation('c1', 10);
    expect(page.map((m) => m.id)).toEqual(['alive']);
    // Ter-seal sebagai ms, dibuka kembali jadi ISO yang sama.
    expect(page[0]!.expiresAt).toBe(aliveExpiry);

    // Tulis ulang tanpa membawa expiresAt → nilai lama TIDAK boleh hilang
    // (envelope tidak boleh diurai dengan `Date.parse`).
    await shadowVault.upsertMessages([liveTombstone('alive') as never]);
    const reread = await shadowVault.getMessagesByConversation('c1', 10);
    expect(reread.find((m) => m.id === 'alive')?.expiresAt).toBeDefined();
  });

  it('migrateAtRestSealing menyegel kolom struktur baris lama (idempoten)', async () => {
    const expiry = new Date(Date.now() + 30 * MIN).toISOString();
    messageRows.set('legacy1', {
      id: 'legacy1',
      conversationId: 'c1',
      content: null,
      createdAt: new Date(B0 + MIN).toISOString(),
      senderId: 'u_legacy',
      isDeletedLocal: true,
      isViewOnce: false,
      repliedToId: 'msg_parent',
      expiresAt: expiry,
      seq: 7,
    });
    conversationRows.set('c1', { id: 'c1', isGroup: true, participants: 'VAULT:W10=' });
    // Baris kontak lama: `updatedAt` masih angka plaintext.
    contactRows.set('peer1', { userId: 'peer1', data: 'VAULT:W10=', updatedAt: 1_700_000_000_000 });

    await expect(shadowVault.migrateAtRestSealing()).resolves.toBe(3);

    const raw = messageRows.get('legacy1')!;
    const sealed = (v: unknown) => typeof v === 'string' && v.startsWith('ENC1:');
    expect(sealed(raw.senderId)).toBe(true);
    expect(sealed(raw.repliedToId)).toBe(true);
    expect(sealed(raw.isDeletedLocal)).toBe(true);
    expect(sealed(raw.isViewOnce)).toBe(true);
    expect(sealed(raw.expiresAt)).toBe(true);
    expect(sealed(raw.seq)).toBe(true);
    expect(raw.orderBucketMs).toBe(B0);
    expect(raw.createdAt).toBeNull();
    expect(sealed(conversationRows.get('c1')!.isGroup)).toBe(true);
    expect(sealed(contactRows.get('peer1')!.updatedAt)).toBe(true);

    // Idempoten: jalan kedua tidak menyentuh apa pun (termasuk tabel kontak).
    await expect(shadowVault.migrateAtRestSealing()).resolves.toBe(0);

    // …dan nilainya tetap terbaca benar setelah dibuka.
    const page = await shadowVault.getMessagesByConversation('c1', 10);
    expect(page[0]!.senderId).toBe('u_legacy');
    expect(page[0]!.isDeletedLocal).toBe(true);
    expect(page[0]!.isViewOnce).toBe(false);
    expect(page[0]!.repliedToId).toBe('msg_parent');
    expect(page[0]!.seq).toBe(7);
    expect(page[0]!.expiresAt).toBe(expiry);
    const convs = await shadowVault.getAllConversations();
    expect(convs.find((c) => c.id === 'c1')!.isGroup).toBe(true);
  });

  it('vault terkunci → migrasi TIDAK menghapus plaintext (hanya melewatinya)', async () => {
    const atRest = await import('../localAtRest');
    const mocks = {
      text: vi.mocked(atRest.sealLocalText),
      flag: vi.mocked(atRest.sealLocalFlag),
      num: vi.mocked(atRest.sealLocalNumber),
    };
    const original = {
      text: mocks.text.getMockImplementation(),
      flag: mocks.flag.getMockImplementation(),
      num: mocks.num.getMockImplementation(),
    };
    mocks.text.mockResolvedValue(null);
    mocks.flag.mockResolvedValue(null);
    mocks.num.mockResolvedValue(null);

    const createdAt = new Date(B0).toISOString();
    messageRows.set('locked1', {
      id: 'locked1',
      conversationId: 'c1',
      content: null,
      createdAt,
      senderId: 'u_plain',
      isDeletedLocal: true,
      seq: 9,
    });

    try {
      // Bucket indeks TETAP diisi (murni aritmetika waktu, tanpa kunci) supaya
      // barisnya tetap bisa ditemukan; yang tidak boleh terjadi adalah menghapus
      // plaintext tanpa berhasil membuat envelope.
      await expect(shadowVault.migrateAtRestSealing()).resolves.toBe(1);
    } finally {
      mocks.text.mockImplementation(original.text!);
      mocks.flag.mockImplementation(original.flag!);
      mocks.num.mockImplementation(original.num!);
    }

    const raw = messageRows.get('locked1')!;
    expect(raw.createdAt).toBe(createdAt);
    expect(raw.createdAtSealed).toBeUndefined();
    expect(raw.senderId).toBe('u_plain');
    expect(raw.isDeletedLocal).toBe(true);
    expect(raw.seq).toBe(9);
    // Barisnya tetap terbaca di query (bucket terisi).
    const page = await shadowVault.getMessagesByConversation('c1', 10);
    expect(page.map((m) => m.id)).toEqual(['locked1']);
    expect(page[0]!.createdAt).toBe(createdAt);
  });

  it('Conversation.isGroup di-seal, dan baris lama boolean tetap terbaca', async () => {
    await shadowVault.saveConversation({ id: 'c1', isGroup: true, participants: [] } as never);
    expect(typeof conversationRows.get('c1')!.isGroup).toBe('string');
    expect(String(conversationRows.get('c1')!.isGroup).startsWith('ENC1:')).toBe(true);

    // Catatan: stub `@lib/crypto-worker-proxy` di berkas ini tidak aman untuk
    // dekripsi KONKUREN (dynamic `import()` modul yang di-mock bisa menggantung
    // di lingkungan test), jadi tiap pembacaan dijalankan satu per satu —
    // `getAllConversations` produksi tetap memakai `Promise.all` yang sama.
    const sealed = await shadowVault.getAllConversations();
    expect(sealed.find((c) => c.id === 'c1')!.isGroup).toBe(true);

    // Baris lama dari klien pra-v10 (boolean plaintext) harus tetap terbaca.
    conversationRows.clear();
    conversationRows.set('c2', { id: 'c2', isGroup: false, participants: 'VAULT:W10=' });
    const legacy = await shadowVault.getAllConversations();
    expect(legacy.find((c) => c.id === 'c2')!.isGroup).toBe(false);

    conversationRows.clear();
    conversationRows.set('c3', { id: 'c3', isGroup: true, participants: 'VAULT:W10=' });
    const legacyGroup = await shadowVault.getAllConversations();
    expect(legacyGroup.find((c) => c.id === 'c3')!.isGroup).toBe(true);
  });
});

describe('shadowVault.getMessagesByConversation (indeks bucket)', () => {
  it('mengembalikan `limit` pesan terbaru, urut lama→baru', async () => {
    for (const [i, off] of [0, 1, 2, 3].entries()) {
      const row = await sealedRow(`m${i}`, 'conv_1', B0 + off * MIN);
      messageRows.set(row.id, row);
    }

    const page = await shadowVault.getMessagesByConversation('conv_1', 2);
    expect(page.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(page.map((m) => m.createdAt)).toEqual([
      new Date(B0 + 2 * MIN).toISOString(),
      new Date(B0 + 3 * MIN).toISOString(),
    ]);
  });

  it('kursor `beforeDate` inklusif dan tidak melewatkan baris di bucket batas', async () => {
    // Semua dalam SATU bucket — kasus yang dulu berisiko terlewat kalau
    // kandidat dipotong `limit` di level indeks.
    for (const [i, off] of [0, 1, 2, 3].entries()) {
      const row = await sealedRow(`m${i}`, 'conv_1', B0 + off * MIN);
      messageRows.set(row.id, row);
    }

    const cursor = new Date(B0 + 2 * MIN).toISOString();
    const page = await shadowVault.getMessagesByConversation('conv_1', 2, cursor);
    // Dua yang terbaru dan ≤ kursor; kursor sendiri ikut (inklusif).
    expect(page.map((m) => m.id)).toEqual(['m1', 'm2']);

    const olderPage = await shadowVault.getMessagesByConversation('conv_1', 5, new Date(B0 + MIN).toISOString());
    expect(olderPage.map((m) => m.id)).toEqual(['m0', 'm1']);
  });

  it('mengambil bucket yang lebih lama sampai halaman penuh', async () => {
    for (const [i, off] of [0, 1].entries()) {
      const row = await sealedRow(`new${i}`, 'conv_1', B0 + off * MIN);
      messageRows.set(row.id, row);
    }
    for (const [i, off] of [0, 1].entries()) {
      const row = await sealedRow(`old${i}`, 'conv_1', B0 - BUCKET + off * MIN);
      messageRows.set(row.id, row);
    }

    const page = await shadowVault.getMessagesByConversation('conv_1', 3);
    expect(page.map((m) => m.id)).toEqual(['old1', 'new0', 'new1']);
  });

  it('tidak mengambil pesan percakapan lain', async () => {
    messageRows.set('a', await sealedRow('a', 'conv_1', B0));
    messageRows.set('b', await sealedRow('b', 'conv_2', B0));
    const page = await shadowVault.getMessagesByConversation('conv_2', 10);
    expect(page.map((m) => m.id)).toEqual(['b']);
  });

  it('menyaring pesan kedaluwarsa dari halaman', async () => {
    messageRows.set('fresh', await sealedRow('fresh', 'conv_1', B0 + MIN));
    messageRows.set(
      'expired',
      await sealedRow('expired', 'conv_1', B0 + 2 * MIN, { expiresAt: new Date(Date.now() - MIN).toISOString() })
    );

    const page = await shadowVault.getMessagesByConversation('conv_1', 10);
    expect(page.map((m) => m.id)).toEqual(['fresh']);
  });

  it('memulihkan seq ter-seal (kursor paginasi server)', async () => {
    const row = await sealedRow('withSeq', 'conv_1', B0);
    row.seq = 'ENC1:' + Buffer.from('42', 'utf8').toString('base64');
    messageRows.set('withSeq', row);

    const page = await shadowVault.getMessagesByConversation('conv_1', 10);
    expect(page[0]!.seq).toBe(42);
  });
});
