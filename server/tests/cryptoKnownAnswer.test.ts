// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 quick win #6] Known-answer tests lintas-implementasi.
 *
 * Semua primitif NYX dijalankan lewat libsodium (X25519, Ed25519, XChaCha20-
 * Poly1305, BLAKE2b, X-Wing/ML-KEM-768). Tanpa vector dari luar, satu bug di
 * library (atau panggilan yang salah) baru ketahuan setelah ada peer yang tidak
 * bisa mendekripsi. Test ini mengunci nilai-nilai yang sudah dipublikasikan dan
 * membandingkannya dengan **implementasi kedua yang independen** (OpenSSL lewat
 * `node:crypto`), sehingga klaim "implementasi kita benar" tidak bergantung pada
 * library yang sama.
 *
 * Cakupan dan alasannya:
 *   - RFC 7748 §6.1 — X25519 (kanal klasik PQX3DH & Double Ratchet).
 *   - RFC 8032 §7.1 — Ed25519 TEST 1/2 (signing pre-key & pesan grup).
 *   - RFC 7693 App. A — BLAKE2b-512 (KDF vault/at-rest).
 *   - RFC 8439 §2.8.2 — ChaCha20-Poly1305 (AEAD dasar).
 *   - XChaCha20-Poly1305 (draft IRTF) — konstruksi NYX: HChaCha20 yang dihitung
 *     ulang di JS + ChaCha20-Poly1305 OpenSSL harus menghasilkan envelope yang
 *     identik dengan libsodium. Ini menguji bahwa envelope NYX memang standar
 *     XChaCha (bukan varian internal libsodium).
 *   - X-Wing (ML-KEM-768): vector resmi draft-connolly-cfrg-xwing-kem-06
 *     Appendix C (seed keypair + deterministic encapsulation). Vector ini
 *     mencakup pk 1216 / ct 1120 / ss 32 dan mengunci derivasi seed → kunci,
 *     sehingga kesalahan di library tidak bisa lolos hanya dengan roundtrip.
 *     Kyber1024 milik libsignal BUKAN primitive yang sama, jadi vector
 *     libsignal tidak berlaku.
 *   - RFC 9106 §5.3 — Argon2id (vault unlock, blind index username di klien,
 *     hash password & PoW di server). Ini satu-satunya vektor di sini yang
 *     memakai secret (K) + associated data (X). `hash-wasm` (sisi klien) tidak
 *     mengekspos X, jadi tag RFC hanya bisa diikat di sini; nilai penengah A/B
 *     di bawah dikunci ulang oleh `web/src/lib/__tests__/argonKnownAnswer.test.ts`
 *     lewat `hash-wasm` → dua implementasi berbeda harus sepakat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto, { createHash, createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import argon2 from 'argon2';
import sodium from 'libsodium-wrappers';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

const X25519_SPKI_PREFIX = '302a300506032b656e032100';
const X25519_PKCS8_PREFIX = '302e020100300506032b656e04220420';
const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';

await sodium.ready;

test('KAT: X25519 RFC 7748 §6.1 — vektor, OpenSSL, dan libsodium sepakat', () => {
  const alicePriv = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
  const alicePub = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
  const bobPriv = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
  const bobPub = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
  const expectedShared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

  // 1. Vektor RFC: kunci publik diturunkan dari private key.
  assert.equal(hex(sodium.crypto_scalarmult_base(bytes(alicePriv))), alicePub, 'libsodium: Alice pub');
  assert.equal(hex(sodium.crypto_scalarmult_base(bytes(bobPriv))), bobPub, 'libsodium: Bob pub');

  // 2. OpenSSL (node:crypto) — implementasi kedua yang independen.
  const aliceKey = createPrivateKey({ key: Buffer.from(X25519_PKCS8_PREFIX + alicePriv, 'hex'), format: 'der', type: 'pkcs8' });
  const bobPublic = createPublicKey({ key: Buffer.from(X25519_SPKI_PREFIX + bobPub, 'hex'), format: 'der', type: 'spki' });
  const opensslShared = diffieHellman({ privateKey: aliceKey, publicKey: bobPublic });
  assert.equal(opensslShared.toString('hex'), expectedShared, 'OpenSSL: shared secret');

  // 3. libsodium menghitung nilai yang sama.
  assert.equal(hex(sodium.crypto_scalarmult(bytes(alicePriv), bytes(bobPub))), expectedShared, 'libsodium: shared secret');
  assert.equal(
    hex(sodium.crypto_scalarmult(bytes(bobPriv), bytes(alicePub))),
    expectedShared,
    'libsodium: arah sebaliknya harus sama (DH simetris)'
  );
});

test('KAT: Ed25519 RFC 8032 §7.1 TEST 1 & 2 — seed→pubkey, tanda tangan, verifikasi', () => {
  const vectors = [
    {
      name: 'TEST 1 (pesan kosong)',
      seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      message: new Uint8Array(0),
      signature:
        'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    },
    {
      name: 'TEST 2 (1 byte 0x72)',
      seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
      publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      message: new Uint8Array([0x72]),
      signature:
        '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    },
  ];

  for (const v of vectors) {
    // libsodium: seed → keypair (pola NYX: kunci identitas diturunkan dari seed).
    const kp = sodium.crypto_sign_seed_keypair(bytes(v.seed));
    assert.equal(hex(kp.publicKey), v.publicKey, `libsodium: pubkey ${v.name}`);
    const sig = sodium.crypto_sign_detached(v.message, kp.privateKey);
    assert.equal(hex(sig), v.signature, `libsodium: signature ${v.name}`);
    assert.equal(sodium.crypto_sign_verify_detached(sig, v.message, kp.publicKey), true, `libsodium: verify ${v.name}`);

    // OpenSSL: tanda tangan harus identik (Ed25519 deterministik).
    const key = createPrivateKey({
      key: Buffer.from(ED25519_PKCS8_PREFIX + v.seed, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    const opensslSig = crypto.sign(null, Buffer.from(v.message), key);
    assert.equal(opensslSig.toString('hex'), v.signature, `OpenSSL: signature ${v.name}`);
    assert.equal(
      crypto.verify(null, Buffer.from(v.message), createPublicKey(key), Buffer.from(v.signature, 'hex')),
      true,
      `OpenSSL: verify ${v.name}`
    );
  }
});

test('KAT: BLAKE2b-512 RFC 7693 App. A — vektor, OpenSSL, dan libsodium sepakat', () => {
  const cases = [
    { input: '', expected: '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce' },
    { input: 'abc', expected: 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923' },
  ];

  for (const c of cases) {
    const msg = new TextEncoder().encode(c.input);
    const blake = createHash('blake2b512').update(msg).digest('hex'); // OpenSSL
    assert.equal(blake, c.expected, `OpenSSL: BLAKE2b-512("${c.input}")`);
    assert.equal(hex(sodium.crypto_generichash(64, msg, null)), c.expected, `libsodium: BLAKE2b-512("${c.input}")`);
  }
});

test('KAT: ChaCha20-Poly1305 RFC 8439 §2.8.2 — OpenSSL cocok vektor', () => {
  const key = bytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = bytes('070000004041424344454647');
  const aad = bytes('50515253c0c1c2c3c4c5c6c7');
  const plaintext = Buffer.from(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    'utf8'
  );
  const expectedCiphertext =
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116';
  const expectedTag = '1ae10b594f09e26a7e902ecbd0600691';

  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const out = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  assert.equal(out.toString('hex'), expectedCiphertext, 'OpenSSL: ciphertext');
  assert.equal(cipher.getAuthTag().toString('hex'), expectedTag, 'OpenSSL: tag');
});

/**
 * HChaCha20 (draft-irtf-cfrg-xchacha20poly1305 §2.2) — implementasi independen
 * dari libsodium, dipakai untuk membuktikan envelope XChaCha NYX memang
 * konstruksi standar.
 */
function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const sigma = new TextEncoder().encode('expand 32-byte k');
  const state = new Uint32Array(16);
  for (let i = 0; i < 4; i++) state[i] = sigma[i * 4]! | (sigma[i * 4 + 1]! << 8) | (sigma[i * 4 + 2]! << 16) | (sigma[i * 4 + 3]! << 24);
  const rd = (b: Uint8Array, off: number) => b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24);
  for (let i = 0; i < 8; i++) state[4 + i] = rd(key, i * 4);
  for (let i = 0; i < 4; i++) state[12 + i] = rd(nonce16, i * 4);

  const rotl = (v: number, c: number) => ((v << c) | (v >>> (32 - c))) >>> 0;
  const qr = (a: number, b: number, c: number, d: number) => {
    state[a] = (state[a]! + state[b]!) >>> 0; state[d] = rotl(state[d]! ^ state[a]!, 16);
    state[c] = (state[c]! + state[d]!) >>> 0; state[b] = rotl(state[b]! ^ state[c]!, 12);
    state[a] = (state[a]! + state[b]!) >>> 0; state[d] = rotl(state[d]! ^ state[a]!, 8);
    state[c] = (state[c]! + state[d]!) >>> 0; state[b] = rotl(state[b]! ^ state[c]!, 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }

  const out = new Uint8Array(32);
  const words = [0, 1, 2, 3, 12, 13, 14, 15];
  words.forEach((w, idx) => {
    const v = state[w]!;
    out[idx * 4] = v & 0xff;
    out[idx * 4 + 1] = (v >>> 8) & 0xff;
    out[idx * 4 + 2] = (v >>> 16) & 0xff;
    out[idx * 4 + 3] = (v >>> 24) & 0xff;
  });
  return out;
}

test('KAT: XChaCha20-Poly1305 NYX = HChaCha20+ChaCha20/Poly1305 standar (dua implementasi)', () => {
  const key = sodium.randombytes_buf(32);
  const nonce = sodium.randombytes_buf(24);
  const aad = new TextEncoder().encode('nyx-aad');
  const message = new TextEncoder().encode('envelope at-rest NYX (ENC1:) diuji lintas-implementasi'.repeat(3));

  // libsodium (implementasi yang dipakai NYX).
  const combined = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, null, nonce, key);
  assert.equal(combined.length, message.length + 16, 'ciphertext + tag 16 byte');

  // Implementasi kedua: HChaCha20 (JS di atas) + ChaCha20-Poly1305 (OpenSSL).
  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const chachaNonce = new Uint8Array(12);
  chachaNonce.set(nonce.subarray(16, 24), 4);
  const cipher = crypto.createCipheriv('chacha20-poly1305', subkey, chachaNonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const nodeOut = Buffer.concat([cipher.update(Buffer.from(message)), cipher.final()]);
  const nodeCombined = Buffer.concat([nodeOut, cipher.getAuthTag()]);

  assert.equal(nodeCombined.toString('hex'), Buffer.from(combined).toString('hex'), 'XChaCha20-Poly1305 lintas-implementasi identik');

  // Dan sebaliknya: ciphertext OpenSSL dibuka oleh libsodium.
  const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, new Uint8Array(nodeCombined), aad, nonce, key);
  assert.equal(Buffer.from(opened).toString('utf8'), Buffer.from(message).toString('utf8'), 'libsodium membuka envelope OpenSSL');
});

test('KAT: Argon2id RFC 9106 §5.3 — node-argon2 cocok tag yang dipublikasikan', async () => {
  // Vektor RFC 9106 §5.3: p=4 lanes, t=3, m=32 KiB, tag 32 byte,
  // P = 32×0x01, S = 16×0x02, K (secret) = 8×0x03, X (associated data) = 12×0x04.
  const password = Buffer.alloc(32, 0x01);
  const salt = Buffer.alloc(16, 0x02);
  const secret = Buffer.alloc(8, 0x03);
  const associatedData = Buffer.alloc(12, 0x04);
  const base = {
    type: argon2.argon2id,
    memoryCost: 32,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
    version: 0x13, // Argon2 v1.3 — versi yang dipakai NYX.
    raw: true as const,
  };

  // A: tanpa secret/AD — nilai ini identik dengan hasil `hash-wasm` di sisi klien
  // (lihat argonKnownAnswer.test.ts). Baseline lintas-implementasi.
  const a = await argon2.hash(password, { ...base, salt });
  assert.equal(a.toString('hex'), '03aab965c12001c9d7d0d2de33192c0494b684bb148196d73c1df1acaf6d0c2e', 'A: tanpa secret/AD');

  // B: dengan secret — menguji binding `secret` benar-benar sampai ke core.
  const b = await argon2.hash(password, { ...base, salt, secret });
  assert.equal(b.toString('hex'), '0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d', 'B: secret saja');

  // C: vektor resmi RFC 9106 §5.3 (secret + associated data).
  const c = await argon2.hash(password, { ...base, salt, secret, associatedData });
  assert.equal(
    c.toString('hex'),
    '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    'C: tag RFC 9106 §5.3'
  );

  // Setiap parameter harus benar-benar mengubah hasil (tidak ada yang diam-diam
  // diabaikan oleh binding): regresi di sini = hash lama tidak lagi tervalidasi.
  const variants = [
    await argon2.hash(password, { ...base, salt, memoryCost: 64 }),
    await argon2.hash(password, { ...base, salt, timeCost: 4 }),
    await argon2.hash(password, { ...base, salt, parallelism: 2 }),
    await argon2.hash(password, { ...base, salt, hashLength: 16 }),
    await argon2.hash(Buffer.alloc(32, 0x00), { ...base, salt }),
  ];
  for (const [i, v] of variants.entries()) {
    assert.notEqual(v.toString('hex').slice(0, 32), a.toString('hex').slice(0, 32), `varian ${i} harus mengubah tag`);
  }
});

test('KAT: X-Wing draft-06 Appendix C — keypair, encapsulation, decapsulation', () => {
  // Ukuran X-Wing: pk = ML-KEM-768 pk (1184) + X25519 (32) = 1216;
  // ct = ML-KEM-768 ct (1088) + X25519 (32) = 1120; ss = 32 byte.
  assert.equal(sodium.crypto_kem_xwing_PUBLICKEYBYTES, 1216);
  assert.equal(sodium.crypto_kem_xwing_CIPHERTEXTBYTES, 1120);
  assert.equal(sodium.crypto_kem_xwing_SHAREDSECRETBYTES, 32);
  assert.equal(sodium.crypto_kem_xwing_SEEDBYTES, 32);

  const vector = JSON.parse(
    readFileSync(new URL('./fixtures/xwing-draft06.json', import.meta.url), 'utf8')
  ) as { seed: string; eseed: string; pk: string; ct: string; ss: string };

  const keypair = sodium.crypto_kem_xwing_seed_keypair(bytes(vector.seed));
  assert.equal(hex(keypair.publicKey), vector.pk, 'seed vector → public key persis draft-06');

  const encapsulated = sodium.crypto_kem_xwing_enc_deterministic(keypair.publicKey, bytes(vector.eseed));
  assert.equal(hex(encapsulated.ciphertext), vector.ct, 'eseed vector → ciphertext persis draft-06');
  assert.equal(hex(encapsulated.sharedSecret), vector.ss, 'eseed vector → shared secret persis draft-06');

  const decapsulated = sodium.crypto_kem_xwing_dec(encapsulated.ciphertext, keypair.privateKey);
  assert.equal(hex(decapsulated), vector.ss, 'decapsulation memulihkan shared secret vector');

  const other = sodium.crypto_kem_xwing_seed_keypair(new Uint8Array(32).fill(0x42));
  assert.notEqual(hex(sodium.crypto_kem_xwing_dec(encapsulated.ciphertext, other.privateKey)), vector.ss, 'kunci lain → secret lain');
});
