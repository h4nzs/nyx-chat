import { createWithEqualityFn } from 'zustand/traditional';
import type { BurnerDoubleRatchetState, BurnerDoubleRatchetHeader } from '../workers/crypto.worker';
import { getSocket } from '../lib/socket';
import { worker_burner_dr_init_guest, worker_burner_dr_encrypt, worker_burner_dr_decrypt } from '../lib/crypto-worker-proxy';
import { getSodiumLib } from '../utils/crypto';
import { useAuthStore } from './auth';

export type BurnerMessage = {
  id: string;
  senderId: string; // 'host' or 'guest'
  content: string;
  createdAt: string;
};

interface BurnerState {
  roomId: string | null;
  hostDeviceId: string | null;
  hostPqPk: string | null;
  hostClassicalPk: string | null;
  hostUserId: string | null;
  
  // Guest Crypto State (RAM ONLY)
  drState: BurnerDoubleRatchetState | null;
  guestClassicalPk: string | null;
  
  messages: BurnerMessage[];
  isInitialized: boolean;
  error: string | null;
}

interface BurnerActions {
  initializeFromHash: (hash: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  receiveMessage: (ciphertext: string) => Promise<void>;
  reset: () => void;
}

const initialState: BurnerState = {
  roomId: null,
  hostDeviceId: null,
  hostPqPk: null,
  hostClassicalPk: null,
  hostUserId: null,
  drState: null,
  guestClassicalPk: null,
  messages: [],
  isInitialized: false,
  error: null,
};

export const useBurnerStore = createWithEqualityFn<BurnerState & BurnerActions>((set, get) => ({
  ...initialState,

  reset: () => set(initialState),

  initializeFromHash: async (hash: string) => {
    try {
      // Hash format: #<RoomID>_<HostDeviceID>_<HostPQPublicKey>_<HostClassicalPublicKey>_<HostUserId>
      // Wait, let's include HostUserId so we can route it.
      // Let's assume hash format is: #<RoomID>:<HostUserId>:<HostDeviceID>:<HostPQPublicKey>:<HostClassicalPublicKey>
      const cleanHash = hash.replace('#', '');
      const parts = cleanHash.split(':');
      if (parts.length < 5) {
        throw new Error('Invalid burner link format.');
      }
      
      const [roomId, hostUserId, hostDeviceId, hostPqPk, hostClassicalPk] = parts;
      
      const sodium = await getSodiumLib();
      // Ensure we safely decode URL-encoded base64 components
      const safePqPk = decodeURIComponent(hostPqPk);
      const safeClassicalPk = decodeURIComponent(hostClassicalPk);
      
      const hostClassicalPkBytes = sodium.from_base64(safeClassicalPk, sodium.base64_variants.URLSAFE_NO_PADDING);
      const hostPqPkBytes = sodium.from_base64(safePqPk, sodium.base64_variants.URLSAFE_NO_PADDING);

      // Initialize Guest Double Ratchet State
      const { state, guestClassicalPk: guestPk } = await worker_burner_dr_init_guest({
        hostClassicalPk: hostClassicalPkBytes.buffer,
        hostPqPk: hostPqPkBytes.buffer
      });

      set({
        roomId,
        hostUserId,
        hostDeviceId,
        hostPqPk,
        hostClassicalPk,
        drState: state,
        guestClassicalPk: guestPk,
        isInitialized: true,
        error: null
      });
      
      // Optionally, we could send a "Hello, I joined" message here, but we'll leave it to the UI.

    } catch (e) {
      console.error('Failed to initialize burner session:', e);
      set({ error: 'Invalid or expired burner link.' });
    }
  },

  sendMessage: async (content: string) => {
    const state = get().drState;
    const { roomId, hostDeviceId, hostUserId } = get();
    if (!state || !roomId || !hostDeviceId || !hostUserId) return;

    try {
      const { state: newState, header, ciphertext } = await worker_burner_dr_encrypt({
        state,
        plaintext: content
      });

      // Update state
      set({ drState: newState });

      const sodium = await getSodiumLib();
      const ciphertextB64 = sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const payload = {
        header,
        ciphertext: ciphertextB64,
        // Since we are guest, we need to send our guestClassicalPk on the first message so Host knows who we are.
        // But for simplicity, we can include it in the header or as a separate field.
        guestClassicalPk: get().guestClassicalPk
      };

      const socket = getSocket();
      socket.emit('burner:send', {
        roomId,
        targetDeviceId: hostDeviceId,
        hostUserId,
        ciphertext: JSON.stringify(payload)
      }, (res: any) => {
        if (res && res.ok) {
          const msg: BurnerMessage = {
            id: Date.now().toString(),
            senderId: 'guest',
            content,
            createdAt: new Date().toISOString()
          };
          set(s => ({ messages: [...s.messages, msg] }));
        } else {
          console.error("Failed to send burner message:", res?.error);
        }
      });
    } catch (e) {
      console.error('Burner encrypt failed:', e);
    }
  },

  receiveMessage: async (cipherString: string) => {
    const state = get().drState;
    if (!state) return;

    try {
      const payload = JSON.parse(cipherString);
      const { header, ciphertext: ciphertextB64 } = payload;
      
      const sodium = await getSodiumLib();
      const ciphertext = sodium.from_base64(ciphertextB64, sodium.base64_variants.URLSAFE_NO_PADDING);

      const { state: newState, plaintext } = await worker_burner_dr_decrypt({
        state,
        header: header as BurnerDoubleRatchetHeader,
        ciphertext: ciphertext.buffer
      });

      set({ drState: newState });

      const content = new TextDecoder().decode(plaintext);
      const msg: BurnerMessage = {
        id: Date.now().toString(),
        senderId: 'host',
        content,
        createdAt: new Date().toISOString()
      };
      set(s => ({ messages: [...s.messages, msg] }));

    } catch (e) {
      console.error('Burner decrypt failed:', e);
    }
  }
}));

// Utility to generate a burner link for the Host
export async function generateBurnerLink(): Promise<string> {
  const roomId = `burner_${crypto.randomUUID()}`; 
  const sodium = await getSodiumLib();
  
  // Host keys
  const authStore = useAuthStore.getState();
  const myUserId = authStore.user?.id;
  
  if (!myUserId) throw new Error("User not authenticated");

  // Fetch current device ID
  const { authFetch } = await import('../lib/api');
  const devices = await authFetch<any[]>('/api/users/me/devices');
  const currentDevice = devices.find(d => d.isCurrent);
  if (!currentDevice) throw new Error("Could not determine current device ID");
  const myDeviceId = currentDevice.id;

  const { getMyEncryptionKeyPair } = await import('../utils/crypto');
  const myDeviceKeys = await getMyEncryptionKeyPair(); // Classical X25519
  const myPqKeys = await authStore.getPqEncryptionKeyPair();
  
  const myPqPkB64 = sodium.to_base64(myPqKeys.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const b64Classical = sodium.to_base64(myDeviceKeys.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

  // Link format: #<RoomID>:<HostUserId>:<HostDeviceID>:<HostPQPublicKey>:<HostClassicalPublicKey>
  return `${window.location.origin}/drop/#${roomId}:${myUserId}:${myDeviceId}:${encodeURIComponent(myPqPkB64)}:${encodeURIComponent(b64Classical)}`;
}
