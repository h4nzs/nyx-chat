// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Oblivious HTTP (RFC 9458) — kontrak wire + implementasi
 * kripto yang dipakai KLIEN (worker) dan GATEWAY (server).
 *
 * Profil yang dipakai NYX:
 *   KEM  DHKEM(P-256, HKDF-SHA256)  id 0x0010
 *   KDF  HKDF-SHA256                 id 0x0001
 *   AEAD AES-256-GCM                 id 0x0002
 *
 * Ketiganya native di WebCrypto (browser + Node), sehingga tidak ada primitif
 * buatan sendiri dan tidak ada aset WASM baru. X25519 tidak dipakai di sini:
 * HPKE/OHTTP adalah Tier B (docs/35 §35.1) yang memang masih classical.
 *
 * Wire mengikuti RFC 9458 §4.1–4.4 apa adanya:
 *   Encapsulated Request  = hdr(7) ‖ enc(65) ‖ HPKE ct
 *   hdr                   = keyId(1) ‖ kemId(2) ‖ kdfId(2) ‖ aeadId(2)
 *   info                  = "message/bhttp request" ‖ 0x00 ‖ hdr
 *   Encapsulated Response = response_nonce(32) ‖ AES-256-GCM ct
 *   response key/nonce    = HKDF-SHA256(Extract(salt = enc ‖ response_nonce,
 *                           ikm = context.Export("message/bhttp response", 32)))
 *
 * Isi terenkripsi adalah Binary HTTP (RFC 9292) known-length — request
 * (framing 0) dan response (framing 1), tanpa informational responses dan
 * tanpa padding. Field name di-lowercase saat encode (aturan HTTP/2 §8.3.1).
 */

import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const OHTTP_KEY_ID = 0x01;
/** Slot rotasi: kunci aktif + kunci berikutnya (lama tetap bisa dibuka). */
export const OHTTP_MAX_KEY_CONFIGS = 4;
export const OHTTP_KEM_P256_SHA256 = 0x0010;
export const OHTTP_KDF_SHA256 = 0x0001;
export const OHTTP_AEAD_AES256_GCM = 0x0002;

export const OHTTP_REQUEST_INFO = 'message/bhttp request';
export const OHTTP_RESPONSE_INFO = 'message/bhttp response';
export const OHTTP_GATEWAY_KEY_BYTES = 65; // uncompressed P-256 point
export const OHTTP_PRIVATE_KEY_BYTES = 32;
export const OHTTP_ENC_BYTES = 65;
export const OHTTP_HEADER_BYTES = 7;
export const OHTTP_RESPONSE_NONCE_BYTES = 32; // max(Nk, Nn) untuk AES-256-GCM
export const OHTTP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class OhttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OhttpError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let suite: CipherSuite | null = null;

/** Cipher suite tunggal (dibuat lazy; aman dipakai browser dan Node). */
export function ohttpSuite(): CipherSuite {
  suite ??= new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  return suite;
}

// ─────────────────────────── QUIC varint (RFC 9000 §16) ─────────────────────

