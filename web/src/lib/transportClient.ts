import { EventEmitter } from 'eventemitter3';
import { io, type Socket } from 'socket.io-client';
import {
  CLIENT_CAPABILITIES,
  TRANSPORT_PROTOCOL_VERSION,
  encodeTransportHello,
  negotiateCapabilities,
  parseTransportHello,
  sanitizeCapabilityList,
  TransportOpCode,
} from '@nyx/shared';
import type { MainToTransportWorker, TransportWorkerToMain, BinaryPayload } from '@nyx/shared';
import { decideTransportMode, OUTGOING_OPCODE_MAP } from './transportMode';
import { classifyKickPayload } from './forceLogout';
import { advertisedCapabilities } from './spqrNegotiation';
import { advertisedPqCapabilities } from './pqCapability';
import { resolveChaffProfile } from './chaff';
import { useAuthStore } from '../store/auth';

import type { 
  RawServerMessage, 
  Message, 
  User, 
  Conversation,
  ConversationId,
  UserId,
  SubscriptionTier
} from '@nyx/shared';

// ============================================================================
// [docs/29 §5.6] Kapabilitas transport — state modul, diakses lewat helper.
// ============================================================================
//
// Yang diiklankan HANYA kapabilitas yang benar-benar sudah dipahami klien ini.
// Server boleh memilih format payload berdasarkan daftar ini, jadi mengiklankan
// fitur yang belum siap = pesan rusak (persis masalah yang mau dihindari).
//
// [docs/33 §33.7] `spqr-ratchet` masuk lewat `advertisedCapabilities()` (saklar
// integrasi + kill switch `VITE_SPQR_FORCE_V1`), bukan literal di sini: nama
// kapabilitas hidup di `@nyx/shared` dan keputusan mengiklankannya di
// `spqrNegotiation.ts`. Kapabilitas ini hanya menyatakan "deployment boleh
// melewatkan frame v2" — versi sesi tetap ditentukan deklarasi peer (`ackV`).
const ANNOUNCED_CLIENT_CAPABILITIES: string[] = [
  CLIENT_CAPABILITIES.HELLO_V1,
  ...advertisedCapabilities(),
  ...advertisedPqCapabilities(),
];
const HELLO_ACK_TIMEOUT_MS = 5000;

let negotiatedCapabilities: string[] = [];
let negotiatedProtocolVersion = 0;
let capabilityNegotiationDone = false;

/** Kapabilitas hasil negosiasi klien↔server (kosong = legacy). */
export const getNegotiatedCapabilities = (): string[] => negotiatedCapabilities;

/** Apakah kapabilitas (hasil negosiasi) tersedia di sesi ini? */
export const hasTransportCapability = (capability: string): boolean =>
  negotiatedCapabilities.includes(capability);

/** Versi protokol transport server (0 = belum/legacy). */
export const getNegotiatedProtocolVersion = (): number => negotiatedProtocolVersion;

/** Sudah selesai dinegosiasikan (atau server lama diam)? */
export const isCapabilityNegotiationDone = (): boolean => capabilityNegotiationDone;

function resetCapabilityState(done: boolean): void {
  negotiatedCapabilities = [];
  negotiatedProtocolVersion = 0;
  capabilityNegotiationDone = done;
}

type TransportEvents = {
  // Connection
  'connect': [];
  'disconnect': [reason: string];
  // [docs/29 §5.6] kapabilitas hasil negosiasi (kosong = server legacy)
  'capabilities': [capabilities: string[]];
  
  // Messages
  'message:new': [payload: BinaryPayload];
  // (event `message:updated` dihapus: TIDAK ada emitter di server — lihat
  // packages/shared/src/socket.ts.)
  'message:deleted': [data: { conversationId: string; id: string }];
  // [GAP 2026-10-18] Event yang benar-benar dikirim server, kini punya listener
  // di socketListeners: unsend peer, hapus massal (auto-delete sweeper), dan
  // view-once yang dibuka peer.
  'message:deleted_remotely': [data: { conversationId: string; messageId: string; deletedBy?: string }];
  'message:deleted_batch': [data: { conversationId: string; messageIds: string[] }];
  'message:viewed': [data: { conversationId: string; messageId: string }];
  'message:status_updated': [data: { conversationId: string; messageId: string; userId: string; status: string }];
  
  // Conversations
  'conversation:new': [conversation: Conversation];
  'conversation:updated': [data: Partial<Conversation> & { id: string }];
  // [BUGFIX 2026-10-18] `reason: 'removed'` = dikeluarkan dari grup (kick) —
  // riwayat lokal (pesan + kunci era) wajib dipertahankan agar tetap terbaca
  // saat anggota di-add kembali. `'hidden'`/absent = hapus lokal seperti biasa.
  'conversation:deleted': [data: { id: string; reason?: 'removed' | 'hidden' }];
  // (event `conversation:participants_added` dihapus: TIDAK ada emitter di server
  // — keanggotaan baru sampai lewat `conversation:updated` + refresh metadata.)
  'conversation:participant_removed': [data: { conversationId: string; userId: string }];
  // (event `conversation:participant_updated` dihapus: TIDAK ada emitter di
  // server; perubahan peran sampai lewat `conversation:updated`.)
  // [T1 FIX 2026-09-28] Perubahan keanggotaan (add/kick/leave) — pemicu refresh
  // metadata + rotasi kunci pasif di member non-admin.
  'group:participants_changed': [data: { conversationId: string }];
  
  // Users
  'user:updated': [user: Partial<User>];
  
  // Presence & RTC
  'presence:update': [payload: BinaryPayload];
  'webrtc:signal': [payload: BinaryPayload];
  
  // Auth & Security
  // `deviceId`/`reason` ikut dikirim server (`/api/sessions`, kick device, ban)
  // dan dipakai handler untuk memutuskan apakah event ini untuk device lokal.
  'force_logout': [data: { jti?: string; deviceId?: string; reason?: string }];
  'auth:banned': [data: { reason: string }];
  // [GAP 2026-10-18] Dikirim setelah webhook pembayaran (routes/subscriptions.ts).
  'subscription_updated': [data: { tier: SubscriptionTier; expiresAt?: string }];
  
  // Key Management
  // `session:request_key` = permintaan kunci sesi 1:1 yang DIRELAY server ke
  // target (nama lama di klien: `session:fulfill_request`, event yang tidak
  // pernah di-emit siapa pun). Listener-nya ada di socketListeners.
  'session:request_key': [data: { conversationId: string; sessionId: string; requesterId: string; requesterPublicKey?: string; requesterPqPublicKey?: string; requesterDeviceId?: string }];
  // [PQ v4 Fase 1.5 — AUDIT 2026-10-20] Kunci verifikasi pengirim ikut tipe:
  // event ini satu-satunya jalan distribusi sender-key, jadi field v1/v2 tidak
  // boleh hilang diam-diam di seam transport.
  'session:new_key': [data: { conversationId: string; sessionId?: string; encryptedKey: string; type?: 'GROUP_KEY' | 'SESSION_KEY'; senderId?: string; senderDeviceKey?: string; senderSigningKey?: string; senderSigningKeyV2?: string; drHeader?: unknown }];
  'group:fulfill_key_request': [data: { conversationId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string; requesterDeviceId?: string }];
  'group:key_request_failed': [data: { conversationId: string; reason: string }];
  'session:request_key_failed': [data: { sessionId: string; targetId: string; reason: string }];
  'handshake:completed': [success: boolean, error?: string];
  // [AUDIT 2026-10-25] Kegagalan handshake socket.io (mis. middleware gateway
  // menolak `unauthorized`). Tanpa event ini penolakan itu tidak pernah
  // dilaporkan: socket tidak "connect" dan tidak ada yang mencatat apa pun,
  // sehingga status klien tertinggal di 'connecting' selamanya.
  'connect_error': [message: string];
  
  // Burner Chats
  'burner:receive': [payload: { roomId?: string, ciphertext: string }];
  'burner:terminated': [payload: { roomId: string }];

  // Migration
  'migration:start': [payload: { roomId: string; totalChunks: number; sealedKey: string; }];
  'migration:chunk': [payload: { chunkIndex: number; chunk: string; }];
  'migration:ack': [payload: { roomId: string, success: boolean }];

  // Allow arbitrary events for backward compatibility
  [event: string]: unknown[];
};

