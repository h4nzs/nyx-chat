// web/src/types/crypto-common.ts

// Type alias for raw binary data passed between Worker and Main Thread.
// PostMessage serialization often converts Uint8Array to number[] or keeps it as Uint8Array/ArrayBuffer.
export type CryptoBuffer = number[] | Uint8Array;

export interface SodiumKeyPair {
  publicKey?: CryptoBuffer;
  privateKey: CryptoBuffer;
}

export interface GroupRatchetState {
  CK: string;
  N: number;
}

export interface GroupRatchetHeader {
  n: number;
}

export interface DoubleRatchetHeader {
  dh: string;
  n: number;
  pn: number;
}
