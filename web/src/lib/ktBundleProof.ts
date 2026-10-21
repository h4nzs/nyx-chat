// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.6 poin 1] Verifikasi prekey bundle terhadap **log Key Transparency**.
 *
 * Sampai sekarang NYX hanya *menulis* log KT dan punya verifier
 * (`web/src/lib/keyTransparency.ts`) yang belum pernah dipanggil jalur produksi.
 * Akibatnya server masih bisa menyajikan bundle kunci palsu yang konsisten dengan
 * dirinya sendiri (TOFU): `peerIdentityTrust` hanya membandingkan kunci baru
 * dengan pin sebelumnya, dan pada kontak pertama ia menerima apa pun.
 *
 * Modul ini menutup celah itu: sebelum sebuah `identityKey` dipin, bukti log
 * untuk `0x75 || usernameHash(32)` peer diambil lewat `/api/keys/kt/*`,
 * **diverifikasi di klien** (WASM `libsignal-keytrans`), lalu kunci di dalam
 * nilai log dibandingkan dengan kunci yang disajikan bundle.
 *
 * Hasilnya sebuah *verdict* (tidak melempar):
 *
 * | status | arti | tindakan pemanggil |
 * |---|---|---|
 * | `confirmed` | bukti sah **dan** kunci log = kunci bundle | pin seperti biasa, tandai terverifikasi |
 * | `mismatch` | bukti sah, **tetapi** kunci log ≠ kunci bundle | JANGAN pin kunci bundle; blokir kirim + minta user memverifikasi safety number |
 * | `unverifiable` | bukti/bukti-konsistensi ditolak verifier | tidak memblokir; catat (bisa berarti anchor basi ATAU server berbohong) |
 * | `unavailable` | KT nonaktif / jaringan / subjek tak ada di log | TOFU seperti sebelumnya, catat |
 * | `unknown-subject` | username peer belum diketahui → search key tak bisa diturunkan | TOFU, tanpa panggilan jaringan |
 *
 * Kenapa bukan `crypto.worker.ts`: verifikasi berjalan di thread utama lewat
 * impor dinamis (`keyTransparency.ts` + `keytrans.wasm` 295 KiB), jadi bundle
 * di aplikasi yang **tidak** mengaktifkan KT tidak menanggung biaya muatnya
 * sama sekali. Verifikasi hanya terjadi saat bundle peer pertama dibaca
 * (dan di-cache), bukan per pesan — anggarannya milidetik dibanding CPU
 * pembangkitan kunci.
 *
 * Batas yang jujur (lihat `docs/34`):
 *   1. Search key membutuhkan **username peer** (Argon2id klien). Kalau username
 *      belum diketahui, verifikasi mustahil — dicatat sebagai `unknown-subject`,
 *      bukan diam-diam dianggap sah.
 *   2. `mismatch` hanya bisa dikatakan bila bukti terverifikasi: tanpa anchor
 *      tersimpan, perubahan di dalam `search`/tree head tidak terdeteksi — karena
 *      itu tree size + monitoring data disimpan (`ktMonitoring`) dan dikirim
 *      sebagai `last` pada verifikasi berikutnya.
 *   3. Anchor distinguished diambil sekali saat verifikasi pertama; kalau gagal,
 *      verifikasi search tetap sah (konsistensi saja yang belum bisa dibuktikan).
 */

import { api } from './api';
import {
  hexToBytes,
  ktSearchKeyHex,
  loadKtStates,
  runKtMonitorOnce,
  saveKtState,
  type KtMonitorOutcome,
  type KtStateUpdate,
  type KtStoredState,
} from './ktMonitoring';
import { getLocalAnchor, storeAnchor, type KtHeadAnchor } from './ktGossip';
import {
  ktConfigPinMatches,
  loadKtConfigPin,
  parseKtConfigPin,
  saveKtConfigPin,
  type KtConfigAbi,
  type KtConfigPin,
} from './ktConfigPin';
import { parseKtValueBytes } from '@nyx/shared';
import {
  KT_MODE_CONTACT_MONITORING,
  KtVerificationError,
  type KeyTransparencyVerifier as KeyTransparencyVerifierV1,
  type KtConfig as KtConfigV1,
  type KtVerifySearchResult,
} from './keyTransparency';
import {
  type KeyTransparencyVerifier as KeyTransparencyVerifierV2,
  type KtConfig as KtConfigV2,
} from './keyTransparencyV2';

