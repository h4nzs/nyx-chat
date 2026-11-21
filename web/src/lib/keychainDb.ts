import { isPlainObject } from '@utils/typeGuards';
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { db, VaultEntry, type PqDrSessionRecord } from './db';
import { clearAppTable, listAppRows, putAppRows } from './storage/appStorage';
import type { StoryId } from '@nyx/shared';
import { base64UrlToBytes, bytesToBase64Url } from './base64url';
import { pickChainState } from './groupEra';
import { asConversationId, asUserId } from '@nyx/shared';
import type { ConversationId, UserId } from '@nyx/shared';
import type { KeyStore } from './storage/types';
import { createDexieKvStore } from './storage/dexieStores';
import { createKeyStore } from './storage/keyStore';
import { useDexieTestFallback } from './storage/testFallback';

// ============================================================
// [docs/43 §43.11.6 B2/B3] Keychain bertipe di KeyStore SQLite/OPFS.
//
// Seluruh kelompok kunci hot path memakai SATU KeyStore. `sqliteKeys()` tidak
// pernah mengembalikan `null`; tes jsdom memakai `db.kvStore` sebagai KeyStore
// (lewat `createDexieKvStore`), jadi tidak ada cabang tabel Dexie bertipe di
// satu pun fungsi CRUD di berkas ini.
//
// Impor DINAMIS wajib: rantai statis keychainDb → storage/sqliteMessages →
// storage/dbKey → keychainDb adalah siklus (kunci database SQLite disegel
// dengan masterSeed dari modul ini).
//
// Prefix kunci wajib karena satu KeyStore menampung lima tabel; tanpa prefix,
// `sess:<conv>_<sid>` bisa menabrak `gskip:<conv>_<sender>_…`.
// ============================================================
const KEY_PREFIX = {
  session: 'sess:',
  group: 'gkey:',
  ratchet: 'ratchet:',
  skipped: 'skip:',
  groupSkipped: 'gskip:',
  preKey: 'pre:',
  identity: 'id:',
  pendingHeader: 'ph:',
  messageKey: 'mk:',
  groupSender: 'gs:',
  groupReceiver: 'gr:',
  groupParticipants: 'gcp:',
  pqDr: 'pq:',
} as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * KeyStore bersama. Produksi selalu SQLite. Tes jsdom memakai `db.kvStore`
 * sebagai KeyStore Dexie, sehingga seluruh jalur keychain tetap satu bentuk
 * (tidak ada cabang tabel Dexie bertipe di fungsi CRUD).
 */
async function sqliteKeys(): Promise<KeyStore> {
  try {
    const { openSqliteKeyStore } = await import('./storage/sqliteMessages');
    return await openSqliteKeyStore();
  } catch (error) {
    if (useDexieTestFallback()) return createKeyStore(createDexieKvStore(db));
    throw error;
  }
}

/** Kunci ber-prefix, urut leksikografis (semantik indeks string Dexie). */
async function keyNames(keys: KeyStore, prefix: string): Promise<string[]> {
  return (await keys.keys(prefix)).sort();
}

function encodeJson(value: unknown): Uint8Array {
  // `TextEncoder` jsdom/Node bisa berasal dari realm lain; KeyStore memeriksa
  // `instanceof Uint8Array`, jadi salin ke realm modul ini.
  return Uint8Array.from(TEXT_ENCODER.encode(JSON.stringify(value)));
}

function decodeJson<T>(value: Uint8Array | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(TEXT_DECODER.decode(value)) as T;
  } catch {
    return undefined;
  }
}

type GroupSenderRow = Parameters<typeof db.groupSenderStates.put>[0];
type GroupReceiverRow = Parameters<typeof db.groupReceiverStates.put>[0];
type PreKeyRow = Parameters<typeof db.preKeys.put>[0];
type IdentityRow = Parameters<typeof db.identityKeys.put>[0];
type PendingHeaderRow = Parameters<typeof db.pendingHeaders.put>[0];
type GroupParticipantsRow = Parameters<typeof db.groupCachedParticipants.put>[0];

async function getGroupSenderRow(conversationId: string): Promise<GroupSenderRow | undefined> {
  const keys = await sqliteKeys();
  return decodeJson<GroupSenderRow>(await keys.get(`${KEY_PREFIX.groupSender}${conversationId}`));
}

async function putGroupSenderRow(row: GroupSenderRow): Promise<void> {
  const keys = await sqliteKeys();
  await keys.put(`${KEY_PREFIX.groupSender}${row.conversationId}`, encodeJson(row));
}

async function getGroupReceiverRow(id: string): Promise<GroupReceiverRow | undefined> {
  const keys = await sqliteKeys();
  return decodeJson<GroupReceiverRow>(await keys.get(`${KEY_PREFIX.groupReceiver}${id}`));
}

async function putGroupReceiverRow(row: GroupReceiverRow): Promise<void> {
  const keys = await sqliteKeys();
  await keys.put(`${KEY_PREFIX.groupReceiver}${row.id}`, encodeJson(row));
}

async function listGroupReceiverRows(prefix: string): Promise<GroupReceiverRow[]> {
  const keys = await sqliteKeys();
  const rows: GroupReceiverRow[] = [];
  for (const name of await keyNames(keys, `${KEY_PREFIX.groupReceiver}${prefix}`)) {
    const row = decodeJson<GroupReceiverRow>(await keys.get(name));
    if (row) rows.push(row);
  }
  return rows;
}

async function deleteGroupReceiverRows(prefix: string): Promise<void> {
  const keys = await sqliteKeys();
  await deleteByPrefix(keys, `${KEY_PREFIX.groupReceiver}${prefix}`);
}

async function deleteByPrefix(keys: KeyStore, prefix: string): Promise<void> {
  for (const name of await keys.keys(prefix)) await keys.delete(name);
}

/** Buang kelima kelompok kunci keychain (dipakai wipe akun/percakapan). */
async function wipeKeychainKeys(keys: KeyStore): Promise<void> {
  for (const prefix of Object.values(KEY_PREFIX)) await deleteByPrefix(keys, prefix);
}

function skippedOrder(name: string): number {
  const match = name.match(/_(\d+)$/);
  return match ? Number(match[1]) : -1;
}

// ============================================================
// AT-REST ENCRYPTION (masterSeed-bound)
// Group chain keys (CK), skipped message keys, dan story keys
// dienkripsi dengan masterSeed sebelum disimpan ke IndexedDB.
// Skema sama dengan ratchet state (worker_encrypt_session_key).
// Nilai legacy (plaintext, tanpa prefix) tetap terbaca transparan
// dan dienkripsi ulang lewat migrateKeychainAtRestEncryption().
// [audit D7] Penulisan BARU fail-closed: kalau masterSeed belum ada
// atau worker gagal, `encryptValueAtRest` melempar dan penulisan
// dilewati — nilai tidak pernah ditulis plaintext "diam-diam".
// ============================================================
export const AT_REST_PREFIX = 'ENC1:';