/** Encode integer sebagai QUIC varint (selalu panjang minimum). */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new OhttpError(`varint di luar rentang: ${value}`);
  }
  if (value < 0x40) return Uint8Array.of(value);
  if (value < 0x4000) return Uint8Array.of(0x40 | (value >> 8), value & 0xff);
  // Batas keras: PIR query bisa beberapa MB (hint tetap di luar OHTTP), jadi
  // varint 8-byte tidak diperlukan dan ditolak alih-alih di-encode setengah benar.
  if (value > 0x3fffffff) throw new OhttpError(`varint terlalu besar: ${value}`);
  return Uint8Array.of(0x80 | (value >> 24), (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

export interface VarintResult {
  value: number;
  bytesRead: number;
}

/** Decode QUIC varint. Melempar pada buffer terpotong. */
export function decodeVarint(bytes: Uint8Array, offset = 0): VarintResult {
  if (offset >= bytes.length) throw new OhttpError('varint: buffer habis');
  const first = bytes[offset]!;
  const length = 1 << (first >> 6); // 1, 2, 4, 8
  if (offset + length > bytes.length) throw new OhttpError('varint: buffer terpotong');
  let value = first & 0x3f;
  for (let i = 1; i < length; i += 1) value = value * 256 + bytes[offset + i]!;
  if (!Number.isSafeInteger(value)) throw new OhttpError('varint: nilai terlalu besar');
  return { value, bytesRead: length };
}

// ─────────────────────────── Binary HTTP (RFC 9292) ─────────────────────────

export type OhttpHeader = readonly [name: string, value: string];

export interface OhttpRequest {
  method: string;
  scheme: string;
  authority: string;
  path: string;
  headers: OhttpHeader[];
  content: Uint8Array;
}

export interface OhttpResponse {
  status: number;
  headers: OhttpHeader[];
  content: Uint8Array;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLengthPrefixed(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  return concatBytes(encodeVarint(bytes.length), bytes);
}

function encodeFieldSection(headers: readonly OhttpHeader[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!lower) throw new OhttpError('bhttp: nama field kosong');
    parts.push(encodeLengthPrefixed(lower), encodeLengthPrefixed(value));
  }
  return concatBytes(...parts);
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  varint(): number {
    const { value, bytesRead } = decodeVarint(this.bytes, this.offset);
    this.offset += bytesRead;
    return value;
  }

  bytesOf(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new OhttpError('bhttp: buffer terpotong');
    }
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string(): string {
    return textDecoder.decode(this.bytesOf(this.varint()));
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  get position(): number {
    return this.offset;
  }
}

function decodeFieldSection(reader: Reader): OhttpHeader[] {
  const length = reader.varint();
  const end = reader.position + length;
  const headers: OhttpHeader[] = [];
  while (reader.position < end) {
    const name = reader.string();
    const value = reader.string();
    if (!name) throw new OhttpError('bhttp: nama field kosong');
    headers.push([name, value]);
    if (headers.length > 128) throw new OhttpError('bhttp: terlalu banyak field');
  }
  if (reader.position !== end) throw new OhttpError('bhttp: field section tidak konsisten');
  return headers;
}

/** Encode request known-length (framing indicator 0). */
export function encodeBinaryHttpRequest(request: OhttpRequest): Uint8Array {
  const headerSection = encodeFieldSection(request.headers);
  return concatBytes(
    encodeVarint(0),
    encodeLengthPrefixed(request.method),
    encodeLengthPrefixed(request.scheme),
    encodeLengthPrefixed(request.authority),
    encodeLengthPrefixed(request.path),
    encodeVarint(headerSection.length),
    headerSection,
    encodeVarint(request.content.length),
    request.content,
    encodeVarint(0), // trailer section kosong
  );
}

export function decodeBinaryHttpRequest(bytes: Uint8Array): OhttpRequest {
  const reader = new Reader(bytes);
  if (reader.varint() !== 0) throw new OhttpError('bhttp: framing request harus 0');
  const method = reader.string();
  const scheme = reader.string();
  const authority = reader.string();
  const path = reader.string();
  const headers = decodeFieldSection(reader);
  const content = reader.bytesOf(reader.varint());
  if (!reader.done) {
    const trailerLength = reader.varint();
    if (trailerLength !== 0) throw new OhttpError('bhttp: trailer tidak didukung');
  }
  if (!method || !scheme || !path) throw new OhttpError('bhttp: request tidak lengkap');
  return { method, scheme, authority, path, headers, content };
}

/** Encode response known-length (framing indicator 1). */
export function encodeBinaryHttpResponse(response: OhttpResponse): Uint8Array {
  const headerSection = encodeFieldSection(response.headers);
  return concatBytes(
    encodeVarint(1),
    encodeVarint(response.status),
    encodeVarint(headerSection.length),
    headerSection,
    encodeVarint(response.content.length),
    response.content,
    encodeVarint(0),
  );
}

export function decodeBinaryHttpResponse(bytes: Uint8Array): OhttpResponse {
  const reader = new Reader(bytes);
  if (reader.varint() !== 1) throw new OhttpError('bhttp: framing response harus 1');
  const status = reader.varint();
  if (status < 200 || status > 599) throw new OhttpError(`bhttp: status tidak sah (${status})`);
  const headers = decodeFieldSection(reader);
  const content = reader.bytesOf(reader.varint());
  if (!reader.done) {
    const trailerLength = reader.varint();
    if (trailerLength !== 0) throw new OhttpError('bhttp: trailer tidak didukung');
  }
  return { status, headers, content };
}

// ─────────────────────────── Key configuration (RFC 9458 §3) ────────────────

export interface OhttpKeyConfig {
  keyId: number;
  kemId: number;
  kdfId: number;
  aeadId: number;
  publicKey: Uint8Array;
}

/** Encode satu key config (RFC 9458 §3.1) — bukan collection. */
export function encodeOhttpKeyConfig(config: OhttpKeyConfig): Uint8Array {
  if (config.publicKey.length !== OHTTP_GATEWAY_KEY_BYTES) {
    throw new OhttpError(`ohttp: public key harus ${OHTTP_GATEWAY_KEY_BYTES} byte`);
  }
  const out = new Uint8Array(1 + 2 + OHTTP_GATEWAY_KEY_BYTES + 2 + 4);
  const view = new DataView(out.buffer);
  out[0] = config.keyId;
  view.setUint16(1, config.kemId, false);
  out.set(config.publicKey, 3);
  view.setUint16(3 + OHTTP_GATEWAY_KEY_BYTES, 4, false); // panjang algoritma simetris
  view.setUint16(3 + OHTTP_GATEWAY_KEY_BYTES + 2, config.kdfId, false);
  view.setUint16(3 + OHTTP_GATEWAY_KEY_BYTES + 4, config.aeadId, false);
  return out;
}

/** Decode satu key config (tanpa panjang prefiks collection). */
export function decodeOhttpKeyConfig(config: Uint8Array): OhttpKeyConfig {
  if (config.length < 3 + OHTTP_GATEWAY_KEY_BYTES + 6) {
    throw new OhttpError('ohttp: key config terlalu pendek');
  }
  const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
  const publicKey = config.slice(3, 3 + OHTTP_GATEWAY_KEY_BYTES);
  if (publicKey.length !== OHTTP_GATEWAY_KEY_BYTES) {
    throw new OhttpError('ohttp: public key terpotong');
  }
  const symLength = view.getUint16(3 + OHTTP_GATEWAY_KEY_BYTES, false);
  if (symLength < 4) throw new OhttpError('ohttp: algoritma simetris tidak ada');
  return {
    keyId: config[0]!,
    kemId: view.getUint16(1, false),
    kdfId: view.getUint16(3 + OHTTP_GATEWAY_KEY_BYTES + 2, false),
    aeadId: view.getUint16(3 + OHTTP_GATEWAY_KEY_BYTES + 4, false),
    publicKey,
  };
}

/**
 * Encode collection `application/ohttp-keys` (RFC 9458 §3.2), satu atau
 * beberapa config. Rotasi mempublikasikan kunci aktif DAN kunci berikutnya:
 * klien lama tetap bisa membuka jawaban, klien baru memakai key id tertinggi.
 */
export function encodeOhttpKeyConfigCollection(
  input: OhttpKeyConfig | readonly OhttpKeyConfig[],
): Uint8Array {
  const configs = Array.isArray(input) ? input : [input as OhttpKeyConfig];
  if (configs.length === 0) throw new OhttpError('ohttp: collection kosong');
  if (configs.length > OHTTP_MAX_KEY_CONFIGS) {
    throw new OhttpError(`ohttp: maksimal ${OHTTP_MAX_KEY_CONFIGS} key config`);
  }
  const ids = new Set<number>();
  const encoded: Uint8Array[] = [];
  for (const config of configs) {
    if (ids.has(config.keyId)) throw new OhttpError(`ohttp: key id duplikat (${config.keyId})`);
    ids.add(config.keyId);
    encoded.push(encodeOhttpKeyConfig(config));
  }
  const total = encoded.reduce((sum, bytes) => sum + 2 + bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const bytes of encoded) {
    view.setUint16(offset, bytes.length, false);
    offset += 2;
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

/** Decode collection; mengembalikan SEMUA config (dipakai untuk rotasi). */
export function decodeOhttpKeyConfigCollection(bytes: Uint8Array): OhttpKeyConfig[] {
  if (bytes.length < 2) throw new OhttpError('ohttp: key collection terlalu pendek');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const configs: OhttpKeyConfig[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new OhttpError('ohttp: panjang config terpotong');
    const length = view.getUint16(offset, false);
    offset += 2;
    if (length < 3 || offset + length > bytes.length) {
      throw new OhttpError('ohttp: panjang config tidak sah');
    }
    configs.push(decodeOhttpKeyConfig(bytes.slice(offset, offset + length)));
    offset += length;
    if (configs.length > OHTTP_MAX_KEY_CONFIGS) {
      throw new OhttpError('ohttp: terlalu banyak key config');
    }
  }
  if (configs.length === 0) throw new OhttpError('ohttp: collection kosong');
  return configs;
}

/**
 * Config yang dipakai klien: key id tertinggi.
 *
 * Klien TIDAK memilih kunci sendiri berdasarkan urutan wire — server yang
 * menentukan kunci mana yang aktif, dan urutan collection tidak boleh berarti
 * apa pun (RFC 9458 tidak mendefinisikan prioritas).
 */
export function selectOhttpKeyConfig(configs: readonly OhttpKeyConfig[]): OhttpKeyConfig {
  if (configs.length === 0) throw new OhttpError('ohttp: collection kosong');
  return configs.reduce((best, item) => (item.keyId > best.keyId ? item : best));
}

// ─────────────────────────── Allowlist target ───────────────────────────────

export interface OhttpAllowRule {
  method: string;
  path: RegExp;
}

/**
 * Target yang boleh dilewatkan gateway. Sengaja sangat sempit: gateway tidak
 * boleh menjadi proxy HTTP umum (SSRF + penyalahgunaan). Tambahkan entri di
 * sini hanya untuk endpoint yang memang butuh menyembunyikan IP klien.
 */
export const OHTTP_DEFAULT_ALLOWLIST: readonly OhttpAllowRule[] = [
  { method: 'GET', path: /^\/api\/users\/search$/ },
  { method: 'GET', path: /^\/api\/keys\/prekey-bundle\/[A-Za-z0-9_-]{1,64}$/ },
  { method: 'POST', path: /^\/api\/pir\/query$/ },
];

export function isOhttpTargetAllowed(
  method: string,
  path: string,
  rules: readonly OhttpAllowRule[] = OHTTP_DEFAULT_ALLOWLIST,
): boolean {
  const upper = method.toUpperCase();
  // `path` di Binary HTTP membawa query string; aturan allowlist ditulis untuk
  // pathname saja supaya `?q=...` tidak membuat target yang sah ditolak.
  const pathname = path.split('?')[0] ?? '';
  return rules.some((rule) => rule.method === upper && rule.path.test(pathname));
}

/** Header hop-by-hop / identitas yang tidak boleh diteruskan gateway. */
const FORBIDDEN_FORWARD_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
]);

/** Filter header sebelum request diteruskan ke target (gateway). */
export function sanitizeOhttpForwardHeaders(headers: readonly OhttpHeader[]): OhttpHeader[] {
  return headers.filter(([name]) => !FORBIDDEN_FORWARD_HEADERS.has(name.toLowerCase()));
}

// ─────────────────────────── HPKE encapsulation ─────────────────────────────

function buildRequestInfo(config: OhttpKeyConfig): Uint8Array {
  return concatBytes(
    textEncoder.encode(OHTTP_REQUEST_INFO),
    Uint8Array.of(0),
    Uint8Array.of(config.keyId),
    Uint8Array.of((config.kemId >> 8) & 0xff, config.kemId & 0xff),
    Uint8Array.of((config.kdfId >> 8) & 0xff, config.kdfId & 0xff),
    Uint8Array.of((config.aeadId >> 8) & 0xff, config.aeadId & 0xff),
  );
}

/** Salin ke buffer ArrayBuffer baru (WebCrypto menolak ArrayBufferLike/SharedArrayBuffer). */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

async function aesGcmSeal(keyBytes: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', copyBytes(keyBytes), 'AES-GCM', false, ['encrypt']);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: copyBytes(nonce), tagLength: 128 },
    key,
    copyBytes(plaintext),
  );
  return new Uint8Array(sealed);
}

async function aesGcmOpen(keyBytes: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', copyBytes(keyBytes), 'AES-GCM', false, ['decrypt']);
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyBytes(nonce), tagLength: 128 },
    key,
    copyBytes(ciphertext),
  );
  return new Uint8Array(opened);
}

