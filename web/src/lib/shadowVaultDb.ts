import { db, DecryptedMessageRecord, PqDrSessionRecord } from './db';
import { Dexie } from 'dexie';
import type { Message, Conversation } from '@store/conversation';
import { getSodium } from '@lib/sodiumInitializer';
import { getMyEncryptionKeyPair } from '@utils/crypto';
import { asMessageId, asConversationId, asUserId } from '@nyx/shared';
import type { StoryId } from '@nyx/shared';
// [docs/29 §5.5/§7.3] bucket waktu + seal metadata lokal (vault).
import {
  bucketLocalTimestamp,
  openLocalFlag,
  openLocalNumber,
  openLocalText,
  sealLocalFlag,
  sealLocalNumber,
  sealLocalText,
} from './localAtRest';
import { AT_REST_PREFIX } from './keychainDb';
// [docs/30 WS-F] skema urutan terenkripsi untuk kolom pengurutan pesan.
import {
  ensureOrderFields,
  hasIndexableOrder,
  openOrderInstant,
  orderBucketOf,
  pickOlderPage,
  previousOrderBucket,
  resolveOrderInstants,
} from './localOrderKey';

// --- CRYPTO ENGINE FOR IRON VAULT ---
// Kunci vault (deterministik dari identity private key) di-cache per sesi —
// sebelumnya di-derive ulang (crypto_generichash) di SETIAP encrypt/decrypt pesan.
let vaultKeyCache: { key: Uint8Array; privateKeyRef: Uint8Array } | null = null;

/**
 * [docs/30 WS-F langkah 3] Baca `expiresAt` dari baris vault: ms ter-seal
 * (baris baru) atau ISO plaintext (baris lama). `openLocalNumber` sendirian
 * tidak cukup — ISO legacy akan jadi `NaN` → `null`, dan baris kedaluwarsa
 * warisan itu akan lolos saringan.
 */
