// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Pin key config OHTTP yang TAHAN ROTASI.
 *
 * Pin lama (`sha256(seluruh collection)`) akan menolak rotasi kunci yang sah,
 * jadi pin disimpan per key id: `{ "<keyId>": "<sha256(publicKey)>" }`.
 *
 * Aturannya:
 *  - **Public key untuk key id yang sudah dipin TIDAK BOLEH berubah** → kalau
 *    berubah, `OHTTP_CONFIG_CHANGED` (substitusi kunci = gateway bisa membaca
 *    semua request; pola yang sama dengan pin KT).
 *  - Klien memakai key id TERTINGGI di antara kunci yang dipin, bukan key id
 *    tertinggi di collection: server tidak bisa menambahkan kunci baru dan
 *    memaksa klien memakainya diam-diam.
 *  - Rotasi baru diadopsi setelah SEMUA kunci yang dipin hilang dari collection
 *    (kunci lama pensiun). Saat itu pin diganti kunci tertinggi yang baru.
 *  - `OHTTP_MAX_KEY_CONFIGS` membatasi ukuran collection (anti-memory/CPU).
 */

import type { OhttpKeyConfig } from '@nyx/shared';

export const OHTTP_CONFIG_PIN_KEY = 'nyx_ohttp_config_pin_v2';

export class OhttpPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OhttpPinError';
  }
}

export interface OhttpPinDecision {
  /** Key id yang harus dipakai untuk enkapsulasi. */
  keyId: number;
  /** Nilai pin baru (JSON) — simpan bila `changed`. */
  pinJson: string;
  /** True bila pin berubah dan pemanggil harus menulisnya. */
  changed: boolean;
}

type PinMap = Record<string, string>;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digestPublicKey(publicKey: Uint8Array): Promise<string> {
  const copy = new Uint8Array(publicKey.length);
  copy.set(publicKey);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)));
}

function parsePin(raw: string | null): PinMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PinMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && /^\d+$/.test(key)) out[key] = value;
    }
    return out;
  } catch {
    // Pin rusak = tidak ada pin (TOFU ulang), bukan alasan memblokir selamanya.
    return {};
  }
}

function highestByKeyId(configs: readonly OhttpKeyConfig[]): OhttpKeyConfig {
  return configs.reduce((best, item) => (item.keyId > best.keyId ? item : best));
}

/**
 * Evaluasi collection terhadap pin tersimpan. Melempar `OhttpPinError` dengan
 * pesan `OHTTP_CONFIG_CHANGED` bila kunci yang sudah dipin berubah.
 */
export async function evaluateOhttpConfigPin(
  configs: readonly OhttpKeyConfig[],
  pinnedRaw: string | null,
): Promise<OhttpPinDecision> {
  if (configs.length === 0) throw new OhttpPinError('OHTTP_CONFIG_EMPTY');
  const pinned = parsePin(pinnedRaw);
  const pinnedIds = Object.keys(pinned).map(Number);
  const byId = new Map(configs.map((config) => [config.keyId, config]));

  const nextPin: PinMap = {};
  const survivingPinned: OhttpKeyConfig[] = [];

  for (const id of pinnedIds) {
    const config = byId.get(id);
    if (!config) continue; // kunci pensiun — bukan pelanggaran
    const digest = await digestPublicKey(config.publicKey);
    if (digest !== pinned[String(id)]) {
      throw new OhttpPinError('OHTTP_CONFIG_CHANGED');
    }
    nextPin[String(id)] = digest;
    survivingPinned.push(config);
  }

  // Ada kunci lama yang masih berlaku → jangan adopsi kunci baru.
  if (survivingPinned.length > 0) {
    const chosen = highestByKeyId(survivingPinned);
    const pinJson = JSON.stringify(nextPin);
    return { keyId: chosen.keyId, pinJson, changed: pinJson !== (pinnedRaw ?? '') };
  }

  // Tidak ada pin, atau semua pin lama sudah pensiun (rotasi selesai).
  const chosen = highestByKeyId(configs);
  const pinJson = JSON.stringify({ [String(chosen.keyId)]: await digestPublicKey(chosen.publicKey) });
  return { keyId: chosen.keyId, pinJson, changed: pinJson !== (pinnedRaw ?? '') };
}
