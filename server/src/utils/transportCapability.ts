// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §5.6 · docs/33 §33.7] Negosiasi kapabilitas pada jalur **WSS**.
 *
 * Jalur WebTransport punya HELLO bidi di sidecar (`protocol.rs`); jalur WSS
 * (socket.io, fallback yang justru dipakai mayoritas pengguna di jaringan yang
 * memblokir QUIC) dulu **tidak punya apa pun** — akibatnya `negotiatedCapabilities`
 * selalu kosong di sana dan jalur ratchet v2 (braid SPQR) tidak pernah bisa
 * dipakai, walau kedua peer sudah saling menyatakan mampu in-band (`ackV`).
 *
 * Modul ini adalah pasangan TS dari aturan yang sudah ada di
 * `packages/shared/src/transport.ts` (batas parse + irisan kapabilitas), dipakai
 * gateway pada handshake:
 *
 *   klien → `handshake.auth.capabilities` (array string pendek)
 *   server → event `capabilities` (irisan dengan `SERVER_CAPABILITIES`)
 *
 * Aturan yang sama dengan HELLO sidecar: klien lama yang tidak mengirim apa pun
 * diperlakukan **legacy** (daftar kosong), bukan error — dan server TIDAK pernah
 * mengiklankan kapabilitas yang tidak diiklankan klien.
 */

import { SERVER_CAPABILITIES, negotiateCapabilities, sanitizeCapabilityList } from '@nyx/shared';
import { WSS_CAPABILITY, incCounter } from './metrics.js';

/**
 * Daftar kapabilitas yang diiklankan klien WSS, sudah dibersihkan dari input
 * jaringan. Bentuk tidak sah → `[]` (legacy), bukan lempar: satu klien dengan
 * field cacat tidak boleh memutus handshake dirinya sendiri, apalagi yang lain.
 */
export function parseAnnouncedCapabilities(raw: unknown): string[] {
  return sanitizeCapabilityList(raw) ?? [];
}

/**
 * Kapabilitas yang disepakati klien↔gateway: irisan daftar klien dengan
 * `SERVER_CAPABILITIES`. Kapabilitas tak dikenal tidak pernah masuk hasil, dan
 * urutannya mengikuti daftar klien (deterministik) — sama seperti balasan HELLO
 * sidecar, supaya klien tidak perlu tahu relay mana yang menjawab.
 */
export function negotiateWssCapabilities(raw: unknown): string[] {
  return negotiateCapabilities(parseAnnouncedCapabilities(raw), SERVER_CAPABILITIES);
}

/**
 * Mencatat hasil negosiasi satu koneksi WSS ke `nyx_wss_capability_total`.
 *
 * Satu koneksi = satu hit per kapabilitas yang disepakati; bila klien
 * mengiklankan sesuatu tetapi **tidak satu pun** dikenali gateway (mis. klien
 * eksperimental, atau gateway lebih tua), dicatat sebagai `capability="none"` —
 * itu keadaan yang harus terlihat, bukan nol yang ambigu.
 */
export function recordWssCapabilities(agreed: readonly string[]): void {
  if (agreed.length === 0) {
    incCounter(WSS_CAPABILITY, { capability: 'none' });
    return;
  }
  for (const capability of agreed) {
    incCounter(WSS_CAPABILITY, { capability });
  }
}
