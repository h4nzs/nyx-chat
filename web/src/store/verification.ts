
import { create } from 'zustand';
import { Conversation } from './conversation';
import { useAuthStore } from './auth';

const VERIFIED_PREFIX = 'verified_conversation_';

type VerificationState = {
  verifiedStatus: Record<string, boolean>;
  loadInitialStatus: (conversations: Conversation[]) => Promise<void>;
  setVerified: (conversationId: string, peerPublicKey: string) => void;
  unsetVerified: (conversationId: string) => void;
};

// Helper to compute fingerprint for safety number
export const computeFingerprint = async (peer: any) => {
  try {
      const { generateSafetyNumber } = await import('@lib/crypto-worker-proxy');
      const { getSodium } = await import('@lib/sodiumInitializer');
      const { getEncryptionKeyPair, getPqEncryptionKeyPair, getSigningPrivateKey } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) return peer.publicKey;
      
      const pqKeyPair = await getPqEncryptionKeyPair().catch(() => null);

      const sodium = await getSodium();
      const mySigningKey = await getSigningPrivateKey();
      const mySigningPubKey = mySigningKey.slice(32);
      
      const myParts = [keyPair.publicKey];
      if (pqKeyPair?.publicKey) myParts.push(pqKeyPair.publicKey);
      myParts.push(mySigningPubKey);
      
      const myTotalLen = myParts.reduce((acc: number, p: Uint8Array) => acc + p.length, 0);
      const myPublicKeyCombined = new Uint8Array(myTotalLen);
      let myOffset = 0;
      for (const part of myParts) {
        myPublicKeyCombined.set(part, myOffset);
        myOffset += part.length;
      }

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

      return await generateSafetyNumber(myPublicKeyCombined, theirPublicKeyCombined);
  } catch (e) {
      console.error('Failed to compute safety fingerprint', e);
      return null;
  }
};

export const useVerificationStore = create<VerificationState>((set, _get) => ({
  verifiedStatus: {},

  loadInitialStatus: async (conversations) => {
    const initialStatus: Record<string, boolean> = {};
    const myId = useAuthStore.getState().user?.id;
    for (const convo of conversations) {
      const participant = convo.participants.find(p => p.id !== myId && p.userId !== myId);
      const peer = participant?.user;
      if (peer && peer.publicKey) {
        const storedKey = localStorage.getItem(`${VERIFIED_PREFIX}${convo.id}`);
        if (storedKey) {
          const fingerprint = await computeFingerprint(peer);
          if (storedKey === fingerprint) {
            initialStatus[convo.id] = true;
          } else if (storedKey === peer.publicKey) {
            // Upgrade legacy stored keys
            localStorage.setItem(`${VERIFIED_PREFIX}${convo.id}`, fingerprint);
            initialStatus[convo.id] = true;
          }
        }
      }
    }
    set({ verifiedStatus: initialStatus });
  },

  setVerified: (conversationId, fingerprint) => {
    localStorage.setItem(`${VERIFIED_PREFIX}${conversationId}`, fingerprint);
    set(state => ({
      verifiedStatus: { ...state.verifiedStatus, [conversationId]: true },
    }));
  },

  unsetVerified: (conversationId) => {
    localStorage.removeItem(`${VERIFIED_PREFIX}${conversationId}`);
    set(state => ({
      verifiedStatus: { ...state.verifiedStatus, [conversationId]: false },
    }));
  },
}));