/** Prefix tipe search key di log KT (`shared.UsernameHashPrefix`, docs/32). */
export const KT_SEARCH_PREFIX = 0x75;
/** Versi format nilai log NYX yang dipahami modul ini. */
export const KT_VALUE_VERSION = 1;
/** Panjang nilai log v1: 1+1+32+1216+32+4. */
export const KT_VALUE_BYTES = 1286;
/** Jeda minimum antar percobaan saat KT tidak tersedia (ms). */
export const KT_UNAVAILABLE_BACKOFF_MS = 5 * 60 * 1000;
/** Umur maksimum konfirmasi KT yang dianggap masih segar (ms). */
export const KT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export type KtVerdictStatus =
  | 'confirmed'
  | 'mismatch'
  | 'unverifiable'
  | 'unavailable'
  | 'unknown-subject';

export interface KtVerdict {
  status: KtVerdictStatus;
  /** Alasan ringkas (hanya untuk log/diagnostik, bukan untuk UI). */
  reason?: string;
  /** `keyVersion` dari nilai log yang terverifikasi. */
  keyVersion?: number;
  /** `identityKey` di log (hex) saat status `mismatch`. */
  logIdentityKey?: string;
  /** `pqIdentityKey` di log (hex) saat mismatch kunci PQ. */
  logPqIdentityKey?: string;
  /** `signingKeyV2` (ML-DSA-65) di log (hex) saat mismatch kunci tanda tangan PQ. */
  logSigningKeyV2?: string;
}

export interface KtRemoteConfig {
  mode: number;
  signatureKey: string;
  /** Hanya ABI 1 (Ed25519 + EC-VRF). Log v2 memakai ML-DSA-65 tanpa VRF. */
  vrfKey?: string;
  auditorKeys?: string[];
  valueFormat?: string;
  /** ABI frame verifier; tidak ada = 1 (server lama). */
  abiVersion?: number;
}

/** Verifier v1 dan v2 punya permukaan identik; ABI dipilih dari config. */
type KtVerifier = KeyTransparencyVerifierV1 | KeyTransparencyVerifierV2;

type ResolvedKtConfig =
  | { abi: 1; config: KtConfigV1; pin: KtConfigPin; pinChanged: boolean }
  | { abi: 2; config: KtConfigV2; pin: KtConfigPin; pinChanged: boolean };

export interface KtProof {
  fullTreeHead: Uint8Array;
  condensed: Uint8Array;
}

export interface KtProofQuery {
  searchKey: Uint8Array;
  /** Ukuran pohon yang sudah dipercaya klien (menyalakan bukti konsistensi). */
  last?: number;
  distinguished?: number;
}

export interface KtBundleCheckInput {
  userId: string;
  /** Username peer (login name). `undefined`/kosong → `unknown-subject`. */
  username?: string | null;
  /** `identityKey` dari prekey bundle (base64url). */
  identityKey: string;
  /**
   * `pqIdentityKey` (X-Wing) dari prekey bundle (base64url). Nilai log v1/v2
   * sudah memuatnya sejak awal — membandingkannya menutup celah lama di mana
   * hanya `identityKey` X25519 yang dicek.
   */
  pqIdentityKey?: string | null;
  /**
   * `signingKeyV2` (ML-DSA-65) dari prekey bundle (base64url). Hanya ada pada
   * nilai log v2; membandingkannya mengikat kunci tanda tangan PQ ke log.
   */
  signingKeyV2?: string | null;
  now?: Date | number;
}