export class NyxWebTransportClient extends EventEmitter<TransportEvents> {
  private worker: Worker;
  public connected: boolean = false;
  // [WT FIX 2026-09-29] Ekspos status menyambung agar connectSocket() bisa
  // mencegah panggilan ganda (loop reconnect saat reload).
  public get connecting(): boolean {
    return this.mode === 'wt' && this.wtConnecting;
  }
  private pendingAcks = new Map<string, { resolve: (val: unknown) => void, reject: (err: unknown) => void, startedAt: number, timeoutId: ReturnType<typeof setTimeout> }>();

  private offlineQueue: MainToTransportWorker[] = [];

  // --- WebSocket fallback (state machine) ---
  // mode 'wt' adalah default; beralih ke 'wss' (sticky untuk sesi) jika WT
  // gagal berturut-turut mencapai ambang batas.
  // [e2e/self-host] VITE_FORCE_WSS=1 melewati percobaan QUIC sepenuhnya.
  // Dipakai job E2E Chromium yang tidak menjalankan sidecar: Chromium baru
  // mengekspos WebTransport walau tidak ada uplink, sehingga deteksi
  // `typeof WebTransport` saja tidak lagi cukup.
  private mode: 'wt' | 'wss' = import.meta.env.VITE_FORCE_WSS === '1' ? 'wss' : 'wt';
  private wtFailCount = 0;
  private readonly WT_MAX_FAILS = 2;
  private readonly WT_TIMEOUT_MS = 8000;
  private wtConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wtConnecting = false;
  private lastConnectParams: { url: string; token: string; certificateHash?: string } = { url: '', token: '' };
  // [WT FIX 2026-09-29] Sesi yang DITOLAK server sesaat setelah handshake
  // (mis. sidecar auth gagal / cert hash basi) tidak boleh dianggap koneksi
  // sehat. Tanpa grace window, DISCONNECTED tiba setelah wtConnecting=false →
  // tidak dihitung gagal → wtFailCount tak pernah mencapai ambang → fallback
  // WSS tidak pernah aktif → loop reconnect tanpa henti (ditemukan di log
  // "Percobaan WebTransport ke-1 gagal" berulang ~20× saat reload).
  private connectedAt = 0;
  private wtStableTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WT_REJECT_GRACE_MS = 15000;
  private readonly WT_STABLE_MS = 15000;
  private socket: Socket | null = null;
  private wssOfflineQueue: { opCode: TransportOpCode; payload: BinaryPayload }[] = [];
  private silentNoopOpcodes = new Set<TransportOpCode>();
  // [docs/29 §5.6] Timer tunggu balasan HELLO (sidecar lama tidak menjawab).
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.worker = new Worker(new URL('../workers/transport.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    
    // [docs/35 Fase 3] Chaff visibility-aware: tab background berhenti
    // mengirim datagram penyamaran (aturan sama dengan cover traffic).
    if (typeof document !== 'undefined') {
      this.applyChaffProfile();
      document.addEventListener('visibilitychange', () => this.applyChaffProfile());
    }

    // [+] FLUSH ANTRIAN SAAT KONEK
    this.on('connect', () => {
      this.applyChaffProfile();
      if (this.mode === 'wss') {
        while (this.wssOfflineQueue.length > 0) {
          const m = this.wssOfflineQueue.shift();
          if (m) this.routeOutgoingWss(m.opCode, m.payload);
        }
      } else {
        while (this.offlineQueue.length > 0) {
          const msg = this.offlineQueue.shift();
          if (msg) {
             const transferables = ('payload' in msg && msg.payload instanceof Uint8Array) ? [msg.payload.buffer] : [];
             this.worker.postMessage(msg, transferables);
          }
        }
      }
    });
  }

  public async connect(url: string, token: string, certificateHash?: string): Promise<void> {
    if (this.mode === 'wss') {
      this.connectWss();
      return;
    }
    // [AUDIT 2026-10-25] Tanpa URL WebTransport yang benar-benar menunjuk
    // sidecar, percobaan WT hanya membuang ~1,5 dtk + dua error konsol sebelum
    // jatuh ke WSS. Lebih jujur langsung memakai WSS.
    if (!resolveTransportUrl(url)) {
      console.info(
        '[Transport] VITE_TRANSPORT_URL tidak diset (dan VITE_API_URL relatif) — ' +
          'WebTransport dilewati, memakai WebSocket.'
      );
      this.mode = 'wss';
      this.connectWss();
      return;
    }
    await this.connectWt(url, token, certificateHash);
  }

  /**
   * WebTransport (primary) connect path. Mirrors the original behavior exactly,
   * plus a per-attempt timeout so a blocked UDP/QUIC network fails fast and
   * triggers the WebSocket fallback.
   */
  private async connectWt(url: string, token: string, certificateHash?: string): Promise<void> {
    // [WT FIX 2026-09-29] Guard duplikat: connectSocket() bisa dipanggil ulang
    // saat upaya sebelumnya masih berjalan (worker menutup transport lama
    // mid-connect → error "close() called on WebTransport while connecting"
    // → counter gagal tercemar oleh race, bukan kegagalan jaringan sungguhan).
    if (this.wtConnecting) return;
    this.lastConnectParams = { url, token, certificateHash };
    // [AUDIT 2026-10-25] Tidak ada lagi fallback hardcoded
    // `https://api.nyx-app.my.id/transport`: host itu tidak menyajikan jalur
    // sidecar, sehingga sesi SELALU ditolak ("WebTransport connection
    // rejected") di deployment dengan VITE_API_URL relatif. Lihat
    // resolveTransportUrl().
    const rawUrl = resolveTransportUrl(url)!;
    
    // 1. Get Temporary Transport Ticket for better browser compatibility (Brave/Safari fallback)
    let finalUrlWithTicket = rawUrl;
    try {
      const { api } = await import('./api');
      const { ticket } = await api<{ ticket: string }>('/api/auth/transport-ticket');
      
      const urlObj = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      urlObj.searchParams.set('ticket', ticket);
      finalUrlWithTicket = urlObj.toString();
    } catch (e) {
      console.warn("[Transport] Could not fetch connection ticket, falling back to pure Token Auth:", e);
    }

    // Ensure URL has https:// scheme as required by WebTransport
    let finalUrl = finalUrlWithTicket;
    if (!finalUrl.startsWith('https://') && !finalUrl.startsWith('http://')) {
       finalUrl = 'https://' + finalUrl;
    } else if (finalUrl.startsWith('http://')) {
       finalUrl = finalUrl.replace('http://', 'https://');
    }

    const hash = certificateHash || (import.meta.env.PROD ? undefined : import.meta.env.VITE_TRANSPORT_CERT_HASH);
    
    // 2. Get Device Identity for Hardware Binding (Lapis 2 Security)
    let deviceIdentity: string | undefined = undefined;
    try {
      const { getFullDeviceIdentity } = await import('../utils/fingerprint');
      const identity = await getFullDeviceIdentity();
      deviceIdentity = JSON.stringify(identity);
    } catch (e) {
      console.warn("[Transport] Could not generate device identity:", e);
    }

    this.worker.postMessage({ type: 'CONNECT', url: finalUrl, token, certificateHash: hash, deviceIdentity } satisfies MainToTransportWorker);

    // [+] TIMEOUT: jika WT tidak CONNECT dalam WT_TIMEOUT_MS, anggap gagal.
    this.wtConnecting = true;
    this.clearWtTimer();
    this.wtConnectTimer = setTimeout(() => {
      this.handleWtFailure();
    }, this.WT_TIMEOUT_MS);
  }

  /**
   * WebSocket (socket.io) fallback connect path. Establishes the socket.io
   * connection against the same API origin and re-emits the SAME TransportEvents
   * so everything upstream (socketListeners) is unchanged.
   */
  private connectWss(): void {
    // Pindahkan SEMUA pesan yang mengantri di worker WT ke antrean WSS SEBELUM
    // guard early-return, agar tidak ada pesan user yang terbuang saat transisi
    // mode (termasuk saat connectWss dipanggil ulang dengan socket yang sudah ada).
    this.drainWtQueueToWss();

    if (this.socket) return; // sudah terkoneksi / sedang menyambung

    const origin = this.resolveApiOrigin();
    // Transports dapat dikunci via env (mis. VITE_WSS_TRANSPORTS=websocket)
    // saat berjalan di belakang LB tanpa sticky-session: koneksi websocket
    // murni adalah satu stream TCP yang bisa dirutekan ke replika mana pun,
    // sedangkan polling fallback butuh affinity antar-replika.
    const rawTransports = String(
      import.meta.env.VITE_WSS_TRANSPORTS ?? 'websocket,polling'
    )
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is 'websocket' | 'polling' => t === 'websocket' || t === 'polling');
    const socket = io(origin, {
      withCredentials: true,
      transports: rawTransports.length > 0 ? rawTransports : ['websocket', 'polling'],
      path: '/socket.io',
      reconnection: true,
      // [docs/29 §5.6 · docs/33 §33.7] Kapabilitas diiklankan lewat handshake;
      // gateway WSS membalas event `capabilities` (irisan dengan
      // SERVER_CAPABILITIES). Sebelum ini jalur WSS selalu "legacy", sehingga
      // jalur ratchet v2 (braid SPQR) tidak pernah dipakai di sini walau kedua
      // peer sudah saling menyatakan mampu in-band (`ackV`).
      //
      // [AUDIT 2026-10-25] `token` ikut dikirim: jalur WSS dulu HANYA bergantung
      // pada cookie `at`. Cookie itu host-only (kecuali COOKIE_DOMAIN di-set),
      // sedangkan socket menuju `api.nyx-app.my.id` sementara REST dilayani
      // relatif di `app.nyx-app.my.id` → handshake tanpa cookie → gateway
      // menjawab `unauthorized` dan klien berhenti di ESTABLISHING_UPLINK.
      // Gateway sudah menerima `handshake.auth.token` sebagai cadangan
      // (server/src/realtime/gateway.ts). Dibuat callback supaya token yang
      // di-refresh tetap terpakai saat reconnect.
      auth: (cb) => cb({
        token: useAuthStore.getState().accessToken || undefined,
        capabilities: ANNOUNCED_CLIENT_CAPABILITIES,
      }),
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      // Jalur WSS punya negosiasinya sendiri sekarang: JANGAN langsung menandai
      // legacy. Tunggu balasan gateway dengan batas waktu yang sama seperti
      // HELLO sidecar; server lama yang tidak membalas = legacy (bukan error).
      this.startWssCapabilityNegotiation();
      this.emit('connect');
    });

    // Balasan kapabilitas dari gateway WSS (`server/src/realtime/gateway.ts`).
    socket.on('capabilities', (caps: unknown) => {
      const parsed = sanitizeCapabilityList(caps);
      if (!parsed) {
        console.warn('[Transport] Balasan kapabilitas WSS tidak sah — diabaikan (mode legacy).');
        return;
      }
      // Irisan di sisi klien juga: server TIDAK boleh mengaktifkan kapabilitas
      // yang tidak kita iklankan (pertahanan terhadap server/konfigurasi salah).
      this.finishCapabilityNegotiation(
        negotiateCapabilities(ANNOUNCED_CLIENT_CAPABILITIES, parsed),
        'wss'
      );
    });

    socket.on('disconnect', (reason: string) => {
      this.connected = false;
      this.emit('disconnect', reason);
    });

    // [AUDIT 2026-10-25] Penolakan middleware gateway (mis. `unauthorized`
    // karena cookie sesi tidak ikut di handshake — lihat COOKIE_DOMAIN di
    // server/src/config.ts). socket.io TIDAK mencoba ulang untuk error
    // middleware, jadi tanpa handler ini penolakan tersebut sepenuhnya senyap
    // dan klien diam di status 'connecting' (banner ESTABLISHING_UPLINK).
    socket.on('connect_error', (err: Error) => {
      const message = err?.message || 'connect_error';
      console.warn(`[Transport] WebSocket ditolak gateway: ${message}`);
      this.emit('connect_error', message);
    });

    // Tangkap semua event masuk dan teruskan ke TransportEvents.
    socket.onAny((eventName: string, ...args: any[]) => {
      if (eventName === 'connect' || eventName === 'disconnect') return;
      // Balasan kapabilitas bukan data pesan — jangan di-map ke event
      // TransportEvents (paralel dengan HELLO yang transport-local di jalur WT).
      if (eventName === 'capabilities') return;
      this.handleIncomingWss(eventName, args[0]);
    });
  }

