import Dexie, { Table } from 'dexie';
import { orderBucketOf } from './localOrderBucket';
import type { Message } from '@store/conversation';
import type { ConversationId, UserId, MessageId, StoryId, DoubleRatchetState } from '@nyx/shared';
import type { GroupRatchetState } from '../types/crypto-common';
import type { BurnerDoubleRatchetState } from '../workers/crypto.worker';

// --- Interfaces for ShadowVault (Messages) ---
export interface DecryptedMessageRecord {
  id: MessageId;
  conversationId: ConversationId;
  content: string | null; // ENCRYPTED Base64 string at rest
  // [docs/30 WS-F langkah 3] `repliedToId`, `senderId`, `isViewOnce`,
  // `isDeletedLocal`, `expiresAt` di-seal **di tempat** (`ENC1:`), jadi tipenya
  // menerima bentuk lama juga. Tidak ada indeks yang bergantung padanya lagi
  // (lihat versi 10 di bawah): pembacaannya lewat `openLocalText`/`openLocalFlag`.
  repliedToId?: string | null;
  repliedTo?: string; // Encrypted JSON string of the replied message
  // [BUGFIX 2026-10-18] Reaksi (`Message.reactions`) ikut dipersist. Sebelumnya
  // kolom ini tidak ada sehingga reaksi hidup hanya di memori: berpindah
  // percakapan (store di-replace dari vault) dan reload menghapusnya.
  // Disimpan sebagai JSON TER-SEAL (`ENC1:`) — emoji + userId = metadata
  // perilaku, sama kelas dengan `senderId`/`repliedToId` (docs/30 WS-F).
  reactions?: string | null;
  // [BUGFIX 2026-10-18] Status baca (`Message.statuses`: DELIVERED/READ per
  // penerima) ikut dipersist. Sebelumnya kolomnya tidak ada, jadi
  // `updateMessageStatus` "menyimpan" ke vault yang membuang field itu — peta
  // centang biru hidup hanya di memori dan hilang saat reload / ganti
  // percakapan. Bentuknya sama dengan `reactions`: JSON TER-SEAL (`ENC1:`),
  // karena userId + waktu baca = metadata perilaku (docs/30 WS-F).
  statuses?: string | null;
  // [BUGFIX 2026-10-18] Penanda pesan AUTO-DELETE (timer yang benar-benar
  // dipilih pengirim), bukan TTL store-and-forward server yang selalu ada di
  // `expiresAt`. Tanpa penanda ini, indikator hitung-mundur muncul di SEMUA
  // pesan. Disimpan sebagai flag ter-seal (`ENC1:`) — pola yang sama dengan
  // `isViewOnce`/`isDeletedLocal`.
  autoDelete?: boolean | string;
  // [docs/30 WS-F] `createdAt` adalah **bentuk lama** (plaintext ISO/Date) yang
  // masih dibaca dari baris yang belum ditulis ulang; baris baru menyimpannya
  // ter-seal di `createdAtSealed` dan mengosongkan kolom ini (`null`).
  createdAt: string | Date | null;
  // [docs/30 WS-F] lapis presisi ter-seal (`ENC1:`, envelope yang sama dengan `seq`).
  createdAtSealed?: string | null;
  // [docs/30 WS-F] lapis indeks: waktu di-floor ke bucket 15 menit (plaintext).
  // Satu-satunya kolom yang boleh dipakai untuk range-scan/paginasi.
  orderBucketMs?: number | null;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  senderId: string;
  senderName?: string; // Encrypted sender name
  senderUsername?: string; // Encrypted sender username
  senderAvatarUrl?: string; // Encrypted avatar URL
  isViewOnce?: boolean | string;
  isDeletedLocal?: boolean | string;
  fileMeta?: string;
  expiresAt?: string | number | null;
  // [docs/28 Tier 2 — B2] waktu kirim presisi (dari ciphertext).
  // [docs/30 WS-F] di-seal DI TEMPAT (`ENC1:`, pola yang sama dengan `seq`):
  // presisi ms = pola aktivitas per pesan, jadi tidak boleh plaintext di
  // IndexedDB. Tidak ada indeks yang memakainya; baris lama berbentuk angka
  // plaintext tetap terbaca lewat `openLocalNumber`.
  sentAt?: number | string;
  // [docs/28 Tier 2 — B1] seq per-conversation (urutan & kursor paginasi SERVER).
  // Tanpa ini, setelah reload `oldestMessage.seq` hilang → fetch-older jatuh ke
  // kursor ISO-date legacy yang bisa mengulang sebagian halaman.
  // [docs/29 §5.5] disimpan sebagai envelope `ENC1:` (string); baris lama masih
  // berbentuk angka plaintext → tipe union, dibaca lewat `openLocalNumber()`.
  seq?: number | string;
}

