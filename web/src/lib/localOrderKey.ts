// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F / docs/29 §5.5 — §7.3] Skema urutan terenkripsi untuk kolom
 * pengurutan di vault lokal (IndexedDB).
 *
 * Masalahnya: `Message.createdAt` presisi adalah kolom **indeks** (dipakai
 * paginasi `fetch-older`), jadi tidak bisa langsung di-seal dengan `ENC1:` —
 * ciphertext tidak punya urutan leksikal, sehingga range-scan pada indeks
 * (dan `.limit(limit)` sebelum dekripsi) hilang; pembaca yang ada akan rusak.
 *
 * Skema (dua lapis, sesuai keputusan desain WS-F):
 *
 *  1. **Lapis indeks — kasar & plaintext:** `orderBucketMs` = waktu dipotong ke
 *     bucket 15 menit (`LOCAL_TIME_BUCKET_MS`, konstanta yang SAMA dengan
 *     `localAtRest.LOCAL_TIME_BUCKET_MS` dan bucket server `MESSAGE_TIME_BUCKET_MS`).
 *     Kolom ini hanya membocorkan granularitas yang **sudah** bocor di server
 *     (docs/28 Tier 2 — B3/B4 membucket `createdAt`/`lastMessageAt`), jadi tidak
 *     menambah kebocoran baru — dan tetap bisa diindeks untuk range-scan.
 *
 *  2. **Lapis presisi — di-seal:** waktu presisi disimpan sebagai envelope
 *     `ENC1:` (`createdAtSealed`, pola & helper yang sama dengan `seq`). Urutan
 *     presisi di dalam satu bucket dipulihkan dari lapis ini **setelah** baris
 *     kandidat diambil, bukan sebelum.
 *
 * Konsekuensi yang harus disadari pembaca: batas halaman jadi berbutir bucket.
 * Halaman kandidat diambil **per bucket utuh**
 * (`where('[conversationId+orderBucketMs]').equals([conv, bucket])`), baru
 * dipangkas presisi di memori (`pickOlderPage`). Mengambil bucket utuh itu
 * wajib: indeks mengurutkan kunci yang sama berdasarkan primary key (bukan
 * waktu presisi), jadi pemotongan `limit` di level indeks akan **melewatkan
 * baris lebih tua di dalam bucket batas secara permanen** — halaman berikutnya
 * tidak akan pernah menjemputnya karena kursor sudah melewati bucket itu.
 *
 * Baris lama (plaintext ISO/Date) tetap terbaca dan ter-upgrade saat ditulis
 * ulang — perangkat user tidak bisa di-reset seperti DB server (alasan sama
 * dengan `openLocalNumber`).
 */

import { openLocalNumber, sealLocalNumber } from './localAtRest';
import { LOCAL_TIME_BUCKET_MS, orderBucketOf } from './localOrderBucket';

// Bucket adalah modul daun (dipakai juga oleh `db.ts`); diekspor ulang di sini
// supaya pemanggil cukup mengimpor dari satu tempat.
export { LOCAL_TIME_BUCKET_MS, orderBucketOf };

/**
 * Bentuk minimal baris pengurutan. `createdAt` adalah bentuk lama (plaintext
 * ISO/Date) yang masih ditulis sampai migrasi selesai; `createdAtSealed` yang
 * menggantikannya untuk baris baru.
 */
export interface SealedOrderRow {
  createdAt?: string | Date | null;
  createdAtSealed?: string | null;
  orderBucketMs?: number | null;
}

/** Seal instant presisi (ms) → envelope `ENC1:`. `null`/tak valid → null. */
export async function sealOrderInstant(ms: number | null | undefined): Promise<string | null> {
  return await sealLocalNumber(ms);
}

/**
 * Pulihkan waktu presisi sebuah baris: lapis seal dulu, lalu bentuk lama
 * (ISO/Date), terakhir turun ke bucket (baris yang belum punya lapis presisi).
 * `null` berarti baris tidak punya informasi waktu sama sekali.
 */
export async function openOrderInstant(row: SealedOrderRow): Promise<number | null> {
  const sealed = await openLocalNumber(row.createdAtSealed ?? null);
  if (sealed !== null) return sealed;

  const legacy = row.createdAt;
  if (legacy !== null && legacy !== undefined && legacy !== '') {
    const ms = legacy instanceof Date ? legacy.getTime() : Date.parse(legacy);
    if (Number.isFinite(ms)) return ms;
  }

  const bucket = row.orderBucketMs;
  return typeof bucket === 'number' && Number.isFinite(bucket) ? bucket : null;
}

