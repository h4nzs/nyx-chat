// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.2] Pin identitas peer (TOFU) — unit tests.
 *
 * Regresi yang dikunci: dulu setiap jalur TOFU menimpa pin setelah memunculkan
 * peringatan (`savePeerIdentityKey`), sehingga peringatan hanya muncul SEKALI
 * dan `safety number` yang sudah diverifikasi user berhenti cocok diam-diam.
 * Sekarang `trustedKey` hanya berubah lewat penerimaan eksplisit user, dan
 * perubahan yang belum diterima memblokir pengiriman pesan 1:1.
 *
 * DB & keychain di-stub: kontrak yang diuji adalah LOGIKA pin + bentuk
 * penyimpanan terenkripsi (`ENC1:`), bukan IndexedDB/Dexie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvStore = new Map<string, { key: string; value: unknown }>();
const identityKeys = new Map<string, { userId: string; key: string }>();
const conversationState = { conversations: [] as unknown[] };
const authState = { user: { id: 'me' } as { id: string } | null };

vi.mock('@lib/db', () => ({
    db: {
        kvStore: {
            get: async (key: string) => kvStore.get(key),
            put: async (row: { key: string; value: unknown }) => { kvStore.set(row.key, row); },
            delete: async (key: string) => { kvStore.delete(key); },
        },
        identityKeys: {
            get: async (userId: string) => identityKeys.get(userId),
        },
    },
}));

vi.mock('@lib/keychainDb', () => ({
    // Bentuk nyata: `ENC1:` + base64. Cukup untuk memastikan nilai TIDAK
    // tersimpan plaintext di kvStore.
    encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
    decryptValueAtRest: vi.fn(async (stored: string) =>
        stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
    ),
}));

vi.mock('@store/conversation', () => ({
    useConversationStore: { getState: () => conversationState },
}));

vi.mock('@store/auth', () => ({
    useAuthStore: { getState: () => authState },
}));

vi.mock('@nyx/shared', () => ({
    getParticipantUserId: (p: { userId?: string; id?: string }) => p.userId ?? p.id ?? '',
}));

// Penurunan username peer (profil E2EE) di-stub: yang diuji di sini adalah
// keputusan pin, bukan cara mencari username. Default: tidak diketahui →
// verifikasi KT dilewati (TOFU).
vi.mock('@lib/ktSubject', () => ({
    resolvePeerUsername: vi.fn(async () => undefined),
    clearKtSubjectCache: vi.fn(),
}));

import {
    acceptPendingPeerIdentity,
    clearPeerIdentityTrust,
    getPeerIdentityTrust,
    hasPendingIdentityChangeForConversation,
    hasPendingPeerIdentityChange,
    listPendingPeerIdentityChanges,
    observePeerIdentityKey,
} from '../peerIdentityTrust';

const PEER = 'peer-1';
const KEY_A = 'identity-key-A';
const KEY_B = 'identity-key-B';

beforeEach(async () => {
    await clearPeerIdentityTrust();
    kvStore.clear();
    identityKeys.clear();
    conversationState.conversations = [];
    authState.user = { id: 'me' };
});

