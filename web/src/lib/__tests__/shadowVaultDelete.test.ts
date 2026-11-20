import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake in-memory tables cukup untuk memverifikasi perilaku deleteConversation:
// pesan, state ratchet, dan — yang menjadi regresi — baris `conversations`.
function makeTable<T extends { id: string }>() {
  const rows = new Map<string, T>()
  return {
    _rows: rows,
    put(r: T) { rows.set(r.id, r) },
    get(id: string) { return rows.get(id) },
    delete: vi.fn(async (id: string) => { rows.delete(id) }),
    bulkPut(items: T[]) { for (const i of items) rows.set(i.id, i) },
    bulkDelete(ids: string[]) { for (const id of ids) rows.delete(id) },
    count() { return rows.size },
  }
}

const fakeMessages = makeTable<{ id: string; conversationId: string }>()
const fakeConversations = makeTable<{ id: string }>()
const fakeRatchet = makeTable<{ id: string }>()
const fakeGroupSender = makeTable<{ id: string }>()
const fakeGroupReceiver = makeTable<{ id: string }>()

const db = {
  messages: {
    where: (col: string) => ({
      equals: (val: string) => ({
        delete: vi.fn(async () => {
          const rows = [...fakeMessages._rows.entries()].filter(([, r]) => r[col as keyof typeof r] === val)
          for (const [id] of rows) fakeMessages._rows.delete(id)
        }),
      }),
    }),
  },
  conversations: fakeConversations,
  ratchetSessions: fakeRatchet,
  groupSenderStates: fakeGroupSender,
  groupSkippedKeys: {
    where: () => ({
      between: () => ({ delete: vi.fn(async () => {}) }),
    }),
  },
  groupReceiverStates: {
    where: () => ({
      startsWith: (prefix: string) => ({
        delete: vi.fn(async () => {
          const rows = [...fakeGroupReceiver._rows.entries()].filter(([id]) => id.startsWith(prefix))
          for (const [id] of rows) fakeGroupReceiver._rows.delete(id)
        }),
      }),
      between: (lower: string) => ({
        delete: vi.fn(async () => {
          const rows = [...fakeGroupReceiver._rows.entries()].filter(([id]) => id.startsWith(lower))
          for (const [id] of rows) fakeGroupReceiver._rows.delete(id)
        }),
      }),
    }),
  },
}

vi.mock('@lib/db', () => ({ db, Dexie: class {} }))

// Import AFTER mock registration
const { shadowVault } = await import('@lib/shadowVaultDb')

beforeEach(() => {
  fakeMessages._rows.clear()
  fakeConversations._rows.clear()
  fakeRatchet._rows.clear()
  fakeGroupSender._rows.clear()
  fakeGroupReceiver._rows.clear()
})

describe('shadowVault.deleteConversation', () => {
  it('menghapus pesan, state ratchet, dan baris conversations (regresi: percakapan muncul lagi setelah reload)', async () => {
    // Seed data
    fakeMessages.put({ id: 'm1', conversationId: 'conv_1' })
    fakeMessages.put({ id: 'm2', conversationId: 'conv_1' })
    fakeMessages.put({ id: 'm3', conversationId: 'conv_2' })
    fakeConversations.put({ id: 'conv_1' })
    fakeConversations.put({ id: 'conv_2' })
    fakeRatchet.put({ id: 'conv_1' })
    fakeGroupSender.put({ id: 'conv_1' })
    fakeGroupReceiver.put({ id: 'conv_1_0' })
    fakeGroupReceiver.put({ id: 'conv_2_0' })

    await shadowVault.deleteConversation('conv_1')

    // Pesan milik conv_1 hilang; pesan conv_2 bertahan
    expect(fakeMessages._rows.has('m1')).toBe(false)
    expect(fakeMessages._rows.has('m2')).toBe(false)
    expect(fakeMessages._rows.has('m3')).toBe(true)

    // State kripto conv_1 hilang
    expect(fakeRatchet._rows.has('conv_1')).toBe(false)
    expect(fakeGroupSender._rows.has('conv_1')).toBe(false)
    expect(fakeGroupReceiver._rows.has('conv_1_0')).toBe(false)

    // REGRESI: baris `conversations` conv_1 harus ikut terhapus
    expect(fakeConversations._rows.has('conv_1')).toBe(false)
    expect(fakeConversations._rows.has('conv_2')).toBe(true)
  })

  it('tidak melempar saat percakapan tidak dikenal', async () => {
    await expect(shadowVault.deleteConversation('ghost_conv')).resolves.toBeUndefined()
  })
})