async function deriveResponseKeys(
  context: {
    export: (context: ArrayBufferView<ArrayBufferLike> | ArrayBufferLike, length: number) => Promise<ArrayBuffer>;
  },
  enc: Uint8Array,
  responseNonce: Uint8Array,
): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  const secret = new Uint8Array(await context.export(copyBytes(textEncoder.encode(OHTTP_RESPONSE_INFO)), 32));
  const prk = extract(sha256, secret, concatBytes(enc, responseNonce));
  const key = expand(sha256, prk, textEncoder.encode('key'), 32);
  const nonce = expand(sha256, prk, textEncoder.encode('nonce'), 12);
  return { key, nonce };
}

export interface OhttpClientSealedRequest {
  /** Body `message/ohttp-req` yang dikirim ke relay. */
  body: Uint8Array;
  /** Buka `message/ohttp-res` menjadi response HTTP. */
  openResponse: (encapsulatedResponse: Uint8Array) => Promise<OhttpResponse>;
}

/** Generate keypair gateway (P-256). Dipakai script provisioning, bukan runtime. */
export async function generateOhttpKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const kem = new DhkemP256HkdfSha256();
  const keyPair = await kem.generateKeyPair();
  return {
    privateKey: new Uint8Array(await kem.serializePrivateKey(keyPair.privateKey)),
    publicKey: new Uint8Array(await kem.serializePublicKey(keyPair.publicKey)),
  };
}

