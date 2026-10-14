// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D poin 2 / docs/33 §33.7 poin 1] Orkestrasi **satu langkah
 * ratchet** jalur v2 (braid SPQR) di atas ABI mentah `spqrRatchet.ts`.
 *
 * Kenapa lapisan ini ada (dan bukan dipanggil langsung dari worker):
 *
 *  1. **Satu langkah SPQR ≠ satu message key.** State machine crate `spqr`
 *     melewati beberapa keadaan (pertukaran header/ek/ct-ack, chunk braid) yang
 *     mengeluarkan frame dengan `key = null`. Kalau tiap panggilan `send`
 *     dianggap satu pesan, pengguna akan mengirim pesan kosong atau — lebih
 *     buruk — pesan yang isinya tidak bisa dibuka peer. Di sini pengirim
 *     **mengumpulkan frame** sampai message key benar-benar ada (satu pesan
 *     pengguna = satu pesan wire, `docs/04`), dan penerima menerapkan
 *     frame-frame itu berurutan.
 *  2. **Transaksional.** Pembungkus mengembalikan state baru hanya bila seluruh
 *     rangkaian berhasil; pemanggil menyimpan state itu atau tidak sama sekali.
 *     State tidak pernah disimpan di tengah jalan, jadi pesan yang gagal dibuka
 *     bisa dicoba ulang dari state sebelumnya.
 *  3. **Testable tanpa worker.** Modul ini murni (instance WASM disuntik), jadi
 *     harness unit memakai modul hasil build sungguhan — sama seperti
 *     `spqrBench`/`spqrRatchet.test`.
 *
 * Modul ini **tidak** menyentuh AEAD/padding: message key yang keluar dipakai
 * jalur XChaCha20-Poly1305 yang sama dengan v1 (8 KB traffic cover tetap).
 */

import { SPQR_MAX_FRAMES_PER_MESSAGE } from './spqrWire';
import type { SpqrDirection, SpqrRatchet } from './spqrRatchet';

/**
 * Batas langkah per pesan. Disamakan dengan batas frame di wire
 * (`SPQR_MAX_FRAMES_PER_MESSAGE`) supaya pengirim tidak pernah mengumpulkan
 * lebih banyak frame daripada yang bisa dibawa satu header.
 */
export const SPQR_MAX_STEPS_PER_MESSAGE = SPQR_MAX_FRAMES_PER_MESSAGE;

export class SpqrSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpqrSessionError';
  }
}

/** State awal sesi v2. `authKey` = rahasia X3DH yang sama di kedua sisi. */
export function initSpqrSession(
  ratchet: SpqrRatchet,
  input: { authKey: Uint8Array; direction: SpqrDirection }
): Uint8Array {
  if (input.authKey.length === 0) throw new SpqrSessionError('spqr-session: authKey kosong');
  return ratchet.initialState({ authKey: input.authKey, direction: input.direction });
}

export interface SpqrSendStep {
  /** State setelah langkah (WAJIB disimpan oleh pemanggil). */
  state: Uint8Array;
  /** Frame braid yang harus dikirim peer, berurutan. Tidak pernah kosong. */
  frames: Uint8Array[];
  /** Message key untuk pesan ini (selalu ada — loop berhenti hanya saat key ada). */
  key: Uint8Array;
}

/**
 * Jalankan langkah pengiriman sampai message key tersedia.
 *
 * Frame dengan payload kosong (keadaan `MessagePayload::None`) hanya memajukan
 * state dan tidak dikirim. Bila setelah batas langkah key belum juga ada, itu
 * bug/keadaan tak terduga → melempar `SpqrSessionError` (fail-closed: lebih baik
 * tidak mengirim apa pun daripada mengirim pesan tanpa key).
 */
export function spqrSendStep(ratchet: SpqrRatchet, state: Uint8Array): SpqrSendStep {
  const frames: Uint8Array[] = [];
  let current = state;

  for (let step = 0; step < SPQR_MAX_STEPS_PER_MESSAGE; step++) {
    const result = ratchet.send(current);
    current = result.state;
    if (result.msg.length > 0) frames.push(result.msg);
    if (result.key && result.key.length > 0) {
      if (frames.length === 0) {
        // Tidak mungkin dengan ABI sekarang, tapi biarkan terlihat: pesan tanpa
        // frame tidak bisa diterima peer sama sekali.
        throw new SpqrSessionError('spqr-session: key tersedia tanpa frame braid');
      }
      return { state: current, frames, key: result.key };
    }
  }

  throw new SpqrSessionError(
    `spqr-session: message key tidak tersedia setelah ${SPQR_MAX_STEPS_PER_MESSAGE} langkah`
  );
}

export interface SpqrRecvStep {
  state: Uint8Array;
  /**
   * Message key pesan ini, atau `null` bila rangkaian frame tidak menghasilkan
   * key (mis. pesan pembawa braid saja dari peer yang belum mengirim konten).
   */
  key: Uint8Array | null;
}

/**
 * Terapkan frame braid peer secara berurutan pada state lokal.
 *
 * Key yang dipakai adalah key **terakhir** yang dihasilkan: pengirim berhenti
 * mengumpulkan frame tepat saat key muncul, jadi frame terakhir-lah yang
 * membawa key pesan. Kalau sama sekali tidak ada key, pemanggil memperlakukan
 * pesan sebagai tidak dapat dibuka (bukan sebagai sukses tanpa isi).
 */
export function spqrRecvStep(
  ratchet: SpqrRatchet,
  input: { state: Uint8Array; frames: Uint8Array[] }
): SpqrRecvStep {
  if (input.frames.length === 0) throw new SpqrSessionError('spqr-session: tidak ada frame untuk diterapkan');
  if (input.frames.length > SPQR_MAX_STEPS_PER_MESSAGE) {
    throw new SpqrSessionError(`spqr-session: terlalu banyak frame (${input.frames.length})`);
  }

  let current = input.state;
  let key: Uint8Array | null = null;
  for (const frame of input.frames) {
    const result = ratchet.recv(current, frame);
    current = result.state;
    if (result.key && result.key.length > 0) key = result.key;
  }
  return { state: current, key };
}