describe('pin identitas peer (TOFU)', () => {
    it('kunci pertama = new, pin tersimpan TERENKRIPSI (bukan plaintext)', async () => {
        expect(await observePeerIdentityKey(PEER, KEY_A)).toEqual({ status: 'new' });
        const record = await getPeerIdentityTrust(PEER);
        expect(record?.trustedKey).toBe(KEY_A);

        const stored = kvStore.get('nyx_peer_identity_v1');
        expect(typeof stored?.value).toBe('string');
        expect(String(stored?.value).startsWith('ENC1:')).toBe(true);
        expect(String(stored?.value)).not.toContain(KEY_A);
    });

    it('kunci sama = unchanged (tidak menulis ulang pin)', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        expect(await observePeerIdentityKey(PEER, KEY_A)).toEqual({ status: 'unchanged' });
        expect((await getPeerIdentityTrust(PEER))?.trustedKey).toBe(KEY_A);
    });

    it('kunci berubah = changed TAPI pin lama TIDAK ditimpa (regresi utama)', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        const observation = await observePeerIdentityKey(PEER, KEY_B);
        expect(observation).toMatchObject({ status: 'changed', trustedKey: KEY_A, pendingKey: KEY_B });

        const record = await getPeerIdentityTrust(PEER);
        expect(record?.trustedKey).toBe(KEY_A); // pin lama utuh
        expect(record?.pendingKey).toBe(KEY_B);
        expect(record?.changedAt).toBeGreaterThan(0);
    });

    it('perubahan BERULANG tetap terdeteksi (dulu peringatan hanya sekali)', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        await observePeerIdentityKey(PEER, KEY_B);
        // Penyerang mengamati lagi kunci ketiga → masih 'changed' terhadap pin A.
        expect((await observePeerIdentityKey(PEER, 'identity-key-C')).status).toBe('changed');
        expect((await getPeerIdentityTrust(PEER))?.trustedKey).toBe(KEY_A);
    });

    it('pending change terlihat oleh gate kirim & didaftarkan untuk banner', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(false);

        await observePeerIdentityKey(PEER, KEY_B);
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(true);

        const pending = await listPendingPeerIdentityChanges();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ peerId: PEER, previousKey: KEY_A, pendingKey: KEY_B });
    });

    it('menerima kunci baru memindahkan pin + menyimpan riwayat, lalu membuka gate', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        await observePeerIdentityKey(PEER, KEY_B);

        expect(await acceptPendingPeerIdentity(PEER)).toBe(KEY_B);
        const record = await getPeerIdentityTrust(PEER);
        expect(record?.trustedKey).toBe(KEY_B);
        expect(record?.previousKey).toBe(KEY_A);
        expect(record?.pendingKey).toBeUndefined();
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(false);
        expect(await acceptPendingPeerIdentity(PEER)).toBeNull(); // idempoten
    });

    it('kunci kembali cocok dengan pin = pending dibersihkan (tak ada gate palsu)', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        await observePeerIdentityKey(PEER, KEY_B);
        expect(await observePeerIdentityKey(PEER, KEY_A)).toEqual({ status: 'unchanged' });
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(false);
    });

    it('pin legacy plaintext (ID_PUB_*) diadopsi tanpa warning palsu', async () => {
        identityKeys.set(`ID_PUB_${PEER}`, { userId: `ID_PUB_${PEER}`, key: KEY_A });
        expect(await observePeerIdentityKey(PEER, KEY_A)).toEqual({ status: 'unchanged' });
        expect((await getPeerIdentityTrust(PEER))?.trustedKey).toBe(KEY_A);
    });

    it('gate percakapan 1:1: peer dengan pending change diblokir, grup diabaikan', async () => {
        await observePeerIdentityKey(PEER, KEY_A);
        await observePeerIdentityKey(PEER, KEY_B);

        conversationState.conversations = [
            { id: 'conv-1', isGroup: false, participants: [{ userId: PEER }, { userId: 'me' }] },
            { id: 'conv-2', isGroup: true, participants: [{ userId: PEER }, { userId: 'me' }] },
        ];
        expect(await hasPendingIdentityChangeForConversation('conv-1')).toBe(true);
        expect(await hasPendingIdentityChangeForConversation('conv-2')).toBe(false);

        await acceptPendingPeerIdentity(PEER);
        expect(await hasPendingIdentityChangeForConversation('conv-1')).toBe(false);
    });
});

/**
 * [docs/34 §34.6 poin 1] Verifikasi log Key Transparency di jalur TOFU.
 *
 * Yang dikunci: `mismatch` dari log yang buktinya SAH tidak boleh menjadi pin
 * biasa — termasuk pada kontak PERTAMA, kasus yang dulu tak terdeteksi siapa pun
 * (pin pertama selalu dipercaya).
 */
