import { createWithEqualityFn } from 'zustand/traditional';
import type { BurnerDoubleRatchetState, BurnerDoubleRatchetHeader } from '../workers/crypto.worker';
import { transportClient, connectSocket } from '../lib/transportClient';
import { api } from '../lib/api';
import { worker_burner_dr_init_guest, worker_burner_dr_encrypt, worker_burner_dr_decrypt } from '../lib/crypto-worker-proxy';
import { getSodiumLib } from '../utils/crypto';
import { useAuthStore } from './auth';
// Burner file metadata arrives in TWO schemas depending on which UI sent it:
// - Guest (/drop BurnerChat): { fileUrl, fileName, fileType, fileSize, fileKey }
// - Host (main ChatWindow MessageInput/coreSendMessage): { url, key, name, size, mimeType }
// Normalize both so the receiving bubble always shows the preview/decrypt works.
import { extractBurnerFileData } from '../lib/burnerFileData';

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

/**
 * Hasil satu percobaan kirim. UI WAJIB memakainya: sebelumnya `sendMessage`
 * mengembalikan `void` dan semua kegagalan berhenti di `console.error`, jadi
 * menekan Enter di sesi guest yang transportnya mati tampak seperti tombol
 * rusak — tidak ada pesan, tidak ada error.
 */
export interface BurnerSendResult {
  ok: boolean;
  /** 'OFFLINE' | 'ROOM_TERMINATED' | 'TIMEOUT' | 'NO_SESSION' | pesan server. */
  error?: string;
}

interface BurnerActions {
  initializeFromHash: (hash: string) => Promise<void>;
  sendMessage: (content: string) => Promise<BurnerSendResult>;
  receiveMessage: (roomId: string, ciphertext: string) => Promise<void>;
  terminateSession: (reason: string) => void;
  /**
   * Tandai room dihancurkan host: status UI + penanda lokal, supaya refresh
   * berikutnya langsung menolak room ini walau server/Redis sedang tak terjangkau.
   */
  markRoomDestroyed: (roomId: string) => void;
  destroyBurnerSession: (roomId: string) => Promise<void>;
  reset: () => void;
}

/** TTL ack pengiriman burner. Lebih pendek dari default transport supaya UI
 *  bisa memberi umpan balik sebelum pengguna mengetik ulang. */
const SEND_ACK_TIMEOUT_MS = 8000;

/**
 * Pastikan transport guest hidup — memakai token yang ada, dan kalau gagal
 * menerbitkan identitas guest baru.
 *
 * Kenapa retry: sesi guest TIDAK punya refresh token (server sengaja tidak
 * mempersist-nya), sedangkan access token hanya berumur 15 menit. Guest yang
 * duduk lebih lama dari itu masih punya `accessToken` basi di store, sehingga
 * jalur lama (`else if (!socket.connected) connectSocket()`) terus mencoba
 * menyambung dengan token mati: transport tidak pernah naik, `sendEvent` hanya
 * menumpuk di antrean offline, dan tombol kirim tampak tidak melakukan apa pun.
 * Membuat identitas burner baru adalah satu-satunya jalur yang tersedia — dan
 * aman: room burner tidak mengikat identitas lama, guest hanya perlu join ulang.
 */
export async function ensureBurnerTransport(opts: { forceNewToken?: boolean } = {}): Promise<boolean> {
  if (transportClient.connected) return true;

  const auth = useAuthStore.getState();
  let token = opts.forceNewToken ? null : auth.accessToken;

  if (!token) {
    try {
      const res = await api<{ accessToken: string; user: import('./auth').User; deviceId: string }>(
        '/api/auth/burner',
        { method: 'POST' },
      );
      useAuthStore.getState().setAccessToken(res.accessToken);
      useAuthStore.getState().setUser(res.user);
      try { localStorage.setItem('deviceId', res.deviceId); } catch { /* private mode */ }
      token = res.accessToken;
    } catch (e) {
      console.error('[Burner] Gagal mendapatkan token guest:', e);
      return false;
    }
  }

  connectSocket();
  if (await waitForTransportConnected(5000)) return true;

  // Token/identitas lama tidak bisa dipakai (kedaluwarsa/ditolak). Satu percobaan
  // dengan identitas guest baru — tanpa ini sesi panjang berakhir jadi transport
  // mati permanen sampai reload.
  if (!opts.forceNewToken) return ensureBurnerTransport({ forceNewToken: true });
  return false;
}

/**
 * Tunggu transport benar-benar tersambung (bukan sekadar "sedang menyambung").
 * Tanpa ini, `sendEvent` hanya menaruh payload di antrean offline dan pesan
 * tampak hilang sampai ack timeout.
 */
