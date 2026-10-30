// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40 §40.8] Sisi PERANGKAT BARU: verifikasi → buka → impor → konsumsi.
 *
 * Isi arsip adalah objek domain yang sudah didekripsi perangkat lama. Di sini
 * objek itu masuk kembali lewat **penulis** yang sudah ada (`saveContactRecord`,
 * `shadowVault.saveConversation`), jadi penyegelan ulang memakai kunci identitas
 * BARU (kunci vault + `masterSeed`) tanpa peta kolom baru.
 *
 * Urutan pertahanan (gagal sebelum menulis apa pun):
 *   1. `size` + `digest` byte yang diunduh,
 *   2. AEAD arsip (`parseBackupArchive`): tamper/reorder/truncate/kunci salah,
 *   3. penanda `k: 'history'` + tabel yang dikenal,
 *   4. baru menulis.
 *
 * Impor bersifat MERGE (tanpa `clear()`): id pesan/kontak/percakapan dipertahankan,
 * jadi impor ulang tidak menduplikasi dan tidak menghapus data yang dibuat
 * perangkat ini sendiri.
 */

import { libsodiumBackupCrypto } from './backupFormat';
import { libsodiumBackupValueCodec, readBackupChunk, type BackupValueCodec } from './backupPayload';
import { parseBackupArchive, type BackupCryptoBackend } from './backupFormat';
import { getSodium } from './sodiumInitializer';
import { pushContactBundle, saveContactRecord } from './contactStore';
import { saveCachedGroupParticipants } from './keychainDb';
import { shadowVault } from './shadowVaultDb';
import type { ContactRecord, Conversation } from '@nyx/shared';
import type { Message } from '@store/conversation';

import {
  HISTORY_MARKER,
  HISTORY_TABLES,
  type CachedGroupParticipantsRecord,
} from './linkHistoryExport';
import {
  consumeHistoryArchive,
  digestArchive,
  fetchHistoryArchive,
  getHistoryStatus,
  openArchiveKey,
  requestHistoryDownload,
} from './linkHistoryClient';

export interface HistoryImportReport {
  records: number;
  tables: Record<string, number>;
  /** Pesan yang benar-benar ditulis ke vault (progres UI memakai angka ini). */
  messages: number;
}

/** Progres impor — per frame, karena satu arsip bisa berisi puluhan frame. */
export interface HistoryImportProgress {
  /** Frame yang sudah diproses. */
  frame: number;
  totalFrames: number;
  /** Pesan yang sudah ditulis. */
  messages: number;
}

/** Penulis yang bisa disuntik di test; produksi memakai penulis domain asli. */
export interface HistoryImportWriters {
  contacts?: (records: ContactRecord[]) => Promise<void>;
  conversations?: (records: Conversation[]) => Promise<void>;
  messages?: (records: Message[]) => Promise<void>;
  groupCachedParticipants?: (records: CachedGroupParticipantsRecord[]) => Promise<void>;
}

/**
 * Ukuran batch tulis pesan. Cukup besar untuk ribuan pesan (satu `bulkPut`
 * per 250 baris + satu `get` per id di dalam `upsertMessages`), cukup kecil
 * untuk memberi progres yang terasa dan menjaga memori browser.
 */
const MESSAGE_BATCH_SIZE = 250;

function isHistoryTable(table: string): boolean {
  return (HISTORY_TABLES as readonly string[]).includes(table);
}

/**
 * Parse + tulis arsip. `key` adalah kunci yang didapat dari `sealedKey`.
 * Melempar bila arsip bukan arsip riwayat (tidak ada penanda / tabel asing).
 */
