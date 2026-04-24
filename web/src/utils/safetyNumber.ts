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
  myParts.push(mySigningKey.slice(32)); // Use public part of signing key
  
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
  const theirSigningPubKey = peer.signingKey 
      ? sodium.from_base64(peer.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING) 
      : new Uint8Array(0);
      
  const theirParts = [theirX25519PubKey];
  if (theirPqPubKey) theirParts.push(theirPqPubKey);
  theirParts.push(theirSigningPubKey);
  
  const theirTotalLen = theirParts.reduce((acc: number, p: Uint8Array) => acc + p.length, 0);
  const theirPublicKeyCombined = new Uint8Array(theirTotalLen);
  let theirOffset = 0;
  for (const part of theirParts) {
    theirPublicKeyCombined.set(part, theirOffset);
    theirOffset += part.length;
  }

  return { myPublicKeyCombined, theirPublicKeyCombined };
}
