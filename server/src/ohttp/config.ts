// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 3] Konfigurasi gateway OHTTP.
 *
 * Default MATI: tanpa `OHTTP_ENABLED=1`, router tidak dipasang sama sekali
 * (404, bukan 403) sehingga deployment biasa tidak mengiklankan kemampuan ini.
 * Saat hidup, konfigurasi yang tidak lengkap/salah membuat boot gagal — gate
 * yang setengah aktif akan mengirim balasan yang tidak bisa dibuka klien.
 *
 * ROTASI DUA SLOT: `OHTTP_PRIVATE_KEY`/`OHTTP_PUBLIC_KEY` (key id 1) adalah
 * kunci aktif; `OHTTP_NEXT_PRIVATE_KEY`/`OHTTP_NEXT_PUBLIC_KEY` (key id 2)
 * adalah kunci berikutnya. Keduanya dipublikasikan di `/api/ohttp/config`
 * sehingga klien lama (pin key id 1) dan klien baru (memilih key id 2) sama-sama
 * bisa membuka jawaban selama masa transisi. Gateway menerima keduanya; setelah
 * semua klien pindah, slot lama dikosongkan (id 3/4 dicadangkan untuk hybrid).
 *
 * Slot hybrid X-Wing memakai id 3/4 dan **collection terpisah**: klien lama
 * tidak bisa mem-parse public key 1216 byte, jadi collection hybrid hanya
 * dikirim ke klien yang meminta `Accept: application/ohttp-keys+xwing`.
 */

import { createHmac } from 'node:crypto';
import {
  OHTTP_AEAD_AES256_GCM,
  OHTTP_KDF_SHA256,
  OHTTP_KEM_P256_SHA256,
  OHTTP_KEM_XWING,
  OHTTP_KEY_ID,
  OHTTP_XWING_KEY_ID,
  OHTTP_XWING_NEXT_KEY_ID,
  ohttpKemSizes,
  type OhttpAllowRule,
  type OhttpKeyConfig,
} from '@nyx/shared';

export interface OhttpKeySlot {
  keyId: number;
  privateKey: Uint8Array;
}

export type OhttpTokenMode = 'on' | 'off';

export interface OhttpConfig {
  /** Slot yang diterima gateway, urut naik berdasarkan key id. */
  keys: readonly OhttpKeySlot[];
  /** Bentuk publik klasik yang disajikan `/api/ohttp/config` (default). */
  publicConfigs: readonly OhttpKeyConfig[];
  /** Bentuk publik hybrid; disajikan hanya bila klien meminta `OHTTP_XWING_ACCEPT`. */
  pqPublicConfigs: readonly OhttpKeyConfig[];
  /** URL gateway internal yang dituju relay (bukan dari input klien). */
  relayTarget: string;
  /** Allowlist target; default dari shared bila tidak di-override. */
  allowlist?: readonly OhttpAllowRule[];
  /** `off` = relay mencetak token sendiri; klien tidak mengambil token. */
  tokenMode?: OhttpTokenMode;
  /** Rahasia proses untuk membedakan relay internal dari pemanggil luar. */
  internalToken?: string;
}

function decodeKey(name: string, value: string | undefined, expected: number): Uint8Array {
  if (!value) throw new Error(`OHTTP: ${name} wajib diisi saat OHTTP_ENABLED=1`);
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
  if (bytes.length !== expected) {
    throw new Error(`OHTTP: ${name} harus ${expected} byte (didapat ${bytes.length})`);
  }
  return bytes;
}

function parseTokenMode(value: string | undefined): OhttpTokenMode {
  if (value === undefined || value === '' || value === 'on') return 'on';
  if (value === 'off') return 'off';
  throw new Error('OHTTP: OHTTP_TOKEN_MODE harus on atau off');
}

function assertLoopbackRelayTarget(target: string): void {
  let hostname: string;
  try {
    hostname = new URL(target).hostname;
  } catch {
    throw new Error('OHTTP: OHTTP_RELAY_TARGET bukan URL yang valid');
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
    throw new Error('OHTTP: OHTTP_TOKEN_MODE=off hanya mengizinkan relay loopback');
  }
}