/**
 * Baca status room dari server. Satu retry untuk 401: cookie `at` guest hanya
 * berlaku 15 menit dan tidak bisa di-refresh, sedangkan pemeriksaan ini
 * dijalankan sesaat setelah halaman dibuka (bisa sebelum identitas guest baru
 * diterbitkan). Tanpa retry, gerbang destroy akan diam-diam fail-open tepat pada
 * kasus yang paling sering dilaporkan: guest me-refresh halaman yang lama.
 */
async function readRoomStatus(roomId: string): Promise<{ terminated: boolean } | null> {
  const path = `/api/burner/${encodeURIComponent(roomId)}/status`;
  try {
    return await api<{ roomId: string; terminated: boolean }>(path);
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 401) {
      const ok = await ensureBurnerTransport();
      if (ok) {
        try {
          return await api<{ roomId: string; terminated: boolean }>(path);
        } catch (retryError) {
          console.warn('[Burner] Status room tidak bisa diperiksa (setelah token baru):', retryError);
          return null;
        }
      }
    }
    return null;
  }
}

export function waitForTransportConnected(timeoutMs: number): Promise<boolean> {
  if (transportClient.connected) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transportClient.off('connect', onConnect);
      resolve(value);
    };
    const onConnect = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    transportClient.on('connect', onConnect);
  });
}

/** Penanda lokal room yang sudah dihancurkan host (bertahan setelah refresh). */
const BURNED_ROOM_PREFIX = 'burned_';

