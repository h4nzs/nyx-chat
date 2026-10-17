export enum TransportOpCode {
  CHAFF = 0x00,
  CHAT_MESSAGE = 0x01,
  KEY_SYNC = 0x02,
  WEBRTC_SIGNAL = 0x03,
  WEBRTC_ICE = 0x04,
  PRESENCE = 0x05,
  ACK = 0x06,
  KICK = 0x07,
  HANDSHAKE = 0x0A,
  // [docs/29 §5.6] Negosiasi kapabilitas transport (transport-local: sidecar
  // TIDAK meneruskannya ke Redis/Node). Klien lama tidak mengirim ini sama
  // sekali → perilakunya tidak berubah.
  HELLO = 0x0B
}

// ============================================================================
// [docs/29 §5.6] Negosiasi kapabilitas
// ============================================================================
//
// Tanpa ini, setiap fitur baru harus "menebak dari version byte di payload" —
// pola yang sudah terbukti rapuh di jalur sender-key (docs/16: invariant era
// ditambal berulang kali karena routing antar-versi). Klien mengirim daftar
// kapabilitasnya setelah terautentikasi; server membalas irisan yang benar-benar
// dipahami KEDUANYA. Klien/sidecar lama tidak mengirim balas → dianggap legacy
// (daftar kosong), jadi tidak ada klien yang rusak.

export const TRANSPORT_PROTOCOL_VERSION = 1;

export const CLIENT_CAPABILITIES = {
  /** Klien mengerti HELLO/ACK kapabilitas (diri sendiri). */
  HELLO_V1: 'hello-v1',
  /** Kesiapan key-transparency lite (docs/29 §5.1 tahap A). */
  KT_LITE: 'kt-lite',
  /** Kesiapan PQ ratchet SPQR-style (jalur versi paralel). */
  SPQR_RATCHET: 'spqr-ratchet',
  // Catatan: TIDAK ADA kapabilitas multi-device. NYX memilih satu perangkat
  // aktif per akun sebagai properti keamanan (docs/30 §30.6/§30.18), jadi
  // kapabilitas untuk fitur itu sengaja tidak pernah dideklarasikan —
  // mengiklankan kapabilitas yang tidak akan ada hanya menyesatkan.
} as const;

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/**
 * Kapabilitas yang dipahami **relay deployment ini**, dipakai oleh DUA relay:
 *
 *  - sidecar WebTransport (`server/transport-sidecar`, balasan HELLO bidi), dan
 *  - gateway WSS Node (`server/src/realtime/gateway.ts`, balasan event
 *    `capabilities` setelah `handshake.auth.capabilities`).
 *
 * Keduanya harus mengiklankan daftar yang SAMA: klien memilih versi ratchet dari
 * hasil negosiasi, jadi dua relay yang berbeda pendapat berarti perilaku pesan
 * berubah hanya karena transport-nya jatuh ke WSS (`docs/33` §33.7).
 *
 * `spqr-ratchet` masuk di sini sebagai **saklar deployment**: relay yang
 * mengiklankannya berarti "deployment ini melewatkan frame jalur v2 tanpa
 * mengubahnya" (kedua relay meneruskan payload E2EE apa adanya — di WSS,
 * `content` disimpan sebagai string opaque). Ia bukan janji tentang peer (relay
 * tidak tahu versi peer mana pun) — bukti kemampuan peer tetap datang in-band
 * (`ackV` di payload ter-seal, `docs/04`). Menghapusnya dari daftar ini = kill
 * switch setingkat deployment: semua klien kembali ke jalur v1 walau kliennya
 * baru.
 */
export const SERVER_CAPABILITIES: readonly string[] = [
  CLIENT_CAPABILITIES.HELLO_V1,
  CLIENT_CAPABILITIES.SPQR_RATCHET,
];

export interface TransportHello {
  /** Versi protokol transport yang dipakai pengirim. */
  v: number;
  /** Kapabilitas yang didukung pengirim (string pendek, tak dikenal = diabaikan). */
  caps: string[];
}

/** Batas parse — payload HELLO tidak boleh jadi vektor DoS/memory. */
export const HELLO_MAX_CAPS = 32;
export const HELLO_MAX_CAP_LENGTH = 64;
export const HELLO_MAX_VERSION = 65535;

