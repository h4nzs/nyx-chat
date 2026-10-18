import { describe, it, expect } from 'vitest';
import { TransportOpCode } from '@nyx/shared';
import {
  decideTransportMode,
  OUTGOING_OPCODE_MAP,
  MVP_OUTGOING_OPCODES,
} from '../transportMode';

describe('decideTransportMode', () => {
  it('tetap di mode wss jika sudah beralih ke wss (sticky untuk sesi)', () => {
    const res = decideTransportMode({ currentMode: 'wss', wtFailCount: 5, wtMaxFails: 2 });
    expect(res.mode).toBe('wss');
    expect(res.shouldSwitchToWss).toBe(false);
    expect(res.shouldRetryWt).toBe(false);
  });

  it('mencoba ulang wt saat gagal di bawah ambang batas', () => {
    const res = decideTransportMode({ currentMode: 'wt', wtFailCount: 1, wtMaxFails: 2 });
    expect(res.mode).toBe('wt');
    expect(res.shouldRetryWt).toBe(true);
    expect(res.shouldSwitchToWss).toBe(false);
  });

  it('beralih ke wss setelah gagal mencapai ambang batas', () => {
    const res = decideTransportMode({ currentMode: 'wt', wtFailCount: 2, wtMaxFails: 2 });
    expect(res.mode).toBe('wss');
    expect(res.shouldSwitchToWss).toBe(true);
    expect(res.shouldRetryWt).toBe(false);
  });

  it('ambang batas bisa dikonfigurasi', () => {
    const res = decideTransportMode({ currentMode: 'wt', wtFailCount: 3, wtMaxFails: 4 });
    expect(res.mode).toBe('wt');
    expect(res.shouldRetryWt).toBe(true);
  });
});

describe('OUTGOING_OPCODE_MAP parity', () => {
  it('setiap opCode MVP punya mapping yang bukan noop', () => {
    for (const op of MVP_OUTGOING_OPCODES) {
      const m = OUTGOING_OPCODE_MAP[op];
      expect(m.kind).not.toBe('noop');
    }
  });

  it('CHAT_MESSAGE -> message:send', () => {
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.CHAT_MESSAGE]).toEqual({ kind: 'fixed', event: 'message:send' });
  });

  it('PRESENCE -> presence:update', () => {
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.PRESENCE]).toEqual({ kind: 'fixed', event: 'presence:update' });
  });

  it('ACK -> message:ack_delivered', () => {
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.ACK]).toEqual({ kind: 'fixed', event: 'message:ack_delivered' });
  });

  it('KEY_SYNC bersifat derived (event dari payload.event)', () => {
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.KEY_SYNC]).toEqual({ kind: 'derived' });
  });

  // [PARITY 2026-10-18] WEBRTC_SIGNAL/ICE dulu ada di daftar noop — sinyal
  // panggilan hilang diam-diam di mode WSS. Sekarang keduanya dipetakan ke satu
  // event yang sudah ada di kontrak shared (`webrtc:secure_signal`); server yang
  // memutuskan diteruskan atau tidak (token relay tidak dikenal → drop).
  it('WEBRTC_SIGNAL dan WEBRTC_ICE dipetakan ke webrtc:secure_signal (bukan noop)', () => {
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.WEBRTC_SIGNAL]).toEqual({ kind: 'fixed', event: 'webrtc:secure_signal' });
    expect(OUTGOING_OPCODE_MAP[TransportOpCode.WEBRTC_ICE]).toEqual({ kind: 'fixed', event: 'webrtc:secure_signal' });
  });

  it('opCode yang memang tidak punya padanan WSS tetap noop', () => {
    const noopOpcodes = [
      TransportOpCode.CHAFF,
      TransportOpCode.KICK,
      TransportOpCode.HANDSHAKE,
      TransportOpCode.HELLO,
    ];
    for (const op of noopOpcodes) {
      expect(OUTGOING_OPCODE_MAP[op]).toEqual({ kind: 'noop' });
    }
  });

  it('semua opCode memiliki entri mapping (paritas penuh)', () => {
    const allOpcodes = Object.values(TransportOpCode).filter(
      (v): v is TransportOpCode => typeof v === 'number',
    );
    for (const op of allOpcodes) {
      const m = OUTGOING_OPCODE_MAP[op];
      expect(m).toBeDefined();
      expect(['fixed', 'derived', 'noop']).toContain(m.kind);
    }
  });
});
