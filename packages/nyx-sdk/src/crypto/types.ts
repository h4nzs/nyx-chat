export type CryptoBuffer = number[] | Uint8Array;

export interface SodiumKeyPair {
  publicKey?: CryptoBuffer;
  privateKey: CryptoBuffer;
}

export interface GroupRatchetState {
  CK: string;
  N: number;
  createdAt?: number;
  messageCount?: number;
  lastActivityTime?: number;
}

export interface GroupRatchetHeader {
  n: number;
}

export interface DoubleRatchetHeader {
  kemPk: string;
  ct: string;
  n: number;
  pn: number;
}

export interface DoubleRatchetState {
  KEMs: { publicKey: string; privateKey: string } | null;
  KEMr: string | null;
  savedCt: string | null;
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
  messageCount?: number;
  lastActivityTime?: number;
}