/**
 * Pastikan private/public key benar berpasangan. Dipanggil saat boot dengan
 * gateway diaktifkan: salah pasang kunci harus gagal keras, bukan menghasilkan
 * gateway yang membalas sampah ke setiap klien.
 */
export async function assertOhttpKeyPair(privateKey: Uint8Array, publicKey: Uint8Array): Promise<void> {
  const probe = await encapsulateOhttpRequest(
    {
      keyId: OHTTP_KEY_ID,
      kemId: OHTTP_KEM_P256_SHA256,
      kdfId: OHTTP_KDF_SHA256,
      aeadId: OHTTP_AEAD_AES256_GCM,
      publicKey,
    },
    { method: 'GET', scheme: 'https', authority: 'localhost', path: '/', headers: [], content: new Uint8Array() },
  );
  await decapsulateOhttpRequest({ keyId: OHTTP_KEY_ID, privateKey, encapsulatedRequest: probe.body });
}

/** Client: bungkus Binary HTTP request dengan HPKE (RFC 9458 §4.3). */
export async function encapsulateOhttpRequest(
  config: OhttpKeyConfig,
  request: OhttpRequest,
): Promise<OhttpClientSealedRequest> {
  if (config.publicKey.length !== OHTTP_GATEWAY_KEY_BYTES) {
    throw new OhttpError('ohttp: public key gateway tidak sah');
  }
  const cs = ohttpSuite();
  const kem = new DhkemP256HkdfSha256();
  const recipientPublicKey = await kem.deserializePublicKey(config.publicKey);
  const context = await cs.createSenderContext({
    recipientPublicKey,
    info: buildRequestInfo(config),
  });
  const plaintext = encodeBinaryHttpRequest(request);
  const ciphertext = new Uint8Array(await context.seal(plaintext));
  const header = concatBytes(
    Uint8Array.of(config.keyId),
    Uint8Array.of((config.kemId >> 8) & 0xff, config.kemId & 0xff),
    Uint8Array.of((config.kdfId >> 8) & 0xff, config.kdfId & 0xff),
    Uint8Array.of((config.aeadId >> 8) & 0xff, config.aeadId & 0xff),
  );
  const enc = new Uint8Array(context.enc);
  const body = concatBytes(header, enc, ciphertext);
  if (body.length > OHTTP_MAX_MESSAGE_BYTES) throw new OhttpError('ohttp: request terlalu besar');

  return {
    body,
    openResponse: async (encapsulatedResponse) => {
      if (encapsulatedResponse.length < OHTTP_RESPONSE_NONCE_BYTES + 16) {
        throw new OhttpError('ohttp: response terpotong');
      }
      const responseNonce = encapsulatedResponse.slice(0, OHTTP_RESPONSE_NONCE_BYTES);
      const ct = encapsulatedResponse.slice(OHTTP_RESPONSE_NONCE_BYTES);
      try {
        const { key, nonce } = await deriveResponseKeys(context, enc, responseNonce);
        const opened = await aesGcmOpen(key, nonce, ct);
        return decodeBinaryHttpResponse(opened);
      } catch {
        throw new OhttpError('ohttp: dekripsi response gagal');
      }
    },
  };
}

