export enum TransportOpCode {
  CHAT_MESSAGE = 0x01,
  KEY_SYNC = 0x02,
  WEBRTC_SIGNAL = 0x03,
  WEBRTC_ICE = 0x04,
  PRESENCE = 0x05,
  ACK = 0x06
}

export type BinaryPayload = Uint8Array;

export interface WebRtcSignalPayload {
  to: string;
  type: 'request' | 'accept' | 'reject' | 'end' | 'offer' | 'answer' | 'ice-candidate';
  payload: BinaryPayload; 
}

export type TransportWorkerToMain = 
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED'; reason: string }
  | { type: 'ERROR'; error: string }
  | { type: 'DATA_RECEIVED'; opCode: TransportOpCode; payload: BinaryPayload };

export type MainToTransportWorker =
  | { type: 'CONNECT'; url: string; token: string }
  | { type: 'DISCONNECT' }
  | { type: 'SEND_STREAM'; opCode: TransportOpCode; payload: BinaryPayload }
  | { type: 'SEND_DATAGRAM'; opCode: TransportOpCode; payload: BinaryPayload };
