import type { INyxStorage } from '../storage/types.js';
import type { NyxApiClient } from '../network/api.js';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  generatePQKeyPair,
  exportPublicKey,
  getSodium
} from '../crypto/index.js';

export interface PreKeyBundlePayload {
  identityKey: string;
  pqIdentityKey: string;
  signingKey: string;
  signedPreKey: {
    key: string;
    pqKey: string;
    signature: string;
    pqSignature: string;
  };
}

export interface OTPKPayload {
  keyId: number;
  publicKey: string;
  pqPublicKey?: string;
}

export class NyxKeyManager {
  private storage: INyxStorage;
  private api: NyxApiClient;

  constructor(storage: INyxStorage, api: NyxApiClient) {
    this.storage = storage;
    this.api = api;
  }

  public async registerDevice(): Promise<void> {
    const sodium = await getSodium();
    
    // Check if we already generated keys
    let identityKeyPair = await this.storage.get<{ publicKey: Uint8Array; privateKey: Uint8Array }>('identityKeys', 'ed25519');
    let signingKeyPair = await this.storage.get<{ publicKey: Uint8Array; privateKey: Uint8Array }>('identityKeys', 'signing');
    let pqIdentityKeyPair = await this.storage.get<{ publicKey: Uint8Array; privateKey: Uint8Array }>('identityKeys', 'pq');

    if (!identityKeyPair) {
      identityKeyPair = await generateEd25519KeyPair();
      await this.storage.set('identityKeys', 'ed25519', identityKeyPair);
    }
    if (!signingKeyPair) {
      signingKeyPair = await generateEd25519KeyPair();
      await this.storage.set('identityKeys', 'signing', signingKeyPair);
    }
    if (!pqIdentityKeyPair) {
      pqIdentityKeyPair = await generatePQKeyPair();
      await this.storage.set('identityKeys', 'pq', pqIdentityKeyPair);
    }

    // 2. Generate Signed PreKey
    const signedPreKey = await generateX25519KeyPair();
    const pqSignedPreKey = await generatePQKeyPair();

    // Store private keys for Signed PreKey
    await this.storage.set('preKeys', 'signed_x25519', signedPreKey);
    await this.storage.set('preKeys', 'signed_pq', pqSignedPreKey);

    // Sign the public keys using signingKey
    const signatureBytes = sodium.crypto_sign_detached(signedPreKey.publicKey, signingKeyPair.privateKey);
    const pqSignatureBytes = sodium.crypto_sign_detached(pqSignedPreKey.publicKey, signingKeyPair.privateKey);

    const bundlePayload: PreKeyBundlePayload = {
      identityKey: await exportPublicKey(identityKeyPair.publicKey),
      pqIdentityKey: await exportPublicKey(pqIdentityKeyPair.publicKey),
      signingKey: await exportPublicKey(signingKeyPair.publicKey),
      signedPreKey: {
        key: await exportPublicKey(signedPreKey.publicKey),
        pqKey: await exportPublicKey(pqSignedPreKey.publicKey),
        signature: await exportPublicKey(signatureBytes),
        pqSignature: await exportPublicKey(pqSignatureBytes)
      }
    };

    // Upload bundle
    await this.api.request('/keys/prekey-bundle', {
      method: 'POST',
      body: JSON.stringify(bundlePayload)
    });

    // 3. Generate One-Time PreKeys (OTPKs)
    const otpkCountRes = await this.api.request<{ count: number }>('/keys/count-otpk', { method: 'GET' });
    const currentOtpkCount = otpkCountRes.count || 0;

    if (currentOtpkCount < 10) {
      const otpkPayloads: OTPKPayload[] = [];
      const batchSize = 50;

      for (let i = 0; i < batchSize; i++) {
        const keyId = Date.now() + i;
        const x25519Key = await generateX25519KeyPair();
        const pqKey = await generatePQKeyPair();

        // Store private keys
        await this.storage.set('preKeys', `otpk_x25519_${keyId}`, x25519Key);
        await this.storage.set('preKeys', `otpk_pq_${keyId}`, pqKey);

        otpkPayloads.push({
          keyId,
          publicKey: await exportPublicKey(x25519Key.publicKey),
          pqPublicKey: await exportPublicKey(pqKey.publicKey)
        });
      }

      await this.api.request('/keys/upload-otpk', {
        method: 'POST',
        body: JSON.stringify({ keys: otpkPayloads })
      });
    }
  }
}