export interface OhttpGatewaySealedRequest {
  request: OhttpRequest;
  /** Bungkus Binary HTTP response menjadi `message/ohttp-res` (§4.4). */
  sealResponse: (response: OhttpResponse) => Promise<Uint8Array>;
}

/** Gateway: buka Encapsulated Request (RFC 9458 §4.3). */
export async function decapsulateOhttpRequest(input: {
  keyId: number;
  privateKey: Uint8Array;
  encapsulatedRequest: Uint8Array;
}): Promise<OhttpGatewaySealedRequest> {
  const bytes = input.encapsulatedRequest;
  if (bytes.length < OHTTP_HEADER_BYTES + OHTTP_ENC_BYTES + 16) {
    throw new OhttpError('ohttp: encapsulated request terpotong');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyId = bytes[0]!;
  if (keyId !== input.keyId) throw new OhttpError('ohttp: key id tidak dikenal');
  const kemId = view.getUint16(1, false);
  const kdfId = view.getUint16(3, false);
  const aeadId = view.getUint16(5, false);
  if (kemId !== OHTTP_KEM_P256_SHA256 || kdfId !== OHTTP_KDF_SHA256 || aeadId !== OHTTP_AEAD_AES256_GCM) {
    throw new OhttpError('ohttp: parameter HPKE tidak didukung');
  }
  if (input.privateKey.length !== OHTTP_PRIVATE_KEY_BYTES) {
    throw new OhttpError('ohttp: private key gateway tidak sah');
  }
  const header = bytes.slice(0, OHTTP_HEADER_BYTES);
  const enc = bytes.slice(OHTTP_HEADER_BYTES, OHTTP_HEADER_BYTES + OHTTP_ENC_BYTES);
  const ciphertext = bytes.slice(OHTTP_HEADER_BYTES + OHTTP_ENC_BYTES);
  const info = concatBytes(
    textEncoder.encode(OHTTP_REQUEST_INFO),
    Uint8Array.of(0),
    header,
  );
  const cs = ohttpSuite();
  const kem = new DhkemP256HkdfSha256();
  let context;
  let plaintext: Uint8Array;
  try {
    const recipientKey = await kem.deserializePrivateKey(input.privateKey);
    context = await cs.createRecipientContext({ recipientKey, enc, info });
    plaintext = new Uint8Array(await context.open(ciphertext));
  } catch {
    // Jangan bocorkan detail HPKE ke pemanggil; cukup satu kelas error publik.
    throw new OhttpError('ohttp: dekripsi request gagal');
  }
  const request = decodeBinaryHttpRequest(plaintext);

  return {
    request,
    sealResponse: async (response) => {
      const responseNonce = crypto.getRandomValues(new Uint8Array(OHTTP_RESPONSE_NONCE_BYTES));
      const { key, nonce } = await deriveResponseKeys(context, enc, responseNonce);
      const ct = await aesGcmSeal(key, nonce, encodeBinaryHttpResponse(response));
      return concatBytes(responseNonce, ct);
    },
  };
}