async function getMasterSeedOrUndefined(): Promise<Uint8Array | undefined> {
  // [FIX 2026-10-13] Harus NON-prompting: `migrateKeychainAtRestEncryption`
  // (dipanggil fire-and-forget dari `saveDeviceAutoUnlockKey`) memakai helper ini
  // saat registrasi, ketika vault belum ter-unlock dan identitas user belum sempat
  // ter-scope. Memakai `getMasterSeed()` yang memunculkan prompt membuat modal
  // "ACCESS CONTROL PAD" menghalangi alur onboarding. Fungsi bernama "OrUndefined"
  // memang tidak boleh memblokir; bila terkunci, jawabannya `undefined` (dan
  // pemanggil sudah menangani itu dengan menyimpan nilai apa adanya).
  const { useAuthStore } = await import('@store/auth');
  return useAuthStore.getState().getMasterSeedIfUnlocked();
}

/**
 * [audit N7-02] Subkey deterministik untuk indeks pencarian KT.
 *
 * `searchKey` adalah hash nama kontak yang bisa ditebak (Argon2id dengan
 * parameter publik), jadi ia tidak boleh menjadi primary key plaintext di
 * IndexedDB. Turunkan kunci indeks dari masterSeed supaya dump IDB tanpa vault
 * tidak bisa dipakai untuk mengenumerasi kontak yang dimonitor.
 */
export async function deriveKtSearchIndexKey(): Promise<Uint8Array> {
  const masterSeed = await getMasterSeedOrUndefined();
  if (!masterSeed) {
    throw new AtRestSealUnavailableError(
      'masterSeed belum tersedia — indeks pencarian KT tidak dapat diturunkan'
    );
  }
  const sodium = await import('@lib/sodiumInitializer').then((m) => m.getSodium());
  // [audit N8-01] Binding JS libsodium MENGEMBALIKAN subkey; ia tidak menulis ke
  // argumen pertama seperti API C. Dulu kode memakai bentuk C
  // (`crypto_kdf_derive_from_key(subkey, 1, ctx, key)`) sehingga SELALU melempar
  // `TypeError: subkey_len must be an unsigned integer` — akibatnya tidak ada
  // satu pun baris KT yang bisa ditulis dan verifikasi kontak selalu
  // `unavailable`. Argumen: (panjang, id, ctx 8 karakter, kunci 32 byte).
  const subkey = sodium.crypto_kdf_derive_from_key(32, 1, 'nyx-kt01', masterSeed);
  if (subkey.length !== 32) {
    throw new AtRestSealUnavailableError('indeks pencarian KT berukuran salah');
  }
  return subkey;
}

/**
 * [audit D7] Dilempar bila sebuah nilai **tidak bisa** disegel: masterSeed belum
 * tersedia (vault terkunci) atau worker enkripsi gagal.
 *
 * Pemanggil wajib **melewati penulisan** (atau membiarkan error naik ke
 * try/catch yang membatalkan tulis baris itu), bukan menyimpan plaintext.
 */
export class AtRestSealUnavailableError extends Error {
  constructor (message: string) {
    super(message);
    this.name = 'AtRestSealUnavailableError';
  }
}

/**
 * Seal satu nilai dengan `masterSeed` → `ENC1:<base64url>`.
 *
 * [audit D7] Fail-closed: **tidak ada** fallback plaintext. Sebelumnya nilai
 * dikembalikan apa adanya (hanya `console.warn`) saat masterSeed tidak tersedia
 * atau `encrypt_session_key` melempar — akibatnya `Message.seq`, `senderId`,
 * `repliedToId`, `expiresAt`, `Conversation.isGroup` bisa tersimpan plaintext di
 * IndexedDB padahal `docs/04` §4.8 menjanjikan baris baru selalu ter-seal
 * (model ancaman perangkat dicuri, `docs/28`).
 *
 * Baris **lama** yang plaintext tetap terbaca: `decryptValueAtRest` mengembalikan
 * nilai tanpa prefix apa adanya, dan migrasi at-rest men-seal ulang saat vault
 * terbuka.
 */
export async function encryptValueAtRest(value: string): Promise<string> {
  if (value.startsWith(AT_REST_PREFIX)) return value;
  const masterSeed = await getMasterSeedOrUndefined();
  if (!masterSeed) {
    throw new AtRestSealUnavailableError(
      'masterSeed belum tersedia — nilai tidak disegel dan tidak boleh ditulis plaintext'
    );
  }
  const { worker_encrypt_session_key } = await import('@lib/crypto-worker-proxy');
  const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
  const bytes = await worker_encrypt_session_key(new TextEncoder().encode(value), masterSeed);
  return AT_REST_PREFIX + sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function decryptValueAtRest(value: string): Promise<string | null> {
  if (!value.startsWith(AT_REST_PREFIX)) return value; // legacy plaintext
  try {
    const masterSeed = await getMasterSeedOrUndefined();
    if (!masterSeed) return null;
    const { worker_decrypt_session_key } = await import('@lib/crypto-worker-proxy');
    const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
    const bytes = await worker_decrypt_session_key(
      sodium.from_base64(value.slice(AT_REST_PREFIX.length), sodium.base64_variants.URLSAFE_NO_PADDING),
      masterSeed
    );
    return new TextDecoder().decode(bytes);
  } catch (e) {
    console.warn('[KeychainDB] At-rest decryption failed:', e);
    return null;
  }
}

async function encryptSkippedKeysAtRest(skippedKeys: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!skippedKeys) return out;
  for (const [k, v] of Object.entries(skippedKeys)) {
    out[k] = await encryptValueAtRest(v);
  }
  return out;
}

async function decryptSkippedKeysAtRest(skippedKeys: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!skippedKeys) return out;
  for (const [k, v] of Object.entries(skippedKeys)) {
    const plain = await decryptValueAtRest(v);
    if (plain === null) continue; // unreadable entry — skip (forward secrecy preserved)
    out[k] = plain;
  }
  return out;
}

