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
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  fileKey?: string;
};

interface BurnerState {
  hostDeviceId: string | null;
  hostPqPk: string | null;
  hostClassicalPk: string | null;
  hostUserId: string | null;
  
  activeSessions: Record<string, { drState: BurnerDoubleRatchetState | null; guestClassicalPk: string | null }>;
  
  messages: BurnerMessage[];
  isInitialized: boolean;
  error: string | null;
}

interface BurnerActions {
  initializeFromHash: (hash: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  receiveMessage: (roomId: string, ciphertext: string) => Promise<void>;
  terminateSession: (reason: string) => void;
  destroyBurnerSession: (roomId: string) => void;
  reset: () => void;
}

const initialState: BurnerState = {
  hostDeviceId: null,
  hostPqPk: null,
  hostClassicalPk: null,
  hostUserId: null,
  activeSessions: {},
  messages: [],
  isInitialized: false,
  error: null,
};

const roomLocks: Record<string, Promise<void>> = {};

async function withRoomLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
  const previous = roomLocks[roomId] || Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  roomLocks[roomId] = previous.then(() => next);
  
  try {
    await previous;
    return await task();
  } finally {
    release!();
  }
}

export const useBurnerStore = createWithEqualityFn<BurnerState & BurnerActions>((set, get) => ({
  ...initialState,

  reset: () => set(initialState),

  terminateSession: (reason: string) => {
    set({ error: reason, isInitialized: true, activeSessions: {} });
  },

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
      const { state: stateFromWorker, guestClassicalPk: guestPk } = await worker_burner_dr_init_guest({
        hostClassicalPk: hostClassicalPkBytes.buffer,
        hostPqPk: hostPqPkBytes.buffer
      });

      set(state => ({
        hostUserId,
        hostDeviceId,
        hostPqPk,
        hostClassicalPk,
        activeSessions: {
          ...state.activeSessions,
          [roomId]: { drState: stateFromWorker, guestClassicalPk: guestPk }
        },
        isInitialized: true,
        error: null
      }));
      
      // Optionally, we could send a "Hello, I joined" message here, but we'll leave it to the UI.

    } catch (e) {
      console.error('Failed to initialize burner session:', e);
      set({ error: 'Invalid or expired burner link.' });
    }
  },

  sendMessage: async (content: string) => {
    const roomId = Object.keys(get().activeSessions)[0];
    if (!roomId) return;

    await withRoomLock(roomId, async () => {
      const session = get().activeSessions[roomId];
      const state = session?.drState;
      const { hostDeviceId, hostUserId } = get();
      if (!state || !hostDeviceId || !hostUserId || !session) return;

      try {
        const { state: newState, header, ciphertext } = await worker_burner_dr_encrypt({
          state,
          plaintext: content
        });

        // Update state
        set(s => ({
          activeSessions: {
            ...s.activeSessions,
            [roomId]: { ...session, drState: newState }
          }
        }));

        const sodium = await getSodiumLib();
        const ciphertextB64 = sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const payload = {
          header,
          ciphertext: ciphertextB64,
          guestClassicalPk: session.guestClassicalPk
        };

        const socket = getSocket();
        socket.emit('burner:send', {
          roomId,
          targetDeviceId: hostDeviceId,
          hostUserId,
          ciphertext: JSON.stringify(payload)
        }, (res: any) => {
          if (res && res.ok) {
            let parsedContent = content;
            let fileData = {};
            try {
              if (content.startsWith('{')) {
                const data = JSON.parse(content);
                if (data.type === 'file') {
                  parsedContent = data.text || '';
                  fileData = {
                    fileUrl: data.fileUrl,
                    fileName: data.fileName,
                    fileType: data.fileType,
                    fileSize: data.fileSize,
                    fileKey: data.fileKey
                  };
                }
              }
            } catch (e) {}

            const msg: BurnerMessage = {
              id: Date.now().toString(),
              senderId: 'guest',
              content: parsedContent,
              createdAt: new Date().toISOString(),
              ...fileData
            };
            set(s => ({ messages: [...s.messages, msg] }));
          } else {
            console.error("Failed to send burner message:", res?.error);
          }
        });
      } catch (e) {
        console.error('Burner encrypt failed:', e);
      }
    });
  },

  receiveMessage: async (roomId: string, cipherString: string) => {
    if (localStorage.getItem('burned_' + roomId)) return; // Reject zombie messages

    await withRoomLock(roomId, async () => {
      const session = get().activeSessions[roomId] || { drState: null, guestClassicalPk: null };
      let state = session.drState;
      let guestPkState = session.guestClassicalPk;

      try {
        const payload = JSON.parse(cipherString);
        const { header, ciphertext: ciphertextB64, guestClassicalPk } = payload;

        // Host initialization on first message from Guest
        if (!state) {
          if (guestClassicalPk) {
            const sodium = await getSodiumLib();
            const { getMyEncryptionKeyPair } = await import('../utils/crypto');
            const myDeviceKeys = await getMyEncryptionKeyPair(); // Host classical
            const authStore = useAuthStore.getState();
            const myPqKeys = await authStore.getPqEncryptionKeyPair(); // Host PQ

            const guestPkBytes = sodium.from_base64(guestClassicalPk, sodium.base64_variants.URLSAFE_NO_PADDING);
            const savedCtBytes = sodium.from_base64((header as any).ct, sodium.base64_variants.URLSAFE_NO_PADDING);
            
            const { worker_burner_dr_init_host } = await import('../lib/crypto-worker-proxy');
            const initRes = await worker_burner_dr_init_host({
               hostClassicalSk: myDeviceKeys.privateKey,
               hostPqSk: myPqKeys.privateKey,
               guestClassicalPk: guestPkBytes,
               savedCt: savedCtBytes
            });
            
            state = initRes.state;
            guestPkState = guestClassicalPk;
          } else {
             return; // Cannot decrypt without drState or guestPk
          }
        }

        const sodium = await getSodiumLib();
        const ciphertext = sodium.from_base64(ciphertextB64, sodium.base64_variants.URLSAFE_NO_PADDING);

        const { state: newState, plaintext } = await worker_burner_dr_decrypt({
          state,
          header: header as BurnerDoubleRatchetHeader,
          ciphertext: ciphertext.buffer
        });

        set(s => ({
          activeSessions: {
            ...s.activeSessions,
            [roomId]: { drState: newState, guestClassicalPk: guestPkState }
          }
        }));

        const content = new TextDecoder().decode(plaintext);
        let parsedContent = content;
        let fileData = {};

        if (content.startsWith('{')) {
          try {
            const data = JSON.parse(content);
            if (data.type === 'file') {
              parsedContent = data.text || '';
              fileData = {
                fileUrl: data.fileUrl,
                fileName: data.fileName,
                fileType: data.fileType,
                fileSize: data.fileSize,
                fileKey: data.fileKey
              };
            }
          } catch (e) {
            console.warn('Failed to parse message JSON:', e);
          }
        }

        const currentUser = useAuthStore.getState().user;
        const storedHostId = get().hostUserId;
        
        let isHost = false;
        if (currentUser) {
          if (storedHostId) {
            isHost = currentUser.id === storedHostId;
          } else {
            isHost = true;
          }
        }

        const msg: BurnerMessage = {
          id: Date.now().toString(),
          senderId: isHost ? 'guest' : 'host',
          content: parsedContent,
          createdAt: new Date().toISOString(),
          ...fileData
        };
        
        // If we are Host, push to UI chat list
        if (isHost) {
          const { useMessageStore } = await import('./message');
          const mainMsg = {
             id: msg.id,
             conversationId: roomId,
             senderId: 'guest_user', 
             content: msg.content,
             createdAt: msg.createdAt,
             updatedAt: msg.createdAt,
             isSilent: false,
             isEdited: false,
             isViewOnce: false,
             isViewed: false,
             ...fileData
          };
          useMessageStore.getState().addOptimisticMessage(roomId, mainMsg as any);
          
          const { useConversationStore } = await import('./conversation');
          useConversationStore.getState().updateConversationLastMessage(roomId, mainMsg as any);
        }

        set(s => ({ messages: [...s.messages, msg] }));

      } catch (e) {
        console.error('Burner decrypt failed:', e);
      }
    });
  },

  destroyBurnerSession: async (roomId: string) => {
    localStorage.setItem('burned_' + roomId, 'true'); // Local blacklist
    
    // 1. Remove from burner active sessions
    set(s => {
      const newSessions = { ...s.activeSessions };
      delete newSessions[roomId];
      return { activeSessions: newSessions };
    });

    // 2. Local-only conversation cleanup (Host/Guest UI)
    const { useConversationStore } = await import('./conversation');
    await useConversationStore.getState().deleteConversation(roomId);

    // 3. Clear RAM messages
    const { useMessageStore } = await import('./message');
    useMessageStore.getState().clearMessagesForConversation(roomId);

    // 4. Emit to server for blacklist reinforcement
    const socket = getSocket();
    if (socket) {
      const myUserId = useAuthStore.getState().user?.id;
      socket.emit('burner:destroy', { roomId, hostUserId: myUserId });
    }

    // 5. Atomic Redirection
    window.location.hash = '';
    if (window.location.pathname.includes('/drop')) {
       window.location.href = '/chat';
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
