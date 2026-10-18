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
 *  WEBRTC_SIGNAL (0x03) -> 'webrtc:secure_signal'  (fixed; { to: relayToken,
 *  WEBRTC_ICE    (0x04) ->  type, payload })
 *  PRESENCE      (0x05) -> 'presence:update'        (fixed; payload.event adalah
 *                         typing:start|typing:stop|active|away)
 *  ACK           (0x06) -> 'message:ack_delivered' (fixed; konfirmasi terkirim)
 *
 *  [PARITY 2026-10-18] WEBRTC_SIGNAL/ICE dulu `noop` di sini — sinyal panggilan
 *  keluar hilang diam-diam begitu klien jatuh ke fallback WSS (sementara arah
 *  masuknya bahkan salah rute ke `message:new` di gateway). Sekarang keduanya
 *  memakai SATU event (`webrtc:secure_signal`, nama yang sudah ada di
 *  `packages/shared/src/socket.ts`): gateway meneruskan ke
 *  `handleWebRtcRelay`, dan `to` tetap token relay buram — jadi yang menentukan
 *  diteruskan atau tidak adalah keputusan server, bukan tabel ini.
 *
 *  CHAFF / KICK / HANDSHAKE / HELLO -> noop
 *  (CHAFF = padding penyamaran trafik yang tidak punya padanan di WSS;
 *  KICK hanya arah server→klien; HANDSHAKE (PQ) khusus WebTransport — jalur WSS
 *  tidak punya handshake transport, lihat `startHandshake`; HELLO kapabilitas
 *  punya padanannya sendiri di WSS lewat `handshake.auth.capabilities` +
 *  event `capabilities`, docs/29 §5.6. Semuanya diabaikan sekali per opCode.)
 */
export const OUTGOING_OPCODE_MAP: Record<TransportOpCode, OutgoingMapping> = {
  [TransportOpCode.CHAFF]: { kind: 'noop' },
  [TransportOpCode.CHAT_MESSAGE]: { kind: 'fixed', event: 'message:send' },
  [TransportOpCode.KEY_SYNC]: { kind: 'derived' },
  [TransportOpCode.WEBRTC_SIGNAL]: { kind: 'fixed', event: 'webrtc:secure_signal' },
  [TransportOpCode.WEBRTC_ICE]: { kind: 'fixed', event: 'webrtc:secure_signal' },
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
  TransportOpCode.WEBRTC_SIGNAL,
  TransportOpCode.WEBRTC_ICE,
];
