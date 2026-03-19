
import { create } from 'zustand';
import { Conversation } from './conversation';

const VERIFIED_PREFIX = 'verified_conversation_';

type VerificationState = {
  verifiedStatus: Record<string, boolean>;
  loadInitialStatus: (conversations: Conversation[]) => void;
  setVerified: (conversationId: string, peerPublicKey: string) => void;
  unsetVerified: (conversationId: string) => void;
};

export const useVerificationStore = create<VerificationState>((set, _get) => ({
  verifiedStatus: {},

  loadInitialStatus: (conversations) => {
    const initialStatus: Record<string, boolean> = {};
    for (const convo of conversations) {
      const peer = convo.participants.find(p => p.id !== localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!).id : null);
      if (peer && (peer as any).publicKey) {
        const storedKey = localStorage.getItem(`${VERIFIED_PREFIX}${convo.id}`);
        if (storedKey && storedKey === (peer as any).publicKey) {
          initialStatus[convo.id] = true;
        }
      }
    }
    set({ verifiedStatus: initialStatus });
  },

  setVerified: (conversationId, peerPublicKey) => {
    localStorage.setItem(`${VERIFIED_PREFIX}${conversationId}`, peerPublicKey);
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
