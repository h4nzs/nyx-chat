// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.3] Bucket waktu untuk semua kolom temporal yang tidak
 * dibutuhkan untuk urutan presisi.
 *
 * Prisma tidak bisa `@default(bucket(now()))`, dan menambal 50+ titik tulis
 * satu per satu mudah terlewat saat ada model baru. Karena itu nilai dipotong
 * di satu tempat: Prisma client extension di `lib/prisma.ts` memanggil
 * `bucketTemporalArgs()` untuk setiap `create`/`createMany`/`update`/
 * `updateMany`/`upsert`.
 *
 * Aturan:
 *   - kolom yang sudah diisi pemanggil → dipotong ke bucket-nya;
 *   - `fillOnCreate` → diisi bucket `now` bila pemanggil tidak menyebutnya;
 *   - `touchOnUpdate` → disetel ulang ke bucket `now` pada `update` (pengganti
 *     `@updatedAt`, yang menulis presisi detik dan menimpa nilai kita).
 *
 * `Message` dan `Story` TIDAK ada di peta ini: keduanya menurunkan `expiresAt`
 * dari waktu yang sudah dipotong (`messageTimeBucket`) di route-nya, dan
 * memotong ulang di sini akan memisahkan `expiresAt` dari `createdAt + TTL`
 * sebesar satu bucket. Lihat `routes/messages.ts` dan `routes/stories.ts`.
 */

import {
  DAY_BUCKET_MS,
  DEVICE_ACTIVITY_BUCKET_MS,
  truncateToBucket,
} from '../utils/temporalBucket.js';

export interface TemporalField {
  /** Nama field Prisma. */
  field: string;
  /** Ukuran bucket dalam milidetik. */
  bucketMs: number;
  /** Isi sendiri saat `create` bila pemanggil tidak menyebutkan. */
  fillOnCreate?: boolean;
  /** Setel ulang ke bucket `now` pada `update` (pengganti `@updatedAt`). */
  touchOnUpdate?: boolean;
}

const ACTIVITY: Omit<TemporalField, 'field'> = {
  bucketMs: DEVICE_ACTIVITY_BUCKET_MS,
  fillOnCreate: true,
};

const TOUCHED: Omit<TemporalField, 'field'> = {
  bucketMs: DEVICE_ACTIVITY_BUCKET_MS,
  fillOnCreate: true,
  touchOnUpdate: true,
};

const EVENT: Omit<TemporalField, 'field'> = { bucketMs: DEVICE_ACTIVITY_BUCKET_MS };

export const TEMPORAL_BUCKETS: Record<string, TemporalField[]> = {
  User: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'updatedAt', ...TOUCHED },
    { field: 'bannedAt', ...EVENT },
    { field: 'lastActiveDay', ...ACTIVITY, bucketMs: DAY_BUCKET_MS },
    { field: 'subscriptionExpiresAt', ...EVENT, bucketMs: DAY_BUCKET_MS },
  ],
  Device: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'lastActiveAt', ...ACTIVITY },
  ],
  RefreshToken: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'lastUsedAt', ...TOUCHED },
    { field: 'revokedAt', ...EVENT },
  ],
  MessageStatus: [{ field: 'updatedAt', ...EVENT }],
  SessionKey: [{ field: 'createdAt', ...ACTIVITY }],
  PushSubscription: [{ field: 'createdAt', ...ACTIVITY }],
  Conversation: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'updatedAt', ...TOUCHED },
    { field: 'lastMessageAt', ...EVENT },
    { field: 'epochRotatedAt', ...EVENT },
  ],
  UserHiddenConversation: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'expiresAt', ...EVENT },
  ],
  GroupMailboxItem: [
    { field: 'createdAt', ...ACTIVITY },
    { field: 'expiresAt', ...EVENT },
  ],
  BlockedUser: [{ field: 'createdAt', ...ACTIVITY }],
  MessageViewOnceOpen: [{ field: 'openedAt', ...ACTIVITY }],
  MessageViewOnceRecipient: [{ field: 'createdAt', ...ACTIVITY }],
};

/** Model yang waktu `expiresAt`-nya diturunkan di route, bukan di sini. */
export const DERIVED_TIME_MODELS = ['Message', 'Story'] as const;

/**
 * Kolom DateTime yang sengaja TIDAK dipotong, beserta alasannya. Didaftar
 * eksplisit supaya `tests/temporalSchema.test.ts` bisa gagal ketika ada kolom
 * waktu baru yang belum diputuskan (bukan lolos diam-diam).
 */
export const TEMPORAL_EXCEPTIONS: Record<string, Record<string, string>> = {
  RefreshToken: {
    expiresAt: 'masa berlaku token: harus tepat createdAt + TTL, kalau tidak sesi kedaluwarsa tidak konsisten dengan cookie',
  },
  SessionKey: {
    expiresAt: 'masa berlaku kunci sesi: sama seperti RefreshToken.expiresAt',
  },
  Conversation: {
    groupTokenExpiresAt: 'diturunkan dari waktu rotasi era + TTL; memotongnya memisahkan TTL dari rotasi',
  },
};

type Mode = 'create' | 'update';

function bucketValue(value: unknown, bucketMs: number): unknown {
  if (value instanceof Date) return truncateToBucket(value, bucketMs);
  // Bentuk `{ set: Date }` dipakai pada update bersarang.
  if (value && typeof value === 'object' && 'set' in value) {
    const inner = (value as { set: unknown }).set;
    if (inner instanceof Date) {
      return { ...(value as Record<string, unknown>), set: truncateToBucket(inner, bucketMs) };
    }
  }
  return value;
}

function bucketRecord(
  record: unknown,
  fields: TemporalField[],
  mode: Mode,
  now: Date
): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }
  const next = { ...(record as Record<string, unknown>) };
  for (const { field, bucketMs, fillOnCreate, touchOnUpdate } of fields) {
    const current = next[field];
    if (current !== undefined) {
      next[field] = bucketValue(current, bucketMs);
    } else if (mode === 'create' && fillOnCreate) {
      next[field] = truncateToBucket(now, bucketMs);
    } else if (mode === 'update' && touchOnUpdate) {
      next[field] = truncateToBucket(now, bucketMs);
    }
  }
  return next;
}

/**
 * Potong semua field temporal pada args Prisma untuk satu operasi.
 *
 * Murni (tidak menyentuh DB) supaya bisa diuji tanpa Postgres, dan
 * mengembalikan `args` apa adanya untuk model/operasi yang tidak dipetakan.
 */
export function bucketTemporalArgs(
  model: string | undefined,
  operation: string,
  args: unknown,
  now: Date = new Date()
): unknown {
  if (!model) return args;
  const fields = TEMPORAL_BUCKETS[model];
  if (!fields || !args || typeof args !== 'object') return args;

  const input = args as Record<string, unknown>;
  const next = { ...input };

  switch (operation) {
    case 'create':
      next.data = bucketRecord(input.data, fields, 'create', now);
      break;
    case 'createMany':
      next.data = Array.isArray(input.data)
        ? input.data.map((row) => bucketRecord(row, fields, 'create', now))
        : bucketRecord(input.data, fields, 'create', now);
      break;
    case 'update':
    case 'updateMany':
      next.data = bucketRecord(input.data, fields, 'update', now);
      break;
    case 'upsert':
      next.create = bucketRecord(input.create, fields, 'create', now);
      next.update = bucketRecord(input.update, fields, 'update', now);
      break;
    default:
      return args;
  }

  return next;
}
