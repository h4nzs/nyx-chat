// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §5.5 / §7.3] Metadata struktur lokal: bucket waktu + seal angka.
 *
 * Yang dikunci:
 *   1. `lastMessageAt` dipotong ke bucket 15 menit (paritas server) — tidak ada
 *      presisi detik di IndexedDB.
 *   2. `seq` tersimpan sebagai envelope `ENC1:`, tapi tetap terbaca sebagai
 *      angka (termasuk baris lama berbentuk plaintext).
 *   3. Vault benar-benar memakai helper ini (guardrail wiring).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/keychainDb', () => ({
    AT_REST_PREFIX: 'ENC1:',
    encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
    decryptValueAtRest: vi.fn(async (stored: string) =>
        stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
    ),
}));

import {
    LOCAL_TIME_BUCKET_MS,
    bucketLocalTimestamp,
    openLocalNumber,
    sealLocalNumber,
} from '../localAtRest';

describe('bucketLocalTimestamp', () => {
    it('memotong ke bucket 15 menit (floor, deterministik)', () => {
        expect(LOCAL_TIME_BUCKET_MS).toBe(15 * 60 * 1000);
        expect(bucketLocalTimestamp('2026-10-11T10:07:43.512Z')).toBe('2026-10-11T10:00:00.000Z');
        expect(bucketLocalTimestamp('2026-10-11T10:14:59.999Z')).toBe('2026-10-11T10:00:00.000Z');
        expect(bucketLocalTimestamp('2026-10-11T10:15:00.000Z')).toBe('2026-10-11T10:15:00.000Z');
        expect(bucketLocalTimestamp(new Date('2026-10-11T10:15:00.001Z'))).toBe('2026-10-11T10:15:00.000Z');
    });

    it('nilai kosong/tak valid → null (bukan epoch palsu)', () => {
        expect(bucketLocalTimestamp(null)).toBeNull();
        expect(bucketLocalTimestamp(undefined)).toBeNull();
        expect(bucketLocalTimestamp('')).toBeNull();
        expect(bucketLocalTimestamp('bukan-tanggal')).toBeNull();
    });

    it('monotonik: pesan yang lebih baru tidak pernah terurut mundur', () => {
        const older = bucketLocalTimestamp('2026-10-11T10:00:01.000Z')!;
        const newer = bucketLocalTimestamp('2026-10-11T10:20:00.000Z')!;
        expect(Date.parse(newer)).toBeGreaterThan(Date.parse(older));
    });
});

describe('sealLocalNumber / openLocalNumber', () => {
    it('round-trip lewat envelope ENC1 (bukan angka plaintext)', async () => {
        const sealed = await sealLocalNumber(42);
        expect(typeof sealed).toBe('string');
        expect(sealed!.startsWith('ENC1:')).toBe(true);
        expect(sealed).not.toContain('42');
        expect(await openLocalNumber(sealed)).toBe(42);
    });

    it('baris lama plaintext tetap terbaca (perangkat user tidak bisa di-reset)', async () => {
        expect(await openLocalNumber(7)).toBe(7);
        expect(await openLocalNumber('7')).toBe(7);
    });

    it('nilai tak valid → null (bukan NaN)', async () => {
        expect(await sealLocalNumber(null)).toBeNull();
        expect(await sealLocalNumber(Number.NaN)).toBeNull();
        expect(await openLocalNumber(null)).toBeNull();
        expect(await openLocalNumber('')).toBeNull();
        expect(await openLocalNumber('ENC1:korup')).toBeNull();
        expect(await openLocalNumber('bukan-angka')).toBeNull();
    });
});

describe('wiring vault', () => {
    it('ShadowVault memakai helper bucket & seal (regresi §5.5)', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const src = readFileSync(resolve(process.cwd(), 'src/lib/shadowVaultDb.ts'), 'utf8');
        expect(src).toMatch(/bucketLocalTimestamp\(/);
        expect(src).toMatch(/await sealLocalNumber\(m\.seq\)/);
        expect(src).toMatch(/await openLocalNumber\(r\.seq\)/);
        expect(src).not.toMatch(/lastMessageAt: \(conv as[^)]*\)\.lastMessageAt \?\? null/);
    });
});
