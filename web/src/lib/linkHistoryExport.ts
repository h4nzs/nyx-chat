// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/40 §40.7] Sisi PERANGKAT LAMA: bangun arsip riwayat lalu unggah.
 *
 * Kenapa tidak menyalin baris Dexie seperti `.nyxbak`: isi pesan/kontak disegel
 * kunci vault = turunan identity private key, dan perangkat hasil link punya
 * identitas baru. Menyalin ciphertext menghasilkan riwayat yang tampil kosong.
 * Karena itu arsip ini membawa **objek domain** hasil pembaca yang mendekripsi
 * (`getAllContacts`, `shadowVault.getAllConversations`), lalu disegel dengan
 * kunci acak `K` yang hanya bisa dibuka perangkat baru.
 *
 * `HISTORY_MARKER` ditulis ke setiap chunk supaya arsip ini tidak mungkin
 * direstore sebagai `.nyxbak` (payload-nya beda jenis: objek vs baris).
 */

import { BACKUP_SALT_BYTES, libsodiumBackupCrypto } from './backupFormat';
import { libsodiumBackupValueCodec } from './backupPayload';
import { createFramedBackup, type BackupStore, type CreateBackupReport } from './backupRestore';
import { getSodium } from './sodiumInitializer';
import { getAllContacts } from './contactStore';
import { shadowVault } from './shadowVaultDb';
import type { ContactRecord } from '@nyx/shared';
import type { Conversation, Message } from '@store/conversation';

import {
  digestArchive,
  generateArchiveKey,
  getHistoryLimits,
  markHistoryReady,
  presignHistoryUpload,
  sealArchiveKey,
  uploadHistoryArchive,
  abortHistoryUpload,
} from './linkHistoryClient';

/** Penanda jenis arsip di setiap chunk (ikut AEAD). */
export const HISTORY_MARKER = 'history';

/** Prefix error `HISTORY_TOO_LARGE:<size>:<limit>` (byte). */
export const HISTORY_TOO_LARGE_PREFIX = 'HISTORY_TOO_LARGE';

/**
 * Arsip melebihi kuota akun. Dibawa sebagai error bertipe supaya UI bisa
 * menampilkan ukuran + batas yang nyata (bukan "gagal mengirim arsip").
 */
export class HistoryArchiveTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number
  ) {
    super(`${HISTORY_TOO_LARGE_PREFIX}:${size}:${limit}`);
    this.name = 'HistoryArchiveTooLargeError';
  }
}

/** Baca kembali ukuran/batas dari error, `null` bila bukan kasus kelebihan kuota. */
export function parseHistoryTooLarge(error: unknown): { size: number; limit: number } | null {
  const message = error instanceof Error ? error.message : '';
  if (!message.startsWith(`${HISTORY_TOO_LARGE_PREFIX}:`)) return null;
  const [, rawSize, rawLimit] = message.split(':');
  const size = Number(rawSize);
  const limit = Number(rawLimit);
  if (!Number.isFinite(size) || !Number.isFinite(limit)) return null;
  return { size, limit };
}

/**
 * Tabel yang ikut arsip tahap ini. Nama tabel = nama frame `backupPayload`
 * (dipakai untuk tipe frame + urutan deterministik), tetapi isinya objek domain,
 * bukan baris Dexie.
 */
export const HISTORY_TABLES = ['contacts', 'conversations', 'messages'] as const;

export interface HistoryTables {
  contacts: ContactRecord[];
  conversations: Conversation[];
  messages: Message[];
}

export interface HistoryArchiveReport extends CreateBackupReport {
  digest: string;
}

/** Baca riwayat yang bisa dipindah lewat pembaca yang sudah mendekripsi. */
export async function readHistoryTables(): Promise<HistoryTables> {
  const [contacts, conversations, messages] = await Promise.all([
    getAllContacts(),
    shadowVault.getAllConversations(),
    // [docs/40 §40.7] Pesan dibaca lewat `decodeMessageRecord` yang sama dengan
    // tampilan chat — bukan salinan baris Dexie (yang tersegel kunci identitas
    // LAMA dan akan tampil kosong di perangkat baru).
    shadowVault.getMessagesForExport(),
  ]);
  return { contacts, conversations, messages };
}

/** Jumlah catatan yang akan ikut (untuk menampilkan/menyembunyikan opsi UI). */
export function countHistoryRecords(tables: HistoryTables): number {
  return tables.contacts.length + tables.conversations.length + tables.messages.length;
}

