import { TransportOpCode } from '@nyx/shared';

export type TransportMode = 'wt' | 'wss';

export interface ModeDecisionInput {
  currentMode: TransportMode;
  wtFailCount: number;
  wtMaxFails: number;
}

export interface ModeDecisionResult {
  mode: TransportMode;
  shouldSwitchToWss: boolean;
  shouldRetryWt: boolean;
}

/**
 * PURE decision logic for the active-transport state machine.
 *
 * Diberikan mode saat ini dan berapa kali berturut-turut upaya koneksi
 * WebTransport gagal, tentukan langkah berikutnya:
 *  - Jika sudah di mode 'wss', tetap di sana (sticky untuk sesi ini).
 *  - Jika kegagalan WT sudah mencapai ambang batas, beralih ke 'wss'.
 *  - Jika belum, tetap di 'wt' dan biarkan pemanggil mencoba ulang WT.
 */
export function decideTransportMode(input: ModeDecisionInput): ModeDecisionResult {
  if (input.currentMode === 'wss') {
    return { mode: 'wss', shouldSwitchToWss: false, shouldRetryWt: false };
  }
  if (input.wtFailCount >= input.wtMaxFails) {
    return { mode: 'wss', shouldSwitchToWss: true, shouldRetryWt: false };
  }
  return { mode: 'wt', shouldSwitchToWss: false, shouldRetryWt: true };
}

export type OutgoingMapping =
  | { kind: 'fixed'; event: string }
  | { kind: 'derived' } // KEY_SYNC: nama event diambil dari payload.event
  | { kind: 'noop' };

/**
 * TABEL MAPPING Otoritatif opCode keluar -> event socket.io.
 *
 *  CHAT_MESSAGE (0x01) -> 'message:send'           (fixed)
 *  KEY_SYNC      (0x02) -> derived dari payload.event
 *                         (session:request_key, session:fulfill_response,
 *                          group:request_key, group:fulfilled_key,
 *                          messages:distribute_keys, burner:*, migration:*, ...)
 *  PRESENCE      (0x05) -> 'presence:update'        (fixed; payload.event adalah
 *                         typing:start|typing:stop|active|away)
 *  ACK           (0x06) -> 'message:ack_delivered' (fixed; konfirmasi terkirim)
 *
 *  CHAFF / WEBRTC_SIGNAL / WEBRTC_ICE / KICK / HANDSHAKE / HELLO -> noop
 *  (tidak didukung oleh fallback WebSocket di MVP; diam-diam diabaikan sekali
 *  per opCode. HELLO khusus transport WebTransport — jalur WSS langsung
 *  menandai negosiasi kapabilitas selesai tanpa kapabilitas, docs/29 §5.6).
 */
export const OUTGOING_OPCODE_MAP: Record<TransportOpCode, OutgoingMapping> = {
  [TransportOpCode.CHAFF]: { kind: 'noop' },
  [TransportOpCode.CHAT_MESSAGE]: { kind: 'fixed', event: 'message:send' },
  [TransportOpCode.KEY_SYNC]: { kind: 'derived' },
  [TransportOpCode.WEBRTC_SIGNAL]: { kind: 'noop' },
  [TransportOpCode.WEBRTC_ICE]: { kind: 'noop' },
  [TransportOpCode.PRESENCE]: { kind: 'fixed', event: 'presence:update' },
  [TransportOpCode.ACK]: { kind: 'fixed', event: 'message:ack_delivered' },
  [TransportOpCode.KICK]: { kind: 'noop' },
  [TransportOpCode.HANDSHAKE]: { kind: 'noop' },
  [TransportOpCode.HELLO]: { kind: 'noop' },
};

/** OpCode yang WAJIB punya mapping keluar yang bisa dipakai (bukan noop) di MVP. */
export const MVP_OUTGOING_OPCODES: TransportOpCode[] = [
  TransportOpCode.CHAT_MESSAGE,
  TransportOpCode.KEY_SYNC,
  TransportOpCode.PRESENCE,
  TransportOpCode.ACK,
];