export interface PqDrSessionRecord {
  id: string; // Composite key: conversationId_deviceId
  conversationId: string;
  state: BurnerDoubleRatchetState;
  peerClassicalPk: string | null;
  peerDeviceId: string | null;
  version: number;
  negotiationStatus: 'INITIATED' | 'ESTABLISHED' | 'FAILED';
  // [docs/30 WS-F] waktu aktivitas sesi PQ-DR di-seal (`ENC1:`) — presisi ms
  // per sesi mengungkap kapan sebuah kontak terakhir diajak bicara. Baris lama
  // berbentuk angka plaintext tetap terbaca lewat `openLocalNumber`.
  lastActivity: number | string;
}

// --- Interfaces for OfflineQueue ---
export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

// --- Interfaces for Keychain (Signal Protocol) ---
export interface SessionKey {
  storageKey: string; // conversationId_sessionId
  conversationId: ConversationId;
  sessionId: string;
  key: Uint8Array;
}

export interface GroupKey {
  conversationId: ConversationId;
  key: Uint8Array;
}

// Menyelaraskan dengan output worker_generate_otpk_batch
export interface PreKey {
  keyId: number;
  pqPublicKey?: string;
  encryptedPrivateKey: Uint8Array;
}
export interface IdentityKey {
  userId: UserId;
  key: string; // Base64 public key (Gabungan X-Wing + Ed25519)
}

// Menggunakan tipe State yang sesuai dari shared
export interface RatchetSession {
  conversationId: ConversationId;
  state: Uint8Array; // serialized encrypted state
}

// Menggunakan tipe State yang sesuai dari crypto-common
export interface GroupSenderState {
  conversationId: ConversationId;
  state: GroupRatchetState; // serialized state
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  state: GroupRatchetState; // serialized state
}

export interface SkippedKey {
  headerKey: string; // format: conversationId_kemPk_n
  key: Uint8Array;
}

export interface MessageKey {
  messageId: MessageId;
  key: Uint8Array;
}

export interface PendingHeader {
  conversationId: ConversationId;
  header: Record<string, unknown>;
}

// --- Interface for KeyStorage (KV) ---
export interface KVItem {
  key: string;
  value: unknown;
}

export interface VaultEntry {
  key: unknown;
  value: unknown;
}

export interface ProfileCacheRecord {
  id: UserId;
  name: string;
  avatarUrl: string | null;
  description: string | null;
  encryptedHash: string; // Hash profil terenkripsi untuk deteksi perubahan
  // [docs/30 WS-F §30.10] waktu penulisan cache — tidak ada indeks/query yang
  // memakainya, jadi disimpan sebagai envelope `ENC1:` (baris lama masih
  // angka plaintext; tidak ada pembaca, jadi tidak perlu `openLocalNumber`).
  updatedAt: number | string;
}

export interface ConversationRecord {
  id: ConversationId;
  // [docs/30 WS-F langkah 3] `isGroup` di-seal di tempat (`ENC1:` atau boolean
  // baris lama) — tidak ada query yang memakainya sebagai indeks; `isPinned`/
  // `isArchived` memang tidak pernah ditulis siapa pun.
  isGroup: boolean | string;
  encryptedMetadata: string | null;
  decryptedMetadata: string | null; // Encrypted JSON string of decrypted group metadata
  lastMessageAt: string | Date | null;
  participants: string; // Encrypted JSON string of Participant[]
  isPinned?: boolean;
  isArchived?: boolean;
}

// [CONTACT STORE 2026-10-05] Record kontak per peer — satu-satunya daftar
// "user yang pernah bertukar pesan" yang persisten. Kolom `data` berisi JSON
// ContactRecord TERENKRIPSI (encryptVaultText — kunci deterministik dari
// identity private key, jadi bisa di-restore lintas device via bundle).
// Lihat lib/contactStore.ts untuk CRUD + sinkronisasi.
/**
 * [docs/34 §34.6 poin 2] State monitoring Key Transparency per search key.
 *
 * Satu baris per `0x75||usernameHash(32)` yang pernah diverifikasi klien.
 * Semua nilai bukti di-seal `ENC1:` (masterSeed) — IndexedDB tidak boleh
 * menyimpan tree head/monitoring data dalam bentuk terbaca, karena keduanya
 * mengungkap kontak mana yang dimonitor. `searchKeyHex` sengaja plaintext:
 * ia sudah hash 32 byte (tidak reversible), dan ia satu-satunya kunci indeks.
 */
