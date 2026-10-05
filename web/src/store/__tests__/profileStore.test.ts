/**
 * [FIX UI ANONYMOUS 2026-10-05] Profile store — dual-write alias plain-id.
 *
 * Bug: decryptAndCache/getCacheOnly hanya menulis/membaca key komposit
 * `${id}_${ep.slice(0,32)}` sedangkan UI (useUserProfile participant tanpa ep,
 * ContactRow kontak tanpa ep) membaca key polos `${id}` → profil sukses
 * didekripsi TETAP tak terlihat → "Anonymous" senyap di picker/panel grup.
 *
 * Semua dependency eksternal (worker dekripsi, keychain, Dexie) di-stub —
 * tidak butuh Postgres/Redis (aturan repo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ramProfiles, idbProfiles, profileKeys, decryptProfileMock } = vi.hoisted(() => ({
    ramProfiles: new Map<string, unknown>(),
    idbProfiles: new Map<string, { id: string; name: string; avatarUrl: string | null; description: string | null; encryptedHash: string; updatedAt: number }>(),
    profileKeys: new Map<string, string>(),
    decryptProfileMock: vi.fn(async (_ep: string, _key: string) => JSON.stringify({ name: 'Peer Name', username: 'peer', avatarUrl: null })),
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
    decryptProfile: (...args: unknown[]) => decryptProfileMock(...(args as [string, string])),
}));

vi.mock('@lib/keychainDb', () => ({
    getProfileKey: async (userId: string) => profileKeys.get(userId),
}));

vi.mock('@lib/db', () => ({
    db: {
        profileCache: {
            get: async (userId: string) => idbProfiles.get(userId),
            put: async (row: { id: string; name: string; avatarUrl: string | null; description: string | null; encryptedHash: string; updatedAt: number }) => {
                idbProfiles.set(row.id, row);
            },
        },
    },
}));

import { useProfileStore, hydrateProfileForPlainId } from '../profile';

const EP = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('profileStore dual-write alias plain-id', () => {
    beforeEach(() => {
        ramProfiles.clear();
        idbProfiles.clear();
        profileKeys.clear();
        decryptProfileMock.mockClear();
        useProfileStore.setState({ profiles: {} });
    });

    it('dekripsi sukses menulis key komposit DAN alias plain-id', async () => {
        profileKeys.set('peer1', 'k1');
        const parsed = await useProfileStore.getState().decryptAndCache('peer1', EP);
        expect(parsed.name).toBe('Peer Name');
        const profiles = useProfileStore.getState().profiles;
        expect(profiles[`peer1_${EP.substring(0, 32)}`]).toBeDefined();
        expect(profiles['peer1']).toBeDefined(); // alias — inilah yang dibaca UI
        expect(profiles['peer1']!.name).toBe('Peer Name');
    });

    it('getCacheOnly menemukan profil via alias walau key komposit belum ada', async () => {
        // Simulasi: entri hanya alias (hasil dekripsi sebelumnya)
        useProfileStore.setState({ profiles: { peer2: { name: 'Alias Only', avatarUrl: null, description: null } } });
        const res = await useProfileStore.getState().getCacheOnly('peer2', EP);
        expect(res?.name).toBe('Alias Only');
    });

    it('decryptAndCache TANPA ep mengembalikan cache RAM alias tanpa dekripsi', async () => {
        useProfileStore.setState({ profiles: { peer3: { name: 'Cached', avatarUrl: null, description: null } } });
        const res = await useProfileStore.getState().decryptAndCache('peer3', null);
        expect(res?.name).toBe('Cached');
        expect(decryptProfileMock).not.toHaveBeenCalled();
    });

    it('decryptAndCache DENGAN ep TIDAK short-circuit di alias — profil basi diperbarui', async () => {
        // Alias lama ada, tapi pemanggil membawa ep TERBARU → wajib decrypt,
        // bukan menyematkan nama basi dari alias (dulu: alias selalu menang).
        useProfileStore.setState({ profiles: { peer3: { name: 'Old Name', avatarUrl: null, description: null } } });
        profileKeys.set('peer3', 'k3');
        const res = await useProfileStore.getState().decryptAndCache('peer3', EP);
        expect(res?.name).toBe('Peer Name'); // hasil dekripsi ep baru
        expect(decryptProfileMock).toHaveBeenCalledTimes(1);
        const profiles = useProfileStore.getState().profiles;
        expect(profiles['peer3']!.name).toBe('Peer Name'); // alias ikut segar
        expect(profiles[`peer3_${EP.substring(0, 32)}`]).toBeDefined();
    });

    it('tanpa profileKey → fallback "Encrypted User" (tanpa alias — jangan cache nama palsu)', async () => {
        const res = await useProfileStore.getState().decryptAndCache('peer4', EP);
        expect(res?.name).toBe('Encrypted User');
        expect(useProfileStore.getState().profiles['peer4']).toBeUndefined();
    });

    it('IDB hit (encryptedHash cocok) mengisi RAM komposit + alias', async () => {
        idbProfiles.set('peer5', { id: 'peer5', name: 'IDB Name', avatarUrl: null, description: null, encryptedHash: EP, updatedAt: 1 });
        const res = await useProfileStore.getState().decryptAndCache('peer5', EP);
        expect(res?.name).toBe('IDB Name');
        const profiles = useProfileStore.getState().profiles;
        expect(profiles['peer5']).toBeDefined();
        expect(profiles[`peer5_${EP.substring(0, 32)}`]).toBeDefined();
        expect(decryptProfileMock).not.toHaveBeenCalled();
    });

    it('IDB hit dengan encryptedHash BEDA diabaikan (bukan profil yang sama)', async () => {
        idbProfiles.set('peer6', { id: 'peer6', name: 'Stale', avatarUrl: null, description: null, encryptedHash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', updatedAt: 1 });
        const res = await useProfileStore.getState().getCacheOnly('peer6', EP);
        expect(res).toBeNull();
    });

    it('hydrateProfileForPlainId: RAM → IDB → decrypt (dengan ep) → null', async () => {
        // 1) kosong semua tanpa ep → null (tidak melempar)
        expect(await hydrateProfileForPlainId('h1')).toBeNull();

        // 2) IDB hit → dihidrasi ke alias plain-id
        idbProfiles.set('h2', { id: 'h2', name: 'From IDB', avatarUrl: null, description: null, encryptedHash: EP, updatedAt: 1 });
        expect(await hydrateProfileForPlainId('h2')).toMatchObject({ name: 'From IDB' });
        expect(useProfileStore.getState().profiles['h2']).toBeDefined();

        // 3) tidak ada di RAM/IDB tapi ep tersedia → dekripsi penuh
        profileKeys.set('h3', 'k3');
        expect(await hydrateProfileForPlainId('h3', EP)).toMatchObject({ name: 'Peer Name' });
        expect(useProfileStore.getState().profiles['h3']).toBeDefined();
    });
});