export interface KtBundleDeps {
  hashUsername?: (username: string) => Promise<string>;
  fetchConfig?: () => Promise<KtRemoteConfig>;
  /** Tree head ringkas untuk gossip (`GET /api/keys/kt/head`). */
  fetchHead?: () => Promise<KtHeadAnchor>;
  /** Bukti search untuk satu search key (`GET /api/keys/kt/search`). */
  fetchProof?: (query: KtProofQuery) => Promise<KtProof>;
  /** Bukti anchor distinguished (`GET /api/keys/kt/distinguished`). */
  fetchAnchor?: (query: { last?: number; distinguished?: number }) => Promise<KtProof>;
  verifier?: KtVerifier;
  loadStates?: () => Promise<KtStoredState[]>;
  saveState?: (update: KtStateUpdate) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface ParsedKtValue {
  version: number;
  keyVersion: number;
  identityKey: Uint8Array;
  pqIdentityKey: Uint8Array;
  signingKey: Uint8Array;
  signingKeyV2?: Uint8Array;
  updatedAtDay: number;
}

// ---------------------------------------------------------------------------
// Kodek
// ---------------------------------------------------------------------------

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Search key log dari usernameHash base64url 32 byte: `0x75 || hash`.
 * Bentuk yang ditolak dilempar (bukan diam-diam dipotong) — search key salah
 * akan terlihat sebagai "subjek tak ada di log", yang menyesatkan.
 */
export function ktSearchKeyFromUsernameHash(usernameHashB64Url: string): Uint8Array {
  if (!BASE64URL_32.test(usernameHashB64Url)) {
    throw new Error('kt: usernameHash harus base64url dari 32 byte');
  }
  const hash = base64UrlToBytes(usernameHashB64Url);
  const searchKey = new Uint8Array(1 + hash.length);
  searchKey[0] = KT_SEARCH_PREFIX;
  searchKey.set(hash, 1);
  return searchKey;
}

/**
 * Urai nilai log NYX (`docs/32`): versi 1 (1286 B) atau versi 2 (3238 B, + `signingKeyV2`).
 * Delegasi ke kodek bersama agar web/server memakai tata letak yang sama.
 */
export function parseKtValue(value: Uint8Array): ParsedKtValue {
  return parseKtValueBytes(value);
}

/**
 * `FullTreeHead.tree_head.tree_size` dari byte `FullTreeHead` (protobuf).
 * Angka ini yang harus dikirim sebagai `last` pada permintaan berikutnya supaya
 * server menyertakan bukti konsistensi (tanpa itu verifikasi ber-anchor gagal
 * `Malformed proof` — temuan `docs/34` §34.5a).
 */
export function treeSizeFromFullTreeHead(fullTreeHead: Uint8Array): number {
  let index = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    while (index < fullTreeHead.length) {
      const byte = fullTreeHead[index++]!;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    throw new Error('kt: varint terpotong pada FullTreeHead');
  };

  while (index < fullTreeHead.length) {
    const key = varint();
    const wire = key & 0x07;
    if (wire === 2) {
      const length = varint();
      if (key >> 3 === 1) {
        const sub = fullTreeHead.subarray(index, index + length);
        if ((sub[0]! >> 3) !== 1 || (sub[0]! & 0x07) !== 0) {
          throw new Error('kt: tree head tidak diawali tree_size');
        }
        let subIndex = 1;
        let size = 0;
        let shift = 0;
        while (subIndex < sub.length) {
          const byte = sub[subIndex++]!;
          size |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) return size >>> 0;
          shift += 7;
        }
        throw new Error('kt: tree_size terpotong');
      }
      index += length;
    } else if (wire === 0) {
      varint();
    } else if (wire === 5) {
      index += 4;
    } else if (wire === 1) {
      index += 8;
    } else {
      throw new Error(`kt: wire-type ${wire} tidak didukung`);
    }
  }
  throw new Error('kt: FullTreeHead tanpa tree_head');
}

// ---------------------------------------------------------------------------
// Loader lazy (modul WASM + config)
// ---------------------------------------------------------------------------

let verifierPromises: Partial<Record<KtConfigAbi, Promise<KtVerifier>>> = {};
let cachedConfig: ResolvedKtConfig | null = null;
let lastUnavailableAt = 0;

/** Hook test: buang cache config & instance WASM. */
export function resetKtBundleProofCaches(): void {
  verifierPromises = {};
  cachedConfig = null;
  lastUnavailableAt = 0;
}

/**
 * Muat verifier sesuai ABI config, sekali per ABI per sesi. Modul WASM diambil
 * lewat URL aset Vite (`?url`) sehingga hanya diunduh saat KT benar-benar dipakai.
 *
 * ABI 1 (v1) dan ABI 2 (v2) memakai file WASM berbeda; frame v1 ditolak modul v2
 * dan sebaliknya, jadi modul tidak boleh dipilih dari tebakan.
 */