export interface KtMonitoringRecord {
  searchKeyHex: string; // PK (hex dari search key)
  /** `StoredTreeHead` (base64url) ter-seal, `null` bila belum ada bukti. */
  treeHead: string | null;
  /** `StoredMonitoringData` (base64url) ter-seal. */
  monitoringData: string | null;
  /** `StoredTreeHead` distinguished (anchor monitor) ter-seal. */
  distinguishedTreeHead: string | null;
  /** `keyVersion` terakhir yang terverifikasi (ter-seal, string angka). */
  keyVersion: string | null;
  /**
   * Ukuran pohon (`FullTreeHead.tree_head.tree_size`) saat bukti terakhir
   * diterima — ter-seal (string angka), `null` bila belum ada. Dikirim sebagai
   * `last` pada permintaan berikutnya supaya server menyertakan bukti
   * konsistensi.
   */
  treeSize: string | null;
  /** Waktu tulis terakhir (ter-seal, ISO). */
  updatedAt: string;
}

/**
 * [docs/30 §30.5 tahap C] Baris tunggal gossip tree head (`web/src/lib/ktGossip.ts`).
 *
 * Satu baris menyimpan seluruh state gossip dalam satu JSON ter-seal: jangkar
 * terakhir yang dipercaya + head terakhir per sesi. Head peer mengungkap kapan
 * percakapan itu aktif (dan sesi mana yang dipakai), jadi tidak boleh plaintext —
 * `ENC1:` (masterSeed), pola yang sama dengan `ktMonitoring`.
 */
export interface KtGossipRow {
  id: string; // PK; selalu satu baris (lihat KT_GOSSIP_ROW_ID)
  blob: string; // JSON ter-seal (ENC1:)
}

export interface ContactRow {
  userId: UserId; // PK
  data: string; // ENCRYPTED JSON ContactRecord (base64 envelope)
  // [docs/30 WS-F §30.10] waktu tulis baris — satu-satunya kolom waktu kontak
  // yang dulu plaintext (pola aktivitas di IndexedDB). Tidak ada indeks/query
  // yang bergantung padanya; dibaca hanya sebagai fallback `firstSeenAt`/
  // `lastSeenAt` lewat `openLocalNumber` (baris lama plaintext tetap terbaca).
  updatedAt: number | string;
}

export class NyxDatabase extends Dexie {
  // ShadowVault
  messages!: Table<DecryptedMessageRecord, string>;
  conversations!: Table<ConversationRecord, string>;
  storyKeys!: Table<{ storyId: StoryId; key: string }, string>;

  // Profile Cache
  profileCache!: Table<ProfileCacheRecord, string>;

  // OfflineQueue
  offlineQueue!: Table<QueueItem, number>;

  // KeyStorage (KV)
  kvStore!: Table<KVItem, string>;

  // Keychain (Signal)
  sessionKeys!: Table<SessionKey, string>;
  groupKeys!: Table<GroupKey, string>;
  preKeys!: Table<PreKey, number>; // OTPKs
  identityKeys!: Table<IdentityKey, string>; // Profile Keys
  ratchetSessions!: Table<RatchetSession, string>;
  groupSenderStates!: Table<GroupSenderState, string>;
  groupReceiverStates!: Table<GroupReceiverState, string>;
  skippedKeys!: Table<SkippedKey, string>;
  messageKeys!: Table<MessageKey, string>;
  pendingHeaders!: Table<PendingHeader, string>;
  groupSkippedKeys!: Table<{ key: string; mk: string }, string>;
  pqDrSessions!: Table<Record<string, unknown>, string>; // Legacy
  pqDrSessionsV2!: Table<PqDrSessionRecord, string>;
  groupCachedParticipants!: Table<{ conversationId: string; userIds: string[] }, string>;

  // Contact Store (P1 2026-10-05)
  contacts!: Table<ContactRow, string>;

  // [docs/34 §34.6] State monitoring Key Transparency (per search key).
  ktMonitoring!: Table<KtMonitoringRecord, string>;

  // [docs/30 §30.5 tahap C] Jangkar + head peer untuk deteksi split-view.
  ktGossip!: Table<KtGossipRow, string>;