// --- Types ---
export interface GroupSenderState {
  conversationId: ConversationId;
  CK: string;
  N: number;
  // [T2 FIX 2026-10-01] Chain key AWAL era (posisi N=0). Fulfillment key request
  // harus menyegel INI — bukan CK ratchet saat ini. Jika pengirim seal state
  // terkini (CK_n, N=n), penerima yang telat mustahil menurunkan message key
  // untuk pesan < n (KDF chain satu arah) → "Ratchet Advanced! Cannot decrypt
  // old message (header.n=0, state.N=1)" (log 2-browser 2026-10-01). Pola
  // Sender Key Distribution Message libsignal: distribusi era selalu memuat
  // sender key awal; semua anggota menurunkan message key sendiri dari sana.
  initialCK?: string;
  // [V2 2026-10-02 — RENCANA AWAL #1/#2] chainId RANDOM 64-bit per era (bukan
  // turunan CK) + kunci metadata era (keluar dari chain — rencana #2).
  // Keduanya dienkripsi at-rest bersama CK.
  chainId?: string;
  metadataKey?: string;
  createdAt?: number;
  messageCount?: number;
  lastActivityTime?: number;
  requiresImmediateRotation?: boolean;
  // [PQ v4 Fase 1.5] Kunci privat ML-DSA milik sendiri untuk era ini (bila v2
  // aktif). Saat null → jalur tanda tangan v1 (Ed25519) tetap dipakai.
  signingKeyV2?: string;
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  conversationId: ConversationId;
  senderId: UserId;
  CK: string;
  N: number;
  // [INVARIANT 1 — multi-era 2026-10-02] Anchor era: chain key posisi AWAL era
  // (initialCK). Dipakai untuk membedakan "replay distribusi era yang sama"
  // (no-op, JANGAN rewind) vs "era baru" (arsipkan state lama, simpan baru).
  // Pola libsignal SenderKeyState: state disimpan per (distributionId, chainId).
  eraCK?: string;
  // [REWRITE 2026-10-02] Identitas era eksplisit ala libsignal chain_id —
  // stabil sepanjang rantai (= 8-char prefix eraCK). Lihat groupEra.ts.
  chainId?: string;
  // [V2 2026-10-02 — RENCANA #2] Kunci metadata era (at-rest terenkripsi).
  metadataKey?: string;
  skippedKeys?: Record<string, string>;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim, diikat SEJAK distribusi
  // kunci (pola libsignal SenderKeyState: sender_signing_key tersimpan di state
  // penerima). Sumber utama verifikasi signature pesan grup — menghapus
  // ketergantungan decrypt pada pseudonymMap/bundle API (chicken-and-egg).
  signingKey?: string;
  // [PQ v4 Fase 1.5] Public signing key ML-DSA pengirim, diikat sejak
  // distribusi kunci (bila pengirim memakai tanda tangan v2).
  signingKeyV2?: string;
  // [PQ v4 Fase 1.5 — envelope v3] Pengenal 8B (base64url) dari `signingKeyV2`
  // pengirim; dipakai mencocokkan envelope dengan kunci verifikasi.
  senderKeyId?: string;
}

// --- GLOBAL WRITE QUEUE ---
const dbWriteQueue: Promise<unknown> = Promise.resolve();
let queueTail = dbWriteQueue;

async function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const prev = queueTail;
    queueTail = (async () => {
        try {
            await prev;
        } catch (_e) {}
        return op();
    })();
    return queueTail as Promise<T>;
}

export async function closeDatabaseConnection() {
  // [docs/43 §43.11.6 B2] Worker SQLite memegang kunci DB di memori; tutup
  // sebelum koneksi Dexie hilang supaya tidak ada worker yang tertinggal.
  const { closeSqliteMessages } = await import('./storage/sqliteMessages');
  await closeSqliteMessages().catch(() => {});
  if (db.isOpen()) {
    db.close();
  }
}

// ... existing helpers ...

export async function getGroupSenderState(conversationId: string): Promise<GroupSenderState | null> {
  return enqueueWrite(async () => {
    const record = await getGroupSenderRow(conversationId);
    // Di GroupRatchetState yang baru, CK sudah berupa string. 
    // Jika di runtime dia berupa Uint8Array (dari legacy code), kita konversi.
    let ckString = '';
    if (record) {
        const rawCk: unknown = record.state.CK;
        if (typeof rawCk === 'string') {
            ckString = rawCk;
        } else if (rawCk instanceof Uint8Array) {
            const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
            ckString = sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING);
        }
    }

    const ckPlain = await decryptValueAtRest(ckString);
    if (ckPlain === null) return null; // encrypted but unreadable (locked/corrupt)

    return record ? {
        conversationId: asConversationId(record.conversationId),
        CK: ckPlain,
        N: record.state.N,
        initialCK: record.state.initialCK
            ? (await decryptValueAtRest(record.state.initialCK)) ?? undefined
            : undefined,
        chainId: record.state.chainId,
        metadataKey: record.state.metadataKey
            ? (await decryptValueAtRest(record.state.metadataKey)) ?? undefined
            : undefined,
        createdAt: record.state.createdAt,
        messageCount: record.state.messageCount,
        lastActivityTime: record.state.lastActivityTime,
        requiresImmediateRotation: record.state.requiresImmediateRotation,
        // [PQ v4 Fase 1.5 — AUDIT 2026-10-20] Kunci PUBLIK ML-DSA era ini
        // (bukan rahasia). Dulu field ini tidak pernah dibaca/ditulis sehingga
        // hilang setiap reload; sender state lalu jatuh ke jalur v1.
        signingKeyV2: record.state.signingKeyV2
    } : null;
  });
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  return enqueueWrite(async () => {
      // Sama seperti di atas, kita simpan sesuai schema yang baru (string)
      // CK dienkripsi at-rest dengan masterSeed (prefix ENC1:)
      await putGroupSenderRow({
          conversationId: state.conversationId,
          state: {
            CK: await encryptValueAtRest(state.CK),
            N: state.N,
            initialCK: state.initialCK ? await encryptValueAtRest(state.initialCK) : undefined,
            chainId: state.chainId,
            metadataKey: state.metadataKey ? await encryptValueAtRest(state.metadataKey) : undefined,
            createdAt: state.createdAt,
            messageCount: state.messageCount,
            lastActivityTime: state.lastActivityTime,
            requiresImmediateRotation: state.requiresImmediateRotation,
            // [PQ v4 Fase 1.5 — AUDIT 2026-10-20] Lihat catatan di
            // `getGroupSenderState`: field ini wajib ikut persist.
            signingKeyV2: state.signingKeyV2
          }
      });  });
}