/** Payload HELLO/ACK: UTF-8 JSON `{"v":1,"caps":[...]}`. */
export function encodeTransportHello(hello: TransportHello): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: hello.v, caps: hello.caps }));
}

/**
 * Validasi daftar kapabilitas yang datang dari JARINGAN — dipakai jalur WT
 * (payload HELLO `{v,caps}`) **dan** jalur WSS (`handshake.auth.capabilities`
 * di socket.io). Payload ini datang dari klien mana pun, jadi batas anti-DoS-nya
 * bagian dari kontrak, bukan detail implementasi.
 *
 * Mengembalikan `null` bila bentuknya tidak sah (bukan array, ada elemen bukan
 * string, panjang elemen di luar batas, terlalu banyak elemen) — pemanggil
 * memperlakukannya sebagai **legacy** (daftar kosong), bukan error fatal: klien
 * lama tidak pernah mengirim field ini. Duplikat dibuang, urutan dipertahankan.
 */
export function sanitizeCapabilityList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > HELLO_MAX_CAPS) return null;

  const clean: string[] = [];
  for (const cap of raw) {
    if (typeof cap !== 'string') return null;
    if (cap.length === 0 || cap.length > HELLO_MAX_CAP_LENGTH) return null;
    if (!clean.includes(cap)) clean.push(cap);
  }
  return clean;
}

/**
 * Parse HELLO/ACK. Mengembalikan `null` untuk bentuk yang tidak sah (bukan
 * object, versi bukan bilangan positif, caps bukan string pendek) — pemanggil
 * memperlakukannya sebagai legacy, bukan error fatal.
 */
export function parseTransportHello(raw: Uint8Array | string): TransportHello | null {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      text = new TextDecoder().decode(raw);
    } catch {
      return null;
    }
  }
  if (text.length === 0 || text.length > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const { v, caps } = parsed as { v?: unknown; caps?: unknown };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > HELLO_MAX_VERSION) return null;
  const clean = sanitizeCapabilityList(caps);
  if (clean === null) return null;

  return { v, caps: clean };
}

/**
 * Irisan kapabilitas klien↔server, urut sesuai daftar klien (deterministik).
 * Kapabilitas tak dikenal tidak pernah masuk hasil — jadi klien versi baru yang
 * mengirm kapabilitas eksperimental tidak membuat klien itu dianggap berbeda.
 */
export function negotiateCapabilities(client: readonly string[], server: readonly string[]): string[] {
  const offered = new Set(server);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cap of client) {
    if (!offered.has(cap)) continue;
    if (seen.has(cap)) continue;
    seen.add(cap);
    result.push(cap);
  }
  return result;
}

/** Apakah daftar kapabilitas (hasil negosiasi) memuat `cap`? */
export function supportsCapability(capabilities: readonly string[] | undefined, cap: string): boolean {
  return !!capabilities && capabilities.includes(cap);
}

export type BinaryPayload = Uint8Array;

export interface WebRtcSignalPayload {
  to: string;
  type: 'request' | 'accept' | 'reject' | 'end' | 'offer' | 'answer' | 'ice-candidate';
  payload: BinaryPayload; 
}

export type TransportWorkerToMain = 
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED'; reason: string }
  | { type: 'ERROR'; error: string }
  | { type: 'DATA_RECEIVED'; opCode: TransportOpCode; payload: BinaryPayload }
  | { type: 'HANDSHAKE_COMPLETED'; success: boolean; error?: string };

export type MainToTransportWorker =
  | { type: 'CONNECT'; url: string; token: string; certificateHash?: string; deviceIdentity?: string }
  | { type: 'DISCONNECT' }
  | { type: 'SEND_STREAM'; opCode: TransportOpCode; payload: BinaryPayload }
  | { type: 'SEND_DATAGRAM'; opCode: TransportOpCode; payload: BinaryPayload }
  | { type: 'START_HANDSHAKE'; payload: BinaryPayload }
  // [docs/29 §5.6] HELLO kapabilitas WAJIB lewat stream BIDI (server membalas
  // irisan kapabilitas di stream yang sama). `SEND_STREAM` membuat stream UNI
  // yang tidak bisa dibalas server — dan di jalur itu sidecar akan
  // meneruskannya ke `nyx:upstream:11` (melanggar "transport-local").
  | { type: 'CAPABILITY_HELLO'; payload: BinaryPayload };
