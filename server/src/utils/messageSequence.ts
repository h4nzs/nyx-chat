// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B1] Urutan pesan berbasis sequence per-conversation.
 *
 * Sebelum ini, urutan pesan (dan kursor keyset pagination) bergantung pada
 * `Message.createdAt`. Itu memaksa jam dinding presisi tersimpan di DB — padahal
 * pola temporal adalah salah satu kebocoran terbesar saat dump (D11). B1 memindah
 * penentu urutan ke `Message.seq` yang ditetapkan server, sehingga waktu presisi
 * nanti bisa dikasar (B3) tanpa merusak urutan/scroll-history.
 *
 * Counter hidup di `Conversation.messageSeq` dan di-increment **atomik**:
 * Postgres men-serialisasi `UPDATE ... SET messageSeq = messageSeq + 1` pada satu
 * baris, jadi dua pengirim bersamaan tidak akan pernah mendapat seq yang sama.
 * Ini pola yang sama dananya dengan atomic increment di jalur lain; bukan
 * incr-then-read yang punya race.
 */

/** Subset klien Prisma yang dibutuhkan — supaya unit test bisa memakai fake. */
export interface SeqPrismaClient {
  conversation: {
    update(args: {
      where: { id: string };
      data: { messageSeq: { increment: number } };
      select: { messageSeq: true };
    }): Promise<{ messageSeq: number }>;
  };
}

/**
 * Ambil seq berikutnya untuk sebuah conversation (atomik). Melempar bila
 * conversation tidak ada (caller harus memvalidasi keberadaannya lebih dulu —
 * jalur pesan sudah melakukannya).
 */
export async function reserveMessageSeq(
  client: SeqPrismaClient,
  conversationId: string
): Promise<number> {
  const updated = await client.conversation.update({
    where: { id: conversationId },
    data: { messageSeq: { increment: 1 } },
    select: { messageSeq: true },
  });
  return updated.messageSeq;
}

/**
 * [docs/28 Tier 2 — B1] Kursor paginasi: klien baru mengirim `?before=<seq>`
 * (numerik). Untuk kompatibilitas mundur, `?before=<ISO date>` (klien lama)
 * tetap diterima. Helper ini mengklasifikasikan nilai kursor.
 */
export type ParsedCursor =
  | { kind: 'seq'; seq: number }
  | { kind: 'date'; date: Date }
  | { kind: 'none' };

export function parseMessageCursor(raw: unknown): ParsedCursor {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { kind: 'none' };

  // Numerik murni → seq. Wajib `>= 0`; seq dimulai dari 1.
  if (/^\d+$/.test(value)) {
    const seq = parseInt(value, 10);
    if (Number.isSafeInteger(seq)) return { kind: 'seq', seq };
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return { kind: 'date', date: parsed };

  return { kind: 'none' };
}
