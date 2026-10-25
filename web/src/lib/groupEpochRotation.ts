// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.6] Rotasi era terjadwal + rotasi manual admin.
 *
 * Urutan yang dijaga (penting, pernah menjadi bug kelas "kunci hilang"):
 *   1. `GET /api/groups/:id/epoch` → umur era + `messageSeq` (admin capability);
 *   2. keputusan dari `groupEpochPolicy` (murni, teruji);
 *   3. `POST /api/groups/:id/epoch` → token grup era baru (hanya admin);
 *   4. token tersebut **ditulis dulu ke state lokal** (`pendingToken`) sebelum
 *      metadata di-re-encrypt, supaya percobaan ulang memakai token yang sama
 *      alih-alih merotasi dua kali dan meninggalkan anggota dengan token basi;
 *   5. `rotateGroupKey(..., 'periodic_rotation', true, token)` menulis token
 *      baru ke metadata v3 dan mendistribusikan era kunci baru (mailbox).
 *
 * Tanpa langkah 4, kegagalan PUT metadata membuat anggota memegang token lama
 * yang sudah ditolak server (mailbox pull 403) sampai admin kebetulan merotasi
 * lagi.
 */

import { authFetch } from '@lib/api';
import { decideEpochRotation, type LocalEpochState } from '@lib/groupEpochPolicy';

export const GROUP_EPOCH_ROTATION_INTERVAL_MS = 15 * 60 * 1000;
/** Jeda awal: biarkan app shell + mailbox loop selesai lebih dulu. */
export const GROUP_EPOCH_ROTATION_INITIAL_DELAY_MS = 2 * 60 * 1000;

const KV_KEY = 'nyx_group_epoch_state';

interface StoredEpochState extends LocalEpochState {
  epoch?: number;
  pendingToken?: string;
}

interface ServerEpochStatus {
  epoch: number;
  rotatedAt: string | null;
  createdAt: string | null;
  messageSeq: number;
}

export type EpochRotationOutcome = 'rotated' | 'skipped' | 'not_admin' | 'unavailable';

const memory = new Map<string, StoredEpochState>();

