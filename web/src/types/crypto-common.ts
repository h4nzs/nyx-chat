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
  // [T2 FIX 2026-10-01] Chain key awal era (sender state saja) — fulfillment
  // key request menyegel INI dengan N=0, bukan posisi ratchet saat ini.
  initialCK?: string;
  skippedKeys?: Record<string, string>;
  createdAt?: number;
  messageCount?: number;
  lastActivityTime?: number;
  requiresImmediateRotation?: boolean;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim (receiver state saja).
  // Pola libsignal SenderKeyState: diikat sejak distribusi kunci.
  signingKey?: string;
  // [INVARIANT 1 — multi-era 2026-10-02] Anchor chain key awal era (receiver
  // state) — identitas era untuk deteksi replay distribusi (idempotent receive,
  // tanpa rewind). Juga dipakai arsip era lama (archiveGroupReceiverState).
  eraCK?: string;
  // Tanggal arsip (arsip era lama saja).
  archivedAt?: number;
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
