/**
 * [PROFILE KEY DISTRIBUTION 2026-10-05] Unit test distribusi kunci profil:
 *   • mergeMyProfileKeyIntoRoster — penulis metadata menyuntik kunci MILIKNYA
 *     sendiri ke entri roster (pola Signal sender-keys), bukan koleksi orang.
 *   • applyGroupProfileKeys — pembaca menyimpan kunci peer (first-wins) +
 *     trigger PROFILE_SYNC bila entri sendiri belum membawa kunci (kasus
 *     anggota pasif).
 *   • shouldFireProfileSync / maybeFireProfileSync — fallback sekali per
 *     (device, conversation).
 *
 * Semua dependency eksternal (keychain, store, sendMessage) di-stub — tanpa
 * Postgres/Redis (aturan repo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { profileKeys, rosterState, sendMessageMock } = vi.hoisted(() => ({
    profileKeys: new Map<string, string>(),
    rosterState: { members: [] as Array<Record<string, unknown>> },
    sendMessageMock: vi.fn(async () => {}),
}));

vi.mock('@store/conversation', () => ({
    useConversationStore: {
        getState: () => ({
            conversations: [
                { id: 'conv1', isGroup: true, decryptedMetadata: { v: 3, members: rosterState.members } },
            ],
        }),
    },
}));

vi.mock('@store/auth', () => ({
    useAuthStore: {
        getState: () => ({ user: { id: 'me-user' } }),
    },
}));

vi.mock('@lib/keychainDb', () => ({
    getProfileKey: async (userId: string) => profileKeys.get(userId),
    saveProfileKey: async (userId: string, key: string) => {
        profileKeys.set(userId, key);
    },
}));

vi.mock('@store/message', () => ({
    useMessageStore: {
        getState: () => ({
            sendMessage: sendMessageMock,
        }),
    },
}));

import { parseGroupMembers } from '@nyx/shared';
import {
    mergeMyProfileKeyIntoRoster,
    applyGroupProfileKeys,
    shouldFireProfileSync,
    maybeFireProfileSync,
    resetProfileSyncState,
} from '../groupProfileKeys';

const ROSTER: Array<{ userId: string; role: string; joinedAtGeneration: number; profileKey?: string }> = [
    { userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1 },
    { userId: 'peer-a', role: 'MEMBER', joinedAtGeneration: 1 },
    { userId: 'peer-b', role: 'ADMIN', joinedAtGeneration: 1 },
];

describe('parseGroupMembers — field profileKey (shared)', () => {
    it('mempertahankan profileKey string valid', () => {
        const roster = [
            { userId: 'u1', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 'k1' },
        ];
        expect(parseGroupMembers(roster)).toEqual(roster);
    });

    it('buang profileKey non-string / kosong (whitelist ketat)', () => {
        const out = parseGroupMembers([
            { userId: 'u1', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 123 },
            { userId: 'u2', role: 'MEMBER', joinedAtGeneration: 1, profileKey: '' },
            { userId: 'u3', role: 'MEMBER', joinedAtGeneration: 1 },
        ]);
        expect(out[0]!.profileKey).toBeUndefined();
        expect(out[1]!.profileKey).toBeUndefined();
        expect(out[2]!.profileKey).toBeUndefined();
    });
});

describe('mergeMyProfileKeyIntoRoster (penulis metadata)', () => {
    beforeEach(() => {
        profileKeys.clear();
        resetProfileSyncState();
    });

    it('menyuntik kunci MILIK SENDIRI ke entri roster-nya (bukan orang lain)', async () => {
        profileKeys.set('me-user', 'k-me');
        const members = ROSTER.map(m => ({ ...m }));
        await mergeMyProfileKeyIntoRoster(members, 'conv1');
        expect(members.find(m => m.userId === 'me-user')!.profileKey).toBe('k-me');
        expect(members.find(m => m.userId === 'peer-a')!.profileKey).toBeUndefined();
        expect(members.find(m => m.userId === 'peer-b')!.profileKey).toBeUndefined();
    });

    it('tanpa kunci di keychain → roster tetap polos (tanpa error)', async () => {
        const members = ROSTER.map(m => ({ ...m }));
        await mergeMyProfileKeyIntoRoster(members, 'conv1');
        expect(members.every(m => m.profileKey === undefined)).toBe(true);
    });
});

describe('applyGroupProfileKeys (pembaca metadata)', () => {
    beforeEach(() => {
        profileKeys.clear();
        resetProfileSyncState();
        sendMessageMock.mockClear();
    });

    it('simpan kunci peer (first-wins) — kunci peer yang sudah ada TIDAK ditimpa', async () => {
        profileKeys.set('peer-a', 'lama');
        rosterState.members = [
            { userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 'k-me' },
            { userId: 'peer-a', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 'baru' },
        ];
        const summary = await applyGroupProfileKeys('conv1', rosterState.members);
        expect(profileKeys.get('peer-a')).toBe('lama');
        expect(summary.withKeys).toBe(1);
        expect(summary.mine).toBe(true);
        // Entri saya membawa kunci → TIDAK memicu PROFILE_SYNC
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('kasus anggota pasif: entri saya tanpa kunci → trigger PROFILE_SYNC sekali', async () => {
        rosterState.members = [
            { userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1 },
            { userId: 'peer-a', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 'k-a' },
        ];
        profileKeys.set('me-user', 'k-me');
        await applyGroupProfileKeys('conv1', rosterState.members);
        // async void trigger — beri satu tick
        await new Promise(r => setTimeout(r, 0));
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        const [convId, payload] = sendMessageMock.mock.calls[0] as unknown as [string, { content: string; isSilent: boolean }];
        expect(convId).toBe('conv1');
        expect(payload.isSilent).toBe(true);
        expect(JSON.parse(payload.content)).toEqual({ type: 'PROFILE_SYNC', profileKey: 'k-me' });
    });

    it('dedupe: PROFILE_SYNC kedua untuk conversation sama tidak mengirim ulang', async () => {
        rosterState.members = [{ userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1 }];
        profileKeys.set('me-user', 'k-me');
        await maybeFireProfileSync('conv1');
        const again = await maybeFireProfileSync('conv1');
        expect(again).toBe(false);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('shouldFireProfileSync: false bila entri saya sudah membawa kunci', async () => {
        rosterState.members = [
            { userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1, profileKey: 'k-me' },
        ];
        expect(await shouldFireProfileSync('conv1')).toBe(false);
    });

    it('pengirim PROFILE_SYNC tanpa kunci di keychain → tidak mengirim', async () => {
        rosterState.members = [{ userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 1 }];
        // me-user TIDAK punya kunci
        expect(await maybeFireProfileSync('conv2')).toBe(false);
        expect(sendMessageMock).not.toHaveBeenCalled();
    });
});