function publicConfigFor(
  keyId: number,
  publicKey: Uint8Array,
  kemId: number = OHTTP_KEM_P256_SHA256,
): OhttpKeyConfig {
  return {
    keyId,
    kemId,
    kdfId: OHTTP_KDF_SHA256,
    aeadId: OHTTP_AEAD_AES256_GCM,
    publicKey,
  };
}

/**
 * [audit F-06] Token internal relay → gateway HARUS sama di semua worker.
 *
 * Dulu nilainya `randomBytes(32)` per proses, sementara pm2 menjalankan
 * `-i max`: relay (worker mana pun) mengirim token yang tidak dikenal worker
 * penerima, jadi gateway menjawab 403 secara acak. Sekarang urutannya:
 * `OHTTP_INTERNAL_TOKEN` (eksplisit, dipakai juga saat relay berjalan di proses
 * terpisah) → HMAC `JWT_SECRET` (deterministik, tanpa env baru) → boot gagal.
 *
 * Konsekuensi yang harus dipahami operator: token ini bukan rahasia klien,
 * hanya pembeda "dipanggil relay internal" vs "dipanggil langsung"; ia bisa
 * dihitung siapa pun yang memegang `JWT_SECRET` (yaitu proses server sendiri).
 * Klien TIDAK pernah memegang `JWT_SECRET`, dan header ini dibuang OHTTP.
 *
 * [audit N9-01] Token yang sama juga mengautentikasi **tag klien relay**
 * (`x-nyx-ohttp-client-tag`), jadi pada mode `on` ia tetap boleh disetel —
 * hanya saja eksplisit: relay proses terpisah tidak memegang `JWT_SECRET`, jadi
 * turunan otomatis tidak bisa dipakai bersama dan tidak dicoba diam-diam.
 * Tanpa token, tag tidak dipercaya dan limiter kembali ke perilaku lama
 * (bukan jalur yang lebih longgar).
 */
function resolveInternalToken (env: NodeJS.ProcessEnv, required: boolean): string | undefined {
  const explicit = (env.OHTTP_INTERNAL_TOKEN ?? '').trim();
  if (explicit) {
    if (explicit.length < 32) {
      throw new Error('OHTTP: OHTTP_INTERNAL_TOKEN minimal 32 karakter');
    }
    return explicit;
  }
  if (!required) return undefined;
  const secret = (env.JWT_SECRET ?? '').trim();
  if (!secret) {
    throw new Error(
      'OHTTP: OHTTP_TOKEN_MODE=off butuh OHTTP_INTERNAL_TOKEN atau JWT_SECRET ' +
        'yang sama di semua worker (kalau tidak, relay acak ditolak gateway)'
    );
  }
  return createHmac('sha256', secret).update('nyx-ohttp-internal-token-v1').digest('base64url');
}

/** Fitur hidup? Dipakai endpoint token agar mati = 404, bukan 403. */
export function isOhttpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OHTTP_ENABLED === '1';
}

/**
 * Muat konfigurasi dari env. `null` = fitur mati (perilaku default).
 * Melempar bila diaktifkan tetapi tidak lengkap.
 */