export async function getGroupReceiverState(conversationId: string, senderId: string, senderDeviceKey?: string): Promise<GroupReceiverState | null> {
  return enqueueWrite(async () => {
    // [BUGFIX 2026-10-02 — STATE KEY BY DEVICE] Sender identity TIDAK STABIL:
    // wrapper metadata memakai userId mentah, envelope kunci memakai pseudonym
    // (yang berubah tiap rotasi metadata generation+1) — state yang di-store
    // di bawah kunci (pseudonym, device) tidak pernah ditemukan oleh lookup
    // metadata (rawId, device) → anggota baru selamanya "pending waiting_for_key"
    // untuk metadata. Solusi ala libsignal (state keyed by alamat pengirim yang
    // STABIL): kunci utama = (conversationId, senderDeviceKey) — identity key
    // device pengirim, unik & ada di SEMUA wrapper (metadata, pesan, envelope).
    // Fallback ke id legacy (senderId-keyed) untuk state lama.
    const record = senderDeviceKey
        ? (await getGroupReceiverRow(`${conversationId}_${senderDeviceKey}`))
          ?? (await getGroupReceiverRow(`${conversationId}_${senderId}_${senderDeviceKey}`))
        : await getGroupReceiverRow(`${conversationId}_${senderId}`);

    let ckString = '';
    if (record) {
        const rawCk: unknown = record.state.CK;
        if (typeof rawCk === 'string') {
            ckString = rawCk;
        } else if (rawCk instanceof Uint8Array) {
            const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
            ckString = sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING);
        }
    }

    const ckPlain = await decryptValueAtRest(ckString);
    if (ckPlain === null) return null;

    return record ? {
        id: record.id,
        conversationId: asConversationId(conversationId),
        senderId: asUserId(record.state.senderId || senderId),
        CK: ckPlain,
        N: record.state.N,
        eraCK: record.state.eraCK,
        chainId: record.state.chainId,
        metadataKey: record.state.metadataKey
            ? (await decryptValueAtRest(record.state.metadataKey)) ?? undefined
            : undefined,
        skippedKeys: await decryptSkippedKeysAtRest(record.state.skippedKeys),
        signingKey: record.state.signingKey,
        // [PQ v4 Fase 1.5 — BUGFIX 2026-10-20] Field ini dulu TIDAK ikut
        // dibaca/ditulis di lapisan Dexie, sehingga kunci verifikasi ML-DSA
        // yang sudah terikat saat distribusi hilang setiap kali state dibaca →
        // semua pesan/metadata `sigV:2` gagal "Missing sender signing key v2"
        // walau envelope v4 membawanya.
        signingKeyV2: record.state.signingKeyV2,
        senderKeyId: record.state.senderKeyId
    } : null;
  });
}

export async function saveGroupReceiverState(state: GroupReceiverState): Promise<void> {
  return enqueueWrite(async () => {
      await putGroupReceiverRow({
          id: state.id,
          state: {
            CK: await encryptValueAtRest(state.CK),
            N: state.N,
            eraCK: state.eraCK,
            chainId: state.chainId,
            metadataKey: state.metadataKey ? await encryptValueAtRest(state.metadataKey) : undefined,
            // senderId ikut disimpan agar state device-keyed bisa
            // mengembalikan identitas pengirim yang benar (id record kini
            // device-keyed — parts[1] bukan lagi senderId).
            senderId: state.senderId,
            skippedKeys: await encryptSkippedKeysAtRest(state.skippedKeys),
            // Public key — tidak sensitif (bukan private), simpan plaintext.
            signingKey: state.signingKey,
            signingKeyV2: state.signingKeyV2,
            senderKeyId: state.senderKeyId
          }
      });
  });
}

// [INVARIANT 1 — multi-era 2026-10-02] Arsipkan receiver state era LAMA saat era
// baru tiba, ala libsignal SenderKeyRecord (MAX_SENDER_KEY_STATES=5): pesan era
// lama yang datang belakangan masih bisa di-route via chainId lookup, dan yang
// terpenting state era lama TIDAK DITIMPA — menghilangkan seluruh kelas bug
// "rewind saat offline sync". Id arsip: `${id}#era_${chainId}` — TIDAK akan
// dikembalikan oleh getGroupReceiverState (exact-id get) tapi TETAP ditemukan
// oleh findGroupReceiverState / listGroupReceiverStates (startsWith scan).
const MAX_ARCHIVED_RECEIVER_STATES = 5;

export async function archiveGroupReceiverState(state: GroupReceiverState): Promise<void> {
  return enqueueWrite(async () => {
    const chainId = state.chainId ?? state.eraCK?.substring(0, 8) ?? state.CK.substring(0, 8);
    const archivedId = `${state.id}#era_${chainId}`;
    const existing = await getGroupReceiverRow(archivedId);
    if (existing) return; // era ini sudah terarsip — jangan timpa snapshot lebih maju

    // Cap per (conversation, sender): buang arsip tertua bila melebihi batas.
    const prefix = `${state.id.split('#')[0]}#era_`;
    const archived = (await listGroupReceiverRows(prefix))
      .map(r => ({ id: r.id, archivedAt: (r.state as { archivedAt?: number }).archivedAt ?? 0 }))
      .sort((a, b) => a.archivedAt - b.archivedAt);
    while (archived.length >= MAX_ARCHIVED_RECEIVER_STATES) {
      const oldest = archived.shift();
      if (oldest) {
        const keys = await sqliteKeys();
        await keys.delete(`${KEY_PREFIX.groupReceiver}${oldest.id}`);
      }
    }

    await putGroupReceiverRow({
        id: archivedId,
        state: {
          CK: await encryptValueAtRest(state.CK),
          N: state.N,
          eraCK: state.eraCK ?? state.CK,
          chainId,
          metadataKey: state.metadataKey ? await encryptValueAtRest(state.metadataKey) : undefined,
          senderId: state.senderId,
          skippedKeys: await encryptSkippedKeysAtRest(state.skippedKeys),
          signingKey: state.signingKey,
          signingKeyV2: state.signingKeyV2,
          senderKeyId: state.senderKeyId,
          archivedAt: Date.now()
        }
    });
  });
}

/**
 * Stores a group skipped message key atomically.
 */