  /**
   * [docs/35 Fase 3] Kirim profil chaff ke worker. Dipanggil saat visibilitas
   * berubah dan saat koneksi terbentuk; `maximum` dibiarkan default karena
   * kepadatan cover diatur scheduler aplikasi, bukan transport.
   */
  private applyChaffProfile(maximum = false): void {
    const profile = resolveChaffProfile({
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      maximum,
    });
    this.worker.postMessage({ type: 'CHAFF_CONFIG', ...profile } satisfies MainToTransportWorker);
  }

  public disconnect(): void {
    this.clearWtTimer();
    if (this.wtStableTimer) {
      clearTimeout(this.wtStableTimer);
      this.wtStableTimer = null;
    }
    this.wtConnecting = false;
    if (this.mode === 'wss' && this.socket) {
      this.socket.disconnect();
      this.socket = null;
      return;
    }
    this.worker.postMessage({ type: 'DISCONNECT' } satisfies MainToTransportWorker);
  }

  private handleWorkerMessage(event: MessageEvent<TransportWorkerToMain>): void {

    const data = event.data;
    switch (data.type) {
      case 'CONNECTED':
        this.clearWtTimer();
        this.wtConnecting = false;
        this.connected = true;
        this.connectedAt = Date.now();
        // [WT FIX 2026-09-29] Reset counter gagal TIDAK instan — tunggu sesi
        // terbukti stabil. Bila sesi ditolak server sebelum timer ini habis,
        // DISCONNECTED tetap dihitung sebagai kegagalan (grace window).
        if (this.wtStableTimer) clearTimeout(this.wtStableTimer);
        this.wtStableTimer = setTimeout(() => {
          this.wtStableTimer = null;
          this.wtFailCount = 0;
        }, this.WT_STABLE_MS);
        // [docs/29 §5.6] Tiap sesi WT baru menegosiasikan kapabilitasnya sendiri.
        this.sendCapabilityHello();
        this.emit('connect');
        break;
      case 'DISCONNECTED':
        this.connected = false;
        this.clearHelloTimer();
        resetCapabilityState(false);
        this.emit('disconnect', data.reason);
        // Hitung sebagai kegagalan bila masih menyambung ATAU sesi baru saja
        // terbuka lalu langsung ditutup (ditolak sidecar — pola loop reload).
        if (this.mode === 'wt' && (this.wtConnecting || this.wasRecentlyConnected())) {
          this.handleWtFailure();
        }
        break;
      case 'ERROR':
        console.error("Transport Worker Error:", data.error);
        // Hitung sebagai kegagalan WT saat menyambung atau sesi baru saja
        // gagal (bukan error pinggir saat sesi sudah lama stabil).
        if (this.mode === 'wt' && (this.wtConnecting || this.wasRecentlyConnected())) {
          this.handleWtFailure();
        }
        break;
      case 'DATA_RECEIVED':
        this.routeOpCode(data.opCode, data.payload);
        break;
      case 'HANDSHAKE_COMPLETED':
        this.emit('handshake:completed', data.success, data.error);
        break;
    }
  }