/** Pesan yang sama dengan yang dikirim event `burner:terminated`. */
export const BURNER_TERMINATED_MESSAGE = 'This secure session has been terminated by the host.';

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

  markRoomDestroyed: (roomId: string) => {
    // Penanda lokal dulu (tahan refresh/offline), baru status UI. `messages`
    // dikosongkan juga supaya tidak ada sisa bubble yang bisa dibaca setelah
    // sesi dianggap mati.
    try {
      localStorage.setItem(BURNED_ROOM_PREFIX + roomId, 'true');
    } catch { /* storage penuh/private mode — status UI tetap di-set */ }
    set({ error: BURNER_TERMINATED_MESSAGE, isInitialized: true, activeSessions: {}, messages: [] });
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
      
      const roomId = parts[0] ?? '';
      const hostUserId = parts[1] ?? '';
      const hostDeviceId = parts[2] ?? '';
      const hostPqPk = parts[3] ?? '';
      const hostClassicalPk = parts[4] ?? '';

      // [BURNER 2026-10-18] GERBANG DESTROY. Dulu satu-satunya tanda "room
      // sudah dihancurkan" adalah event realtime `burner:terminated`; kalau
      // guest sedang offline/tidak bergabung saat host menekan destroy, tidak
      // ada yang tersimpan di klien dan halaman `/drop` tetap bisa dibuka
      // (bahkan setelah refresh) seolah sesi masih hidup.
      // Dua lapis: penanda lokal (bertahan tanpa jaringan) + status server.
      if (localStorage.getItem(BURNED_ROOM_PREFIX + roomId)) {
        set({ error: BURNER_TERMINATED_MESSAGE, isInitialized: true });
        return;
      }
      try {
        const status = await readRoomStatus(roomId);
        if (status?.terminated) {
          localStorage.setItem(BURNED_ROOM_PREFIX + roomId, 'true');
          set({ error: BURNER_TERMINATED_MESSAGE, isInitialized: true });
          return;
        }
      } catch (e) {
        // Gagal bertanya bukan alasan menolak masuk (mis. offline) — penanda
        // lokal di atas tetap berlaku, dan event realtime tetap menangani
        // destroy yang terjadi selagi halaman terbuka.
        console.warn('[Burner] Status room tidak bisa diperiksa:', e);
      }

      const sodium = await getSodiumLib();
      // Ensure we safely decode URL-encoded base64 components
      const safePqPk = decodeURIComponent(hostPqPk);
      const safeClassicalPk = decodeURIComponent(hostClassicalPk);
      
      const hostClassicalPkBytes = sodium.from_base64(safeClassicalPk, sodium.base64_variants.URLSAFE_NO_PADDING);
      const hostPqPkBytes = sodium.from_base64(safePqPk, sodium.base64_variants.URLSAFE_NO_PADDING);

      // Initialize Guest Double Ratchet State
      const initResult = await worker_burner_dr_init_guest({
        hostClassicalPk: hostClassicalPkBytes,
        hostPqPk: hostPqPkBytes
      });
      const stateFromWorker = initResult.state;
      const guestPk = initResult.guestClassicalPk;
      // Extract ct for propagation (ignoring strict TS errors here as instructed)
      const ct = (initResult as Record<string, unknown>).ct || (initResult as Record<string, unknown>).savedCt || "";

      set(state => ({
        hostUserId,
        hostDeviceId,
        hostPqPk,
        hostClassicalPk,
        activeSessions: {
          ...state.activeSessions,
          [roomId]: { drState: stateFromWorker, guestClassicalPk: guestPk, ct }
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

  sendMessage: async (content: string): Promise<BurnerSendResult> => {
    const roomId = Object.keys(get().activeSessions)[0];
    if (!roomId) return { ok: false, error: 'NO_SESSION' };

    // [BURNER 2026-10-18] Pre-flight koneksi SEBELUM enkripsi.
    // Dua alasan: (1) `sendEvent` saat transport mati hanya menaruh payload di
    // antrean offline — pesan tidak pernah sampai dan ack tidak pernah datang,
    // jadi UI diam total; (2) state Double Ratchet sudah maju saat enkripsi,
    // dan membakar satu langkah ratchet untuk pesan yang tidak pernah keluar
    // membuat percobaan berikutnya tidak sinkron dengan host.
    if (!transportClient.connected) {
      const connected = await ensureBurnerTransport();
      if (!connected) return { ok: false, error: 'OFFLINE' };
    }

    return await withRoomLock(roomId, async (): Promise<BurnerSendResult> => {
      const session = get().activeSessions[roomId];
      const state = session?.drState;
      const { hostDeviceId, hostUserId } = get();
      if (!state || !hostDeviceId || !hostUserId || !session) return { ok: false, error: 'NO_SESSION' };

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
        const ciphertextU8 = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext as ArrayBuffer);
        const ciphertextB64 = sodium.to_base64(ciphertextU8, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const payload = {
          header: { ...header, ct: state.savedCt || "" },
          ciphertext: ciphertextB64,
          guestClassicalPk: session.guestClassicalPk
        };

        const socket = transportClient;
        
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

        // `burner:reply` kini juga di-ACK server (sebelumnya diasumsikan sukses
        // tanpa bukti, sehingga kegagalan host tidak pernah terlihat).
        const emitPromise = new Promise<{ok?: boolean; error?: string}>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), SEND_ACK_TIMEOUT_MS);

          const onAck = (err: unknown, res: { ok?: boolean; error?: string } | undefined) => {
            clearTimeout(timer);
            if (err) {
              resolve({ ok: false, error: err instanceof Error && err.message === 'timeout' ? 'TIMEOUT' : 'NETWORK' });
            } else {
              resolve(res && typeof res === 'object' ? res : { ok: true });
            }
          };

          if (isHost) {
            transportClient.sendEvent('burner:reply', {
              roomId,
              ciphertext: JSON.stringify(payload)
            }, onAck);
          } else {
            transportClient.sendEvent('burner:send', { 
              roomId, 
              targetDeviceId: hostDeviceId, 
              hostUserId, 
              ciphertext: JSON.stringify(payload) 
            }, onAck);
          }
        });
        
        const res = await emitPromise;
        if (res && res.ok) {
          let parsedContent = content;
            let fileData = {};
            try {
              if (content.startsWith('{')) {
                const data = JSON.parse(content);
                if (data.type === 'file') {
                  parsedContent = data.text || '';
                  fileData = extractBurnerFileData(data);
                }
              }
            } catch (e) {}

            const msg: BurnerMessage = {
              id: Date.now().toString(),
              senderId: isHost ? 'host' : 'guest',
              content: parsedContent,
              createdAt: new Date().toISOString(),
              ...fileData
            };
            set(s => ({ messages: [...s.messages, msg] }));
            return { ok: true };
          }

        // [BURNER 2026-10-18] Kegagalan tidak boleh berhenti di console.
        const reason = res?.error || 'UNKNOWN';
        console.error("Failed to send burner message:", reason);
        if (reason === 'ROOM_TERMINATED') {
          get().markRoomDestroyed(roomId);
          return { ok: false, error: reason };
        }
        return { ok: false, error: reason };
      } catch (e) {
        console.error('Burner encrypt failed:', e);
        return { ok: false, error: 'ENCRYPT_FAILED' };
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

        const sodium = await getSodiumLib();

        // Host initialization on first message OR recovery if decryption fails
        const tryDecrypt = async (currentState: BurnerDoubleRatchetState | null): Promise<{ state: BurnerDoubleRatchetState; plaintext: Uint8Array }> => {
          if (!currentState) throw new Error("No state");
          const ciphertext = sodium.from_base64(ciphertextB64, sodium.base64_variants.URLSAFE_NO_PADDING);
          const result = await worker_burner_dr_decrypt({
            state: currentState,
            header: header as BurnerDoubleRatchetHeader,
            ciphertext: ciphertext.buffer
          });
          return { state: result.state, plaintext: result.plaintext };
        };

        let decryptionResult: { state: BurnerDoubleRatchetState; plaintext: Uint8Array } | null = null;

        if (state) {
          try {
            decryptionResult = await tryDecrypt(state);
          } catch (e) {
            console.warn("[Burner] Decryption failed with existing state, attempting recovery...", e);
            state = null; // Force re-init below
          }
        }

        if (!state) {
          if (guestClassicalPk) {
            const { getMyEncryptionKeyPair } = await import('../utils/crypto');
            const myDeviceKeys = await getMyEncryptionKeyPair(); // Host classical
            const authStore = useAuthStore.getState();
            const myPqKeys = await authStore.getPqEncryptionKeyPair(); // Host PQ

            const guestPkBytes = sodium.from_base64(guestClassicalPk, sodium.base64_variants.URLSAFE_NO_PADDING);
            const ctStr = String((header as Record<string, unknown>).ct);
            if (!ctStr) {
                throw new Error('KEM Ciphertext missing');
            }
            const savedCtBytes = sodium.from_base64(ctStr, sodium.base64_variants.URLSAFE_NO_PADDING);
            
            const { worker_burner_dr_init_host } = await import('../lib/crypto-worker-proxy');
            const initRes = await worker_burner_dr_init_host({
               hostClassicalSk: myDeviceKeys.privateKey,
               hostPqSk: myPqKeys.privateKey,
               guestClassicalPk: guestPkBytes,
               savedCt: savedCtBytes
            });
            
            state = initRes.state;
            guestPkState = guestClassicalPk;
            
            // Try decrypting again with new state
            decryptionResult = await tryDecrypt(state);
          } else {
             console.error("[Burner] Cannot recover session: Missing guest public key.");
             return; 
          }
        }

        if (!decryptionResult) return;

        const { state: newState, plaintext } = decryptionResult;

        set(s => ({
          activeSessions: {
            ...s.activeSessions,
            [roomId]: { drState: newState, guestClassicalPk: guestPkState }
          }
        }));

        const content = new TextDecoder().decode(plaintext);
        let parsedContent = content;
        let fileData = {};

        // [T4][26.10.5 Q5] Cover traffic: drop setelah dekripsi — jalur burner
        // DR tidak lewat parseSilent message store, jadi butuh guard sendiri
        // agar cover tidak muncul sebagai bubble JSON mentah. Pesan cover TIDAK
        // menghitung ratchet burner lebih jauh dari yang sudah terjadi (DR
        // state sudah di-commit di atas — sama seperti jalur grup, cover
        // memang menghitung chain by design).
        {
          const { isCoverPayload } = await import('@lib/coverTraffic');
          if (isCoverPayload(content)) return;
        }

        if (content.startsWith('{')) {
          try {
            const data = JSON.parse(content);
            if (data.type === 'file') {
              parsedContent = data.text || '';
              fileData = extractBurnerFileData(data);
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
          const { asMessageId, asConversationId, asUserId } = await import('@nyx/shared');
          const mainMsgTyped: import('@nyx/shared').Message = {
            ...mainMsg,
            id: asMessageId(mainMsg.id),
            conversationId: asConversationId(mainMsg.conversationId),
            senderId: asUserId(mainMsg.senderId),
          };
          useMessageStore.getState().addOptimisticMessage(roomId, mainMsgTyped);
          
          const { useConversationStore } = await import('./conversation');
          useConversationStore.getState().updateConversationLastMessage(roomId, mainMsgTyped);
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

    // 4. Emit ke server + TUNGGU ACK.
    // [BURNER 2026-10-18] Dulu event dikirim lalu langsung redirect: navigasi
    // bisa memutus transport sebelum payload terkirim, sehingga host melihat
    // destroy "berhasil" padahal server tidak pernah menerimanya — dan guest
    // tidak pernah menerima `burner:terminated` (gejala flaky). Tunggu ack
    // (maks 3 s) supaya siaran benar-benar sudah diproses.
    if (!transportClient.connected) {
      connectSocket();
      await waitForTransportConnected(3000);
    }
    if (transportClient.connected) {
      const myUserId = useAuthStore.getState().user?.id;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        transportClient.sendEvent(
          'burner:destroy',
          { roomId, hostUserId: myUserId },
          () => { clearTimeout(timer); resolve(); },
        );
      });
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
  const sodium = await getSodiumLib();
  const roomId = `burner_${sodium.to_hex(sodium.randombytes_buf(16))}`;
  
  // Host keys
  const authStore = useAuthStore.getState();
  const myUserId = authStore.user?.id;
  
  if (!myUserId) throw new Error("User not authenticated");

  // Fetch current device ID
  const { useConnectionStore } = await import('@store/connection');
  const devices = await useConnectionStore.getState().fetchMyDevices();
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