export async function storeGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string, n: number, mk: string, keyId?: string): Promise<void> {
    return enqueueWrite(async () => {
        const key = keyId ? `${conversationId}_${senderId}_${senderDeviceKey}_${keyId}_${n}` : `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
        // [INVARIANT 2 — MK-persist ala Signal 2026-10-02] Kap total skipped keys
        // per conversation: yang terlama dihapus saat melebihi batas. Kunci TIDAK
        // lagi dihapus setelah dipakai — reload/kick+re-add tetap bisa decrypt
        // pesan lama yang message key-nya sudah terlewati ratchet (pola
        // add_sender_message_key libsignal: skipped keys hidup di state record).
        const MAX_SKIPPED_KEYS = 200;
        const keys = await sqliteKeys();
        const names = await keys.keys(`${KEY_PREFIX.groupSkipped}${conversationId}_`);
        if (names.length >= MAX_SKIPPED_KEYS) {
            const oldest = names.sort((a, b) => skippedOrder(a) - skippedOrder(b))
                .slice(0, names.length - MAX_SKIPPED_KEYS + 1);
            for (const name of oldest) await keys.delete(name);
        }
        await keys.put(`${KEY_PREFIX.groupSkipped}${key}`, Uint8Array.from(TEXT_ENCODER.encode(await encryptValueAtRest(mk))));
    });
}

/**
 * Retrieves a group skipped message key without deleting it.
 */
export async function getGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string | undefined, n: number, keyId?: string): Promise<string | null> {
    return enqueueWrite(async () => {
        const keys = await sqliteKeys();
        if (senderDeviceKey && senderDeviceKey !== 'undefined') {
            const key = keyId ? `${conversationId}_${senderId}_${senderDeviceKey}_${keyId}_${n}` : `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
            const record = await keys.get(`${KEY_PREFIX.groupSkipped}${key}`);
            if (record) return decryptValueAtRest(TEXT_DECODER.decode(record));
            if (keyId) {
                // Fallback ke format lama tanpa keyId.
                const fallbackKey = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
                const fallbackRecord = await keys.get(`${KEY_PREFIX.groupSkipped}${fallbackKey}`);
                if (fallbackRecord) return decryptValueAtRest(TEXT_DECODER.decode(fallbackRecord));
            }

            // [REWRITE 2026-10-02 — TIDAK ADA SCAN TANPA FILTER] DULU di sini ada
            // array-scan `${conv}_${sender}_*_${n}` yang mengabaikan keyId DAN
            // deviceKey — sejak twin-MK tersimpan per posisi, scan itu mengambil
            // MK dari ERA/CHAIN LAIN pada posisi yang sama → MAC gagal walau
            // "entri ditemukan" (log 3-browser 17:06, B ikut gagal). Lookup
            // sekarang WAJIB exact (device + chain/keyId + posisi); pemanggil
            // mencoba alias chainId sebagai percobaan kedua.
            return null;
        }

        // Fallback HANYA untuk pesan lama yang benar-benar tanpa senderDeviceKey:
        // tetap memfilter senderId secara ketat (tanpa wildcard device).
        const prefix = `${KEY_PREFIX.groupSkipped}${conversationId}_${senderId}_`;
        for (const name of await keyNames(keys, prefix)) {
            if (!name.endsWith(`_${n}`)) continue;
            const record = await keys.get(name);
            if (record) return decryptValueAtRest(TEXT_DECODER.decode(record));
        }
        return null;
    });
}

/**
 * Deletes a group skipped message key.
 */
export async function deleteGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string | undefined, n: number): Promise<void> {
    return enqueueWrite(async () => {
        const keys = await sqliteKeys();
        if (senderDeviceKey && senderDeviceKey !== 'undefined') {
            await keys.delete(`${KEY_PREFIX.groupSkipped}${conversationId}_${senderId}_${senderDeviceKey}_${n}`);
            return;
        }

        const prefix = `${KEY_PREFIX.groupSkipped}${conversationId}_${senderId}_`;
        for (const name of await keyNames(keys, prefix)) {
            if (name.endsWith(`_${n}`)) await keys.delete(name);
        }
    });
}

export async function deleteGroupStates(conversationId: string): Promise<void> {
  await enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.groupSender}${conversationId}`);
      await deleteGroupReceiverRows(`${conversationId}_`);
      await deleteByPrefix(keys, `${KEY_PREFIX.groupSkipped}${conversationId}_`);
  });
}

export async function deleteGroupSenderState(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.groupSender}${conversationId}`);
  });
}

/** Hapus satu receiver state (aktif/arsip) berdasarkan id lengkap. */
export async function deleteGroupReceiverState(id: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.groupReceiver}${id}`);
  });
}

/** Rotasi identitas: buang sesi lama, pertahankan receiver state grup. */
export async function clearIdentitySessions(): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await deleteByPrefix(keys, KEY_PREFIX.session);
      await deleteByPrefix(keys, KEY_PREFIX.ratchet);
      await deleteByPrefix(keys, KEY_PREFIX.groupSender);
  });
}

type StoredPreKey = Omit<PreKeyRow, 'encryptedPrivateKey'> & { encryptedPrivateKey: string };

async function getPendingHeaderRow(conversationId: string): Promise<PendingHeaderRow | undefined> {
  const keys = await sqliteKeys();
  return decodeJson<PendingHeaderRow>(await keys.get(`${KEY_PREFIX.pendingHeader}${conversationId}`));
}

export async function storePendingHeader(conversationId: string, header: Record<string, unknown>): Promise<void> {
  return enqueueWrite(async () => {
      const row = { conversationId: conversationId as ConversationId, header };
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.pendingHeader}${conversationId}`, encodeJson(row));
  });
}

export async function getPendingHeader(conversationId: string): Promise<Record<string, unknown> | null> {
  const record = await getPendingHeaderRow(conversationId);
  return record ? record.header : null;
}

export async function deletePendingHeader(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.pendingHeader}${conversationId}`);
  });
}

export async function storeOneTimePreKey(keyId: number, encryptedPrivateKey: Uint8Array, pqPublicKey?: string): Promise<void> {
  return enqueueWrite(async () => {
      try {
          const keys = await sqliteKeys();
          const row: StoredPreKey = {
              keyId: Number(keyId),
              pqPublicKey,
              encryptedPrivateKey: bytesToBase64Url(encryptedPrivateKey),
          };
          await keys.put(`${KEY_PREFIX.preKey}${keyId}`, encodeJson(row));
      } catch (err) {
          console.error(`[KeychainDB] CRITICAL: Failed to save OneTimePreKey ${keyId}`, err);
          throw err;
      }
  });
}

export async function getOneTimePreKey(keyId: number): Promise<Uint8Array | null> {
  const keys = await sqliteKeys();
  const row = decodeJson<StoredPreKey>(await keys.get(`${KEY_PREFIX.preKey}${keyId}`));
  return row ? base64UrlToBytes(row.encryptedPrivateKey) : null;
}

export async function deleteOneTimePreKey(keyId: number): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.preKey}${keyId}`);
  });
}

export async function getLastOtpkId(): Promise<number> {
  const keys = await sqliteKeys();
  let max = 0;
  for (const name of await keys.keys(KEY_PREFIX.preKey)) {
      const id = Number(name.slice(KEY_PREFIX.preKey.length));
      if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

export async function addSessionKey(
  conversationId: string,
  sessionId: string,
  key: Uint8Array
): Promise<void> {
  return enqueueWrite(async () => {
      const storageKey = `${conversationId}_${sessionId}`;
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.session}${storageKey}`, key);
  });
}

export async function getSessionKey(
  conversationId: string,
  sessionId: string
): Promise<Uint8Array | null> {
  const storageKey = `${conversationId}_${sessionId}`;
  const keys = await sqliteKeys();
  return (await keys.get(`${KEY_PREFIX.session}${storageKey}`)) ?? null;
}

export async function getLatestSessionKey(
  conversationId: string
): Promise<{ sessionId: string; key: Uint8Array } | null> {
  const keys = await sqliteKeys();
  const prefix = `${KEY_PREFIX.session}${conversationId}_`;
  const names = await keyNames(keys, prefix);
  const name = names[names.length - 1];
  if (!name) return null;
  const key = await keys.get(name);
  return key ? { sessionId: name.slice(prefix.length), key } : null;
}

export async function storeGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.group}${conversationId}`, key);
  });
}