  private routeOpCode(opCode: TransportOpCode, payload: BinaryPayload): void {
    switch (opCode) {
      case TransportOpCode.CHAT_MESSAGE:
        this.emit('message:new', payload);
        break;
      case TransportOpCode.WEBRTC_SIGNAL:
      case TransportOpCode.WEBRTC_ICE:
        this.emit('webrtc:signal', payload);
        break;
      case TransportOpCode.PRESENCE:
        this.emit('presence:update', payload);
        break;
      case TransportOpCode.ACK:
        this.handleAck(payload);
        break;
      case TransportOpCode.HELLO:
        this.handleCapabilityHelloReply(payload);
        break;
      case TransportOpCode.KICK: {
        // [PARITY 2026-10-18] Frame KICK kini benar-benar sampai di jalur WT —
        // sidecar mengirim frame-nya SEBELUM menutup koneksi (dulu hanya
        // `close("Kicked by server")`, sehingga alur force_logout yang jalan di
        // jalur WSS tidak pernah aktif di transport utama). Pemetaannya sengaja
        // sama dengan gateway WSS supaya hasilnya tidak bergantung transport:
        //   - payload dengan `deviceId` = kick PER-DEVICE (revoke sesi, kick
        //     device, hardware mismatch) → `force_logout` (handler melakukan
        //     scoping device + logout + `/login?reason=revoked`).
        //   - payload tanpa `deviceId` tapi ada `reason` = aksi level AKUN
        //     (akun dihapus / ban admin) → `auth:banned` (perilaku lama tetap).
        //   - payload tak terbaca → `force_logout` (server memang menutup sesi).
        let json: Record<string, unknown> = {};
        try {
          const parsedJson = JSON.parse(new TextDecoder().decode(payload)) as unknown;
          if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
            json = parsedJson as Record<string, unknown>;
          }
        } catch {
          json = {}; // payload tidak terbaca → server tetap menutup sesi ini
        }

        // [+] AMBIL DARI OBJECT USER
        let currentDeviceId: string | null = null;
        try {
          const userJson = localStorage.getItem('user');
          const parsedUser = userJson ? (JSON.parse(userJson) as unknown) : null;
          currentDeviceId = (typeof parsedUser === 'object' && parsedUser !== null && 'deviceId' in parsedUser)
            ? ((parsedUser as Record<string, unknown>).deviceId as string | null)
            : localStorage.getItem('deviceId');
        } catch {
          currentDeviceId = localStorage.getItem('deviceId');
        }

        // Keputusan (ignore/banned/logout) hidup di helper murni supaya jalur WT
        // dan WSS diuji dengan aturan yang sama — lihat forceLogout.ts.
        const disposition = classifyKickPayload(json, currentDeviceId);
        if (disposition.action === 'ignore') {
           console.log("Ignored kick for different device ID:", disposition.deviceId);
        } else if (disposition.action === 'auth_banned') {
           this.emit('auth:banned', { reason: disposition.reason });
        } else {
           this.emit('force_logout', disposition.payload);
        }
        break;
      }
      default:
        // Handle generic events
        try {
           const json = JSON.parse(new TextDecoder().decode(payload));
           if (json && json.event) {
              this.emit(json.event, json.data);
           }
        } catch (e) {}
        break;
    }
  }

  // --- [docs/29 §5.6] Negosiasi kapabilitas ---

  /**
   * Kirim HELLO setelah terautentikasi; tanpa balasan → mode legacy.
   *
   * HELLO HARUS lewat stream bidi (worker `CAPABILITY_HELLO`): server membalas
   * di stream yang sama. Lewat `sendStream` (uni) balasan tidak mungkin datang,
   * dan sidecar akan meneruskan frame itu ke `nyx:upstream:11` — padahal opcode
   * ini transport-local dan tidak boleh sampai ke Node.
   */
  private sendCapabilityHello(): void {
    this.clearHelloTimer();
    resetCapabilityState(false);
    if (this.mode !== 'wt' || !this.connected) {
      // Tidak ada jalur WT: fallback WSS tidak punya HELLO → legacy, selesai.
      resetCapabilityState(true);
      return;
    }
    try {
      const payload = encodeTransportHello({ v: TRANSPORT_PROTOCOL_VERSION, caps: ANNOUNCED_CLIENT_CAPABILITIES });
      const message: MainToTransportWorker = { type: 'CAPABILITY_HELLO', payload };
      this.worker.postMessage(message, [payload.buffer]);
    } catch (e) {
      console.warn('[Transport] Gagal mengirim HELLO kapabilitas:', e);
    }
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      // Sidecar lama (atau jaringan lambat): jalan sebagai legacy, bukan error.
      resetCapabilityState(true);
      console.info('[Transport] Tidak ada balasan HELLO — jalan dalam mode legacy (tanpa kapabilitas).');
      this.emit('capabilities', []);
    }, HELLO_ACK_TIMEOUT_MS);
  }

  /**
   * [docs/29 §5.6 · docs/33 §33.7] Negosiasi kapabilitas jalur WSS.
   *
   * Klien sudah mengiklankan daftarnya di `handshake.auth.capabilities`, jadi di
   * sini yang dilakukan hanya menunggu balasan gateway — dengan batas waktu yang
   * sama seperti jalur WT. Tanpa batas waktu, klien yang bicara dengan gateway
   * lama akan menggantung "pending" selamanya dan (lebih buruk) tidak pernah
   * mengunci keputusan versi ratchet.
   */
  private startWssCapabilityNegotiation(): void {
    this.clearHelloTimer();
    resetCapabilityState(false);
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      console.info('[Transport] Gateway WSS tidak membalas kapabilitas — jalan dalam mode legacy (tanpa kapabilitas).');
      this.finishCapabilityNegotiation([], 'wss');
    }, HELLO_ACK_TIMEOUT_MS);
  }

  /**
   * Menutup satu negosiasi kapabilitas (`wt` lewat HELLO sidecar, `wss` lewat
   * balasan gateway) dan mengumumkan hasilnya. Satu tempat supaya dua transport
   * tidak bisa menyimpang soal "kapan negosiasi dianggap selesai".
   */
  private finishCapabilityNegotiation(agreed: string[], source: 'wt' | 'wss'): void {
    negotiatedCapabilities = agreed;
    capabilityNegotiationDone = true;
    this.clearHelloTimer();
    // Versi protokol hanya datang dari HELLO sidecar; gateway WSS tidak punya
    // versi protokol (handshake socket.io sudah punya framing-nya sendiri).
    const protocol = negotiatedProtocolVersion > 0 ? ` protokol v${negotiatedProtocolVersion}` : '';
    console.info(
      `[Transport] Kapabilitas ${source}${protocol} dinegosiasikan: ${agreed.length > 0 ? agreed.join(', ') : '—'}`
    );
    this.emit('capabilities', agreed);
  }

  /** Balasan HELLO dari sidecar: simpan irisan kapabilitas yang disepakati. */
  private handleCapabilityHelloReply(payload: BinaryPayload): void {
    const parsed = parseTransportHello(payload);
    if (!parsed) {
      console.warn('[Transport] Balasan HELLO tidak sah — diabaikan (mode legacy).');
      return;
    }
    // Irisan di sisi klien juga: server TIDAK boleh mengaktifkan kapabilitas yang
    // tidak kita iklankan (pertahanan terhadap server/konfigurasi salah).
    const agreed = negotiateCapabilities(ANNOUNCED_CLIENT_CAPABILITIES, parsed.caps);
    negotiatedProtocolVersion = parsed.v;
    this.finishCapabilityNegotiation(agreed, 'wt');
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private handleAck(payload: BinaryPayload) {
     try {
       const parsedJson = JSON.parse(new TextDecoder().decode(payload)) as unknown;
       const json = typeof parsedJson === 'object' && parsedJson !== null ? parsedJson as Record<string, unknown> : null;
       if (json && json.msgId && typeof json.msgId === 'string' && this.pendingAcks.has(json.msgId)) {
          const p = this.pendingAcks.get(json.msgId)!;
          clearTimeout(p.timeoutId);
          if (import.meta.env.DEV) {
            const duration = performance.now() - p.startedAt;
            console.debug(`[perf:transport] ack ${json.msgId}: ${duration.toFixed(1)}ms`);
          }
          p.resolve(json.data);
          this.pendingAcks.delete(json.msgId);
       }
     } catch (e) {}
  }

  // --- WebSocket fallback helpers ---

  private clearWtTimer(): void {
    if (this.wtConnectTimer !== null) {
      clearTimeout(this.wtConnectTimer);
      this.wtConnectTimer = null;
    }
  }

  /** Sesi WT apakah ditutup dalam grace window setelah CONNECTED? */
  private wasRecentlyConnected(): boolean {
    return this.connectedAt > 0 && (Date.now() - this.connectedAt) < this.WT_REJECT_GRACE_MS;
  }

  /**
   * Dipanggil ketika upaya konek WT gagal (timeout / ERROR / DISCONNECTED
   * saat menyambung). Menggunakan decideTransportMode untuk menentukan:
   * coba ulang WT, atau beralih ke WebSocket (sticky untuk sesi).
   */
  private handleWtFailure(): void {
    this.clearWtTimer();
    this.wtConnecting = false;
    this.wtFailCount += 1;

    const decision = decideTransportMode({
      currentMode: this.mode,
      wtFailCount: this.wtFailCount,
      wtMaxFails: this.WT_MAX_FAILS,
    });

    if (decision.shouldSwitchToWss) {
      console.info(`[Transport] WebTransport gagal ${this.wtFailCount}x berturut-turut, beralih ke WebSocket fallback.`);
      if (import.meta.env.DEV) {
        // [2026-10-09] Penolakan handshake WT di DEV hampir selalu berarti
        // sertifikat sidecar sudah kedaluwarsa/berotasi sehingga pin
        // VITE_TRANSPORT_CERT_HASH basi. Sidecar kini merotasi otomatis dan
        // mencetak hash baru — salin ke web/.env lalu restart `vite dev`.
        console.info(
          `[Transport] DEV: cek VITE_TRANSPORT_CERT_HASH vs hash yang dicetak sidecar ` +
            `(sertifikat lokal masa berlaku 10 hari; sidecar merotasi & mencetak hash baru saat kedaluwarsa).`
        );
      }
      this.mode = 'wss';
      this.connectWss();
    } else if (decision.shouldRetryWt) {
      console.info(`[Transport] Percobaan WebTransport ke-${this.wtFailCount} gagal, mencoba ulang...`);
      void this.connectWt(this.lastConnectParams.url, this.lastConnectParams.token, this.lastConnectParams.certificateHash);
    }
  }

  private resolveApiOrigin(): string {
    const envUrl = (import.meta.env.VITE_API_URL as string | undefined) || '';
    const cleaned = envUrl.replace(/\/api\/?$/, '').replace(/\/$/, '');
    if (cleaned) return cleaned;
    // Dev/E2E tanpa VITE_API_URL: socket.io harus menuju origin yang sama
    // dengan REST (relatif /api), bukan produksi. Fallback produksi tetap
    // dipakai untuk build non-DEV yang lupa mengisi env.
    if (import.meta.env.DEV && typeof window !== 'undefined') return window.location.origin;
    return 'https://api.nyx-app.my.id';
  }

  private drainWtQueueToWss(): void {
    while (this.offlineQueue.length > 0) {
      const msg = this.offlineQueue.shift();
      if (!msg || !('payload' in msg) || !(msg.payload instanceof Uint8Array)) continue;
      if (msg.type === 'SEND_STREAM' || msg.type === 'SEND_DATAGRAM') {
        this.wssOfflineQueue.push({ opCode: msg.opCode, payload: msg.payload });
      }
      // START_HANDSHAKE (PQ handshake) adalah fitur WT-only; bukan pesan user dan
      // akan dibangun ulang saat sesi WT berikutnya, jadi sengaja dibuang saat
      // transisi WT→WSS.
    }
  }

  /**
   * Map event socket.io server -> TransportEvents (byte-equivalent dengan WT).
   *
   * Gateway server meng-emit:
   *   'message:new'     -> CHAT_MESSAGE  (di-re-encode ke Uint8Array, sama spt WT)
   *   'presence:update' -> PRESENCE      (di-re-encode ke Uint8Array, sama spt WT)
   *   'message:ack_delivered' -> ACK     (konfirmasi terkirim, resolve pendingAcks)
   *   'webrtc:secure_signal' -> webrtc:signal (paritas opcode 0x03/0x04 jalur WT)
   *   'force_logout'    -> force_logout  (passthrough json.data)
   *   <json.event>      -> passthrough   (message:updated, conversation:*,
   *                                       user:updated, session:*, group:*,
   *                                       burner:*, migration:*, dll.)
   */
  private handleIncomingWss(eventName: string, data: unknown): void {
    if (eventName === 'message:new') {
      this.routeOpCode(TransportOpCode.CHAT_MESSAGE, this.encodeJson(data));
    } else if (eventName === 'presence:update') {
      this.routeOpCode(TransportOpCode.PRESENCE, this.encodeJson(data));
    } else if (eventName === 'webrtc:secure_signal') {
      // [PARITY 2026-10-18] Sinyal panggilan (envelope `{ from, type, payload }`).
      // Di-re-encode ke byte lalu lewat `routeOpCode` yang SAMA dengan jalur WT,
      // sehingga listener `webrtc:signal` (webrtc.ts) tidak tahu transport apa
      // yang dipakai. WEBRTC_SIGNAL dipilih karena di WSS tidak ada perbedaan
      // datagram/uni — sisi penerima menangani keduanya identik.
      this.routeOpCode(TransportOpCode.WEBRTC_SIGNAL, this.encodeJson(data));
    } else if (eventName === 'message:ack_delivered') {
      // Opcode ACK server (konfirmasi pesan terkirim) -> resolve pendingAcks.
      this.handleAck(this.encodeJson(data));
    } else {
      // Passthrough: mencerminkan default branch routeOpCode (this.emit(json.event, json.data)).
      this.emit(eventName, data);
    }
  }

  private encodeJson(data: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(data ?? null));
  }

  private decodeJson(payload: BinaryPayload): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
  }

  /**
   * Terjemahkan {opCode, payload} keluar ke event socket.io sesuai tabel
   * OUTGOING_OPCODE_MAP. Payload keluar adalah JSON (sudah diserialisasi oleh
   * bridge/sidecar), jadi kita decode lalu emit objek aslinya.
   */
  private routeOutgoingWss(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (!this.socket) return;
    const mapping = OUTGOING_OPCODE_MAP[opCode];
    switch (mapping.kind) {
      case 'fixed':
        this.socket.emit(mapping.event, this.decodeJson(payload));
        break;
      case 'derived': {
        const json = this.decodeJson(payload) as { event?: string; data?: unknown; msgId?: string } | null;
        if (json && typeof json.event === 'string') {
          // Paritas ACK dengan jalur WT: msgId diteruskan sebagai arg ke-2 agar
          // gateway WSS bisa mengirim ACK yang meng-resolve pendingAcks (dipakai
          // mis. emitGroupKeyDistribution dengan callback).
          this.socket.emit(json.event, json.data, typeof json.msgId === 'string' ? json.msgId : undefined);
        }
        break;
      }
      case 'noop':
        if (!this.silentNoopOpcodes.has(opCode)) {
          this.silentNoopOpcodes.add(opCode);
          console.info(`[Transport] WebSocket fallback: opCode 0x${opCode.toString(16)} tidak didukung, diabaikan.`);
        }
        break;
    }
  }

  public sendStream(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      if (!this.connected || !this.socket) {
        this.wssOfflineQueue.push({ opCode, payload });
      } else {
        this.routeOutgoingWss(opCode, payload);
      }
      return;
    }
    const message: MainToTransportWorker = { type: 'SEND_STREAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public sendDatagram(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      if (!this.connected || !this.socket) {
        this.wssOfflineQueue.push({ opCode, payload });
      } else {
        this.routeOutgoingWss(opCode, payload);
      }
      return;
    }
    const message: MainToTransportWorker = { type: 'SEND_DATAGRAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public startHandshake(payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      // PQ handshake adalah fitur WT; tidak didukung di fallback WebSocket.
      return;
    }
    const message: MainToTransportWorker = { type: 'START_HANDSHAKE', payload };
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public sendJsonStream(opCode: TransportOpCode, payload: unknown): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendStream(opCode, buffer);
  }

  public sendJsonDatagram(opCode: TransportOpCode, payload: unknown): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendDatagram(opCode, buffer);
  }
  
  private routeAndSend(event: string, data: unknown, msgId?: string): void {
    if (event === 'message:send') {
        this.sendJsonStream(TransportOpCode.CHAT_MESSAGE, { ...(data as Record<string, unknown>), msgId });
        } else if (event.startsWith('user:') || event.startsWith('typing:') || event === 'presence:subscribe') {
        // [docs/28 Tier 1.5 / D14] `presence:subscribe` ikut opcode PRESENCE
        // (langganan per-kontak menggantikan snapshot otomatis).
        this.sendJsonStream(TransportOpCode.PRESENCE, { event, ...(data as Record<string, unknown>) });
    } else {
        this.sendJsonStream(TransportOpCode.KEY_SYNC, { event, msgId, data });
    }
  }

  public sendEvent(event: string, data?: unknown, callback?: Function): void {
    const msgId = crypto.randomUUID();
    
    if (callback) {
       this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(err, null),
          startedAt: performance.now(),
          timeoutId: setTimeout(() => {
             this.pendingAcks.delete(msgId);
             callback(new Error('timeout'), null);
          }, 30000)
       });
    }
    
    this.routeAndSend(event, data, msgId);
  }

  public timeout(ms: number) {
    return {
      emit: (event: string, data: unknown, callback: Function) => {
        const msgId = crypto.randomUUID();
        this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(new Error('timeout'), null),
          startedAt: performance.now(),
          timeoutId: setTimeout(() => {
             this.pendingAcks.delete(msgId);
             callback(new Error('timeout'), null);
          }, ms)
        });
        this.routeAndSend(event, data, msgId);
      }
    };
  }
}

