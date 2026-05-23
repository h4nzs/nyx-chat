import type { INyxStorage } from '../storage/types.js';
import type { NyxApiClient } from '../network/api.js';
import type { NyxSocketClient } from '../network/socket.js';
import type { DoubleRatchetState, DoubleRatchetHeader } from '../crypto/types.js';
import { drRatchetDecrypt, drRatchetEncrypt, drInitAlice, drInitBob, getSodium } from '../crypto/index.js';

export interface IncomingMessagePayload {
  conversationId: string;
  header: DoubleRatchetHeader;
  ciphertext: string; // base64 encoded ciphertext
}

export interface DecryptedMessage {
  conversationId: string;
  plaintext: string;
}

interface BundleResponse {
  deviceId: string;
  identityKey: string;
  pqIdentityKey: string | null;
  signingKey: string;
  signedPreKey?: {
    key: string;
    pqKey: string | null;
    signature: string;
    pqSignature: string | null;
  };
  oneTimePreKey?: {
    keyId: number;
    key: string;
    pqKey: string | null;
  };
}

export class NyxSessionManager {
  private storage: INyxStorage;
  private api: NyxApiClient;
  private socket: NyxSocketClient;

  // Simple in-memory lock to prevent race conditions on ratchet state
  private locks: Map<string, Promise<void>> = new Map();

  constructor(storage: INyxStorage, api: NyxApiClient, socket: NyxSocketClient) {
    this.storage = storage;
    this.api = api;
    this.socket = socket;
  }

  private async acquireLock(conversationId: string): Promise<() => void> {
    const previousLock = this.locks.get(conversationId) || Promise.resolve();
    let release: () => void;
    const currentLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(conversationId, currentLock);

    await previousLock;

    return () => {
      release();
      if (this.locks.get(conversationId) === currentLock) {
        this.locks.delete(conversationId);
      }
    };
  }

  public async initializeSession(recipientId: string): Promise<{ ciphertext: string; header: DoubleRatchetHeader }> {
    const sodium = await getSodium();
    const release = await this.acquireLock(recipientId);

    try {
      // 1. Fetch public key bundle
      const bundles = await this.api.request<BundleResponse[]>(`/keys/prekey-bundle/${recipientId}`, { method: 'GET' });
      if (!bundles || bundles.length === 0) {
        throw new Error('Recipient has no active devices or keys.');
      }
      const bundle = bundles[0];

      if (!bundle.signedPreKey?.pqKey) {
        throw new Error('Recipient does not have a PQ PreKey.');
      }

      const theirPqSpkBytes = sodium.from_base64(bundle.signedPreKey.pqKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      // 2 & 3. Inisialisasi DoubleRatchetState (sebagai Alice)
      // Kita gunakan 32-byte zero buffer untuk `sk` karena header tidak memiliki field ephemeral key untuk X3DH klasik.
      // Keamanan bergantung penuh pada PQ-KEM di drInitAlice.
      const dummySk = new Uint8Array(32);
      const state = await drInitAlice(dummySk, theirPqSpkBytes);

      // 4. Simpan state
      await this.storage.set<DoubleRatchetState>('ratchetSessions', recipientId, state);

      // 5. Kembalikan objek inisialisasi
      return {
        ciphertext: state.savedCt!,
        header: {
          kemPk: state.KEMs!.publicKey,
          ct: state.savedCt!,
          n: state.Ns,
          pn: state.PN
        }
      };
    } finally {
      release();
    }
  }

  public async processIncomingMessage(payload: IncomingMessagePayload): Promise<DecryptedMessage> {
    if (!payload || !payload.conversationId || !payload.header || !payload.ciphertext) {
      throw new Error('Invalid message payload');
    }

    const { conversationId, header, ciphertext: ciphertextB64 } = payload;
    const release = await this.acquireLock(conversationId);

    try {
      let state = await this.storage.get<DoubleRatchetState>('ratchetSessions', conversationId);
      
      // Jika state belum ada dan pesan ini membawa KEM Ciphertext, inisialisasi sebagai Bob
      if (!state && header.ct) {
        const myPqSignedPreKey = await this.storage.get<{ publicKey: Uint8Array; privateKey: Uint8Array }>('preKeys', 'signed_pq');
        if (!myPqSignedPreKey) {
          throw new Error('Local PQ Signed PreKey not found for initialization');
        }
        
        const dummySk = new Uint8Array(32);
        state = await drInitBob(dummySk, myPqSignedPreKey);
        await this.storage.set<DoubleRatchetState>('ratchetSessions', conversationId, state);
      } else if (!state) {
        throw new Error(`DoubleRatchetState not found for conversation: ${conversationId}`);
      }

      const sodium = await getSodium();
      const ciphertextBytes = sodium.from_base64(ciphertextB64, sodium.base64_variants.URLSAFE_NO_PADDING);

      const result = await drRatchetDecrypt(state, header, ciphertextBytes);

      await this.storage.set<DoubleRatchetState>('ratchetSessions', conversationId, result.state);

      for (const skipped of result.skippedKeys) {
        const skippedKeyId = `${conversationId}_${skipped.kemPk}_${skipped.n}`;
        await this.storage.set('skippedKeys', skippedKeyId, skipped.mk);
      }

      const plaintext = sodium.to_string(result.plaintext);

      return {
        conversationId,
        plaintext
      };
    } finally {
      release();
    }
  }

  public async sendMessage(conversationId: string, plaintext: string): Promise<{ conversationId: string; header: DoubleRatchetHeader; ciphertext: string }> {
    const release = await this.acquireLock(conversationId);

    try {
      const state = await this.storage.get<DoubleRatchetState>('ratchetSessions', conversationId);
      if (!state) {
        throw new Error(`DoubleRatchetState not found for conversation: ${conversationId}`);
      }

      const sodium = await getSodium();
      const result = await drRatchetEncrypt(state, plaintext);

      await this.storage.set<DoubleRatchetState>('ratchetSessions', conversationId, result.state);

      const ciphertextB64 = sodium.to_base64(result.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);

      const payload = {
        conversationId,
        header: result.header,
        ciphertext: ciphertextB64
      };

      return payload;
    } finally {
      release();
    }
  }
}