async function loadKtVerifier(abi: KtConfigAbi): Promise<KtVerifier> {
  const existing = verifierPromises[abi];
  if (existing) {
    try {
      return await existing;
    } catch (error) {
      delete verifierPromises[abi];
      throw error;
    }
  }

  const promise = (async (): Promise<KtVerifier> => {
    if (abi === 2) {
      const [{ instantiateKeyTransparencyVerifier: instantiate }, wasmModule] = await Promise.all([
        import('./keyTransparencyV2'),
        import('../../../packages/keytrans-wasm-v2/dist/keytrans-v2.wasm?url'),
      ]);
      const url = (wasmModule as { default: string }).default;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`kt: gagal mengunduh modul verifier v2 (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return instantiate(bytes as Uint8Array<ArrayBuffer>);
    }

    const [{ instantiateKeyTransparencyVerifier: instantiate }, wasmModule] = await Promise.all([
      import('./keyTransparency'),
      import('../../../packages/keytrans-wasm/dist/keytrans.wasm?url'),
    ]);
    const url = (wasmModule as { default: string }).default;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`kt: gagal mengunduh modul verifier (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return instantiate(bytes as Uint8Array<ArrayBuffer>);
  })();

  verifierPromises[abi] = promise;
  try {
    return await promise;
  } catch (error) {
    delete verifierPromises[abi];
    throw error;
  }
}

const hexToBytesLocal = (value: string): Uint8Array => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error('kt: kunci publik log bukan hex');
  }
  return hexToBytes(value.toLowerCase());
};

async function defaultFetchConfig(): Promise<KtRemoteConfig> {
  return await api<KtRemoteConfig>('/api/keys/kt/config');
}

async function defaultFetchProof(query: KtProofQuery): Promise<KtProof> {
  const params = new URLSearchParams({ hash: bytesToBase64Url(query.searchKey.subarray(1)) });
  if (query.last !== undefined) params.set('last', String(query.last));
  if (query.distinguished !== undefined) params.set('distinguished', String(query.distinguished));
  const response = await api<{ fullTreeHead: string; condensed: string }>(
    `/api/keys/kt/search?${params.toString()}`
  );
  return {
    fullTreeHead: base64UrlToBytes(response.fullTreeHead),
    condensed: base64UrlToBytes(response.condensed),
  };
}

/**
 * Tree head ringkas dari `/api/keys/kt/head` — **bukan** bukti.
 *
 * Root pohon tidak bisa diambil dari byte `FullTreeHead` (root dihitung verifier
 * saat memverifikasi bukti, `docs/34` §34.2), jadi untuk *membandingkan* head
 * antar-klien NYX memakai endpoint JSON kecil ini. Angka ini tidak menambah
 * kepercayaan apa pun: kalu angka ini berbeda dari bukti yang diverifikasi,
 * verifikasi bukti yang gagal — gossip hanya membandingkan angka antar-klien.
 */
async function defaultFetchHead(): Promise<KtHeadAnchor> {
  const head = await api<{ treeSize: number; timestamp: number; root: string }>('/api/keys/kt/head');
  const anchor = parseHeadAnchorArg(head);
  if (!anchor) throw new Error('kt: head layanan tidak sah');
  return anchor;
}

function parseHeadAnchorArg(value: unknown): KtHeadAnchor | undefined {
  const head = value as { treeSize?: unknown; root?: unknown } | null;
  if (!head || typeof head.treeSize !== 'number' || typeof head.root !== 'string') return undefined;
  return /^[0-9a-f]{64}$/.test(head.root) && Number.isInteger(head.treeSize) && head.treeSize > 0
    ? { root: head.root, treeSize: head.treeSize }
    : undefined;
}

/**
 * Segarkan jangkar lokal dari layanan KT lalu persist. Best-effort: dipanggil
 * setelah verifikasi/monitor berhasil, dan kegagalannya tidak pernah mengubah
 * verdict apa pun (gossip kehilangan jangkar sampai percobaan berikutnya).
 */