export async function getGroupKey(conversationId: string): Promise<Uint8Array | null> {
  const keys = await sqliteKeys();
  return (await keys.get(`${KEY_PREFIX.group}${conversationId}`)) ?? null;
}

export async function receiveGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return storeGroupKey(conversationId, key);
}

export async function deleteGroupKey(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.group}${conversationId}`);
  });
}

// [INVARIANT 1:1 — 2026-10-05] Jumlah slot arsip sesi DR. Ala libsignal
// SessionRecord prior-states (Signal-Desktop memakai beberapa state arsip):
// pesan yang datang 2+ DH-step terlambat (device offline selama beberapa step,
// skipped-key ter-evict LRU) hanya bisa diselamatkan oleh arsip era lama.
export const RATCHET_ARCHIVE_SLOTS = 3;

export function ratchetArchiveIds(conversationId: string): string[] {
  return Array.from(
    { length: RATCHET_ARCHIVE_SLOTS },
    (_, i) => `${conversationId}#archived_${i}`
  );
}

export async function storeRatchetSession(conversationId: string, encryptedState: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      // [INVARIANT 1:1 — MULTI-STATE 2026-10-02] Ala libsignal SessionRecord
      // (ARCHIVED_STATES_MAX_LENGTH): sebelum X3DH/DH-step baru menimpa, state
      // lama digeser ke arsip FIFO `#archived_0..2` — pesan inflight dari era
      // lama tetap decryptable via fallback lookup (crypto.ts DR path).
      // Legacy `#archived` (1 slot, pra-2026-10-05) dibaca di getter dan
      // dimigrasi otomatis ke slot baru saat penulisan berikutnya.
      const keys = await sqliteKeys();
      const main = `${KEY_PREFIX.ratchet}${conversationId}`;
      const ids = ratchetArchiveIds(conversationId).map(id => `${KEY_PREFIX.ratchet}${id}`);
      const existing = await keys.get(main);
      if (existing) {
          for (let i = ids.length - 1; i > 0; i--) {
              const older = await keys.get(ids[i - 1]!);
              if (older) await keys.put(ids[i]!, older);
          }
          await keys.put(ids[0]!, existing);
          await keys.delete(`${KEY_PREFIX.ratchet}${conversationId}#archived`);
      }
      await keys.put(main, encryptedState);
  });
}

export async function getRatchetSession(conversationId: string): Promise<Uint8Array | null> {
  const keys = await sqliteKeys();
  return (await keys.get(`${KEY_PREFIX.ratchet}${conversationId}`)) ?? null;
}

/**
 * [INVARIANT 1:1] Sesi arsip era LAMA (diganti X3DH/DH-step baru), terbaru
 * dulu (slot 0 = era tepat sebelumnya) — fallback decrypt mencoba berurutan.
 * Legacy `#archived` (1 slot, pra-2026-10-05) disertakan di posisi terakhir
 * agar data lama tetap terjangkau.
 */
export async function getArchivedRatchetSessions(conversationId: string): Promise<Uint8Array[]> {
  const ids = ratchetArchiveIds(conversationId);
  const keys = await sqliteKeys();
  const states: Uint8Array[] = [];
  for (const id of [...ids, `${conversationId}#archived`]) {
      const state = await keys.get(`${KEY_PREFIX.ratchet}${id}`);
      if (state) states.push(state);
  }
  return states;
}

export async function storeSkippedKey(headerKey: string, encryptedKey: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      // [INVARIANT 2:1 — MK-PERSIST 2026-10-02] Kap LRU per conversation (ala
      // skipped-key machinery grup): kunci TIDAK dihapus setelah dipakai —
      // reload/relogin tetap bisa decrypt ulang pesan yang MK-nya sudah terlewati
      // ratchet (pola state.add_sender_message_key libsignal).
      const convId = headerKey.split('_').slice(0, 2).join('_');
      const MAX_SKIPPED_DR = 200;
      const keys = await sqliteKeys();
      const prefix = `${KEY_PREFIX.skipped}${convId}_`;
      const names = await keys.keys(prefix);
      if (names.length >= MAX_SKIPPED_DR) {
          const oldest = names.sort((a, b) => skippedOrder(a) - skippedOrder(b))
              .slice(0, names.length - MAX_SKIPPED_DR + 1);
          for (const name of oldest) await keys.delete(name);
      }
      await keys.put(`${KEY_PREFIX.skipped}${headerKey}`, encryptedKey);
  });
}

export async function getSkippedKey(headerKey: string): Promise<Uint8Array | null> {
  const keys = await sqliteKeys();
  return (await keys.get(`${KEY_PREFIX.skipped}${headerKey}`)) ?? null;
}

export async function deleteSkippedKey(headerKey: string): Promise<void> {
  // [INVARIANT 2:1 — 2026-10-02] NO-OP dijadwalkan: kunci skipped TIDAK lagi
  // dihapus setelah dipakai (sekali pakai = bug "reload kedua gagal").
  // Fungsi dipertahankan agar pemanggil lama tidak rusak; pembersihan oleh
  // cap LRU di storeSkippedKey.
  return Promise.resolve();
}

export async function deleteRatchetSession(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      // Hapus juga arsip era lama (wipe percakapan = hapus semua era),
      // termasuk slot FIFO baru dan id legacy `#archived`.
      for (const id of [conversationId, ...ratchetArchiveIds(conversationId), `${conversationId}#archived`]) {
          await keys.delete(`${KEY_PREFIX.ratchet}${id}`);
      }
  });
}

export async function deleteSessionKeys(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await deleteByPrefix(keys, `${KEY_PREFIX.session}${conversationId}_`);
  });
}

export async function deleteGroupReceiverStates(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
     const keys = await sqliteKeys();
     await deleteGroupReceiverRows(`${conversationId}_`);
     await deleteByPrefix(keys, `${KEY_PREFIX.groupSkipped}${conversationId}_`);
  });
}

export async function storeMessageKey(messageId: string, encryptedMk: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.messageKey}${messageId}`, encryptedMk);
  });
}

export async function getMessageKey(messageId: string): Promise<Uint8Array | null> {
  const keys = await sqliteKeys();
  return (await keys.get(`${KEY_PREFIX.messageKey}${messageId}`)) ?? null;
}

export async function deleteMessageKey(messageId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.messageKey}${messageId}`);
  });
}

