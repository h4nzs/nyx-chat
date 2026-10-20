// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi Burner Chat sisi klien (2026-10-18).
 *
 *  1. Guest mengetik lalu menekan Enter → "tidak terjadi apa pun". Dulu
 *     `sendMessage` mengembalikan `void` dan semua kegagalan (transport mati,
 *     room terminated, ack timeout) berhenti di `console.error`, sehingga UI
 *     tidak punya apa pun untuk ditampilkan.
 *  2. Host destroy → guest tidak tahu, dan refresh masih membuka room. Dulu
 *     satu-satunya gerbang adalah event realtime; tidak ada pemeriksaan status
 *     saat halaman dibuka.
 *
 * Kontrak yang dikunci:
 *  • `sendMessage` selalu mengembalikan `{ok, error?}` dan TIDAK mengirim
 *    apa pun saat belum ada sesi / transport tidak bisa disambungkan.
 *  • `ROOM_TERMINATED` dari ack → status UI terminated + penanda lokal
 *    `burned_<roomId>` (bertahan setelah refresh).
 *  • `initializeFromHash` menolak room yang sudah dihancurkan — dari penanda
 *    lokal (tanpa jaringan) maupun status server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ROOM = 'burner_test1234';
const HASH = `#${ROOM}:host_1:hostdev:${encodeURIComponent('pqpk')}:${encodeURIComponent('clpk')}`;

// Semua state mock di-hoist: factory `vi.mock` dijalankan sebelum body modul,
// jadi variabel biasa belum terinisialisasi saat factory dipanggil.
const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sendEventCalls: { event: string; data: Record<string, unknown>; cb?: unknown }[] = [];
  const ack: { current: unknown } = { current: { ok: true } };

  const transport = {
    connected: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    sendEvent(event: string, data: Record<string, unknown>, cb?: (err: unknown, res: unknown) => void) {
      sendEventCalls.push({ event, data, cb });
      if (cb) cb(null, ack.current);
    },
  };

  return {
    listeners,
    sendEventCalls,
    ack,
    transport,
    connectSocket: vi.fn(),
    api: vi.fn(),
    authState: {
      accessToken: 'guest-token' as string | null,
      user: { id: 'guest_1' } as { id: string } | null,
    },
    initGuest: vi.fn(),
    encrypt: vi.fn(),
  };
});

vi.mock('../../lib/transportClient', () => ({
  transportClient: h.transport,
  connectSocket: (...a: unknown[]) => h.connectSocket(...a),
}));
vi.mock('../../lib/api', () => ({
  api: (...a: unknown[]) => h.api(...a),
}));
vi.mock('../auth', () => ({
  useAuthStore: {
    getState: () => h.authState,
    setState: vi.fn(),
  },
}));
vi.mock('../../lib/crypto-worker-proxy', () => ({
  worker_burner_dr_init_guest: (...a: unknown[]) => h.initGuest(...a),
  worker_burner_dr_encrypt: (...a: unknown[]) => h.encrypt(...a),
  worker_burner_dr_decrypt: vi.fn(),
}));
vi.mock('../../utils/crypto', () => ({
  getSodiumLib: async () => ({
    from_base64: () => new Uint8Array([1, 2, 3]),
    to_base64: () => 'Y3Q',
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  }),
}));
vi.mock('../../lib/burnerFileData', () => ({ extractBurnerFileData: () => ({}) }));

import { useBurnerStore, BURNER_TERMINATED_MESSAGE } from '../burner';

const DR_STATE = { RK: 'rk', CKs: 'cks', CKr: null, Ns: 0, Nr: 0, PN: 0 } as never;

function seedSession() {
  useBurnerStore.setState({
    hostUserId: 'host_1',
    hostDeviceId: 'hostdev',
    hostPqPk: 'pqpk',
    hostClassicalPk: 'clpk',
    activeSessions: { [ROOM]: { drState: DR_STATE, guestClassicalPk: 'guestpk' } },
    messages: [],
    isInitialized: true,
    error: null,
  } as never);
}

