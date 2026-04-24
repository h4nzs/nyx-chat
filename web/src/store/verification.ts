
import { create } from 'zustand';
import { Conversation } from './conversation';
import { useAuthStore } from './auth';
import { computeSafetyNumberParts, PeerSecurityInfo } from '@utils/safetyNumber';

const VERIFIED_PREFIX = 'verified_conversation_';

type VerificationState = {
  verifiedStatus: Record<string, boolean>;
  loadInitialStatus: (conversations: Conversation[]) => Promise<void>;
  setVerified: (conversationId: string, peerPublicKey: string) => void;
  unsetVerified: (conversationId: string) => void;
};

// Helper to compute fingerprint for safety number
export const computeFingerprint = async (peer: PeerSecurityInfo) => {
  try {
      const { generateSafetyNumber } = await import('@lib/crypto-worker-proxy');
      const { getEncryptionKeyPair, getPqEncryptionKeyPair, getSigningPrivateKey } = useAuthStore.getState();

      const keyPair = await getEncryptionKeyPair();
      if (!keyPair || !keyPair.publicKey) return peer.publicKey;
      
      const pqKeyPair = await getPqEncryptionKeyPair().catch(() => null);
      const mySigningKey = await getSigningPrivateKey();
      
      const { myPublicKeyCombined, theirPublicKeyCombined } = await computeSafetyNumberParts(
        keyPair.publicKey,
        pqKeyPair?.publicKey || null,
        mySigningKey,
        peer
      );

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
          const fingerprint = await computeFingerprint(peer as any);
          if (storedKey === fingerprint) {
            initialStatus[convo.id] = true;
          } else if (fingerprint && storedKey === peer.publicKey) {
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
    if (!fingerprint) return;
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
