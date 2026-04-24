import { getSodium } from '@lib/sodiumInitializer';

export interface PeerSecurityInfo {
  publicKey: string;
  pqPublicKey?: string;
  signingKey?: string;
}

export async function computeSafetyNumberParts(
  myIdentityKey: Uint8Array,
  myPqIdentityKey: Uint8Array | null,
  mySigningKey: Uint8Array,
  peer: PeerSecurityInfo
) {
  const sodium = await getSodium();
  
  // My Parts
  const myParts = [myIdentityKey];
  if (myPqIdentityKey) myParts.push(myPqIdentityKey);
  
  let normalizedMySigningKey: Uint8Array;
  if (mySigningKey.length === 64) {
    normalizedMySigningKey = mySigningKey.slice(32);
  } else if (mySigningKey.length === 32) {
    normalizedMySigningKey = mySigningKey;
  } else {
    throw new Error(`Invalid mySigningKey length: expected 32 or 64, got ${mySigningKey.length}`);
  }
  myParts.push(normalizedMySigningKey);
  
  const myTotalLen = myParts.reduce((acc: number, p: Uint8Array) => acc + p.length, 0);
  const myPublicKeyCombined = new Uint8Array(myTotalLen);
  let myOffset = 0;
  for (const part of myParts) {
    myPublicKeyCombined.set(part, myOffset);
    myOffset += part.length;
  }

  // Their Parts
  const theirX25519PubKey = sodium.from_base64(peer.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirPqPubKey = peer.pqPublicKey 
      ? sodium.from_base64(peer.pqPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING) 
      : null;
  const theirSigningPubKeyRaw = peer.signingKey 
      ? sodium.from_base64(peer.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING) 
      : new Uint8Array(0);

  let normalizedTheirSigningKey: Uint8Array;
  if (theirSigningPubKeyRaw.length === 64) {
    normalizedTheirSigningKey = theirSigningPubKeyRaw.slice(32);
  } else if (theirSigningPubKeyRaw.length === 32) {
    normalizedTheirSigningKey = theirSigningPubKeyRaw;
  } else if (theirSigningPubKeyRaw.length === 0) {
    normalizedTheirSigningKey = theirSigningPubKeyRaw; // Allow empty for legacy/fallback cases if necessary, though ideally it should be present.
  } else {
    throw new Error(`Invalid peer signingKey length: expected 32 or 64, got ${theirSigningPubKeyRaw.length}`);
  }
      
  const theirParts = [theirX25519PubKey];
  if (theirPqPubKey) theirParts.push(theirPqPubKey);
  theirParts.push(normalizedTheirSigningKey);
  
  const theirTotalLen = theirParts.reduce((acc: number, p: Uint8Array) => acc + p.length, 0);
  const theirPublicKeyCombined = new Uint8Array(theirTotalLen);
  let theirOffset = 0;
  for (const part of theirParts) {
    theirPublicKeyCombined.set(part, theirOffset);
    theirOffset += part.length;
  }

  return { myPublicKeyCombined, theirPublicKeyCombined };
}
