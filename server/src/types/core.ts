// types/core.ts

// --- 1. CRYPTO & RATCHET STATE ---
export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export interface DoubleRatchetState {
  DHs: string; // ED25519 KeyPair (Base64)
  DHr: string | null;
  RK: string;  // Root Key
  CKs: string | null; // Chain Key Sender
  CKr: string | null; // Chain Key Receiver
  Ns: number;  // Message Number Sender
  Nr: number;  // Message Number Receiver
  PN: number;  // Previous Message Number
  // Tambahkan dictionary untuk skipped keys jika lu implementasi itu
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
