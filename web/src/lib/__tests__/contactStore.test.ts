/**
 * [CONTACT STORE — P1 2026-10-05] Unit test helper normalisasi Participant +
 * serializer/parser bundle backup + CRUD contactStore (merge/seed/restore).
 *
 * Semua dependency eksternal (Dexie, vault crypto, auth store, api, sodium)
 * di-stub — tidak butuh Postgres/Redis (aturan repo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Stubs (vi.hoisted agar bisa dipakai di factory vi.mock) ──────────────

const { rows, authFetchMock } = vi.hoisted(() => ({
    rows: new Map<string, { userId: string; data: string; updatedAt: number }>(),
    // Tidak diberi tipe ketat — implementasi berbeda per test (sukses/restore/korup).
    authFetchMock: vi.fn(),
}));

vi.mock('../db', () => ({
    db: {
        contacts: {
            get: async (k: string) => rows.get(k),
            put: async (row: { userId: string; data: string; updatedAt: number }) => {
                rows.set(String(row.userId), row);
            },
            delete: async (k: string) => {
                rows.delete(String(k));
            },
            clear: async () => {
                rows.clear();
            },
            toArray: async () => Array.from(rows.values()),
        },
    },
}));

// Vault crypto stub: prefix ENC1: + base64 (mirror bentuk nyata secara kasar)
vi.mock('../shadowVaultDb', () => ({
    encryptVaultText: vi.fn(async (text: string) => 'ENC1:' + Buffer.from(text, 'utf8').toString('base64')),
    decryptVaultText: vi.fn(async (enc: string) =>
        enc.startsWith('ENC1:') ? Buffer.from(enc.slice(5), 'base64').toString('utf8') : null
    ),
}));

vi.mock('@store/auth', () => ({
    useAuthStore: {
        getState: () => ({ user: { id: 'me-user-id' } }),
    },
}));

vi.mock('@lib/api', () => ({
    authFetch: (...args: unknown[]) => authFetchMock(...(args as [])),
}));

// getSodium → null → contactStore jatuh ke hash fallback deterministik
vi.mock('@lib/sodiumInitializer', () => ({
    getSodium: vi.fn(async () => null),
}));

import {
    getParticipantUserId,
    serializeContactBundle,
    parseContactBundle,
    type ContactRecord,
} from '@nyx/shared';
import {
    upsertContact,
    setContactBlocked,
    getContact,
    getAllContacts,
    getActiveContacts,
    subscribeToContacts,
    deleteContact,
    seedContactsFromConversations,
    buildPeerParticipantsFromContacts,
    pushContactBundle,
    restoreContactsFromBundle,
    wipeContactBackup,
} from '../contactStore';

// ─── getParticipantUserId (shared, pure) ──────────────────────────────────

describe('getParticipantUserId', () => {
    it('prioritas userId > user.id > id (semantik legacy ||)', () => {
        expect(getParticipantUserId({ id: 'a', userId: 'b' })).toBe('b');
        expect(getParticipantUserId({ id: 'a', user: { id: 'c' } })).toBe('c');
        expect(getParticipantUserId({ id: 'a' })).toBe('a');
    });

    it('userId kosong-string jatuh ke kandidat berikutnya (bukan ??)', () => {
        expect(getParticipantUserId({ id: 'a', userId: '' })).toBe('a');
        expect(getParticipantUserId({ id: 'a', userId: '', user: { id: 'c' } })).toBe('c');
    });

    it('objek kosong → string kosong, bukan crash', () => {
        expect(getParticipantUserId({})).toBe('');
        expect(getParticipantUserId({ id: undefined, userId: null })).toBe('');
    });
});

// ─── ContactBundle serializer/parser (shared, pure) ───────────────────────

describe('serializeContactBundle', () => {
    it('dedupe by userId — lastSeenAt terbaru menang; urutan userId deterministik', () => {
        const out = serializeContactBundle([
            { userId: 'b', conversationId: 'c1', firstSeenAt: 1, lastSeenAt: 10 },
            { userId: 'a', conversationId: 'c2', firstSeenAt: 2, lastSeenAt: 20 },
            { userId: 'b', conversationId: 'c3', firstSeenAt: 3, lastSeenAt: 30 },
        ]);
        const parsed = parseContactBundle(out)!;
        expect(parsed.contacts.map(c => c.userId)).toEqual(['a', 'b']);
        expect(parsed.contacts.find(c => c.userId === 'b')!.conversationId).toBe('c3');
        expect(parsed.userIds).toEqual(['a', 'b']);
    });

    it('serialize → parse round-trip mempertahankan field', () => {
        const rec: ContactRecord = {
            userId: 'u1', conversationId: 'conv1', encryptedProfile: 'ep', publicKey: 'pk',
            firstSeenAt: 100, lastSeenAt: 200, alias: 'Budi', blocked: false
        };
        const parsed = parseContactBundle(serializeContactBundle([rec]))!;
        expect(parsed.v).toBe(1);
        expect(parsed.contacts[0]).toEqual(rec);
    });
});

describe('parseContactBundle', () => {
    it('JSON korup → null (fail-open, bukan throw)', () => {
        expect(parseContactBundle('{{{bukan json')).toBeNull();
        expect(parseContactBundle('')).toBeNull();
    });

    it('versi tak dikenal / contacts bukan array → null', () => {
        expect(parseContactBundle('{"v":2,"contacts":[]}')).toBeNull();
        expect(parseContactBundle('{"v":1,"contacts":"bukan"}')).toBeNull();
    });

    it('entri tidak valid di-skip; field hilang di-default', () => {
        const parsed = parseContactBundle(JSON.stringify({
            v: 1,
            contacts: [
                null,
                { userId: '' },                       // userId kosong → skip
                { userId: 'ok', encryptedProfile: 5, lastSeenAt: 'bukan angka' },
            ],
        }))!;
        expect(parsed.contacts.length).toBe(1);
        const c = parsed.contacts[0]!;
        expect(c.userId).toBe('ok');
        expect(c.encryptedProfile).toBeNull();
        expect(typeof c.lastSeenAt).toBe('number');
    });
});

// ─── CRUD contactStore (stub vault + Dexie) ───────────────────────────────

beforeEach(() => {
    rows.clear();
    authFetchMock.mockClear();
    authFetchMock.mockImplementation(async () => ({ success: true }));
    vi.useFakeTimers();
});

afterEach(async () => {
    // Drain timer yang masih pending SEBELUM fake timers dibuang: notify
    // kontak ber-debounce 50ms bisa tertinggal di akhir test → `notifyTimer`
    // (state module) ter-orphan non-null saat useRealTimers → semua
    // notifyContactsChanged() berikutnya no-op (test subscribe gagal).
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
});

async function flushPush(): Promise<void> {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_500);
}

describe('contactStore CRUD', () => {
    it('upsert membuat record terenkripsi at-rest', async () => {
        await upsertContact({ userId: 'peer1', conversationId: 'conv1', encryptedProfile: 'ep1' });
        const row = rows.get('peer1')!;
        expect(row).toBeDefined();
        expect(row.data.startsWith('ENC1:')).toBe(true); // ENCRYPTED, bukan plaintext
        const rec = await getContact('peer1');
        expect(rec!.conversationId).toBe('conv1');
        expect(rec!.encryptedProfile).toBe('ep1');
        expect(rec!.blocked).toBe(false);
    });

    it('upsert merge non-destruktif: field lama dipertahankan bila baru kosong', async () => {
        await upsertContact({ userId: 'peer1', conversationId: 'conv1', encryptedProfile: 'ep1' });
        await upsertContact({ userId: 'peer1', conversationId: 'conv1' }); // tanpa profile
        const rec = await getContact('peer1');
        expect(rec!.encryptedProfile).toBe('ep1');
    });

    it('guest_/burner_/system TIDAK masuk store', async () => {
        await upsertContact({ userId: 'guest_abc', conversationId: null });
        await upsertContact({ userId: 'nyx_system_id', conversationId: null });
        await upsertContact({ userId: 'burner_xyz', conversationId: null });
        expect(rows.size).toBe(0);
    });

    it('getAllContacts urut lastSeenAt terbaru dulu; getActiveContacts menyaring blocked', async () => {
        await upsertContact({ userId: 'a1', conversationId: null });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
        await upsertContact({ userId: 'a2', conversationId: null });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
        await upsertContact({ userId: 'a3', conversationId: null });
        await setContactBlocked('a3', true);

        const all = await getAllContacts();
        expect(all.map(c => c.userId)).toEqual(['a3', 'a2', 'a1']);
        const active = await getActiveContacts();
        expect(active.map(c => c.userId)).toEqual(['a2', 'a1']);

        await setContactBlocked('a3', false);
        expect((await getActiveContacts()).length).toBe(3);
    });

    it('deleteContact menghapus', async () => {
        await upsertContact({ userId: 'peer9', conversationId: null });
        await deleteContact('peer9');
        expect(await getContact('peer9')).toBeNull();
    });
});

describe('seedContactsFromConversations', () => {
    it('1:1 masuk, grup/burner/self di-skip; bentuk participant polimorfik dinormalisasi', async () => {
        await seedContactsFromConversations([
            {
                id: 'conv1', isGroup: false, participants: [
                    { id: 'me-user-id' as never, role: 'MEMBER' },
                    { id: 'x' as never, userId: 'peer-a' as never, encryptedProfile: 'ep-a', role: 'MEMBER' },
                ],
                lastMessage: null,
            } as never,
            {
                id: 'conv2', isGroup: true, participants: [
                    { id: 'peer-b' as never, role: 'MEMBER' },
                ], lastMessage: null,
            } as never,
            {
                id: 'burner_1', isGroup: false, participants: [
                    { id: 'peer-c' as never, role: 'MEMBER' },
                ], lastMessage: null,
            } as never,
        ]);
        const all = await getAllContacts();
        expect(all.map(c => c.userId)).toEqual(['peer-a']);
        expect(all[0]!.encryptedProfile).toBe('ep-a');
        expect(all[0]!.conversationId).toBe('conv1');
    });
});

describe('buildPeerParticipantsFromContacts', () => {
    it('rekonstruksi participants dari kontak dengan conversationId cocok', async () => {
        await upsertContact({ userId: 'peer-a', conversationId: 'conv1', encryptedProfile: 'ep-a' });
        await upsertContact({ userId: 'peer-other', conversationId: 'conv2' });
        const peers = await buildPeerParticipantsFromContacts('conv1');
        expect(peers.length).toBe(1);
        expect(String(peers[0]!.id)).toBe('peer-a');
        expect(peers[0]!.encryptedProfile).toBe('ep-a');
        expect(peers[0]!.role).toBe('MEMBER');
    });
});

// ─── Subscribe (UI live-refresh) ──────────────────────────────────

describe('subscribeToContacts', () => {
    it('mutasi memicu listener (debounced per-burst)', async () => {
        const listener = vi.fn();
        const unsub = subscribeToContacts(listener);
        await upsertContact({ userId: 'peer-sub', conversationId: 'conv-sub' });
        await vi.advanceTimersByTimeAsync(60);
        expect(listener).toHaveBeenCalledTimes(1);
        // Burst: 3 upsert berurutan → hanya SATU notif
        await Promise.all([
            upsertContact({ userId: 'b1', conversationId: 'c1' }),
            upsertContact({ userId: 'b2', conversationId: 'c1' }),
            upsertContact({ userId: 'b3', conversationId: 'c1' }),
        ]);
        await vi.advanceTimersByTimeAsync(60);
        expect(listener).toHaveBeenCalledTimes(2);
        unsub();
        await upsertContact({ userId: 'b4', conversationId: 'c1' });
        await vi.advanceTimersByTimeAsync(60);
        expect(listener).toHaveBeenCalledTimes(2); // tidak naik setelah unsub
    });

    it('restore yang menambah kontak memicu listener', async () => {
        const listener = vi.fn();
        const unsub = subscribeToContacts(listener);
        const bundleJson = JSON.stringify({
            v: 1,
            contacts: [
                { userId: 'peer-remote-x', conversationId: 'conv-x', firstSeenAt: 1, lastSeenAt: 2 },
            ],
            userIds: ['peer-remote-x'],
        });
        authFetchMock.mockImplementation(async () => ({
            encryptedBundle: 'ENC1:' + Buffer.from(bundleJson, 'utf8').toString('base64'),
        }));
        const { restoreContactsFromBundle } = await import('../contactStore');
        await restoreContactsFromBundle();
        await vi.advanceTimersByTimeAsync(60);
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });
});

// ─── Backup blob opaque (server) ──────────────────────────────────────────

describe('pushContactBundle / restore', () => {
    it('push mengirim blob terenkripsi + version (hash deterministik)', async () => {
        await upsertContact({ userId: 'peer1', conversationId: 'conv1' });
        await flushPush();

        expect(authFetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = authFetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
        expect(url).toBe('/api/users/me/contact-bundle');
        expect(init.method).toBe('PUT');
        const body = JSON.parse(init.body) as { encryptedBundle: string; version: number };
        expect(body.encryptedBundle.startsWith('ENC1:')).toBe(true);
        expect(body.version).toBeGreaterThan(0);

        // Push kedua tanpa perubahan → tidak ada HTTP (version-hash guard)
        await pushContactBundle();
        expect(authFetchMock).toHaveBeenCalledTimes(1);
    });

    it('version selalu hash 31-bit (aman Zod safe-int + kolom Postgres Int)', async () => {
        // Regresi: dulu mask 63-bit → version > Number.MAX_SAFE_INTEGER ditolak
        // Zod server ("Too big: expected int to be <=9007199254740991") dan
        // versi >2^31-1 akan meledak di kolom Prisma Int (Postgres INTEGER).
        const MAX_DB_INT = 0x7fffffff; // 2^31-1
        for (let i = 0; i < 5; i++) {
            await upsertContact({ userId: `peer-bound-${i}`, conversationId: `conv-bound-${i}`, alias: `n${i}` });
            await flushPush();
            const [url, init] = authFetchMock.mock.calls.at(-1) as unknown as [string, { method: string; body: string }];
            expect(url).toBe('/api/users/me/contact-bundle');
            const body = JSON.parse(init.body) as { version: number };
            expect(Number.isSafeInteger(body.version)).toBe(true);
            expect(body.version).toBeGreaterThanOrEqual(0);
            expect(body.version).toBeLessThanOrEqual(MAX_DB_INT);
        }
    });

    it('restore menambahkan HANYA kontak yang belum ada lokal; lokal menang', async () => {
        await upsertContact({ userId: 'peer-local', conversationId: 'conv-lokal', encryptedProfile: 'lokal' });
        await flushPush();
        authFetchMock.mockClear();

        const bundleJson = JSON.stringify({
            v: 1,
            contacts: [
                { userId: 'peer-local', conversationId: 'conv-server', encryptedProfile: 'server', firstSeenAt: 1, lastSeenAt: 2 },
                { userId: 'peer-remote', conversationId: 'conv-server2', encryptedProfile: 'remote', firstSeenAt: 1, lastSeenAt: 2 },
            ],
            userIds: ['peer-local', 'peer-remote'],
        });
        authFetchMock.mockImplementation(async () => ({
            encryptedBundle: 'ENC1:' + Buffer.from(bundleJson, 'utf8').toString('base64'),
        }));

        const added = await restoreContactsFromBundle();
        expect(added).toBe(1);
        // lokal menang — profil server TIDAK menimpa
        expect((await getContact('peer-local'))!.encryptedProfile).toBe('lokal');
        expect((await getContact('peer-remote'))!.encryptedProfile).toBe('remote');
    });

    it('bundle korup → restore tidak menghapus kontak lokal (fail-open)', async () => {
        await upsertContact({ userId: 'peer-keep', conversationId: null });
        authFetchMock.mockImplementation(async () => ({
            encryptedBundle: 'ENC1:' + Buffer.from('{{{korup', 'utf8').toString('base64'),
        }));
        const added = await restoreContactsFromBundle();
        expect(added).toBe(0);
        expect(await getContact('peer-keep')).not.toBeNull();
    });

    it('push gagal (server error) TIDAK melempar — backup best-effort', async () => {
        authFetchMock.mockImplementation(async () => { throw new Error('network down'); });
        await upsertContact({ userId: 'peer1', conversationId: null });
        await flushPush();
        expect(await getContact('peer1')).not.toBeNull(); // lokal tetap utuh
    });

    it('wipe menghapus lokal + server', async () => {
        await upsertContact({ userId: 'peer1', conversationId: null });
        await flushPush();
        authFetchMock.mockClear();
        authFetchMock.mockImplementation(async () => ({ success: true }));
        await wipeContactBackup();
        expect(rows.size).toBe(0);
        const [url, init] = authFetchMock.mock.calls[0] as unknown as [string, { method: string }];
        expect(url).toBe('/api/users/me/contact-bundle');
        expect(init.method).toBe('DELETE');
    });
});