describe('pin identitas peer vs log Key Transparency', () => {
    const LOG_KEY = 'aa'.repeat(32);
    const mismatchCheck = vi.fn(async () => ({
        status: 'mismatch',
        keyVersion: 2,
        logIdentityKey: LOG_KEY,
    }));

    it('mismatch pada kontak pertama memblokir kirim + tercatat (bukan pin diam-diam)', async () => {
        const observation = await observePeerIdentityKey(PEER, KEY_A, {
            username: 'alice',
            checkKeyTransparency: mismatchCheck,
            now: 1_000,
        });

        expect(observation).toEqual({
            status: 'changed',
            trustedKey: KEY_A,
            pendingKey: KEY_A,
            source: 'kt',
        });

        const record = await getPeerIdentityTrust(PEER);
        expect(record?.ktMismatch).toEqual({ servedKey: KEY_A, logKey: LOG_KEY, at: 1_000 });
        expect(record?.ktVerifiedAt).toBeUndefined();

        // Gate kirim & banner memakai `pendingKey !== trustedKey` — mismatch harus
        // tetap terlihat walau pin belum pernah berganti.
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(true);
        const pending = await listPendingPeerIdentityChanges();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ peerId: PEER, pendingKey: KEY_A, source: 'kt' });
    });

    it('penerimaan user membersihkan mismatch (gate terbuka setelah verifikasi manual)', async () => {
        await observePeerIdentityKey(PEER, KEY_A, { username: 'alice', checkKeyTransparency: mismatchCheck });
        expect(await acceptPendingPeerIdentity(PEER)).toBe(KEY_A);

        const record = await getPeerIdentityTrust(PEER);
        expect(record?.ktMismatch).toBeUndefined();
        expect(record?.ktLastVerdict).toBe('mismatch-acknowledged');
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(false);
        expect(await acceptPendingPeerIdentity(PEER)).toBeNull();
    });

    it('konfirmasi log mencatat ktVerifiedAt dan TIDAK memanggil log lagi dalam TTL', async () => {
        const confirmed = vi.fn(async () => ({ status: 'confirmed', keyVersion: 1 }));
        await observePeerIdentityKey(PEER, KEY_A, {
            username: 'alice',
            checkKeyTransparency: confirmed,
            now: 1_000,
        });
        expect((await getPeerIdentityTrust(PEER))?.ktVerifiedAt).toBe(1_000);
        expect(confirmed).toHaveBeenCalledTimes(1);

        // Pengamatan berikutnya (kunci sama, dalam TTL) tidak memanggil log.
        await observePeerIdentityKey(PEER, KEY_A, {
            username: 'alice',
            checkKeyTransparency: confirmed,
            now: 2_000,
        });
        expect(confirmed).toHaveBeenCalledTimes(1);

        // Lewat TTL → diperiksa lagi.
        await observePeerIdentityKey(PEER, KEY_A, {
            username: 'alice',
            checkKeyTransparency: confirmed,
            now: 1_000 + 25 * 60 * 60 * 1000,
        });
        expect(confirmed).toHaveBeenCalledTimes(2);
    });

    it('mismatch pada kunci baru membawa sumber kt di daftar pending', async () => {
        await observePeerIdentityKey(PEER, KEY_A, { username: 'alice', checkKeyTransparency: mismatchCheck });
        const record = await getPeerIdentityTrust(PEER);
        expect(record?.trustedKey).toBe(KEY_A);

        // Log kini sepakat dengan kunci baru → mismatch lama selesai sendiri dan
        // perubahan berikutnya kembali ber-sumber TOFU.
        const confirmed = vi.fn(async () => ({ status: 'confirmed', keyVersion: 3 }));
        const observation = await observePeerIdentityKey(PEER, KEY_B, {
            username: 'alice',
            checkKeyTransparency: confirmed,
        });
        expect(observation).toMatchObject({ status: 'changed', pendingKey: KEY_B, source: 'tofu' });
        const after = await getPeerIdentityTrust(PEER);
        expect(after?.trustedKey).toBe(KEY_A);
        expect(after?.ktMismatch).toBeUndefined();
    });

    it('username tak diketahui = unknown-subject: TOFU seperti sebelum KT (tanpa gate palsu)', async () => {
        const check = vi.fn(async () => ({ status: 'confirmed', keyVersion: 1 }));
        const observation = await observePeerIdentityKey(PEER, KEY_A, { checkKeyTransparency: check });

        expect(observation).toEqual({ status: 'new' });
        expect(check).not.toHaveBeenCalled();
        const record = await getPeerIdentityTrust(PEER);
        expect(record?.trustedKey).toBe(KEY_A);
        expect(await hasPendingPeerIdentityChange(PEER)).toBe(false);
    });
});
