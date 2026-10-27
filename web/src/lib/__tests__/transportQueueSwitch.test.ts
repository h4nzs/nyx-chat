import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transportClient } from '@lib/transportClient';
import { TransportOpCode } from '@nyx/shared';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), onAny: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false })),
  Socket: class {},
}));

describe('WT→WSS queue migration (H2)', () => {
  beforeEach(() => {
    const t = transportClient as any;
    t.mode = 'wt';
    t.connected = false;
    t.offlineQueue = [];
    t.wssOfflineQueue = [];
    t.socket = null;
    t.wtFailCount = 0;
    t.wtConnectTimer = null;
    t.wtConnecting = false;
  });

  afterEach(() => {
    try { transportClient.disconnect(); } catch {}
  });

  it('memigrasikan pesan WT yang mengantri ke antrean WSS saat connectWss (guard early-return tidak membuang pesan)', () => {
    const payload = new Uint8Array([104, 105, 33]);
    transportClient.sendStream(TransportOpCode.CHAT_MESSAGE, payload);
    expect((transportClient as any).offlineQueue.length).toBe(1);

    // Simulasikan guard early-return: socket sudah ada (kondisi yang DULU
    // menyebabkan drainWtQueueToWss dilewati -> pesan user terbuang).
    (transportClient as any).socket = { on: vi.fn(), onAny: vi.fn(), emit: vi.fn(), disconnect: vi.fn() };
    (transportClient as any).mode = 'wss'; // handleWtFailure set mode sebelum connectWss

    // connectWss sekarang memanggil drainWtQueueToWss() SEBELUM guard.
    (transportClient as any).connectWss();

    expect((transportClient as any).offlineQueue.length).toBe(0);
    expect((transportClient as any).wssOfflineQueue.length).toBe(1);
  });

  it('membuang START_HANDSHAKE (WT-only) saat transisi, tidak membuang pesan user', () => {
    const payload = new Uint8Array([104, 105, 33]);
    transportClient.sendStream(TransportOpCode.CHAT_MESSAGE, payload);
    (transportClient as any).offlineQueue.push({
      type: 'START_HANDSHAKE',
      opCode: TransportOpCode.HANDSHAKE,
      payload,
    });
    expect((transportClient as any).offlineQueue.length).toBe(2);

    (transportClient as any).socket = { on: vi.fn(), onAny: vi.fn(), emit: vi.fn(), disconnect: vi.fn() };
    (transportClient as any).mode = 'wss';

    (transportClient as any).connectWss();

    expect((transportClient as any).offlineQueue.length).toBe(0);
    // Hanya pesan user (SEND_STREAM) yang dipindahkan; START_HANDSHAKE dibuang.
    expect((transportClient as any).wssOfflineQueue.length).toBe(1);
  });

  it('mengabaikan event WT terlambat setelah fallback ke wss (banner tidak merah)', () => {
    const t = transportClient as any;
    t.mode = 'wss';
    t.connected = true;
    const onDisconnect = vi.fn();
    const onConnect = vi.fn();
    t.on('disconnect', onDisconnect);
    t.on('connect', onConnect);

    t.handleWorkerMessage({ data: { type: 'DISCONNECTED', reason: 'late wt close' } });
    t.handleWorkerMessage({ data: { type: 'CONNECTED' } });
    t.handleWorkerMessage({ data: { type: 'ERROR', error: 'late wt error' } });

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(t.connected).toBe(true);

    t.off('disconnect', onDisconnect);
    t.off('connect', onConnect);
  });
});