/** Resolusi massal (satu pass dekripsi per baris kandidat). */
export async function resolveOrderInstants(rows: readonly SealedOrderRow[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (const row of rows) out.push(await openOrderInstant(row));
  return out;
}

/** Bidang pengurutan siap-tulis untuk sebuah waktu presisi (writer). */
export interface OrderFields {
  orderBucketMs: number | null;
  createdAtSealed: string | null;
}

/** Hitung kedua lapis sekaligus saat menulis baris. */
export async function sealOrderFields(ms: number | null | undefined): Promise<OrderFields> {
  return {
    orderBucketMs: orderBucketOf(ms),
    createdAtSealed: await sealOrderInstant(ms),
  };
}

/** Bucket sebelumnya (satu langkah ke masa lalu) — langkah mundur pembaca indeks. */
export function previousOrderBucket(bucketMs: number): number {
  return bucketMs - LOCAL_TIME_BUCKET_MS;
}

export interface OlderPage<T> {
  /**
   * Baris halaman ini, **terlama → terbaru** — bentuk yang sama dengan yang
   * dikembalikan `getMessagesByConversation` sekarang (`.reverse().limit().reverse()`),
   * karena pemanggil (store) memprosesnya urut lama→baru.
   */
  page: T[];
  /** Bucket dari baris TERLAMA di halaman — kursor bucket berikutnya. */
  boundaryBucketMs: number | null;
  /** Presisi baris terlama di halaman — kursor presisi (semantik `beforeDate`). */
  boundaryInstantMs: number | null;
}

/**
 * Pangkas kandidat (sudah diambil dari indeks bucket, apa pun urutannya)
 * menjadi satu halaman, mempertahankan semantik lama: `beforeDate` **inklusif**
 * (`<=`), halaman diambil dari ujung TERBARU rentang (`.reverse().limit()`),
 * lalu dikembalikan urut lama→baru.
 *
 * `instants` sejajar indeks dengan `rows` (hasil `resolveOrderInstants`).
 * Baris tanpa waktu sama sekali dibuang — sama seperti baris yang tidak pernah
 * bisa cocok dengan range indeks.
 */
export function pickOlderPage<T extends SealedOrderRow>(
  rows: readonly T[],
  instants: readonly (number | null)[],
  limit: number,
  beforeMs?: number | null
): OlderPage<T> {
  const picked: { row: T; instant: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const instant = instants[i];
    if (typeof instant !== 'number') continue;
    if (typeof beforeMs === 'number' && instant > beforeMs) continue;
    picked.push({ row: rows[i] as T, instant });
  }

  // Terbaru → terlama untuk memotong halaman dari ujung terbaru, lalu dibalik
  // kembali ke lama → baru agar sama dengan perintah lama.
  picked.sort((a, b) => b.instant - a.instant);
  const page = picked.slice(0, Math.max(0, limit)).reverse();

  const boundary = page[0];
  return {
    page: page.map((p) => p.row),
    boundaryBucketMs: boundary ? orderBucketOf(boundary.instant) : null,
    boundaryInstantMs: boundary ? boundary.instant : null,
  };
}

/**
 * Normalisasi baris apa pun yang masuk vault (tulis baru, impor, restore
 * backup) menjadi bentuk ber-indeks.
 *
 * Idempoten dan **tanpa kunci**: `orderBucketMs` selalu bisa dihitung dari
 * waktu yang terbaca (baris lama plaintext atau baris baru ter-seal). Lapis
 * presisi di-upgrade hanya bila baris masih plaintext — dan plaintext-nya BARU
 * dilepas setelah envelope berhasil dibuat, supaya kegagalan seal (vault
 * terkunci saat restore, mis.) tidak menghapus satu-satunya sumber waktu baris
 * tersebut.
 */
export type NormalizedOrderRow<T> = T & {
  orderBucketMs: number | null;
  createdAtSealed?: string | null;
  createdAt?: string | Date | null;
};

export async function ensureOrderFields<T extends SealedOrderRow>(
  row: T
): Promise<NormalizedOrderRow<T>> {
  const instant = await openOrderInstant(row);
  const orderBucketMs = orderBucketOf(instant) ?? orderBucketOf(row.orderBucketMs ?? null);

  if (row.createdAtSealed) return { ...row, orderBucketMs };

  const sealed = await sealOrderInstant(instant);
  if (!sealed) return { ...row, orderBucketMs };

  return { ...row, orderBucketMs, createdAtSealed: sealed, createdAt: null };
}

export function hasIndexableOrder(row: SealedOrderRow): boolean {
  return typeof row.orderBucketMs === 'number' && Number.isFinite(row.orderBucketMs);
}