export async function refreshKtAnchor(
  fetchHead: () => Promise<KtHeadAnchor> = defaultFetchHead
): Promise<KtHeadAnchor | null> {
  try {
    const head = await fetchHead();
    const anchor = parseHeadAnchorArg(head);
    if (!anchor) return null;
    await storeAnchor(anchor);
    return anchor;
  } catch (error) {
    defaultLog('kt.head-unavailable', { reason: (error as Error).message });
    return null;
  }
}

async function defaultFetchAnchor(query: { last?: number; distinguished?: number }): Promise<KtProof> {
  const params = new URLSearchParams();
  if (query.last !== undefined) params.set('last', String(query.last));
  if (query.distinguished !== undefined) params.set('distinguished', String(query.distinguished));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await api<{ fullTreeHead: string; condensed: string }>(
    `/api/keys/kt/distinguished${suffix}`
  );
  return {
    fullTreeHead: base64UrlToBytes(response.fullTreeHead),
    condensed: base64UrlToBytes(response.condensed),
  };
}

/**
 * Konfigurasi log yang dilayani berbeda dari pin TOFU pertama. Ini kondisi
 * fail-closed: verifier tidak boleh mempercayai kunci yang tiba-tiba berubah,
 * jadi verdict-nya `unverifiable` (lihat cabang `KtVerificationError`).
 */
class KtConfigPinMismatchError extends KtVerificationError {}

/** ABI tak dikenal tidak boleh jatuh ke verifier v1 secara diam-diam. */
function remoteAbi(remote: KtRemoteConfig): KtConfigAbi {
  if (remote.abiVersion === undefined) return 1;
  if (remote.abiVersion === 1 || remote.abiVersion === 2) return remote.abiVersion;
  throw new Error(`kt: ABI log tidak dikenal (${String(remote.abiVersion)})`);
}

async function resolveConfig(
  fetchConfig: () => Promise<KtRemoteConfig>
): Promise<ResolvedKtConfig> {
  if (cachedConfig) return cachedConfig;
  const remote = await fetchConfig();
  if (
    typeof remote.mode !== 'number' ||
    !Number.isInteger(remote.mode) ||
    !remote.signatureKey
  ) {
    throw new Error('kt: config log tidak lengkap');
  }

  const abi = remoteAbi(remote);
  if (abi === 1 && !remote.vrfKey) throw new Error('kt: config log ABI 1 tanpa vrfKey');
  if (abi === 2 && remote.valueFormat !== 'nyx-kt-value-v2') {
    throw new Error('kt: format nilai log tidak cocok dengan ABI 2');
  }

  const observed = parseKtConfigPin({
    abiVersion: abi,
    mode: remote.mode,
    signatureKey: remote.signatureKey,
    vrfKey: remote.vrfKey,
    auditorKeys: remote.auditorKeys ?? [],
  });
  if (!observed) throw new Error('kt: config log tidak valid');

  const pin = await loadKtConfigPin();
  let pinChanged = false;
  if (!pin || !ktConfigPinMatches(pin, observed)) {
    if (pin) {
      // [docs/35 §35.7 Fase 7] Satu-satunya transisi yang diizinkan: pin ABI 1
      // → config ABI 2 dengan mode sama. Pin baru ditulis setelah bukti v2
      // terbukti sah (`commitKtConfigPin`), jadi config palsu tidak bisa
      // "membajak" pin sebelum ada bukti yang lolos verifikasi. Arah v2 → v1
      // (downgrade) dan perubahan kunci dalam ABI yang sama selalu ditolak.
      const upgrading =
        pin.abiVersion === 1 && observed.abiVersion === 2 && pin.mode === observed.mode;
      if (!upgrading) {
        throw new KtConfigPinMismatchError(
          'kt: konfigurasi log berubah dari pin (kemungkinan server menukar kunci verifikasi)'
        );
      }
    }
    pinChanged = true;
  }

  const signatureKey = hexToBytesLocal(observed.signatureKey);
  const auditorKeys = observed.auditorKeys.map(hexToBytesLocal);
  cachedConfig =
    abi === 1
      ? {
          abi: 1,
          config: {
            // Mode divalidasi sebagai integer di atas; tipe `KtMode` adalah
            // union nilai yang dikenal verifier.
            mode: observed.mode as KtConfigV1['mode'],
            signatureKey,
            vrfKey: hexToBytesLocal(observed.vrfKey!),
            auditorKeys,
          },
          pin: observed,
          pinChanged,
        }
      : {
          abi: 2,
          config: {
            mode: observed.mode as KtConfigV2['mode'],
            signatureKey,
            auditorKeys,
          },
          pin: observed,
          pinChanged,
        };
  return cachedConfig;
}