function lastBurnerEvent() {
  const call = [...h.sendEventCalls].reverse().find((c) => c.event.startsWith('burner:'));
  expect(call).toBeTruthy();
  return call!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sendEventCalls.length = 0;
  h.listeners.clear();
  localStorage.clear();
  h.transport.connected = true;
  h.authState.accessToken = 'guest-token';
  h.authState.user = { id: 'guest_1' };
  h.ack.current = { ok: true };

  h.encrypt.mockResolvedValue({
    state: DR_STATE,
    header: { kemPk: 'kempk', ct: 'ct', n: 0, pn: 0 },
    ciphertext: new Uint8Array([9, 9, 9]),
  });

  useBurnerStore.setState({
    activeSessions: {},
    messages: [],
    isInitialized: false,
    error: null,
    hostDeviceId: null,
    hostUserId: null,
  } as never);
});

describe('burner.sendMessage — hasil yang bisa ditindaklanjuti UI', () => {
  it('tanpa sesi aktif → {ok:false, NO_SESSION}, tidak mengirim apa pun', async () => {
    const result = await useBurnerStore.getState().sendMessage('halo');
    expect(result).toEqual({ ok: false, error: 'NO_SESSION' });
    expect(h.sendEventCalls).toHaveLength(0);
  });

  it('transport tidak tersambung & token guest gagal diterbitkan → OFFLINE (pesan tidak dienkripsi)', async () => {
    seedSession();
    h.transport.connected = false;
    h.authState.accessToken = null;
    h.authState.user = null;
    h.api.mockRejectedValue(new Error('network down'));

    const result = await useBurnerStore.getState().sendMessage('halo');

    expect(result).toEqual({ ok: false, error: 'OFFLINE' });
    // Ratchet tidak boleh maju untuk pesan yang tidak pernah keluar.
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(useBurnerStore.getState().messages).toHaveLength(0);
  });

  it('ack ok → pesan muncul di UI dan hasil {ok:true}', async () => {
    seedSession();
    h.ack.current = { ok: true };

    const result = await useBurnerStore.getState().sendMessage('halo');

    expect(result).toEqual({ ok: true });
    const sent = lastBurnerEvent();
    expect(sent.event).toBe('burner:send');
    expect(sent.data.roomId).toBe(ROOM);
    expect(sent.data.hostUserId).toBe('host_1');
    const messages = useBurnerStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('halo');
    expect(messages[0]!.senderId).toBe('guest');
  });

  it('ack ROOM_TERMINATED → {ok:false}, status terminated, penanda lokal ditulis', async () => {
    seedSession();
    h.ack.current = { ok: false, error: 'ROOM_TERMINATED' };

    const result = await useBurnerStore.getState().sendMessage('halo');

    expect(result).toEqual({ ok: false, error: 'ROOM_TERMINATED' });
    expect(useBurnerStore.getState().error).toBe(BURNER_TERMINATED_MESSAGE);
    expect(localStorage.getItem(`burned_${ROOM}`)).toBe('true');
    expect(useBurnerStore.getState().messages).toHaveLength(0);
  });

  it('ack error lain → tetap {ok:false} dengan alasannya (bukan hening)', async () => {
    seedSession();
    h.ack.current = { ok: false, error: 'INTERNAL_ERROR' };

    const result = await useBurnerStore.getState().sendMessage('halo');

    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    expect(useBurnerStore.getState().messages).toHaveLength(0);
  });
});