function toMs (value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadStates (): Promise<Record<string, StoredEpochState>> {
  try {
    const [{ db }, { decryptValueAtRest }] = await Promise.all([
      import('@lib/db'),
      import('@lib/keychainDb'),
    ]);
    const row = await db.kvStore.get(KV_KEY);
    const sealed = (row?.value as Record<string, string> | undefined) ?? {};
    const states: Record<string, StoredEpochState> = {};
    for (const [conversationId, value] of Object.entries(sealed)) {
      const plain = await decryptValueAtRest(value);
      if (plain) states[conversationId] = JSON.parse(plain) as StoredEpochState;
    }
    return states;
  } catch {
    return {};
  }
}

async function readState (conversationId: string): Promise<StoredEpochState | undefined> {
  if (!memory.has(conversationId)) {
    const stored = await loadStates();
    if (stored[conversationId]) memory.set(conversationId, stored[conversationId]!);
  }
  return memory.get(conversationId);
}

async function writeState (conversationId: string, state: StoredEpochState | null): Promise<void> {
  if (state) memory.set(conversationId, state);
  else memory.delete(conversationId);
  try {
    const [{ db }, { encryptValueAtRest }] = await Promise.all([
      import('@lib/db'),
      import('@lib/keychainDb'),
    ]);
    const row = await db.kvStore.get(KV_KEY);
    const sealed = (row?.value as Record<string, string> | undefined) ?? {};
    if (state) sealed[conversationId] = await encryptValueAtRest(JSON.stringify(state));
    else delete sealed[conversationId];
    await db.kvStore.put({ key: KV_KEY, value: sealed });
  } catch {
    // Vault terkunci: state tetap di memori, cukup untuk sesi ini.
  }
}

/**
 * Rotasi bila kebijakan mengizinkan (`force` = rotasi manual admin).
 * `skipped` berarti belum jatuh tempo, bukan error.
 */
export async function maybeRotateGroupEpoch (
  conversationId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<EpochRotationOutcome> {
  const { amIGroupAdmin, getMyAdminToken } = await import('@lib/groupPseudonyms');
  if (!amIGroupAdmin(conversationId)) return 'not_admin';
  const adminToken = getMyAdminToken(conversationId);
  if (!adminToken) return 'not_admin';

  const headers = { 'X-Admin-Token': adminToken };
  let status: ServerEpochStatus;
  try {
    status = await authFetch<ServerEpochStatus>(`/api/groups/${conversationId}/epoch`, { headers });
  } catch (error) {
    console.warn(`[Epoch] Status era ${conversationId} tidak terbaca:`, error);
    return 'unavailable';
  }

  const local = await readState(conversationId);
  if (!options.force) {
    const decision = decideEpochRotation({
      now: options.now ?? Date.now(),
      server: {
        rotatedAt: toMs(status.rotatedAt),
        createdAt: toMs(status.createdAt),
        messageSeq: status.messageSeq,
      },
      local: local ?? null,
    });
    if (!decision.rotate) return 'skipped';
  }

  let token = local?.pendingToken;
  let epoch = status.epoch + 1;
  if (!token) {
    try {
      const rotated = await authFetch<{ token: string; epoch: number }>(
        `/api/groups/${conversationId}/epoch`,
        { method: 'POST', headers },
      );
      token = rotated.token;
      epoch = rotated.epoch;
    } catch (error) {
      console.warn(`[Epoch] Rotasi token grup ${conversationId} gagal:`, error);
      return 'unavailable';
    }
  }

  const now = Date.now();
  // Simpan SEBELUM metadata ditulis: kalau langkah berikutnya gagal, percobaan
  // ulang memakai token yang sudah dirotasi server.
  await writeState(conversationId, {
    epoch,
    rotatedAt: now,
    messageSeq: status.messageSeq,
    pendingToken: token,
  });

  const { rotateGroupKey } = await import('@utils/crypto');
  try {
    await rotateGroupKey(conversationId, 'periodic_rotation', true, token);
  } catch (error) {
    console.error(`[Epoch] Re-encrypt metadata era baru ${conversationId} gagal:`, error);
    return 'unavailable';
  }

  await writeState(conversationId, { epoch, rotatedAt: now, messageSeq: status.messageSeq });
  return 'rotated';
}

/** Rotasi manual admin (tombol di Group Info): tanpa cek kebijakan. */
export async function rotateGroupEpochNow (conversationId: string): Promise<EpochRotationOutcome> {
  return maybeRotateGroupEpoch(conversationId, { force: true });
}

export interface GroupEpochLoopOptions {
  intervalMs?: number;
  initialDelayMs?: number;
  listGroups?: () => string[] | Promise<string[]>;
  rotate?: (conversationId: string) => Promise<unknown>;
}

/**
 * Loop rotasi terjadwal. Hanya grup tempat kita admin yang diproses (dicek di
 * `maybeRotateGroupEpoch`); satu tick pada satu waktu, gagal satu grup tidak
 * menghentikan yang lain, `stop()` idempoten.
 */
export function startGroupEpochLoop (options: GroupEpochLoopOptions = {}): () => void {
  const intervalMs = Math.max(60_000, options.intervalMs ?? GROUP_EPOCH_ROTATION_INTERVAL_MS);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? GROUP_EPOCH_ROTATION_INITIAL_DELAY_MS);
  const rotate = options.rotate ?? maybeRotateGroupEpoch;
  const listGroups = options.listGroups ?? (async () => {
    const { useConversationStore } = await import('@store/conversation');
    return useConversationStore
      .getState()
      .conversations
      .filter((conversation) => conversation.isGroup)
      .map((conversation) => conversation.id);
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const conversationId of await listGroups()) {
        if (stopped) break;
        try {
          await rotate(conversationId);
        } catch (error) {
          console.warn(`[Epoch] Rotasi terjadwal gagal untuk ${conversationId}:`, error);
        }
      }
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

/** Test-only. */
export function resetGroupEpochStateForTests (): void {
  memory.clear();
}
