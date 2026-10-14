// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 quick win #6] KAT Argon2id lintas-implementasi untuk `hash-wasm`.
 *
 * Argon2id adalah dasar vault unlock (`ARGON_VAULT_CONFIG`) dan blind index
 * `usernameHash` (`ARGON_INDEX_CONFIG`). Satu parameter yang bergeser (lanes
 * tertukar, versi berbeda, satuan `memorySize` salah) membuat semua hash lama
 * tidak lagi cocok — tanpa error apa pun, hanya "password salah". Karena itu
 * nilainya dikunci terhadap **implementasi kedua yang independen**:
 *
 *   `hash-wasm` (WASM, dipakai klien)  ←→  `argon2` npm / phc-winner-argon2 (C,
 *   dipakai server). Kedua sisi menempelkan konstanta yang sama; kalau salah
 *   satu berubah perilaku, salah satu suite gagal.
 *
 * Catatan soal RFC 9106 §5.3 (`0d640df5…`): vektor resminya memakai secret (K)
 * **dan** associated data (X). `hash-wasm` mengekspos `secret` tetapi tidak
 * mengekspos X, jadi tag RFC tidak bisa direproduksi di sini — ia diikat di
 * `server/tests/cryptoKnownAnswer.test.ts` (node-argon2 mendukung keduanya).
 * Di sini yang dikunci adalah dua nilai penengah dari parameter set yang sama
 * (A tanpa secret, B dengan secret) persis seperti keluaran node-argon2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argon2id, type IArgon2Options } from 'hash-wasm';

// RFC 9106 §5.3 — parameter: t=3, m=32 KiB, p=4, tag 32 byte.
const RFC9106_PASSWORD = new Uint8Array(32).fill(0x01);
const RFC9106_SALT = new Uint8Array(16).fill(0x02);
const RFC9106_SECRET = new Uint8Array(8).fill(0x03);
const RFC9106_ASSOCIATED_DATA = new Uint8Array(12).fill(0x04);

/** Keluaran node-argon2 (implementasi C) untuk parameter set RFC di atas. */
const REFERENCE_NO_SECRET = '03aab965c12001c9d7d0d2de33192c0494b684bb148196d73c1df1acaf6d0c2e';
const REFERENCE_WITH_SECRET = '0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d';

const rfcParams = {
    password: RFC9106_PASSWORD,
    salt: RFC9106_SALT,
    parallelism: 4, // p (lanes)
    iterations: 3, // t
    memorySize: 32, // m dalam KiB
    hashLength: 32, // T
    outputType: 'hex' as const,
};

describe('KAT Argon2id (RFC 9106 §5.3 params) — hash-wasm vs implementasi referensi', () => {
    it('tanpa secret/associated data: sama dengan node-argon2 (dan nilai penengah RFC)', async () => {
        expect(await argon2id(rfcParams)).toBe(REFERENCE_NO_SECRET);
    });

    it('dengan secret: sama dengan node-argon2 (binding `secret` benar-benar dipakai)', async () => {
        expect(await argon2id({ ...rfcParams, secret: RFC9106_SECRET })).toBe(REFERENCE_WITH_SECRET);
    });

    it('associated data TIDAK didukung — harus dianggap diabaikan, bukan diterapkan', async () => {
        // hash-wasm tidak punya opsi `associatedData`; key asing diabaikan diam-diam.
        // Test ini mengunci kenyataan itu supaya tidak ada kode yang mengandalkan AD
        // di sisi klien (kalau butuh AD, pakai jalur server/node-argon2).
        const withAd = { ...rfcParams, associatedData: RFC9106_ASSOCIATED_DATA } as unknown as IArgon2Options;
        expect(await argon2id(withAd)).toBe(REFERENCE_NO_SECRET);
    });

    it('parameternya benar-benar dipakai (bukan konstanta tersembunyi)', async () => {
        const tag = await argon2id(rfcParams);
        for (const override of [
            { iterations: 4 },
            { memorySize: 64 },
            { parallelism: 2 },
            { hashLength: 16 },
            { secret: RFC9106_SECRET },
            { password: new Uint8Array(32).fill(0x00) },
            { salt: new Uint8Array(16).fill(0x00) },
        ]) {
            expect(await argon2id({ ...rfcParams, ...override })).not.toBe(tag);
        }
    });
});

describe('konfigurasi produksi tidak boleh berubah tanpa sadar', () => {
    // Perubahan nilai di bawah = semua `usernameHash` / vault lama tidak bisa
    // dibuka lagi. Test ini gagal lebih awal daripada user yang kena.
    const worker = readFileSync(resolve(process.cwd(), 'src/workers/crypto.worker.ts'), 'utf8');
    const configOf = (name: string) => {
        const m = worker.match(new RegExp(`const ${name} = \\{([^}]*)\\}`));
        expect(m, `${name} tidak ditemukan`).not.toBeNull();
        return m![1]!;
    };

    it('ARGON_INDEX_CONFIG (blind index username) tetap kokoh & stabil', () => {
        const cfg = configOf('ARGON_INDEX_CONFIG');
        expect(cfg).toMatch(/memorySize:\s*65536/); // 64 MB
        expect(cfg).toMatch(/iterations:\s*3/);
        expect(cfg).toMatch(/parallelism:\s*1/);
        expect(cfg).toMatch(/hashLength:\s*32/);
    });

    it('ARGON_VAULT_CONFIG (vault unlock) tetap kokoh & stabil', () => {
        const cfg = configOf('ARGON_VAULT_CONFIG');
        expect(cfg).toMatch(/memorySize:\s*131072/); // 128 MB
        expect(cfg).toMatch(/iterations:\s*4/);
        expect(cfg).toMatch(/parallelism:\s*1/);
        expect(cfg).toMatch(/hashLength:\s*32/);
    });

    it('salt blind index tetap literal yang sama (kalau berubah, semua lookup gagal)', () => {
        expect(worker).toContain('NYX_BLIND_IDX_V1');
    });
});
