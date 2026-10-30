/**
 * [SEC 2026-10-30] Kode verifikasi (SAS) tautan perangkat.
 *
 * Yang dikunci di sini:
 *   - derivasi deterministik dari X-Wing public key perangkat baru (dua perangkat
 *     harus menghitung kode yang SAMA dari kunci yang sama),
 *   - kunci berbeda → kode berbeda (kasus server menukar kunci),
 *   - kunci kosong/rusak tidak pernah menghasilkan kode (fail-closed),
 *   - `sendHistoryArchive` MENOLAK sebelum presign bila kode yang dikonfirmasi
 *     tidak cocok dengan kunci yang akan dipakai untuk menyegel `K`.
 */
import { describe, it, expect, vi } from 'vitest';

import { deriveLinkSas, formatLinkSas, LinkSasMismatchError } from '../deviceLinkSas';

// Kunci uji deterministik 1216 byte (ukuran X-Wing pk: ML-KEM-768 1184 + X25519 32).
// Nilai vektor di bawah dihitung dengan libsodium apa adanya (bukan mock), jadi
// perubahan domain-separator/urutan byte akan langsung menggagalkan test ini —
// itu yang mencegah dua build berperilaku berbeda saat pairing.
const VECTOR_KEY = (() => {
  const bytes = new Uint8Array(1216);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return toBase64Url(bytes);
})();

/** base64url tanpa padding — bentuk kunci di wire (Buffer bawaan jsdom tidak punya). */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const VECTOR_SAS = '746933';

function keyOf(seed: number): string {
  const bytes = new Uint8Array(1216);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i + seed) % 251;
  return toBase64Url(bytes);
}

describe('deriveLinkSas', () => {
  it('deterministik dan cocok dengan vektor yang dihitung libsodium', async () => {
    await expect(deriveLinkSas(VECTOR_KEY)).resolves.toBe(VECTOR_SAS);
    await expect(deriveLinkSas(VECTOR_KEY)).resolves.toBe(VECTOR_SAS);
  });

  it('selalu 6 digit dan kunci berbeda menghasilkan kode berbeda', async () => {
    const a = await deriveLinkSas(keyOf(0));
    const b = await deriveLinkSas(keyOf(1));
    expect(a).toMatch(/^\d{6}$/);
    expect(b).toMatch(/^\d{6}$/);
    expect(a).not.toBe(b);
  });

  it('base64 standar dan base64url menurunkan kode yang sama', async () => {
    const urlSafe = keyOf(3);
    const standard = urlSafe.replace(/-/g, '+').replace(/_/g, '/');
    await expect(deriveLinkSas(urlSafe)).resolves.toBe(await deriveLinkSas(standard));
  });

  it('kunci kosong/rusak melempar (tidak pernah dianggap cocok)', async () => {
    await expect(deriveLinkSas('')).rejects.toBeInstanceOf(LinkSasMismatchError);
    await expect(deriveLinkSas('bukan-base64!!')).rejects.toBeInstanceOf(LinkSasMismatchError);
  });
});

describe('formatLinkSas', () => {
  it('menyisipkan spasi setelah tiga digit, tanpa mengubah selain itu', () => {
    expect(formatLinkSas('746933')).toBe('746 933');
    expect(formatLinkSas('000123')).toBe('000 123');
    // Bukan 6 digit (mis. placeholder UI) dibiarkan apa adanya.
    expect(formatLinkSas('—— ——')).toBe('—— ——');
  });
});

// Gate `sendHistoryArchive` (kode tidak cocok → tidak ada presign/ready)
// diuji di `linkHistory.test.ts`, tempat transport arsip sudah di-stub utuh.