describe('burner.initializeFromHash — gerbang room yang sudah dihancurkan', () => {
  it('penanda lokal burned_<roomId> menolak tanpa menyentuh jaringan/kripto', async () => {
    localStorage.setItem(`burned_${ROOM}`, 'true');

    await useBurnerStore.getState().initializeFromHash(HASH);

    expect(useBurnerStore.getState().error).toBe(BURNER_TERMINATED_MESSAGE);
    expect(useBurnerStore.getState().isInitialized).toBe(true);
    expect(h.api).not.toHaveBeenCalled();
    expect(h.initGuest).not.toHaveBeenCalled();
    expect(useBurnerStore.getState().activeSessions[ROOM]).toBeUndefined();
  });

  it('status server terminated → menolak + menulis penanda lokal', async () => {
    h.api.mockResolvedValue({ roomId: ROOM, terminated: true });

    await useBurnerStore.getState().initializeFromHash(HASH);

    expect(useBurnerStore.getState().error).toBe(BURNER_TERMINATED_MESSAGE);
    expect(localStorage.getItem(`burned_${ROOM}`)).toBe('true');
    expect(h.initGuest).not.toHaveBeenCalled();
  });

  it('status server hidup → sesi guest benar-benar diinisialisasi', async () => {
    h.api.mockResolvedValue({ roomId: ROOM, terminated: false });
    h.initGuest.mockResolvedValue({ state: DR_STATE, guestClassicalPk: 'guestpk' });

    await useBurnerStore.getState().initializeFromHash(HASH);

    expect(useBurnerStore.getState().error).toBeNull();
    expect(useBurnerStore.getState().activeSessions[ROOM]).toBeTruthy();
    expect(useBurnerStore.getState().hostUserId).toBe('host_1');
  });
});

describe('burner v2 (PQ-only) — gerbang VITE_PQ_V2', () => {
  const HASH_V2 = `${HASH}:2`;

  it('link v2 + VITE_PQ_V2=1 → initGuest dipanggil pqOnly:true, sesi bertanda v2', async () => {
    vi.stubEnv('VITE_PQ_V2', '1');
    h.api.mockResolvedValue({ roomId: ROOM, terminated: false });
    h.initGuest.mockResolvedValue({ state: DR_STATE, guestClassicalPk: '', burnerVersion: 2 });

    await useBurnerStore.getState().initializeFromHash(HASH_V2);

    expect(h.initGuest).toHaveBeenCalledWith(expect.objectContaining({ pqOnly: true }));
    expect(useBurnerStore.getState().activeSessions[ROOM]?.burnerVersion).toBe(2);
    vi.unstubAllEnvs();
  });

  it('link v2 + VITE_PQ_V2 mati → tetap v1 (pqOnly tidak diset)', async () => {
    vi.stubEnv('VITE_PQ_V2', '');
    h.api.mockResolvedValue({ roomId: ROOM, terminated: false });
    h.initGuest.mockResolvedValue({ state: DR_STATE, guestClassicalPk: 'guestpk', burnerVersion: 1 });

    await useBurnerStore.getState().initializeFromHash(HASH_V2);

    const arg = h.initGuest.mock.calls.at(-1)?.[0] as { pqOnly?: boolean } | undefined;
    expect(arg?.pqOnly).toBeFalsy();
    expect(useBurnerStore.getState().activeSessions[ROOM]?.burnerVersion).toBe(1);
    vi.unstubAllEnvs();
  });

  it('guest sesi v2 → payload menyertakan burnerVersion:2', async () => {
    useBurnerStore.setState({
      hostUserId: 'host_1',
      hostDeviceId: 'hostdev',
      activeSessions: { [ROOM]: { drState: DR_STATE, guestClassicalPk: '', burnerVersion: 2 } },
      messages: [],
      isInitialized: true,
      error: null,
    } as never);

    const result = await useBurnerStore.getState().sendMessage('halo');

    expect(result).toEqual({ ok: true });
    const sent = lastBurnerEvent();
    const inner = JSON.parse(sent.data.ciphertext as string);
    expect(inner.burnerVersion).toBe(2);
    expect(inner.guestClassicalPk).toBe('');
  });
});
