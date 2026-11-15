import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { trustedRelayClientTag } from '../ohttp/clientTag.js';
import { pepperedIdentifier } from './atRestSecrets.js';
import { verifyJwt } from './jwt.js';

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

/**
 * [audit N8-02] Tag limiter untuk trafik yang datang lewat amplop OHTTP.
 *
 * Gateway meneruskan request ke API lewat loopback, jadi `req.ip` = `127.0.0.1`
 * dan `clientIpTag` memberi **satu** bucket untuk semua pengguna OHTTP — satu
 * klien yang memverifikasi banyak kontak bisa menghabiskan jatah 300/15 menit
 * milik semua orang. Identitas yang tersedia dan tidak bisa dipalsukan di sini
 * adalah token OHTTP (JWT ber-`scope: 'ohttp'`), jadi kuncinya turunan `sub`
 * token itu: satu akun = satu bucket, dan penyerang tidak bisa memilih bucket
 * akun lain tanpa tanda tangan sah.
 *
 * `undefined` = bukan trafik OHTTP (token sesi biasa, tanpa token, atau token
 * tidak sah) → pemanggil memakai `clientIpTag` seperti sebelumnya. Token yang
 * sudah kedaluwarsa juga jatuh ke IP: `requireAuth` menolaknya sesudah ini.
 */
export function ohttpTokenSubjectTag(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const payload = verifyJwt(header.slice('Bearer '.length).trim());
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.scope !== 'ohttp') return undefined;
  const subject = payload.id ?? payload.sub;
  if (typeof subject !== 'string' || subject.length === 0) return undefined;
  return pepperedIdentifier(`ohttp-sub:${subject}`);
}

/**
 * [audit N9-01] Tag klien OHTTP untuk trafik **tanpa akun**.
 *
 * Relay adalah satu-satunya pihak yang masih melihat alamat klien, jadi ia
 * menghitung `HMAC(secret, alamat)` dan mengirimnya sebagai header internal
 * (`ohttp/clientTag.ts`). API memakai tag itu setelah di-pepper lagi, sehingga
 * yang masuk Redis tetap opaque: bukan IP, bukan id akun.
 *
 * `undefined` = bukan trafik lewat relay tepercaya (atau header tidak sah) →
 * pemanggil jatuh ke subjek token/IP seperti sebelumnya. Header tanpa token
 * internal TIDAK dipercaya; kalau dipercaya, penyerang cukup mengarang tag baru
 * di setiap request untuk mendapat bucket tanpa batas.
 */
export function ohttpRelayClientTag(req: Pick<Request, 'headers'>): string | undefined {
  const tag = trustedRelayClientTag(req);
  return tag ? pepperedIdentifier(`ohttp-client:${tag}`) : undefined;
}

/**
 * Kunci limiter trafik umum: klien relay OHTTP, lalu akun OHTTP, selain itu IP.
 * Urutan ini penting: jalur bukti KT sengaja tanpa token, sehingga tanpa tag
 * relay ia akan berbagi satu bucket `127.0.0.1` untuk semua pengguna.
 */
export function clientRateLimitTag(req: Pick<Request, 'headers' | 'ip'>): string {
  return ohttpRelayClientTag(req) ?? ohttpTokenSubjectTag(req) ?? clientIpTag(req);
}