/**
 * URL WebTransport yang benar-benar bisa dipakai, atau '' bila tidak ada.
 *
 * Urutan: parameter eksplisit → `VITE_TRANSPORT_URL` → turunan `VITE_API_URL`
 * (hanya bila absolut). `VITE_API_URL` relatif (`/api`, gaya deploy satu domain)
 * TIDAK bisa diturunkan menjadi origin WT — dulu hasilnya diteruskan apa adanya
 * lalu jatuh ke host hardcoded yang tidak menyajikan sidecar.
 */
export function resolveTransportUrl(url: string): string {
  if (url && /^https?:\/\//i.test(url)) return url;
  const configured = String(import.meta.env.VITE_TRANSPORT_URL || '').trim();
  if (configured) return configured;
  const apiUrl = String(import.meta.env.VITE_API_URL || '').trim();
  if (/^https?:\/\//i.test(apiUrl)) return apiUrl.replace(/^http/i, 'https');
  return '';
}

export const transportClient = new NyxWebTransportClient();

export function connectSocket() {
  if (transportClient.connected || transportClient.connecting) return;
  const token = useAuthStore.getState().accessToken || '';
  const certHash = import.meta.env.PROD ? undefined : import.meta.env.VITE_TRANSPORT_CERT_HASH;
  transportClient.connect('', token, certHash);
}

export function disconnectSocket() {
  if (transportClient.connected) {
    transportClient.disconnect();
  }
}

export function emitSessionKeyRequest(conversationId: string, sessionId: string, targetId?: string) {
  const meId = useAuthStore.getState().user?.id;
  transportClient.sendEvent('session:request_key', { 
      conversationId, 
      sessionId, 
      targetId,
      requesterId: meId
  });
}

export function emitSessionKeyFulfillment(payload: { requesterId: string; conversationId: string; sessionId: string; encryptedKey: string; }) {
  transportClient.sendEvent('session:fulfill_response', payload);
}

// [LINT 2026-10-11] Dulu `new Promise(async (resolve, reject) => …)` — executor
// async adalah bug class: throw SEBELUM await pertama tidak pernah sampai ke
// reject() (menjadi unhandled rejection). Diubah ke async function biasa;
// pesan error untuk pemanggil tetap sama.
export async function emitGroupKeyDistribution(conversationId: string, keys: { userId: string; key: string, targetDeviceId?: string, targetDeviceKey?: string, senderDeviceKey?: string, senderSigningKey?: string, senderSigningKeyV2?: string, senderId?: string }[]): Promise<void> {
  if (!transportClient.connected) throw new Error('Socket not connected');
  // [T2 FINAL] Pairwise DR adalah satu-satunya jalur — fallback legacy
  // `messages:distribute_keys` dihapus (prod reset, semua klien ter-update).
  try {
    const { sendGroupKeyDistributionPairwise } = await import('../utils/crypto');
    const { pairwise } = await sendGroupKeyDistributionPairwise(conversationId, keys);
    if (pairwise > 0) console.debug(`[T2] ${pairwise} envelope(s) dikirim via pairwise session`);
  } catch (e) {
    throw e instanceof Error ? e : new Error('Failed to distribute keys');
  }
}

export async function emitGroupKeyRequest(conversationId: string, targetSenderId?: string, targetDeviceKey?: string) {
  const { useAuthStore } = await import('../store/auth');
  const state = useAuthStore.getState();
  const myId = state.user?.id;
  
  const { getEncryptionKeyPair } = state;
  const { publicKey } = await getEncryptionKeyPair();
  const { getSodiumLib, resolvePseudonymToUserId } = await import('../utils/crypto');
  const sodium = await getSodiumLib();
  const myPublicKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

  // [T1] targetSenderId bisa pseudonym (dari wrapper pesan). Routing request
  // butuh AKUN asli (server mem-emit ke user tersebut) → resolve via metadata;
  // kalau bukan pseudonym (grup v1), nilai asli dipakai.
  const targetUserId = targetSenderId
    ? (resolvePseudonymToUserId(conversationId, targetSenderId) ?? targetSenderId)
    : undefined;
  
  transportClient.sendEvent('group:request_key', { 
      conversationId, 
      targetSenderId: targetUserId, 
      targetDeviceKey,
      requesterId: myId,
      requesterDeviceId: myPublicKeyB64,
      requesterPublicKey: myPublicKeyB64
  });
}

// [T2 FIX #11 2026-09-29] senderSigningKey diteruskan — fulfillment offline
// sebelumnya hilang signing key → penerima gagal verifikasi signature pesan
// walau kunci grup ter-unseal (pola libsignal SenderKeyState).
export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; targetDeviceId?: string; targetDeviceKey?: string; senderDeviceKey?: string; senderSigningKey?: string; senderSigningKeyV2?: string; drHeader?: any; senderPseudonym?: string }) {
  transportClient.sendEvent('group:fulfilled_key', payload);
}