  constructor() {
    super('NyxUnifiedDB');
    
    // Define schema
    this.version(1).stores({
      // ShadowVault
      messages: 'id, conversationId, [conversationId+createdAt], senderId, isDeletedLocal',
      storyKeys: 'storyId',

      // OfflineQueue
      offlineQueue: 'tempId, timestamp',

      // KeyStorage
      kvStore: 'key',

      // Keychain
      sessionKeys: 'storageKey, conversationId', // Indexed by storageKey (PK) and conversationId
      groupKeys: 'conversationId',
      preKeys: 'keyId',
      identityKeys: 'userId',
      ratchetSessions: 'conversationId',
      groupSenderStates: 'conversationId',
      groupReceiverStates: 'id',
      skippedKeys: 'headerKey',
      messageKeys: 'messageId',
      pendingHeaders: 'conversationId',
      groupSkippedKeys: 'key'
    });

    this.version(2).upgrade(trans => {
      return trans.table('preKeys').toCollection().modify((preKey: Record<string, unknown>) => {
        if (preKey.keyPair) {
          preKey.encryptedPrivateKey = preKey.keyPair;
          delete preKey.keyPair;
        }
      });
    });

    this.version(3).stores({
      pqDrSessions: 'conversationId'
    });

    this.version(4).stores({
      pqDrSessionsV2: 'id, conversationId'
    }).upgrade(async trans => {
      // Migrate existing sessions to V2
      const oldSessions = await trans.table('pqDrSessions').toArray();
      const newSessions = oldSessions.map(session => ({
        ...session,
        id: `${session.conversationId}_${session.peerDeviceId || 'unknown'}`
      }));
      await trans.table('pqDrSessionsV2').bulkAdd(newSessions);
    });

    this.version(6).stores({
      conversations: 'id, isGroup',
      profileCache: 'id'
    });

    this.version(7).stores({
      groupCachedParticipants: 'conversationId'
    });

    this.version(8).stores({
      contacts: 'userId'
    });

    // [docs/30 WS-F] v9 — kolom pengurutan pesan di-seal, diganti indeks bucket.
    //
    // `messages` dulu diindeks langsung pada `createdAt` presisi; setelah
    // `createdAt` jadi envelope `ENC1:` (ciphertext tidak punya urutan leksikal)
    // indeks itu tidak berguna, jadi range-scan dipindah ke `orderBucketMs`.
    //
    // Upgrade di sini sengaja HANYA mengisi bucket: perhitungannya murni
    // aritmetika waktu (masterSeed belum tentu tersedia saat DB dibuka), dan
    // IndexedDB mengisi indeks baru setelah callback upgrade pada data hasil
    // akhir — jadi baris lama langsung muncul di indeks tanpa perlu membuka kunci.
    // Lapis presisi baris lama tetap plaintext sampai baris ditulis ulang
    // (pola yang sama dengan `seq`, docs/29 §5.5) dan tetap terbaca lewat
    // `openOrderInstant`.
    this.version(9).stores({
      messages: 'id, conversationId, [conversationId+orderBucketMs], senderId, isDeletedLocal'
    }).upgrade(trans => {
      return trans.table('messages').toCollection().modify((row: DecryptedMessageRecord) => {
        if (typeof row.orderBucketMs === 'number') return;
        const bucket = orderBucketOf(row.createdAt ?? null);
        if (bucket !== null) row.orderBucketMs = bucket;
      });
    });

    // [docs/30 WS-F langkah 3] v10 — indeks sisa kolom struktur dilepas.
    //
    // `senderId` dan `isDeletedLocal` tidak pernah dipakai sebagai klausa query
    // (grep `.where('senderId')`/`.where('isDeletedLocal')` bersih), dan
    // `conversations.isGroup` juga tidak. Sekarang ketiganya di-seal, jadi
    // indeksnya bukan cuma tak terpakai — isinya jadi ciphertext acak. Tidak ada
    // migrasi data: baris lama tetap plaintext sampai ditulis ulang dan tetap
    // terbaca lewat `openLocalText`/`openLocalFlag`.
    this.version(10).stores({
      messages: 'id, conversationId, [conversationId+orderBucketMs]',
      conversations: 'id'
    });

    // [docs/34 §34.6 poin 2] v11 — tabel state monitoring KT. Murni aditif: tidak
    // ada baris lama yang perlu diubah, jadi tidak ada callback `upgrade`.
    this.version(11).stores({
      ktMonitoring: 'searchKeyHex'
    });

    // [docs/34 §34.6 poin 1] v12 — `KtMonitoringRecord.treeSize` (ukuran pohon
    // terakhir yang SUDAH dipercaya). Bukti konsistensi hanya dinyalakan server
    // bila klien mengirim `last`; tanpa kolom ini klien kehilangan angkanya
    // setelah reload dan verifikasi ber-anchor gagal `Malformed proof`.
    // Murni aditif (kolom baru, baris lama `null`), jadi tanpa `upgrade`.
    this.version(12).stores({
      ktMonitoring: 'searchKeyHex'
    });

    // [docs/30 §30.5 tahap C] v13 — tabel gossip (`ktGossip`): jangkar tree head
    // yang dibagikan antar-klien + head terakhir per sesi. Murni aditif.
    this.version(13).stores({
      ktGossip: 'id'
    });
  }
}

export const db = new NyxDatabase();