const readExpiresAt = async (raw: string | number | null | undefined): Promise<number | null> => {
  const sealed = await openLocalNumber(raw ?? null);
  if (sealed !== null) return sealed;
  if (typeof raw === 'string' && raw.length > 0) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

const getVaultKey = async () => {
  const { privateKey } = await getMyEncryptionKeyPair();
  if (!privateKey) {
    vaultKeyCache = null;
    throw new Error("Vault locked: Identity key not found in memory.");
  }
  if (vaultKeyCache && vaultKeyCache.privateKeyRef === privateKey) {
    return vaultKeyCache.key;
  }
  const sodium = await getSodium();
  // Derive a deterministic 32-byte symmetric key from the user's private key
  const key = sodium.crypto_generichash(32, privateKey, null);
  vaultKeyCache = { key, privateKeyRef: privateKey };
  return key;
};

export const encryptVaultText = async (text: string): Promise<string> => {
  // Canonical XChaCha envelope — AEAD dijalankan di crypto worker
  const key = await getVaultKey();
  const sodium = await getSodium();
  const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const { workerXChaChaSeal } = await import('@lib/crypto-worker-proxy');
  return workerXChaChaSeal(keyB64, text);
};

export const decryptVaultText = async (encryptedBase64: string): Promise<string | null> => {
  try {
    const key = await getVaultKey();
    const sodium = await getSodium();
    const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
    const { workerXChaChaOpen } = await import('@lib/crypto-worker-proxy');
    return await workerXChaChaOpen(keyB64, encryptedBase64);
  } catch (_e) {
    return null; // Silent fail for corrupted/old data
  }
};
// ------------------------------------

class NyxShadowVaultProxy {
  get messages() {
    return db.messages;
  }

  get storyKeys() {
    return db.storyKeys;
  }

  async savePqDrSession(record: Omit<PqDrSessionRecord, 'id'> & { id?: string }): Promise<void> {
    try {
      const encryptedState = await encryptVaultText(JSON.stringify(record.state));
      const id = record.id || `${record.conversationId}_${record.peerDeviceId || 'unknown'}`;
      await db.pqDrSessionsV2.put({
        ...record,
        id,
        state: encryptedState as unknown as PqDrSessionRecord['state'] 
      });
    } catch (e) {
      console.error("Failed to save PQ-DR session:", e);
    }
  }

  async getPqDrSession(conversationId: string, peerDeviceId?: string): Promise<PqDrSessionRecord | undefined> {
    try {
      // If we have a specific device, fetch that exact session
      if (peerDeviceId) {
          const id = `${conversationId}_${peerDeviceId}`;
          const record = await db.pqDrSessionsV2.get(id);
          if (!record) return undefined;
          return this.decryptPqDrSession(record);
      }

      // Fallback: Get the most recently active session for this conversation
      const records = await db.pqDrSessionsV2.where('conversationId').equals(conversationId).toArray();
      if (records.length === 0) return undefined;

      records.sort((a, b) => b.lastActivity - a.lastActivity);
      return records[0] ? this.decryptPqDrSession(records[0]) : undefined;
    } catch (e) {
      console.error("Failed to get PQ-DR session:", e);
      return undefined;
    }
  }

  private async decryptPqDrSession(record: PqDrSessionRecord): Promise<PqDrSessionRecord | undefined> {
      if (typeof record.state === 'string') {
        const decryptedStateStr = await decryptVaultText(record.state);
        if (decryptedStateStr) {
          return {
            ...record,
            state: JSON.parse(decryptedStateStr)
          };
        }
      }
      return undefined;
  }

  async hasPqDrSession(conversationId: string): Promise<boolean> {
    try {
      const count = await db.pqDrSessionsV2.where('conversationId').equals(conversationId).count();
      return count > 0;
    } catch (e) {
      console.error("Failed to check PQ-DR session:", e);
      return false;
    }
  }

  async deletePqDrSession(conversationId: string, peerDeviceId?: string): Promise<void> {
    try {
      if (peerDeviceId) {
         await db.pqDrSessionsV2.delete(`${conversationId}_${peerDeviceId}`);
      } else {
         const records = await db.pqDrSessionsV2.where('conversationId').equals(conversationId).primaryKeys();
         await db.pqDrSessionsV2.bulkDelete(records);
      }
    } catch (e) {
      console.error("Failed to delete PQ-DR session:", e);
    }
  }

  async exportDatabase(): Promise<string> {
    try {
      const messages = await db.messages.toArray();
      return JSON.stringify({ messages });
    } catch (e) {
      console.error("Export DB failed:", e);
      return "{}";
    }
  }

  async importDatabase(jsonString: string): Promise<void> {
    try {
      const data = JSON.parse(jsonString);
      if (data.messages && Array.isArray(data.messages)) {
        // [docs/30 WS-F] baris impor/restore wajib punya `orderBucketMs`, kalau
        // tidak pesannya tersimpan tapi tidak pernah muncul di query mana pun
        // (tidak ada di indeks `[conversationId+orderBucketMs]`).
        const normalized: DecryptedMessageRecord[] = [];
        for (const row of data.messages as DecryptedMessageRecord[]) {
          normalized.push(await ensureOrderFields(row));
        }
        await db.messages.bulkPut(normalized);
        console.log(`[ShadowVault] Successfully imported ${normalized.length} messages.`);
      }
    } catch (e) {
      console.error("Import DB failed:", e);
    }
  }

  /** Nilai sudah berupa envelope `ENC1:`? (baris baru vs plaintext lama) */
  private static isSealed(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith(AT_REST_PREFIX);
  }

  /**
   * [docs/30 WS-F §30.10 poin 2] Migrasi at-rest vault untuk baris lama:
   * menyegel kolom struktur yang masih plaintext (klien sebelum Dexie v9/v10)
   * dan mengisi bucket indeks — dijalankan sekali setelah sesi ter-unlock
   * (`saveDeviceAutoUnlockKey`, rel yang sama dengan migrasi keychain).
   *
   * Idempoten dan aman dijalankan berulang: baris yang sudah ter-seal dan
   * ber-bucket tidak ditulis ulang. Bila vault masih terkunci (`seal*`
   * mengembalikan `null`), plaintext **tidak** dihapus — satu-satunya sumber
   * waktu/identitas baris itu tidak boleh hilang karena migrasi yang gagal.
   *
   * Mengembalikan jumlah baris (pesan + percakapan) yang diperbarui.
   */
  async migrateAtRestSealing(): Promise<number> {
    let updated = 0;
    try {
      const rows = await db.messages.toArray();
      const sealedRows: DecryptedMessageRecord[] = [];
      for (const row of rows) {
        const sealed = await this.sealLegacyStructFields(row);
        if (sealed) sealedRows.push(sealed);
      }
      if (sealedRows.length > 0) await db.messages.bulkPut(sealedRows);
      updated += sealedRows.length;

      const convs = await db.conversations.toArray();
      const sealedConvs: typeof convs = [];
      for (const conv of convs) {
        if (typeof conv.isGroup !== 'boolean') continue;
        const sealed = await sealLocalFlag(conv.isGroup);
        if (!sealed) continue; // vault terkunci
        sealedConvs.push({ ...conv, isGroup: sealed });
      }
      if (sealedConvs.length > 0) await db.conversations.bulkPut(sealedConvs);
      updated += sealedConvs.length;

      // [docs/30 WS-F §30.10] Kolom waktu yang masih plaintext di tabel lain:
      // `ContactRow.updatedAt` (pola aktivitas per kontak) dan
      // `ProfileCacheRecord.updatedAt`. Tidak ada indeks/query yang
      // bergantung padanya, jadi cukup di-seal di tempat; baris yang sudah
      // ter-seal dilewati (idempoten).
      const contacts = await db.contacts.toArray();
      const sealedContacts = [];
      for (const contact of contacts) {
        if (typeof contact.updatedAt !== 'number') continue;
        const sealed = await sealLocalNumber(contact.updatedAt);
        if (!sealed) continue; // vault terkunci
        sealedContacts.push({ ...contact, updatedAt: sealed });
      }
      if (sealedContacts.length > 0) await db.contacts.bulkPut(sealedContacts);
      updated += sealedContacts.length;

      const profiles = await db.profileCache.toArray();
      const sealedProfiles = [];
      for (const profile of profiles) {
        if (typeof profile.updatedAt !== 'number') continue;
        const sealed = await sealLocalNumber(profile.updatedAt);
        if (!sealed) continue; // vault terkunci
        sealedProfiles.push({ ...profile, updatedAt: sealed });
      }
      if (sealedProfiles.length > 0) await db.profileCache.bulkPut(sealedProfiles);
      updated += sealedProfiles.length;
    } catch (e) {
      console.error('[ShadowVault] At-rest sealing migration failed:', e);
    }
    return updated;
  }

  /**
   * Seal kolom struktur satu baris pesan bila masih plaintext. `null` = tidak
   * ada yang berubah (sudah ter-seal semua) atau vault terkunci.
   */
  private async sealLegacyStructFields(
    row: DecryptedMessageRecord
  ): Promise<DecryptedMessageRecord | null> {
    const ordered = await ensureOrderFields(row);
    const next: DecryptedMessageRecord = { ...ordered };
    let changed =
      (ordered.orderBucketMs ?? null) !== (row.orderBucketMs ?? null) ||
      (ordered.createdAtSealed ?? null) !== (row.createdAtSealed ?? null) ||
      (ordered.createdAt ?? null) !== (row.createdAt ?? null);

    if (typeof next.senderId === 'string' && !NyxShadowVaultProxy.isSealed(next.senderId)) {
      const sealed = await sealLocalText(next.senderId);
      if (sealed) {
        next.senderId = sealed;
        changed = true;
      }
    }

    if (
      typeof next.repliedToId === 'string' &&
      next.repliedToId.length > 0 &&
      !NyxShadowVaultProxy.isSealed(next.repliedToId)
    ) {
      const sealed = await sealLocalText(next.repliedToId);
      if (sealed) {
        next.repliedToId = sealed;
        changed = true;
      }
    }

    for (const key of ['isViewOnce', 'isDeletedLocal'] as const) {
      if (typeof next[key] === 'boolean') {
        const sealed = await sealLocalFlag(next[key]);
        if (sealed) {
          next[key] = sealed;
          changed = true;
        }
      }
    }

    if (typeof next.expiresAt === 'number' && Number.isFinite(next.expiresAt)) {
      const sealed = await sealLocalNumber(next.expiresAt);
      if (sealed) {
        next.expiresAt = sealed;
        changed = true;
      }
    } else if (
      typeof next.expiresAt === 'string' &&
      next.expiresAt.length > 0 &&
      !NyxShadowVaultProxy.isSealed(next.expiresAt)
    ) {
      const ms = Date.parse(next.expiresAt);
      if (Number.isFinite(ms)) {
        const sealed = await sealLocalNumber(ms);
        if (sealed) {
          next.expiresAt = sealed;
          changed = true;
        }
      }
    }

    // `seq` adalah kolom ter-seal sejak docs/29 §5.5, tapi baris lama masih
    // menyimpan angka plaintext dan baru di-upgrade saat ditulis ulang —
    // migrasi unlock ini yang menutupnya tanpa menunggu perubahan pesan.
    if (typeof next.seq === 'number' && next.seq > 0) {
      const sealed = await sealLocalNumber(next.seq);
      if (sealed) {
        next.seq = sealed;
        changed = true;
      }
    }

    return changed ? next : null;
  }

  /**
   * [docs/30 WS-F] Rapikan indeks urutan setelah baris masuk **mentah**
   * (restore `.nyxbak`, impor JSON): baris arsip dari klien pra-v9 tidak punya
   * `orderBucketMs`, dan tanpa kolom itu ia tidak ada di indeks
   * `[conversationId+orderBucketMs]` → pesan tersimpan tapi tidak pernah muncul
   * di query berpaginasi. Sekaligus meng-upgrade lapis presisi baris lama ke
   * `ENC1:` (pola sama dengan `seq`).
   *
   * Idempoten: baris yang sudah ber-indeks + ter-seal tidak ditulis ulang.
   * Mengembalikan jumlah baris yang diperbarui.
   */
  async normalizeOrderIndex(): Promise<number> {
    const rows = await db.messages.toArray();
    const updates: DecryptedMessageRecord[] = [];
    for (const row of rows) {
      if (hasIndexableOrder(row) && row.createdAtSealed) continue;
      const normalized = await ensureOrderFields(row);
      // Bandingkan dengan `?? null` supaya baris tanpa waktu sama sekali
      // (`orderBucketMs` undefined ↔ null, tak ada yang bisa diberi bucket)
      // tidak terus-menerus dianggap "diperbaiki".
      if (
        (normalized.orderBucketMs ?? null) !== (row.orderBucketMs ?? null) ||
        (normalized.createdAtSealed ?? null) !== (row.createdAtSealed ?? null) ||
        (normalized.createdAt ?? null) !== (row.createdAt ?? null)
      ) {
        updates.push(normalized);
      }
    }
    if (updates.length > 0) await db.messages.bulkPut(updates);
    return updates.length;
  }

  async upsertMessages(messages: Message[]) {
    // Filter messages: Allow if it's a chat-relevant type (TEXT/FILE) OR it is a tombstone.
    // Exclude internal system control payloads like GROUP_KEY which should only live in the keychain.
    const validMessages = messages.filter(m => {
      // 1. Check for system control types (strictly exclude from UI vault)
      if ((m as Record<string, unknown>).type === 'GROUP_KEY' || (m as Record<string, unknown>).type === 'KEY_SYNC') return false;

      // 2. Check for valid chat content or state
      const hasContent = m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('[') && !m.content.startsWith('{');
      const isFile = !!(m.fileUrl || m.isBlindAttachment);
      const isTombstone = !!m.isDeletedLocal;

      // [INVARIANT 3 — 2026-10-02] Bubble FAILURE JANGAN pernah masuk vault.
      // Dulu string gagal berbahasa Indonesia ("🔒 Pesan gagal didekripsi…",
      // "[Message too old to decrypt]") lolos filter hasContent → ter-poison
      // permanen, dan Shield "Prevented overwriting valid local message"
      // melindungi content GAGAL itu dari perbaikan. m.error adalah sumber
      // kebenaran (string gagal bervariasi per i18n/kasus).
      if (m.error) return false;
      if (hasContent && typeof m.content === 'string' && m.content.includes('Pesan gagal didekripsi')) return false;

      return hasContent || isFile || isTombstone;
    });

    if (validMessages.length === 0) return;

    try {
      const records: DecryptedMessageRecord[] = [];
      for (const m of validMessages) {
        const existing = await db.messages.get(m.id);
        
        let encryptedContent: string | null = null;
        let encryptedRepliedTo: string | undefined = undefined;
        let encryptedSenderName: string | undefined = undefined;
        let encryptedSenderUsername: string | undefined = undefined;
        let encryptedSenderAvatarUrl: string | undefined = undefined;
        let encryptedFileMeta: string | undefined = undefined;

        if (m.content && !m.isDeletedLocal) {
            encryptedContent = await encryptVaultText(m.content);
        }
        
        if (m.repliedTo) {
             const repliedToStr = JSON.stringify(m.repliedTo);
             encryptedRepliedTo = await encryptVaultText(repliedToStr);
        } else if (existing?.repliedTo) {
             encryptedRepliedTo = existing.repliedTo;
        }

        const mSender = m.sender as { name?: string; username?: string; avatarUrl?: string } | undefined;
        const hasValidName = mSender?.name && mSender.name !== 'Unknown' && mSender.name !== 'Encrypted User';
        
        if (hasValidName) {
            encryptedSenderName = (await encryptVaultText(String(mSender.name))) || undefined;
            if (mSender.username) {
                encryptedSenderUsername = await encryptVaultText(mSender.username);
            }
            if (mSender.avatarUrl) {
                encryptedSenderAvatarUrl = await encryptVaultText(mSender.avatarUrl);
            }
        } else if (existing?.senderName) {
            encryptedSenderName = existing.senderName;
            encryptedSenderUsername = existing.senderUsername;
            encryptedSenderAvatarUrl = existing.senderAvatarUrl;
        } else if (mSender?.avatarUrl) {
            encryptedSenderAvatarUrl = await encryptVaultText(mSender.avatarUrl);
        }

        if (m.fileUrl || m.isBlindAttachment) {
            encryptedFileMeta = await encryptVaultText(JSON.stringify({
                fileUrl: m.fileUrl,
                fileKey: m.fileKey,
                fileName: m.fileName,
                fileType: m.fileType,
                fileSize: m.fileSize,
                duration: m.duration,
                isBlindAttachment: m.isBlindAttachment
            }));
        }
        
        // [docs/30 WS-F langkah 3] kolom struktur yang tidak dipakai untuk
        // pengurutan/seleksi di-seal di tempat. `existing?.*` (baris lama) tetap
        // dipakai apa adanya — sudah berbentuk envelope atau plaintext legacy
        // yang tetap terbaca; menulisnya ulang tidak menambah privasi.
        // `expiresAt`: nilai baru menang; kalau pesan tidak membawa expiry,
        // pertahankan baris lama APA ADANYA (sudah ter-seal atau ISO legacy) —
        // mengurai envelope dengan `Date.parse` akan menghapus expiry-nya.
        let expiresAtRaw: string | number | null = existing?.expiresAt ?? null;
        if (m.expiresAt) {
          const ms = Date.parse(m.expiresAt);
          expiresAtRaw = Number.isFinite(ms) ? (await sealLocalNumber(ms)) ?? ms : null;
        }

        records.push(await ensureOrderFields({
          id: m.id,
          conversationId: m.conversationId,
          content: encryptedContent, 
          repliedToId: m.repliedToId
            ? (await sealLocalText(m.repliedToId)) ?? m.repliedToId
            : existing?.repliedToId,
          repliedTo: encryptedRepliedTo,
          // [docs/28 Tier 2 — B3] waktu presisi (sentAt) bila ada, supaya
          // paginasi/urutan lokal tidak terganggu createdAt server yang kasar.
          // [docs/30 WS-F] `ensureOrderFields` memindahkannya ke lapis ter-seal
          // (`createdAtSealed`) + bucket indeks, dan mengosongkan kolom ini.
          createdAt: m.sentAt ? new Date(m.sentAt).toISOString() : m.createdAt,
          senderId: (await sealLocalText(m.senderId)) ?? m.senderId,
          senderName: encryptedSenderName,
          senderUsername: encryptedSenderUsername,
          senderAvatarUrl: encryptedSenderAvatarUrl,
          isViewOnce: (await sealLocalFlag(m.isViewOnce)) ?? m.isViewOnce,
          isDeletedLocal: (await sealLocalFlag(m.isDeletedLocal)) ?? m.isDeletedLocal,
          fileMeta: encryptedFileMeta || existing?.fileMeta,
          expiresAt: expiresAtRaw,
          // [docs/28 Tier 2 — B2] waktu presisi dari ciphertext (bukan milik server).
          sentAt: m.sentAt ?? existing?.sentAt,
          // [docs/28 Tier 2 — B1] seq disimpan agar kursor paginasi SERVER tetap
          // presisi setelah reload (bukan jatuh ke ISO-date legacy). Baris yang
          // belum pernah di-ACK (pending) belum punya seq → undefined.
          // [docs/29 §5.5] disimpan sebagai envelope `ENC1:`, bukan angka
          // plaintext: seq membocorkan volume/urutan aktivitas percakapan.
          seq: (typeof m.seq === 'number' && m.seq > 0)
            ? (await sealLocalNumber(m.seq)) ?? undefined
            : existing?.seq
        }));
      }
      await db.messages.bulkPut(records);
    } catch (err) {
      console.error("Iron Vault Encryption Error:", err);
    }
  }

  async getMessagesByConversation(conversationId: string, limit: number = 50, beforeDate?: string): Promise<Message[]> {
    try {
      const now = Date.now();
      const parsedBefore = beforeDate ? Date.parse(beforeDate) : Number.NaN;
      // Kursor tetap **inklusif** seperti perintah lama (`between` dua sisi tertutup).
      const beforeMs = Number.isFinite(parsedBefore) ? parsedBefore : null;

      // [docs/30 WS-F] Kandidat diambil PER BUCKET UTUH dari indeks
      // `[conversationId+orderBucketMs]` — bukan rentang yang dipotong `limit`,
      // karena indeks mengurutkan kunci bucket yang sama berdasarkan primary
      // key: memotong di sana akan melewatkan baris lebih tua di dalam bucket
      // batas secara permanen (halaman berikutnya tidak menjemputnya lagi).
      // Presisi baru dipulihkan setelah kandidat terkumpul.
      const candidates: DecryptedMessageRecord[] = [];
      // Batas kerja satu halaman (32 × 15 menit ≈ 8 jam ke belakang) supaya
      // rangkaian bucket kosong di riwayat lama tidak menyapu seluruh masa lalu.
      // Kalau jendela ini habis sebelum halaman penuh (mis. percakapan berlanjut
      // keesokan hari), halaman kembali kosong dan store jatuh ke fallback fetch
      // server yang sudah ada — bukan mengulang-ulang seluruh masa lalu.
      const MAX_BUCKETS_PER_PAGE = 32;

      // Halaman pertama TIDAK boleh mulai dari `now`: percakapan yang sudah sepi
      // berhari-hari tidak akan punya bucket di 8 jam terakhir → chat tampak
      // kosong. Mulai dari bucket TERBARU yang benar-benar ada di percakapan ini
      // (satu baris dari indeks, `.reverse().limit(1)`), sedangkan halaman
      // berikutnya mulai dari bucket kursor.
      let bucket: number | null;
      if (beforeMs !== null) {
        bucket = orderBucketOf(beforeMs);
      } else {
        const newest = await db.messages
          .where('[conversationId+orderBucketMs]')
          .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
          .reverse()
          .limit(1)
          .toArray();
        bucket = newest[0]?.orderBucketMs ?? null;
      }

      for (let scanned = 0; bucket !== null && scanned < MAX_BUCKETS_PER_PAGE; scanned++) {
        const batch = await db.messages
          .where('[conversationId+orderBucketMs]')
          .equals([conversationId, bucket])
          .toArray();
        for (const row of batch) {
          // [docs/30 WS-F langkah 3] `expiresAt` tersimpan ter-seal (ms).
          const expiresAt = await readExpiresAt(row.expiresAt);
          if (expiresAt !== null && expiresAt <= now) continue;
          candidates.push(row);
        }
        if (candidates.length >= limit) break;
        bucket = previousOrderBucket(bucket);
      }

      const instants = await resolveOrderInstants(candidates);
      const { page: validRecords } = pickOlderPage(candidates, instants, limit, beforeMs);

      // Eksekusi pembersihan kadaluarsa tanpa memblokir thread
      queueMicrotask(async () => {
        try {
          // [docs/30 WS-F langkah 3] `expiresAt` ter-seal → tidak bisa disaring
          // lewat `.filter()` sinkron Dexie; ambil baris percakapan ini lalu
          // saring di memori (jalan di luar jalur kritis, via queueMicrotask).
          const rows = await db.messages.where('conversationId').equals(conversationId).toArray();
          const expired: string[] = [];
          for (const r of rows) {
            const expiresAt = await readExpiresAt(r.expiresAt);
            if (expiresAt !== null && expiresAt <= now) expired.push(r.id);
          }

          if (expired.length > 0) {
            await db.messages.bulkDelete(expired);
          }
        } catch (e) {
            console.error("Failed to clean expired messages:", e);
        }
      });

      return this.parseRecordsToMessages(validRecords);
    } catch (e: unknown) {
      console.error("Vault Query Error:", e);
      return [];
    }
  }

  private async parseRecordsToMessages(records: DecryptedMessageRecord[]): Promise<Message[]> {
     const messages: Message[] = [];
      for (const r of records) {
        // FIX 2: Hapus Zod parsing yang ketat di sini, karena record dari DB lokal sudah kita anggap valid bentuknya.
        // Zod parsing bisa memblokir pesan yang valid jika schema shared-nya sangat ketat.
        
        let plainText: string | null = null;
        let decryptedRepliedTo: Message | undefined = undefined;
        let decryptedSenderName: string | undefined = undefined;
        let decryptedSenderUsername: string | undefined = undefined;
        let decryptedSenderAvatarUrl: string | undefined = undefined;
        let decryptedFileMeta: Partial<Message> | undefined = undefined;

        // [docs/30 WS-F langkah 3] kolom struktur dibuka dari lapis ter-seal
        // (baris lama plaintext tetap terbaca — `openLocal*` menangani keduanya).
        const isDeletedLocal = (await openLocalFlag(r.isDeletedLocal)) === true;
        const isViewOnce = (await openLocalFlag(r.isViewOnce)) === true;
        const senderIdText = (await openLocalText(r.senderId)) ?? r.senderId;
        const repliedToIdText = r.repliedToId ? await openLocalText(r.repliedToId) : null;
        const expiresAtMs = await readExpiresAt(r.expiresAt);

        if (r.content && !isDeletedLocal) plainText = await decryptVaultText(r.content);
        if (r.repliedTo) {
            const rawRepliedTo = await decryptVaultText(r.repliedTo);
            if (rawRepliedTo) { 
                try { decryptedRepliedTo = JSON.parse(rawRepliedTo); } catch { /* not JSON */ } 
            }
        }
        if (r.senderName) decryptedSenderName = await decryptVaultText(r.senderName) || undefined;
        if (r.senderUsername) decryptedSenderUsername = await decryptVaultText(r.senderUsername) || undefined;
        if (r.senderAvatarUrl) decryptedSenderAvatarUrl = await decryptVaultText(r.senderAvatarUrl) || undefined;

        if (r.fileMeta) {
            const rawMeta = await decryptVaultText(r.fileMeta);
            if (rawMeta) { 
                try { decryptedFileMeta = JSON.parse(rawMeta); } catch { /* not JSON */ } 
            }
        }

        // FIX 3: Object construction yang konsisten dan strongly typed
        const msg: Message = {
          id: asMessageId(r.id),
          conversationId: asConversationId(r.conversationId),
          content: plainText,
          repliedToId: repliedToIdText ? asMessageId(repliedToIdText) : undefined,
          repliedTo: decryptedRepliedTo,
          // [docs/30 WS-F] presisi dipulihkan dari lapis ter-seal (baris baru)
          // atau plaintext lama. Baris tanpa waktu sama sekali tidak punya
          // urutan terpercaya → 1970 (paling tua), bukan `Invalid Date`.
          createdAt: new Date((await openOrderInstant(r)) ?? 0).toISOString(),
          senderId: asUserId(senderIdText),
          sender: {
              id: asUserId(senderIdText),
              name: decryptedSenderName || 'Unknown',
              username: decryptedSenderUsername,
              avatarUrl: decryptedSenderAvatarUrl
          },
          status: (() => {
              const raw = r.status?.toUpperCase();
              if (raw === 'SENDING' || raw === 'SENT' || raw === 'FAILED') {
                  return raw as 'SENDING' | 'SENT' | 'FAILED';
              }
              return 'SENT';
          })(),
          isViewOnce,
          isDeletedLocal,
          expiresAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : undefined,
          // [docs/28 Tier 2 — B2] pulihkan waktu presisi untuk tampilan.
          sentAt: typeof r.sentAt === 'number' ? r.sentAt : undefined,
          // [docs/28 Tier 2 — B1] pulihkan seq → kursor paginasi server tetap
          // presisi setelah reload (fetch-older tidak mengulang halaman).
          // [docs/29 §5.5] dibuka dari envelope `ENC1:` (baris lama berbentuk
          // angka plaintext tetap terbaca).
          seq: (await openLocalNumber(r.seq)) ?? undefined,
          // Merge file properties cleanly
          fileUrl: decryptedFileMeta?.fileUrl,
          fileKey: decryptedFileMeta?.fileKey,
          fileName: decryptedFileMeta?.fileName,
          fileType: decryptedFileMeta?.fileType,
          fileSize: decryptedFileMeta?.fileSize,
          duration: decryptedFileMeta?.duration,
          isBlindAttachment: decryptedFileMeta?.isBlindAttachment
        };

        messages.push(msg);
      }
      return messages;
  }

  async getMessage(id: string): Promise<Message | null> {
    try {
      const r = await db.messages.get(id);
      if (!r) return null;
      
      const parsedArray = await this.parseRecordsToMessages([r]);
      return parsedArray.length > 0 ? (parsedArray[0] ?? null) : null;
    } catch (_e) {
      return null;
    }
  }

  async deleteMessage(id: string) {
    try {
      await db.messages.delete(id);
    } catch (e) {
      console.error("Failed to delete message from vault", e);
    }
  }

  async deleteConversation(id: string) {
    try {
      await this.deleteConversationMessages(id);
      // Clean up related crypto states if they exist
      await db.ratchetSessions.delete(id);
      await db.groupSenderStates.delete(id);
      await db.groupReceiverStates.where('id').startsWith(id + '_').delete();
      // Hapus record percakapan itu sendiri — sebelumnya hanya pesan + state
      // kripto yang dihapus, sehingga percakapan yang sudah "dihapus" muncul
      // kembali setelah reload karena baris di tabel `conversations` masih ada.
      await db.conversations.delete(id);
    } catch (e) {
      console.error("Failed to delete conversation data from vault", e);
    }
  }

  async deleteConversationMessages(conversationId: string) {
    try {
      await db.messages.where('conversationId').equals(conversationId).delete();
    } catch (e) {
      console.error("Failed to delete conversation messages from vault", e);
    }
  }

  // --- CONVERSATION METHODS ---

  async saveConversation(conv: Conversation) {
    try {
      const encryptedParticipants = await encryptVaultText(JSON.stringify(conv.participants || []));
      let encryptedDecryptedMetadata: string | null = null;
      if (conv.decryptedMetadata) {
        encryptedDecryptedMetadata = await encryptVaultText(JSON.stringify(conv.decryptedMetadata));
      }
      await db.conversations.put({
        id: conv.id,
        // [docs/30 WS-F langkah 3] `isGroup` di-seal (tidak ada query yang
        // memakainya sebagai indeks — lihat Dexie v10).
        isGroup: (await sealLocalFlag(conv.isGroup)) ?? conv.isGroup,
        encryptedMetadata: conv.encryptedMetadata || null,
        decryptedMetadata: encryptedDecryptedMetadata,
        // [docs/29 §5.5] lastMessageAt tidak dipakai untuk pengurutan lokal →
        // dipotong ke bucket 15 menit (paritas dengan server, docs/28 B3).
        lastMessageAt: bucketLocalTimestamp((conv as { lastMessageAt?: string | Date | null }).lastMessageAt),
        participants: encryptedParticipants
      });
    } catch (e) {
      console.error("Failed to save conversation to vault", e);
    }
  }

  async getAllConversations(): Promise<Conversation[]> {
    try {
      const records = await db.conversations.toArray();
      const conversations = await Promise.all(records.map(async r => {
        const decryptedParticipantsStr = await decryptVaultText(r.participants);
        const participants = decryptedParticipantsStr ? JSON.parse(decryptedParticipantsStr) : [];
        let decryptedMetadata: Record<string, unknown> | undefined = undefined;
        if (r.decryptedMetadata) {
          const decryptedMetaStr = await decryptVaultText(r.decryptedMetadata);
          if (decryptedMetaStr) {
            try {
              decryptedMetadata = JSON.parse(decryptedMetaStr);
            } catch {}
          }
        }
        return {
          id: r.id,
          // [docs/30 WS-F langkah 3] baris lama boleh masih boolean plaintext.
          isGroup: (await openLocalFlag(r.isGroup)) === true,
          encryptedMetadata: r.encryptedMetadata,
          decryptedMetadata,
          lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
          participants,
          unreadCount: 0,
          encryptionMode: 'SENDER_KEY' as const,
          lastMessage: null,
        } as Conversation;
      }));
      return conversations;
    } catch (e) {
      console.error("Failed to get all conversations from vault", e);
      return [];
    }
  }
}

export const shadowVault = new NyxShadowVaultProxy();

export async function saveStoryKey(storyId: string, base64Key: string): Promise<void> {
  const { encryptValueAtRest } = await import('./keychainDb');
  await db.storyKeys.put({ storyId: storyId as StoryId, key: await encryptValueAtRest(base64Key) });
}

export async function getStoryKey(storyId: string): Promise<string | null> {
  const { decryptValueAtRest } = await import('./keychainDb');
  const record = await db.storyKeys.get(storyId);
  if (!record) return null;
  return decryptValueAtRest(record.key);
}