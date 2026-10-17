import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { pepperedIdentifier } from './atRestSecrets.js';

/**
 * IP klien yang tahan pemalsuan pada topologi Cloudflare (proxy maupun tunnel).
 *
 * Melalui edge Cloudflare, header `CF-Connecting-IP` SELALU ditimpa oleh CF
 * dengan IP klien asli sehingga tidak bisa dipalsukan. Sebaliknya
 * `X-Forwarded-For` membawa entri yang dikendalikan penyerang di posisi depan,
 * dan `req.ip` (hasil trust proxy) bisa jatuh ke entri palsu itu ketika trafik
 * tidak melewati lapisan nginx yang menormalkan XFF (mis. jalur tunnel langsung
 * ke Express). Karena itu keying rate-limit / PoW / CSRF wajib memilih
 * CF-Connecting-IP lebih dulu; `req.ip` hanya fallback.
 */
export function cfAwareClientIp(req: Pick<Request, 'headers' | 'ip'>): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim() !== '') return cfIp;
  if (req.ip && req.ip !== 'unknown') return req.ip;
  return 'unknown';
}

/**
 * [docs/30 §30.12 WS-H] Key rate-limit untuk klien: **tag HMAC pepper**, bukan
 * alamat IP.
 *
 * Kenapa: `express-rate-limit` + `RedisStore` menulis `${prefix}${key}` ke Redis,
 * jadi keyGenerator yang mengembalikan IP mentah berarti snapshot Redis memuat
 * daftar alamat klien (dan riwayatnya selama TTL 15 menit–1 jam). Itu bertentangan
 * dengan kriteria audit WS-H: "tidak ada IP di DB/Redis".
 *
 * Yang di-HMAC adalah keluaran `ipKeyGenerator` (bukan IP mentah) supaya
 * normalisasi IPv6 bawaannya tetap dipakai — perilaku pembatasan tidak berubah
 * (IP sama → tag sama → counter sama), hanya bentuk key-nya. Operator yang ingin
 * menelusuri satu alamat tetap bisa menghitung tag itu sendiri dari pepper
 * (`pepperedIdentifier('clientip:' + ipKeyGenerator(alamat))`), jadi daya lihat ops
 * tidak hilang — hanya tidak lagi terbaca oleh pemegang snapshot Redis.
 *
 * Konsekuensi yang disengaja: rotasi pepper (atau deploy pertama setelah
 * perubahan ini) menyetel ulang counter rate-limit. Itu wajar — counter memang
 * ber-TTL pendek.
 */
export function clientIpTag(req: Pick<Request, 'headers' | 'ip'>): string {
  return pepperedIdentifier(`clientip:${ipKeyGenerator(cfAwareClientIp(req))}`);
}
