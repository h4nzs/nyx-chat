/**
 * [docs/43 §43.11.6 B3] Pengganti `storage/sqliteMessages` untuk tes jalur
 * pesan di jsdom: tabel Dexie sudah dihapus, jadi tes memakai Map in-memory
 * dengan kontrak fungsi yang sama (tanpa worker OPFS).
 *
 * Urutan halaman meniru pembaca nyata: kandidat diurutkan dari yang terbaru,
 * dipotong `limit`, lalu dikembalikan lama→baru. `beforeDate` inklusif.
 */
import type { DecryptedMessageRecord } from '../../storage/types';

type Row = DecryptedMessageRecord;

function instantOf(row: Row): number {
  if (typeof row.orderBucketMs === 'number') return row.orderBucketMs;
  const createdAt = row.createdAt;
  if (typeof createdAt === 'string') {
    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (createdAt instanceof Date) return createdAt.getTime();
  return 0;
}

export function memoryMessageModule(rows: Map<string, Row>) {
  const all = (): Row[] => [...rows.values()];
  const byConversation = (conversationId: string): Row[] =>
    all().filter((row) => row.conversationId === conversationId);

  return {
    mirrorMessageRows: async (items: Row[]) => {
      for (const row of items) rows.set(String(row.id), row);
    },
    mirrorDeleteMessage: async (id: string) => {
      rows.delete(id);
    },
    mirrorDeleteMessages: async (ids: string[]) => {
      for (const id of ids) rows.delete(id);
    },
    mirrorDeleteConversation: async (conversationId: string) => {
      for (const [id, row] of rows) {
        if (row.conversationId === conversationId) rows.delete(id);
      }
    },
    mirrorClearMessages: async () => {
      rows.clear();
    },
    resetSqliteMessages: async () => {
      rows.clear();
    },
    closeSqliteMessages: async () => {},
    readAllSqliteMessages: async (): Promise<Row[]> => all(),
    readSqliteConversationRows: async (conversationId: string): Promise<Row[]> =>
      byConversation(conversationId),
    readSqliteMessagesByIds: async (ids: string[]): Promise<Row[]> =>
      ids.map((id) => rows.get(id)).filter((row): row is Row => !!row),
    readSqliteMessage: async (id: string) => ({ available: true, row: rows.get(id) }),
    readSqliteMessages: async (
      conversationId: string,
      limit = 50,
      beforeDate?: string,
    ): Promise<Row[]> => {
      const { resolveOrderInstants } = await import('../../localOrderKey');
      const { isExpiredMessageRow } = await import('../../localAtRest');
      const now = Date.now();
      const scoped: Row[] = [];
      for (const row of byConversation(conversationId)) {
        if (await isExpiredMessageRow(row, now)) continue;
        scoped.push(row);
      }
      const instants = await resolveOrderInstants(scoped);
      const before = beforeDate ? Date.parse(beforeDate) : Number.NaN;
      const kept = scoped.filter((_row, index) =>
        Number.isFinite(before) ? (instants[index] ?? 0) <= before : true,
      );
      const keptInstants = await resolveOrderInstants(kept);
      const ordered = kept
        .map((row, index) => ({ row, instant: keptInstants[index] ?? instantOf(row) }))
        .sort((a, b) => b.instant - a.instant)
        .slice(0, limit)
        .sort((a, b) => a.instant - b.instant);
      return ordered.map((entry) => entry.row);
    },
    readSqliteBackup: async () => ({
      key: new Uint8Array(32),
      kv: [],
      messages: all(),
    }),
    restoreSqliteBackup: async (_key: Uint8Array, _kv: unknown[], messages: Row[]) => {
      for (const row of messages) rows.set(String(row.id), row);
    },
  };
}
