/**
 * [CONTACT TRUST — P4 2026-10-05] Unit test helper pure trust level.
 * Tanpa dependency eksternal — pure functions.
 */
import { describe, it, expect } from 'vitest';
import {
    computeContactTrust,
    getTrustRank,
    compareByTrustDescThenRecency,
    type ContactTrustLevel,
} from '../contactTrust';

describe('computeContactTrust', () => {
    it('verified > known > stranger sesuai hierarki', () => {
        expect(computeContactTrust({ inContacts: false, isVerified: true })).toBe('verified');
        expect(computeContactTrust({ inContacts: true, isVerified: true })).toBe('verified');
        expect(computeContactTrust({ inContacts: true })).toBe('known');
        expect(computeContactTrust({ inContacts: false })).toBe('stranger');
    });

    it('blocked SELALU stranger — meski terverifikasi sekalipun', () => {
        expect(computeContactTrust({ inContacts: true, isVerified: true, blocked: true })).toBe('stranger');
        expect(computeContactTrust({ inContacts: true, blocked: true })).toBe('stranger');
    });

    it('isVerified tanpa inContacts tetap verified (fingerprint > riwayat)', () => {
        expect(computeContactTrust({ inContacts: false, isVerified: true })).toBe('verified');
    });
});

describe('getTrustRank', () => {
    it('peringkat naik stranger < known < verified', () => {
        expect(getTrustRank('stranger')).toBeLessThan(getTrustRank('known'));
        expect(getTrustRank('known')).toBeLessThan(getTrustRank('verified'));
    });
});

describe('compareByTrustDescThenRecency', () => {
    const mk = (userId: string, trust: ContactTrustLevel, lastSeenAt: number) => ({ userId, trust, lastSeenAt });

    it('trust tertentu dulu; rekansi pemutus di dalam level yang sama', () => {
        const sorted = [
            mk('u-known-old', 'known', 100),
            mk('u-verified', 'verified', 1),
            mk('u-stranger', 'stranger', 999),
            mk('u-known-new', 'known', 500),
        ].sort(compareByTrustDescThenRecency);
        expect(sorted.map(u => u.userId)).toEqual(['u-verified', 'u-known-new', 'u-known-old', 'u-stranger']);
    });

    it('tie-breaker userId — deterministik untuk dua kontak identik', () => {
        const sorted = [mk('b', 'known', 100), mk('a', 'known', 100)].sort(compareByTrustDescThenRecency);
        expect(sorted.map(u => u.userId)).toEqual(['a', 'b']);
    });

    it('sort stabil untuk array kosong/element tunggal (tidak crash)', () => {
        expect([].sort(compareByTrustDescThenRecency)).toEqual([]);
        const single = [mk('only', 'stranger', 0)].sort(compareByTrustDescThenRecency);
        expect(single.length).toBe(1);
    });
});