function historyStore(tables: HistoryTables): BackupStore {
  return {
    readTables: async () => ({
      contacts: tables.contacts,
      conversations: tables.conversations,
      messages: tables.messages,
    }),
    // Arsip ini tidak pernah ditulis lewat `BackupStore` (impor memakai penulis
    // domain di `linkHistoryImport.ts`), jadi jalur tulis sengaja tidak ada.
    writeTables: async () => {
      throw new Error('Arsip riwayat tidak ditulis lewat store backup');
    },
  };
}

/**
 * Bangun byte arsip. Kunci `K` acak (bukan turunan recovery phrase): arsip ini
 * hanya untuk SATU perangkat, bukan backup yang bisa dibuka siapa pun yang
 * memegang phrase.
 */
export async function createHistoryArchive(opts: {
  key: Uint8Array;
  tables: HistoryTables;
  salt?: Uint8Array;
}): Promise<HistoryArchiveReport> {
  const sodium = await getSodium();
  const crypto = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
  const codec = libsodiumBackupValueCodec(
    sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]
  );

  const report = await createFramedBackup({
    store: historyStore(opts.tables),
    key: opts.key,
    salt: opts.salt ?? sodium.randombytes_buf(BACKUP_SALT_BYTES),
    crypto,
    codec,
    tables: HISTORY_TABLES,
    marker: HISTORY_MARKER,
    // Pesan jauh lebih kecil dari satu chunk, jadi frame 256 KB menahan jumlah
    // frame (dan header per frame) tetap wajar untuk riwayat panjang.
    chunkBytes: 256 * 1024,
    // Frame bertipe sama tidak tersusun menurut struktur sosial.
    scramble: true,
  });

  return { ...report, digest: await digestArchive(report.bytes) };
}

export interface SendHistoryResult {
  size: number;
  records: number;
  digest: string;
}

/**
 * Alur lengkap perangkat lama: ekspor → PUT ke R2 → `ready` dengan kunci
 * arsip yang diseal ke perangkat baru.
 *
 * Kegagalan di titik mana pun membersihkan intent (`abort`) supaya perangkat
 * baru tidak menunggu 60 detik penuh sebelum menyadari tidak ada arsip.
 */
export async function sendHistoryArchive(input: {
  deviceId: string;
  /** X-Wing public key perangkat baru (base64url) dari `auth:linking_request`. */
  pqPublicKeyB64: string;
  onProgress?: (label: 'exporting' | 'uploading' | 'ready') => void;
}): Promise<SendHistoryResult> {
  const key = await generateArchiveKey();

  try {
    input.onProgress?.('exporting');
    const tables = await readHistoryTables();
    const records = countHistoryRecords(tables);
    if (records === 0) {
      // Tidak ada yang bisa dikirim; jangan biarkan perangkat baru menunggu.
      await abortHistoryUpload(input.deviceId);
      return { size: 0, records: 0, digest: '' };
    }

    const archive = await createHistoryArchive({ key, tables });

    // [docs/40 §40.7 langkah 8] Periksa kuota SEBELUM presign/unggah. Kalau
    // batasnya tidak bisa dibaca (jaringan), presign server tetap penegak
    // terakhir — jangan gagalkan transfer hanya karena endpoint limits.
    const limits = await getHistoryLimits().catch(() => null);
    if (limits && limits.maxBytes > 0 && archive.size > limits.maxBytes) {
      // `catch` di bawah memanggil `abort` (intent/presign dibersihkan) supaya
      // perangkat baru tidak menunggu 60 detik untuk arsip yang tak akan datang.
      throw new HistoryArchiveTooLargeError(archive.size, limits.maxBytes);
    }

    input.onProgress?.('uploading');
    const presigned = await presignHistoryUpload(input.deviceId, archive.size);
    await uploadHistoryArchive(presigned.uploadUrl, archive.bytes);

    const sealedKey = await sealArchiveKey({
      key,
      pqPublicKeyB64: input.pqPublicKeyB64,
      records,
    });
    await markHistoryReady({
      deviceId: input.deviceId,
      size: archive.size,
      digest: archive.digest,
      sealedKey,
    });

    input.onProgress?.('ready');
    return { size: archive.size, records, digest: archive.digest };
  } catch (error) {
    // Best-effort: intent + presign + pointer dibersihkan, objek (kalau ada)
    // dihapus server. Error asli tetap dilempar agar UI bisa menampilkan sebab.
    await abortHistoryUpload(input.deviceId).catch(() => {});
    throw error;
  }
}
