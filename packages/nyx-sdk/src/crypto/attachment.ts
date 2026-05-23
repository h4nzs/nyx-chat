import { getSodium } from './sodium.js';

export async function encryptBlob(blob: Blob): Promise<{ encryptedBlob: Blob; symmetricKey: string; nonce: string }> {
  const sodium = await getSodium();
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  const symmetricKeyBytes = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonceBytes = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    uint8Array,
    null,
    null,
    nonceBytes,
    symmetricKeyBytes
  );

  const symmetricKey = sodium.to_base64(symmetricKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  const nonce = sodium.to_base64(nonceBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

  const encryptedBlob = new Blob([ciphertext as unknown as BlobPart], { type: 'application/octet-stream' });

  // Clean up key from memory
  sodium.memzero(symmetricKeyBytes);

  return {
    encryptedBlob,
    symmetricKey,
    nonce
  };
}

export async function decryptBlob(encryptedBlob: Blob, symmetricKey: string, nonce: string): Promise<Blob> {
  const sodium = await getSodium();
  const arrayBuffer = await encryptedBlob.arrayBuffer();
  const ciphertext = new Uint8Array(arrayBuffer);

  const symmetricKeyBytes = sodium.from_base64(symmetricKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const nonceBytes = sodium.from_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonceBytes,
    symmetricKeyBytes
  );

  const decryptedBlob = new Blob([plaintext as unknown as BlobPart]);

  // Clean up key from memory
  sodium.memzero(symmetricKeyBytes);

  return decryptedBlob;
}