export async function deleteConversationKeychain(conversationId: string): Promise<void> {
  await Promise.all([
    deleteSessionKeys(conversationId),
    deleteGroupKey(conversationId),
    deleteRatchetSession(conversationId),
    deletePendingHeader(conversationId),
    deleteGroupSenderState(conversationId),
    deleteGroupReceiverStates(conversationId)
  ]);
}

async function getIdentityRow(userId: string): Promise<IdentityRow | undefined> {
  const keys = await sqliteKeys();
  return decodeJson<IdentityRow>(await keys.get(`${KEY_PREFIX.identity}${userId}`));
}

async function putIdentityRow(userId: string, key: string): Promise<void> {
  const row = { userId: userId as UserId, key };
  const keys = await sqliteKeys();
  await keys.put(`${KEY_PREFIX.identity}${userId}`, encodeJson(row));
}

export async function saveProfileKey(userId: string, keyB64: string): Promise<void> {
  return enqueueWrite(async () => {
      await putIdentityRow(userId, keyB64);
  });
}

export async function getProfileKey(userId: string): Promise<string | undefined> {
  const record = await getIdentityRow(userId);
  return record?.key;
}

export async function savePeerIdentityKey(userId: string, keyB64: string): Promise<void> {
  return enqueueWrite(async () => {
      await putIdentityRow(`ID_PUB_${userId}`, keyB64);
  });
}

export async function getPeerIdentityKey(userId: string): Promise<string | undefined> {
  const record = await getIdentityRow(`ID_PUB_${userId}`);
  return record?.key;
}

/** Hapus cache kunci identitas (dipakai restore backup sebelum impor ulang). */
export async function clearIdentityKeys(): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await deleteByPrefix(keys, KEY_PREFIX.identity);
  });
}

