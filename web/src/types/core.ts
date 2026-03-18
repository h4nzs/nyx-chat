// types/core.ts

// --- 1. CRYPTO & RATCHET STATE ---
export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export interface DoubleRatchetState {
  DHs: { publicKey: string; privateKey: string } | null;
  DHr: string | null;
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
}

// --- 2. MESSAGE SEPARATION ---
// Pesan yang dilihat server / diterima dari socket
export interface ServerMessage {
  id: string;
  conversationId: string;
  senderId: string;
  payload: EncryptedPayload; 
  timestamp: Date;
}

// Pesan yang dilihat UI setelah dekripsi di Web Worker
export interface DecryptedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: 'TEXT' | 'IMAGE' | 'FILE';
  content: string; // Teks asli
  fileUrl?: string; // Object URL dari Blob yang sudah di-dekripsi
  fileName?: string;
  timestamp: Date;
}
