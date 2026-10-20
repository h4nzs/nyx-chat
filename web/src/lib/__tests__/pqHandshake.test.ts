import { describe, it, expect } from 'vitest';
import {
  HANDSHAKE_V2_FLAG_OTPK,
  HANDSHAKE_V2_MAGIC,
  HANDSHAKE_V2_VERSION,
  ML_DSA_65_SIGNATURE_BYTES,
  PQ_V2_DOMAINS,
  buildHandshakeV2Transcript,
  deserializeHandshakeV2,
  mlDsaGetPublicKey,
  mlDsaKeygen,
  mlDsaSign,
  mlDsaVerify,
  serializeHandshakeV2,
} from '@nyx/shared';

const CT_BYTES = 1120;

function ct(fill: number): Uint8Array {
  return new Uint8Array(CT_BYTES).fill(fill);
}

function sig(): Uint8Array {
  return new Uint8Array(ML_DSA_65_SIGNATURE_BYTES).fill(0xab);
}

describe('pqHandshake v2 — wire serialize/deserialize', () => {
  it('round-trip tanpa OTPK: header, ciphertext, dan flag benar', () => {
    const ctId = ct(0x11);
    const ctSpk = ct(0x22);
    const bytes = serializeHandshakeV2({ ctId, ctSpk, signature: sig() });

    expect(bytes[0]).toBe(HANDSHAKE_V2_MAGIC);
    expect(bytes[1]).toBe(HANDSHAKE_V2_VERSION);
    expect((bytes[2] ?? 0) & HANDSHAKE_V2_FLAG_OTPK).toBe(0);
    expect(bytes.length).toBe(4 + 2 * CT_BYTES + ML_DSA_65_SIGNATURE_BYTES);

    const parsed = deserializeHandshakeV2(bytes);
    expect(parsed.ctId).toEqual(ctId);
    expect(parsed.ctSpk).toEqual(ctSpk);
    expect(parsed.ctOtpk).toBeUndefined();
    expect(parsed.signature.length).toBe(ML_DSA_65_SIGNATURE_BYTES);
  });

  it('round-trip dengan OTPK: flag diset dan ctOtpk dikembalikan', () => {
    const bytes = serializeHandshakeV2({ ctId: ct(1), ctSpk: ct(2), ctOtpk: ct(3), signature: sig() });
    expect((bytes[2] ?? 0) & HANDSHAKE_V2_FLAG_OTPK).toBe(HANDSHAKE_V2_FLAG_OTPK);
    expect(bytes.length).toBe(4 + 3 * CT_BYTES + ML_DSA_65_SIGNATURE_BYTES);

    const parsed = deserializeHandshakeV2(bytes);
    expect(parsed.ctOtpk).toEqual(ct(3));
  });

  it('menolak magic, versi, dan panjang yang tidak sah', () => {
    const good = serializeHandshakeV2({ ctId: ct(1), ctSpk: ct(2), signature: sig() });

    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(() => deserializeHandshakeV2(badMagic)).toThrow();

    const badVersion = good.slice();
    badVersion[1] = 0x01;
    expect(() => deserializeHandshakeV2(badVersion)).toThrow();

    expect(() => deserializeHandshakeV2(good.slice(0, good.length - 1))).toThrow();
  });

  it('serialize menolak ciphertext/tanda tangan dengan panjang salah', () => {
    expect(() => serializeHandshakeV2({ ctId: ct(1).slice(0, 10), ctSpk: ct(2), signature: sig() })).toThrow();
    expect(() => serializeHandshakeV2({ ctId: ct(1), ctSpk: ct(2), signature: sig().slice(0, 5) })).toThrow();
  });
});

describe('pqHandshake v2 — transkrip tanda tangan', () => {
  it('mengikat kedua identitas + ciphertext: tanda tangan valid hanya pada transkrip identik', () => {
    const initiator = mlDsaKeygen(new Uint8Array(32).fill(7));
    const initiatorPub = mlDsaGetPublicKey(initiator.secretKey);
    const responderIdentity = new Uint8Array(32).fill(9);
    const ctId = ct(0x33);
    const ctSpk = ct(0x44);

    const transcript = buildHandshakeV2Transcript({
      initiatorSigningKeyV2: initiatorPub,
      responderIdentityKey: responderIdentity,
      ctId,
      ctSpk,
    });
    const signature = mlDsaSign(transcript, initiator.secretKey, PQ_V2_DOMAINS.HANDSHAKE);

    expect(mlDsaVerify(signature, transcript, initiatorPub, PQ_V2_DOMAINS.HANDSHAKE)).toBe(true);

    const tamperedSpk = buildHandshakeV2Transcript({
      initiatorSigningKeyV2: initiatorPub,
      responderIdentityKey: responderIdentity,
      ctId,
      ctSpk: ct(0x45),
    });
    expect(mlDsaVerify(signature, tamperedSpk, initiatorPub, PQ_V2_DOMAINS.HANDSHAKE)).toBe(false);

    const otherResponder = buildHandshakeV2Transcript({
      initiatorSigningKeyV2: initiatorPub,
      responderIdentityKey: new Uint8Array(32).fill(8),
      ctId,
      ctSpk,
    });
    expect(mlDsaVerify(signature, otherResponder, initiatorPub, PQ_V2_DOMAINS.HANDSHAKE)).toBe(false);

    const impostor = mlDsaKeygen(new Uint8Array(32).fill(6));
    const impostorPub = mlDsaGetPublicKey(impostor.secretKey);
    expect(mlDsaVerify(signature, transcript, impostorPub, PQ_V2_DOMAINS.HANDSHAKE)).toBe(false);
  });

  it('membedakan transkrip ber-OTPK dari yang tanpa OTPK', () => {
    const key = mlDsaKeygen(new Uint8Array(32).fill(1));
    const pub = mlDsaGetPublicKey(key.secretKey);
    const base = {
      initiatorSigningKeyV2: pub,
      responderIdentityKey: new Uint8Array(32).fill(2),
      ctId: ct(1),
      ctSpk: ct(2),
    };
    const without = buildHandshakeV2Transcript(base);
    const withOtpk = buildHandshakeV2Transcript({ ...base, ctOtpk: ct(3) });
    expect(without).not.toEqual(withOtpk);
  });
});