/** Tulis pin (TOFU/upgrade) hanya setelah verifier menerima bukti. */
async function commitKtConfigPin(resolved: ResolvedKtConfig): Promise<void> {
  if (!resolved.pinChanged) return;
  resolved.pinChanged = false;
  await saveKtConfigPin(resolved.pin);
}

interface SearchVerificationInput {
  searchKey: Uint8Array;
  condensedResponse: Uint8Array;
  fullTreeHead: Uint8Array;
  context?: {
    lastTreeHead?: Uint8Array;
    lastDistinguishedTreeHead?: Uint8Array;
    monitoringData?: Uint8Array;
  };
  now?: number;
}

/** Panggil `verifySearch` pada verifier yang ABI-nya cocok dengan config. */
function verifySearchWith(
  resolved: ResolvedKtConfig,
  verifier: KtVerifier,
  input: SearchVerificationInput
): KtVerifySearchResult {
  if (resolved.abi === 1) {
    return (verifier as KeyTransparencyVerifierV1).verifySearch({
      ...input,
      config: resolved.config,
    });
  }
  return (verifier as KeyTransparencyVerifierV2).verifySearch({
    ...input,
    config: resolved.config,
  });
}

const defaultLog = (event: string, detail: Record<string, unknown>) => {
  try {
    console.warn(`[KT] ${event}`, detail);
  } catch {
    // Log tidak boleh membuat jalur kunci gagal.
  }
};

// ---------------------------------------------------------------------------
// Pemeriksaan
// ---------------------------------------------------------------------------

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
};

/**
 * Verifikasi `identityKey` bundle peer terhadap log Key Transparency.
 *
 * Tidak pernah melempar: setiap kegagalan (KT nonaktif, subjek tak ada di log,
 * bukti ditolak) dikembalikan sebagai verdict + dicatat. Pemanggil yang memutuskan
 * apakah status itu memblokir pengiriman — `mismatch` HARUS memblokir.
 */
