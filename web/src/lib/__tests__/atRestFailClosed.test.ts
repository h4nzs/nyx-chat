// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit D7] Seal at-rest **fail-closed**.
 *
 * Bug yang dikunci di sini: `encryptValueAtRest` dulu mengembalikan nilai apa
 * adanya (hanya `console.warn`) ketika masterSeed belum tersedia atau worker
 * enkripsi melempar. Akibatnya `Message.seq`/`senderId`/`expiresAt`,
 * `Conversation.isGroup`, token Privacy Pass, dan identifier KT bisa tersimpan
 * **plaintext** di IndexedDB/localStorage padahal `docs/04` §4.8 menjanjikan
 * baris baru selalu ter-seal.
 *
 * Kontrak sekarang:
 *   1. gagal seal → **melempar** `AtRestSealUnavailableError` (atau error worker),
 *      tidak pernah mengembalikan plaintext;
 *   2. helper `sealLocal*` mewarisi sifat itu (pemanggil melewati penulisan);
 *   3. baris LAMA yang plaintext tetap terbaca (perangkat user tidak bisa
 *      di-reset seperti DB server).
 *
 * keychainDb nyata dipakai; hanya auth/crypto worker/sodium/Dexie yang di-stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState: { seed: Uint8Array | undefined } = { seed: undefined };
const cryptoState = { failEncrypt: false };

vi.mock('@store/auth', () => ({
    useAuthStore: {
        getState: () => ({
            getMasterSeedIfUnlocked: () => authState.seed,
        }),
    },
}));

// `encryptValueAtRest` tidak menyentuh DB; stub cukup agar modul bisa dimuat
// tanpa IndexedDB.
vi.mock('@lib/db', () => ({ db: {} }));

vi.mock('@lib/crypto-worker-proxy', () => ({
    worker_encrypt_session_key: vi.fn(async (bytes: Uint8Array) => {
        if (cryptoState.failEncrypt) throw new Error('worker mati');
        return bytes.slice().reverse();
    }),
    worker_decrypt_session_key: vi.fn(async (bytes: Uint8Array) => bytes.slice().reverse()),
}));

vi.mock('@lib/sodiumInitializer', () => ({
    getSodium: async () => ({
        // Lingkungan test memakai polyfill `buffer` yang belum mengenal
        // 'base64url'; bentuk URL-safe disusun manual (setara).
        to_base64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
        from_base64: (value: string) => new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
        base64_variants: { URLSAFE_NO_PADDING: 1 },
    }),
}));

const {
    AT_REST_PREFIX,
    AtRestSealUnavailableError,
    decryptValueAtRest,
    encryptValueAtRest,
} = await import('@lib/keychainDb');
const { sealLocalFlag, sealLocalNumber, sealLocalText } = await import('@lib/localAtRest');

beforeEach(() => {
    authState.seed = undefined;
    cryptoState.failEncrypt = false;
});

describe('encryptValueAtRest — fail-closed (audit D7)', () => {
    it('vault terkunci: melempar AtRestSealUnavailableError, bukan mengembalikan plaintext', async () => {
        const value = '1700000000';
        await expect(encryptValueAtRest(value)).rejects.toBeInstanceOf(AtRestSealUnavailableError);
        // Inti temuan: dulu `await encryptValueAtRest(value)` === value.
        await expect(encryptValueAtRest(value)).rejects.not.toBe(value);
    });

    it('worker enkripsi gagal: error naik, tidak ada fallback plaintext', async () => {
        authState.seed = new Uint8Array(32).fill(7);
        cryptoState.failEncrypt = true;
        await expect(encryptValueAtRest('rahasia')).rejects.toThrow('worker mati');
    });

    it('masterSeed tersedia: hasil selalu envelope ENC1 dan bisa dibuka lagi', async () => {
        authState.seed = new Uint8Array(32).fill(7);
        const sealed = await encryptValueAtRest('rahasia');

        expect(sealed.startsWith(AT_REST_PREFIX)).toBe(true);
        expect(sealed).not.toContain('rahasia');
        expect(await decryptValueAtRest(sealed)).toBe('rahasia');
    });

    it('nilai yang sudah ter-seal dikembalikan apa adanya (idempoten, tanpa worker)', async () => {
        const already = `${AT_REST_PREFIX}abc`;
        expect(await encryptValueAtRest(already)).toBe(already);
    });

    it('baris LAMA plaintext tetap terbaca (kompatibilitas baca, bukan tulis)', async () => {
        expect(await decryptValueAtRest('1700000000')).toBe('1700000000');
    });
});

describe('helper sealLocal* mewarisi fail-closed', () => {
    it('tanpa masterSeed: sealLocalText/Number/Flag melempar, tidak menulis plaintext', async () => {
        await expect(sealLocalText('user-1')).rejects.toBeInstanceOf(AtRestSealUnavailableError);
        await expect(sealLocalNumber(42)).rejects.toBeInstanceOf(AtRestSealUnavailableError);
        await expect(sealLocalFlag(true)).rejects.toBeInstanceOf(AtRestSealUnavailableError);
    });

    it('nilai kosong/tak valid tetap null (bukan error): kolom opsional boleh kosong', async () => {
        expect(await sealLocalText('')).toBeNull();
        expect(await sealLocalNumber(Number.NaN)).toBeNull();
        expect(await sealLocalFlag(null)).toBeNull();
    });
});