export function loadOhttpConfig(env: NodeJS.ProcessEnv = process.env): OhttpConfig | null {
  if (env.OHTTP_ENABLED !== '1') return null;

  const port = env.PORT ?? '4000';
  const tokenMode = parseTokenMode(env.OHTTP_TOKEN_MODE);
  const relayTarget = env.OHTTP_RELAY_TARGET ?? `http://127.0.0.1:${port}/api/ohttp/gateway`;
  if (tokenMode === 'off') assertLoopbackRelayTarget(relayTarget);
  const slots: OhttpKeySlot[] = [];
  const publicConfigs: OhttpKeyConfig[] = [];
  const pqPublicConfigs: OhttpKeyConfig[] = [];

  const addSlot = (
    target: OhttpKeyConfig[],
    keyId: number,
    privName: string,
    pubName: string,
    kemId: number,
  ) => {
    const sizes = ohttpKemSizes(kemId);
    const privateKey = decodeKey(privName, env[privName], sizes.privateKey);
    const publicKey = decodeKey(pubName, env[pubName], sizes.publicKey);
    slots.push({ keyId, privateKey });
    target.push(publicConfigFor(keyId, publicKey, kemId));
  };

  addSlot(publicConfigs, OHTTP_KEY_ID, 'OHTTP_PRIVATE_KEY', 'OHTTP_PUBLIC_KEY', OHTTP_KEM_P256_SHA256);

  const nextPriv = env.OHTTP_NEXT_PRIVATE_KEY;
  const nextPub = env.OHTTP_NEXT_PUBLIC_KEY;
  if (Boolean(nextPriv) !== Boolean(nextPub)) {
    // Separuh slot rotasi = gateway yang tidak bisa dibuka klien baru.
    throw new Error('OHTTP: OHTTP_NEXT_PRIVATE_KEY dan OHTTP_NEXT_PUBLIC_KEY harus diisi bersama');
  }
  if (nextPriv && nextPub) {
    addSlot(
      publicConfigs,
      OHTTP_KEY_ID + 1,
      'OHTTP_NEXT_PRIVATE_KEY',
      'OHTTP_NEXT_PUBLIC_KEY',
      OHTTP_KEM_P256_SHA256,
    );
    const [first, second] = publicConfigs;
    if (first && second && Buffer.from(first.publicKey).equals(Buffer.from(second.publicKey))) {
      throw new Error('OHTTP: kunci rotasi tidak boleh sama dengan kunci aktif');
    }
  }

  // Slot hybrid terpisah dari collection klasik. Klien lama tidak bisa
  // mem-parse X-Wing, jadi hybrid hanya dikirim ke klien yang memintanya
  // lewat `Accept: application/ohttp-keys+xwing`.
  const xwingPriv = env.OHTTP_XWING_PRIVATE_KEY;
  const xwingPub = env.OHTTP_XWING_PUBLIC_KEY;
  if (Boolean(xwingPriv) !== Boolean(xwingPub)) {
    throw new Error('OHTTP: OHTTP_XWING_PRIVATE_KEY dan OHTTP_XWING_PUBLIC_KEY harus diisi bersama');
  }
  if (xwingPriv && xwingPub) {
    addSlot(
      pqPublicConfigs,
      OHTTP_XWING_KEY_ID,
      'OHTTP_XWING_PRIVATE_KEY',
      'OHTTP_XWING_PUBLIC_KEY',
      OHTTP_KEM_XWING,
    );
    const nextXPriv = env.OHTTP_XWING_NEXT_PRIVATE_KEY;
    const nextXPub = env.OHTTP_XWING_NEXT_PUBLIC_KEY;
    if (Boolean(nextXPriv) !== Boolean(nextXPub)) {
      throw new Error(
        'OHTTP: OHTTP_XWING_NEXT_PRIVATE_KEY dan OHTTP_XWING_NEXT_PUBLIC_KEY harus diisi bersama',
      );
    }
    if (nextXPriv && nextXPub) {
      addSlot(
        pqPublicConfigs,
        OHTTP_XWING_NEXT_KEY_ID,
        'OHTTP_XWING_NEXT_PRIVATE_KEY',
        'OHTTP_XWING_NEXT_PUBLIC_KEY',
        OHTTP_KEM_XWING,
      );
      const [first, second] = pqPublicConfigs;
      if (first && second && Buffer.from(first.publicKey).equals(Buffer.from(second.publicKey))) {
        throw new Error('OHTTP: kunci hybrid rotasi tidak boleh sama dengan kunci aktif');
      }
    }
  } else if (env.OHTTP_XWING_NEXT_PRIVATE_KEY || env.OHTTP_XWING_NEXT_PUBLIC_KEY) {
    throw new Error('OHTTP: isi OHTTP_XWING_PRIVATE_KEY/PUBLIC_KEY sebelum slot hybrid berikutnya');
  }

  // Key id harus unik lintas suite: gateway memilih slot hanya dari key id.
  const ids = slots.map((slot) => slot.keyId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('OHTTP: key id gateway duplikat');
  }

  return {
    keys: slots,
    publicConfigs,
    pqPublicConfigs,
    relayTarget,
    tokenMode,
    internalToken: resolveInternalToken(env, tokenMode === 'off'),
  };
}