export async function checkBundleAgainstKeyTransparency(
  input: KtBundleCheckInput,
  deps: KtBundleDeps = {}
): Promise<KtVerdict> {
  const log = deps.log ?? defaultLog;
  const username = input.username?.trim();
  if (!username) return { status: 'unknown-subject', reason: 'username peer belum diketahui' };

  const now = input.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : input.now.getTime();
  // Backoff: jangan hammer layanan KT yang sedang mati (registrasi/login tetap jalan).
  if (now - lastUnavailableAt < KT_UNAVAILABLE_BACKOFF_MS) {
    return { status: 'unavailable', reason: 'backoff setelah kegagalan sebelumnya' };
  }

  try {
    const hashUsername =
      deps.hashUsername ?? (await import('./crypto-worker-proxy')).hashUsername;
    const usernameHash = await hashUsername(username.toLowerCase());
    const searchKey = ktSearchKeyFromUsernameHash(usernameHash);

    const loadStates = deps.loadStates ?? loadKtStates;
    const states = await loadStates();
    const wanted = ktSearchKeyHex(searchKey);
    const state = states.find((candidate) => ktSearchKeyHex(candidate.searchKey) === wanted);

    const fetchConfig = deps.fetchConfig ?? defaultFetchConfig;
    const fetchProof = deps.fetchProof ?? defaultFetchProof;
    const fetchAnchor = deps.fetchAnchor ?? defaultFetchAnchor;
    const saveState = deps.saveState ?? saveKtState;
    // Config dulu: ABI-nya menentukan modul WASM yang harus dimuat.
    const resolved = await resolveConfig(fetchConfig);
    const verifier = deps.verifier ?? (await loadKtVerifier(resolved.abi));

    const proof = await fetchProof({ searchKey, last: state?.treeSize });
    const result = verifySearchWith(resolved, verifier, {
      searchKey,
      condensedResponse: proof.condensed,
      fullTreeHead: proof.fullTreeHead,
      context: state
        ? {
            lastTreeHead: state.treeHead,
            lastDistinguishedTreeHead: state.distinguishedTreeHead,
            monitoringData: state.monitoringData,
          }
        : undefined,
      now,
    });

    // Bukti diterima → pin config boleh ditulis (termasuk upgrade v1 → v2).
    await commitKtConfigPin(resolved);

    const parsed = parseKtValue(result.value);
    const treeSize = treeSizeFromFullTreeHead(proof.fullTreeHead);

    // Anchor distinguished: hanya dibutuhkan untuk membuktikan konsistensi
    // (deteksi split-view). Kegagalannya tidak membatalkan bukti search.
    let anchor = state?.distinguishedTreeHead;
    if (!anchor) {
      try {
        const anchorProof = await fetchAnchor({});
        anchor = verifySearchWith(resolved, verifier, {
          searchKey: new TextEncoder().encode('distinguished'),
          condensedResponse: anchorProof.condensed,
          fullTreeHead: anchorProof.fullTreeHead,
          now,
        }).treeHead;
      } catch (error) {
        log('kt.anchor-unavailable', { reason: (error as Error).message });
      }
    }

    // State hanya ditulis setelah verifikasi berhasil (fail-closed).
    await saveState({
      searchKey,
      treeHead: result.treeHead,
      monitoringData: result.monitoringData,
      distinguishedTreeHead: anchor,
      keyVersion: parsed.keyVersion,
      treeSize,
    });

    // [docs/30 §30.5 tahap C] Jangkar gossip: kontak pertama adalah saat paling
    // mungkin jangkar belum ada (loop monitor baru menyala setelah 30 s), jadi
    // sekali per percakapan bukti terverifikasi ini sekaligus dipakai untuk
    // mengambil head ringkas. Kegagalannya tidak mengubah verdict di bawah.
    if (!getLocalAnchor()) await refreshKtAnchor(deps.fetchHead);

    let served: Uint8Array;
    try {
      served = base64UrlToBytes(input.identityKey);
    } catch {
      return { status: 'unavailable', reason: 'identityKey bundle bukan base64url' };
    }

    if (!bytesEqual(parsed.identityKey, served)) {
      log('kt.key-mismatch', {
        userId: input.userId,
        logIdentityKey: bytesToHex(parsed.identityKey),
        keyVersion: parsed.keyVersion,
      });
      return {
        status: 'mismatch',
        keyVersion: parsed.keyVersion,
        logIdentityKey: bytesToHex(parsed.identityKey),
      };
    }

    if (input.pqIdentityKey) {
      let servedPq: Uint8Array;
      try {
        servedPq = base64UrlToBytes(input.pqIdentityKey);
      } catch {
        return { status: 'unavailable', reason: 'pqIdentityKey bundle bukan base64url' };
      }
      if (!bytesEqual(parsed.pqIdentityKey, servedPq)) {
        log('kt.pq-key-mismatch', {
          userId: input.userId,
          logPqIdentityKey: bytesToHex(parsed.pqIdentityKey),
          keyVersion: parsed.keyVersion,
        });
        return {
          status: 'mismatch',
          keyVersion: parsed.keyVersion,
          logIdentityKey: bytesToHex(parsed.identityKey),
          logPqIdentityKey: bytesToHex(parsed.pqIdentityKey),
        };
      }
    }

    if (input.signingKeyV2 && parsed.signingKeyV2) {
      let servedV2: Uint8Array;
      try {
        servedV2 = base64UrlToBytes(input.signingKeyV2);
      } catch {
        return { status: 'unavailable', reason: 'signingKeyV2 bundle bukan base64url' };
      }
      if (!bytesEqual(parsed.signingKeyV2, servedV2)) {
        log('kt.signing-key-v2-mismatch', {
          userId: input.userId,
          logSigningKeyV2: bytesToHex(parsed.signingKeyV2),
          keyVersion: parsed.keyVersion,
        });
        return {
          status: 'mismatch',
          keyVersion: parsed.keyVersion,
          logIdentityKey: bytesToHex(parsed.identityKey),
          logSigningKeyV2: bytesToHex(parsed.signingKeyV2),
        };
      }
    }

    return { status: 'confirmed', keyVersion: parsed.keyVersion };
  } catch (error) {
    // `KtVerificationError` v1/v2 adalah dua kelas berbeda (modul dimuat dinamis);
    // nama kelas adalah kontrak yang sama, jadi jangan bergantung pada satu
    // identitas kelas saja — kalau tidak, penolakan bukti v2 salah dihitung
    // sebagai `unavailable` + backoff.
    if (
      error instanceof KtVerificationError ||
      (error instanceof Error && error.name === 'KtVerificationError')
    ) {
      // Bukti DITOLAK verifier: bisa anchor basi, bisa server berbohong.
      log('kt.proof-rejected', { userId: input.userId, reason: error.message });
      return { status: 'unverifiable', reason: error.message };
    }
    lastUnavailableAt = now;
    const reason = error instanceof Error ? error.message : String(error);
    log('kt.unavailable', { userId: input.userId, reason });
    return { status: 'unavailable', reason };
  }
}