/** Baris sesi PQ-DR (isi `state` sudah disegel oleh shadowVaultDb). */
export async function putPqDrSessionRow(row: PqDrSessionRecord): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.pqDr}${row.id}`, encodeJson(row));
  });
}

export async function getPqDrSessionRow(id: string): Promise<PqDrSessionRecord | undefined> {
  const keys = await sqliteKeys();
  return decodeJson<PqDrSessionRecord>(await keys.get(`${KEY_PREFIX.pqDr}${id}`));
}

export async function listPqDrSessionRows(conversationId?: string): Promise<PqDrSessionRecord[]> {
  const keys = await sqliteKeys();
  const rows: PqDrSessionRecord[] = [];
  for (const name of await keyNames(keys, KEY_PREFIX.pqDr)) {
      const row = decodeJson<PqDrSessionRecord>(await keys.get(name));
      if (row && (!conversationId || row.conversationId === conversationId)) rows.push(row);
  }
  return rows;
}

export async function deletePqDrSessionRow(id: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      await keys.delete(`${KEY_PREFIX.pqDr}${id}`);
  });
}

export async function deletePqDrSessionRows(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      const keys = await sqliteKeys();
      for (const name of await keyNames(keys, KEY_PREFIX.pqDr)) {
          const row = decodeJson<PqDrSessionRecord>(await keys.get(name));
          if (row?.conversationId === conversationId) await keys.delete(name);
      }
  });
}

export async function clearAllKeys(): Promise<void> {
  return enqueueWrite(async () => {
      // Kosongkan mirror SQLite SEBELUM `kvStore` (tempat kunci DB) dihapus.
      const { resetSqliteMessages, closeSqliteMessages } = await import('./storage/sqliteMessages');
      await resetSqliteMessages().catch(() => {});
      // [docs/43 §43.11.6 B2] Tabel pesan dikosongkan `resetSqliteMessages`;
      // material kunci keychain ada di KeyStore yang sama → hapus per prefix.
      const keys = await sqliteKeys();
      await wipeKeychainKeys(keys).catch(() => {});
      // `kvStore` dikosongkan SEBELUM worker ditutup: setelah close, adapter
      // akan membuka database baru dengan kunci yang baru saja dihapus.
      const kv = await import('./storage/appKv')
        .then((m) => m.getKvStore())
        .catch(() => null);
      if (kv) await kv.clear().catch(() => {});
      // Kunci DB tidak berada di kvStore (B3): kosongkan vault IDB-nya juga.
      await import('./storage/dbKey')
        .then((m) => m.clearSqliteMessagesKey())
        .catch(() => {});
      await closeSqliteMessages().catch(() => {});
      await Promise.all([
          db.messages.clear(),
          clearAppTable('storyKeys'),
          clearAppTable('offlineQueue'),
          clearAppTable('conversations'),
          clearAppTable('profileCache'),
          db.sessionKeys.clear(),
          db.groupKeys.clear(),
          db.preKeys.clear(),
          db.identityKeys.clear(),
          db.ratchetSessions.clear(),
          db.groupSenderStates.clear(),
          db.groupReceiverStates.clear(),
          db.skippedKeys.clear(),
          db.messageKeys.clear(),
          db.pendingHeaders.clear(),
          db.groupSkippedKeys.clear(),
          db.pqDrSessions.clear()
      ]);
  });
}

export type { VaultEntry };

// ============================================================
// MIGRASI AT-REST: enkripsi ulang nilai plaintext legacy (tanpa
// prefix ENC1:) yang tersimpan sebelum versi ini. Dijalankan
// sekali setelah sesi ter-unlock. Idempotent & aman dijalankan
// berulang. Semua tulis lewat queue agar tidak race.
// ============================================================
export async function migrateKeychainAtRestEncryption(): Promise<void> {
  return enqueueWrite(async () => {
    const masterSeed = await getMasterSeedOrUndefined();
    if (!masterSeed) return; // session belum ter-unlock — tunda sampai unlock berikutnya

    const keys = await sqliteKeys();

    // 1. Group sender states (CK + initialCK)
    for (const name of await keyNames(keys, KEY_PREFIX.groupSender)) {
      const row = decodeJson<GroupSenderRow>(await keys.get(name));
      if (!row?.state) continue;
      const state = row.state as unknown as Record<string, unknown>;
      const rawCk = state.CK;
      const rawInitialCk = state.initialCK;
      const needsCk = typeof rawCk === 'string' && !rawCk.startsWith(AT_REST_PREFIX);
      const needsInitialCk = typeof rawInitialCk === 'string' && !rawInitialCk.startsWith(AT_REST_PREFIX);
      if (!needsCk && !needsInitialCk) continue;
      await keys.put(name, encodeJson({
        ...row,
        state: {
          ...state,
          CK: needsCk ? await encryptValueAtRest(rawCk as string) : state.CK,
          initialCK: needsInitialCk ? await encryptValueAtRest(rawInitialCk as string) : state.initialCK,
        },
      }));
    }

    // 2. Group receiver states (CK + skippedKeys)
    for (const name of await keyNames(keys, KEY_PREFIX.groupReceiver)) {
      const row = decodeJson<GroupReceiverRow>(await keys.get(name));
      if (!row?.state) continue;
      const state = row.state as unknown as Record<string, unknown>;
      const rawCk = state.CK;
      const needsCk = typeof rawCk === 'string' && !rawCk.startsWith(AT_REST_PREFIX);
      const skipped = (state.skippedKeys ?? {}) as Record<string, string>;
      const needsSkipped = Object.values(skipped).some(
        (value) => typeof value === 'string' && !value.startsWith(AT_REST_PREFIX),
      );
      if (!needsCk && !needsSkipped) continue;
      await keys.put(name, encodeJson({
        ...row,
        state: {
          ...state,
          CK: needsCk ? await encryptValueAtRest(rawCk as string) : state.CK,
          skippedKeys: needsSkipped ? await encryptSkippedKeysAtRest(skipped) : state.skippedKeys,
        },
      }));
    }

    // 3. Group skipped keys (mk)
    for (const name of await keyNames(keys, KEY_PREFIX.groupSkipped)) {
      const stored = await keys.get(name);
      if (!stored) continue;
      const raw = TEXT_DECODER.decode(stored);
      if (raw.startsWith(AT_REST_PREFIX)) continue;
      await keys.put(name, Uint8Array.from(TEXT_ENCODER.encode(await encryptValueAtRest(raw))));
    }

    // 4. Story keys (di store storyKeys — shared dengan ShadowVault)
    const storyRecords = await listAppRows<{ storyId: StoryId; key: string }>('storyKeys');
    const sealedStoryKeys: Array<{ storyId: StoryId; key: string }> = [];
    for (const r of storyRecords) {
      if (!r.key.startsWith(AT_REST_PREFIX)) {
        sealedStoryKeys.push({ storyId: r.storyId, key: await encryptValueAtRest(r.key) });
      }
    }
    if (sealedStoryKeys.length > 0) await putAppRows('storyKeys', sealedStoryKeys);
  });
}

// --- Opaque Mailbox: Cached Group Participants ---

/**
 * Menyimpan daftar user IDs partisipan grup ke IndexedDB.
 * Digunakan oleh Opaque Mailbox agar non-creator tetap tahu anggota grup
 * meskipun metadata belum didekripsi.
 */
export async function saveCachedGroupParticipants(conversationId: string, userIds: string[]): Promise<void> {
  return enqueueWrite(async () => {
      const row: GroupParticipantsRow = { conversationId, userIds };
      const keys = await sqliteKeys();
      await keys.put(`${KEY_PREFIX.groupParticipants}${conversationId}`, encodeJson(row));
  });
}

/**
 * Mengembalikan daftar user IDs partisipan grup dari cache lokal.
 * Returns null jika belum pernah di-cache.
 */
export async function getCachedGroupParticipants(conversationId: string): Promise<string[] | null> {
  const keys = await sqliteKeys();
  const row = decodeJson<GroupParticipantsRow>(await keys.get(`${KEY_PREFIX.groupParticipants}${conversationId}`));
  return row ? row.userIds : null;
}

/**
 * [docs/40 §40.7] Semua baris cache partisipan grup — dipakai arsip riwayat
 * perangkat hasil link. Isinya hanya id (bukan rahasia): tanpa cache ini, grup
 * hasil impor tampil tanpa nama anggota sampai server mengirim ulang daftarnya.
 */
export async function listCachedGroupParticipants(): Promise<
  Array<{ conversationId: string; userIds: string[] }>
> {
  const keys = await sqliteKeys();
  const rows: GroupParticipantsRow[] = [];
  for (const name of await keyNames(keys, KEY_PREFIX.groupParticipants)) {
      const row = decodeJson<GroupParticipantsRow>(await keys.get(name));
      if (row) rows.push(row);
  }
  return rows;
}

/**
 * [REWRITE 2026-10-02] Semua receiver state (aktif + arsip era lama) untuk satu
 * percakapan, sudah didekripsi at-rest — bahan `pickChainState` (pola libsignal
 * SenderKeyRecord.states).
 */
export async function listGroupReceiverStates(
  conversationId: string
): Promise<Array<GroupReceiverState & { archivedAt?: number }>> {
  return enqueueWrite(async () => {
    const records = await listGroupReceiverRows(`${conversationId}_`);
    const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
    const out: Array<GroupReceiverState & { archivedAt?: number }> = [];

    for (const record of records) {
      const rawCk: unknown = record.state.CK;
      const ckString = typeof rawCk === 'string'
        ? rawCk
        : rawCk instanceof Uint8Array
          ? sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING)
          : '';
      const ckPlain = await decryptValueAtRest(ckString);
      if (ckPlain === null) continue;

      out.push({
        id: record.id,
        conversationId: asConversationId(conversationId),
        senderId: asUserId(record.state.senderId || ''),
        CK: ckPlain,
        N: record.state.N,
        eraCK: record.state.eraCK,
        chainId: record.state.chainId,
        // [AUDIT FIX 2026-10-05] metadataKey WAJIB ikut — decryptGroupMetadata
        // v2 mengambil metadataKey era via findGroupReceiverState (yang baca
        // lewat sini). Tanpa ini metadata v2 selamanya gagal
        // "metadataKey era belum tersedia" walau state-nya ada.
        metadataKey: record.state.metadataKey
            ? (await decryptValueAtRest(record.state.metadataKey)) ?? undefined
            : undefined,
        skippedKeys: await decryptSkippedKeysAtRest(record.state.skippedKeys ?? {}),
        signingKey: record.state.signingKey,
        signingKeyV2: record.state.signingKeyV2,
        senderKeyId: record.state.senderKeyId,
        archivedAt: (record.state as { archivedAt?: number }).archivedAt
      });
    }
    return out;
  });
}

/**
 * [REWRITE 2026-10-02 — ROUTING ALA LIBSIGNAL] Pilih receiver state untuk sebuah
 * wrapper: chainId → state (aktif lalu arsip, via `pickChainState`); bila tidak
 * ada yang cocok, jatuh ke state AKTIF milik device pengirim (posisi mundur
 * ditangani skipped-key map di dalam state). Tidak ada lagi penebakan lintas era.
 */
export async function findGroupReceiverState(
  conversationId: string,
  ref: { chainId?: string },
  senderId?: string,
  senderDeviceKey?: string
): Promise<GroupReceiverState | null> {
  const all = await listGroupReceiverStates(conversationId);
  const forDevice = senderDeviceKey
    ? all.filter(s => s.id.includes(senderDeviceKey))
    : all;

  const picked = pickChainState(forDevice.length > 0 ? forDevice : all, ref);
  if (picked) return picked;

  if (senderDeviceKey || senderId) {
    return getGroupReceiverState(conversationId, senderId ?? '', senderDeviceKey);
  }
  return null;
}

