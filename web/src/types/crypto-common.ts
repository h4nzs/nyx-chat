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
  // [PQ v4 Fase 1.5] Public signing key ML-DSA-65 (sender state = milik sendiri;
  // receiver state = diikat dari distribusi `senderSigningKeyV2`). Wrapper pesan
  // ber-`sigV:2` diverifikasi dengan kunci ini (domain `NYX-PQ-GROUP-V4`).
  signingKeyV2?: string;
  // [PQ v4 Fase 1.5 — envelope v3] Pengenal 8B (base64url) kunci verifikasi
  // pengirim, dari envelope distribusi v3.
  senderKeyId?: string;
  // [INVARIANT 1 — multi-era 2026-10-02] Anchor chain key awal era (receiver
  // state) — identitas era untuk deteksi replay distribusi (idempotent receive,
  // tanpa rewind). Juga dipakai arsip era lama (archiveGroupReceiverState).
  eraCK?: string;
  // [REWRITE 2026-10-02 — chainId stabil ala libsignal SenderKeyState.chain_id]
  // Identitas era eksplisit (64-bit acak per era). Stabil sepanjang rantai.
  // Dibawa eksplisit di wrapper pesan/metadata v2 agar routing penerima
  // deterministik (sender_key_state_for_chain_id) tanpa menebak dari prefix.
  chainId?: string;
  // [V2 2026-10-02 — RENCANA #2] Kunci metadata era (keluar dari chain sender-
  // key). Dienkripsi at-rest; receiver menerima lewat envelope distribusi v2.
  metadataKey?: string;
  // [BUGFIX 2026-10-02] Identitas pengirim (pseudonym) di dalam state —
  // id record kini device-keyed (`${conv}_${deviceKey}`) sehingga parts[1]
  // bukan lagi senderId; pembaca state mengambilnya dari sini.
  senderId?: string;
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