// ---------------------------------------------------------------------------
// Loop monitor (docs/34 §34.5: tanpa ini, KT tidak mendeteksi apa pun)
// ---------------------------------------------------------------------------

async function defaultFetchMonitor(request: Uint8Array): Promise<Uint8Array> {
  const response = await api<{ monitorResponse: string }>('/api/keys/kt/monitor', {
    method: 'POST',
    body: JSON.stringify({ monitorRequest: bytesToBase64Url(request) }),
  });
  return base64UrlToBytes(response.monitorResponse);
}

export interface KtMonitorDeps {
  verifier?: KtVerifier;
  fetchConfig?: () => Promise<KtRemoteConfig>;
  fetchMonitor?: (request: Uint8Array) => Promise<Uint8Array>;
  /** Tree head ringkas untuk gossip (`GET /api/keys/kt/head`). */
  fetchHead?: () => Promise<KtHeadAnchor>;
  states?: KtStoredState[];
  now?: Date | number;
}

/**
 * Satu langkah monitor lengkap: state tersimpan → permintaan → bukti dari
 * `/api/keys/kt/monitor` → verifikasi di klien → state baru disimpan.
 *
 * Ini jembatan antara penjadwal (`ktMonitoring.startKtMonitorLoop`) dan verifier
 * WASM: tanpa panggilan ini, op `monitor_build`/`verify_monitor` tidak pernah
 * berjalan di produksi dan klien tidak punya bukti konsistensi — yaitu kondisi
 * yang membuat perubahan kunci **tak terdeteksi** (`docs/34` §34.5).
 *
 * Tidak ada langkah monitornya yang mengubah kunci yang dipercaya: hasilnya
 * adalah state baru + daftar `keyVersion` yang naik (pemanggil yang memutuskan
 * cara menampilkannya). Kesalahan diteruskan ke pemanggil (penjadwal menangkap).
 */
export async function monitorKeyTransparency(deps: KtMonitorDeps = {}): Promise<KtMonitorOutcome> {
  const resolved = await resolveConfig(deps.fetchConfig ?? defaultFetchConfig);
  const verifier = deps.verifier ?? (await loadKtVerifier(resolved.abi));
  const outcome = await runKtMonitorOnce({
    // `ktMonitoring` hanya meneruskan keduanya ke verifier; modul WASM yang
    // dipilih di atas yang menentukan ABI. Cast ini menjaga tipe v1 lama tanpa
    // menduplikasi loop monitor untuk v2.
    verifier: verifier as unknown as KeyTransparencyVerifierV1,
    config: resolved.config as unknown as KtConfigV1,
    fetchMonitor: deps.fetchMonitor ?? defaultFetchMonitor,
    states: deps.states,
    now: deps.now,
  });
  // Bukti monitor diterima → pin config boleh ditulis (termasuk upgrade v1 → v2).
  await commitKtConfigPin(resolved);
  // [docs/30 §30.5 tahap C] Satu langkah monitor = satu titik segar untuk
  // jangkar gossip (interval 6 jam; satu GET tambahan per langkah, bukan per pesan).
  await refreshKtAnchor(deps.fetchHead);
  return outcome;
}

/** Konfigurasi mode yang dipakai deployment NYX (dipakai test & diagnostik). */
export const KT_DEFAULT_MODE = KT_MODE_CONTACT_MONITORING;