// [T2 FIX #10 2026-09-29] senderPseudonym opsional — dipersist server sebagai
// senderId pesan SYSTEM METADATA_UPDATED. Tanpa ini server menyimpan userId
// asli (25-char) di baris pesan SYSTEM — terlihat di audit DB lokal.
export function emitMetadataUpdated(conversationId: string, encryptedMetadata: string, targetRecipients: string[], senderPseudonym?: string): void {
  transportClient.sendEvent('metadata:updated', { conversationId, encryptedMetadata, targetRecipients, senderPseudonym });
}

export const fireGhostSync = (conversationId: string, baseDelay: number = 1000) => {
    const randomDelay = Math.floor(Math.random() * 2500) + baseDelay;
    setTimeout(async () => {
        try {
            const messageStore = (await import('../store/message')).useMessageStore.getState();
            await messageStore.sendMessage(conversationId, {
                content: JSON.stringify({ type: 'GHOST_SYNC', ts: Date.now() }),
                isSilent: true
            });
            console.log(`[Ghost Sync] Fired for group ${conversationId}`);
        } catch (e) {
            console.error('[Ghost Sync] Failed to send', e);
        }
    }, randomDelay);
};

/**
 * [PROFILE KEY DISTRIBUTION 2026-10-05] Trigger silent PROFILE_SYNC dengan
 * dedupe per (conversation) di module groupProfileKeys + jitter acak — pola
 * fireGhostSync. Roster-aware: hanya kirim bila entri SAYA di roster metadata
 * v3 memang belum membawa profileKey (kanal utama) — tanpa roster v3 kirim
 * saja (fallback kanal utama belum tersedia).
 */
export const fireProfileSync = (conversationId: string, baseDelay: number = 1000): void => {
    void (async () => {
        try {
            const { shouldFireProfileSync } = await import('@lib/groupProfileKeys');
            if (!(await shouldFireProfileSync(conversationId))) return;
        } catch { /* roster tak terbaca — lanjut kirim (fail-open) */ }
        const randomDelay = Math.floor(Math.random() * 2500) + baseDelay;
        setTimeout(() => {
            import('@lib/groupProfileKeys').then(({ maybeFireProfileSync }) =>
                maybeFireProfileSync(conversationId)
            ).catch(() => {});
        }, randomDelay);
    })();
};