export async function importHistoryArchive(opts: {
  bytes: Uint8Array;
  key: Uint8Array;
  crypto?: BackupCryptoBackend;
  codec?: BackupValueCodec;
  writers?: HistoryImportWriters;
  batchSize?: number;
  onProgress?: (progress: HistoryImportProgress) => void;
}): Promise<HistoryImportReport> {
  const sodium = await getSodium();
  const crypto =
    opts.crypto ??
    libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
  const codec =
    opts.codec ??
    libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);

  const { frames } = parseBackupArchive(opts.bytes, opts.key, crypto);

  const contacts: ContactRecord[] = [];
  const conversations: Conversation[] = [];
  const cachedParticipants: CachedGroupParticipantsRecord[] = [];
  const tables: Record<string, number> = {};
  const batchSize = Math.max(1, opts.batchSize ?? MESSAGE_BATCH_SIZE);

  const writeContacts = opts.writers?.contacts ?? (async (rows) => {
    for (const row of rows) await saveContactRecord(row);
  });
  const writeConversations = opts.writers?.conversations ?? (async (rows) => {
    for (const row of rows) await shadowVault.saveConversation(row);
  });
  const writeCachedParticipants =
    opts.writers?.groupCachedParticipants ?? (async (rows) => {
      // Bukan rahasia (id saja), jadi ditulis langsung tanpa penyegelan ulang.
      for (const row of rows) {
        await saveCachedGroupParticipants(row.conversationId, row.userIds);
      }
    });
  const writeMessages = opts.writers?.messages ?? (async (rows) => {
    // [docs/40 §40.8] Penulis yang SAMA dengan jalur pesan biasa: menyegel ulang
    // `content` dengan kunci vault identitas BARU, mengisi `orderBucketMs`, dan
    // filter "Shield" membuat pengulangan idempoten.
    await shadowVault.upsertMessages(rows);
  });

  let pendingMessages: Message[] = [];
  let writtenMessages = 0;

  const flushMessages = async () => {
    if (pendingMessages.length === 0) return;
    const batch = pendingMessages;
    pendingMessages = [];
    await writeMessages(batch);
    writtenMessages += batch.length;
  };

  for (let i = 0; i < frames.length; i++) {
    const chunk = readBackupChunk(frames[i]!, codec);
    if (chunk.k !== HISTORY_MARKER) {
      // Tanpa penanda = `.nyxbak` biasa (baris Dexie). Menulisnya lewat jalur
      // domain akan membuat data yang tidak bisa dibaca aplikasi.
      throw new Error('HISTORY_MARKER_MISSING');
    }
    if (!isHistoryTable(chunk.table)) {
      throw new Error(`HISTORY_TABLE_UNKNOWN:${chunk.table}`);
    }

    if (chunk.table === 'contacts') {
      contacts.push(...(chunk.records as ContactRecord[]));
    } else if (chunk.table === 'conversations') {
      conversations.push(...(chunk.records as Conversation[]));
    } else if (chunk.table === 'groupCachedParticipants') {
      cachedParticipants.push(...(chunk.records as CachedGroupParticipantsRecord[]));
    } else if (chunk.table === 'messages') {
      // Pesan ditulis bertahap, bukan dikumpulkan sampai akhir: riwayat puluhan
      // ribu pesan tidak boleh menahan semuanya di memori sebelum frame pertama
      // tersimpan, dan progres UI butuh titik tulis yang nyata.
      pendingMessages.push(...(chunk.records as Message[]));
      while (pendingMessages.length >= batchSize) {
        await writeMessages(pendingMessages.slice(0, batchSize));
        pendingMessages = pendingMessages.slice(batchSize);
        writtenMessages += batchSize;
      }
    }
    tables[chunk.table] = (tables[chunk.table] ?? 0) + chunk.records.length;
    opts.onProgress?.({ frame: i + 1, totalFrames: frames.length, messages: writtenMessages });
  }

  // Percakapan/kontak ditulis setelah semua frame tervalidasi — lebih kecil,
  // dan tanpa baris percakapan pesan tidak akan pernah tampil di daftar chat.
  if (contacts.length > 0) await writeContacts(contacts);
  if (conversations.length > 0) await writeConversations(conversations);
  if (cachedParticipants.length > 0) await writeCachedParticipants(cachedParticipants);
  await flushMessages();
  // Batch terakhir baru ditulis di sini, jadi progres terakhir dilaporkan ulang
  // supaya UI tidak berhenti di angka sebelum batch penutup.
  opts.onProgress?.({ frame: frames.length, totalFrames: frames.length, messages: writtenMessages });

  const records =
    contacts.length + conversations.length + cachedParticipants.length + writtenMessages;
  return { records, tables, messages: writtenMessages };
}

export interface ReceiveHistoryResult {
  records: number;
  messages: number;
  size: number;
}

/**
 * Alur lengkap perangkat baru. `null` = tidak ada arsip (fitur mati, tidak
 * dicentang di perangkat lama, atau sudah dikonsumsi).
 *
 * `consume` dipanggil HANYA setelah impor sukses: kalau impor gagal (jaringan,
 * kuota browser), state server tetap ada sampai TTL sehingga pengguna bisa
 * mencoba lagi — arsip tidak boleh hangus karena kegagalan sepihak.
 */
export async function receiveLinkedHistory(opts?: {
  onProgress?: (progress: HistoryImportProgress) => void;
}): Promise<ReceiveHistoryResult | null> {
  const status = await getHistoryStatus();
  if (status.state !== 'ready') return null;

  const ticket = await requestHistoryDownload();
  const bytes = await fetchHistoryArchive(ticket.downloadUrl);

  if (bytes.length !== ticket.size) throw new Error('HISTORY_SIZE_MISMATCH');
  const digest = await digestArchive(bytes);
  if (digest !== ticket.digest) throw new Error('HISTORY_DIGEST_MISMATCH');

  const key = await openArchiveKey(ticket.sealedKey);
  const report = await importHistoryArchive({ bytes, key, onProgress: opts?.onProgress });

  // Kontak hasil impor harus ikut disegel ulang di server dengan identitas ini
  // (blob lama disegel identitas sebelumnya — lihat docs/40 §40.2 temuan 2).
  await pushContactBundle().catch(() => {});

  // Daftar chat sudah terlanjur dimuat dari server (yang untuk akun ini kosong),
  // jadi percakapan hasil impor harus di-merge ulang ke store — kalau tidak,
  // riwayatnya ada di vault tapi tidak pernah muncul di sidebar.
  try {
    const { useConversationStore } = await import('@store/conversation');
    await useConversationStore.getState().loadConversations();
  } catch (e) {
    console.warn('[Link] Gagal memuat ulang daftar chat setelah impor riwayat:', e);
  }

  // [docs/40 §40.9] `consume` gagal (jaringan putus tepat setelah impor) TIDAK
  // menggagalkan impor: baris sudah tersimpan, dan objek yatim dihapus TTL/
  // lifecycle. Melempar di sini akan menampilkan "impor gagal" untuk riwayat
  // yang sebenarnya sudah masuk.
  try {
    await consumeHistoryArchive(digest);
  } catch (e) {
    console.warn('[Link] Gagal menghapus arsip riwayat setelah impor:', e);
  }

  return { records: report.records, messages: report.messages, size: bytes.length };
}
