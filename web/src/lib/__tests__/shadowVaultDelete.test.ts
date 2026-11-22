import { describe, it, expect, vi, beforeEach } from 'vitest'

// [docs/43 §43.11.6 B3] keychainDb punya SATU backend: KeyStore SQLite (byte
// mentah). State ratchet/grup dihapus di sana — bukan di tabel Dexie lama.
const kvRows = new Map<string, Uint8Array>()

const keyStore = {
  get: async (key: string) => kvRows.get(key),
  put: async (key: string, value: Uint8Array) => { kvRows.set(key, value) },
  delete: async (key: string) => { kvRows.delete(key) },
  keys: async (prefix?: string) => [...kvRows.keys()].filter((key) => !prefix || key.startsWith(prefix)),
  clear: async () => { kvRows.clear() },
}

vi.mock('@lib/storage/sqliteMessages', () => ({
  openSqliteKeyStore: async () => keyStore,
}))

const fakeMessages = new Map<string, { id: string; conversationId: string }>()
const fakeConversations = new Map<string, { id: string }>()

// Fake in-memory tables cukup untuk memverifikasi perilaku deleteConversation:
// pesan, state kripto, dan — yang menjadi regresi — baris `conversations`.
const db = {
  messages: {
    where: () => ({
      equals: (value: string) => ({
        delete: async () => {
          for (const [id, row] of fakeMessages) {
            if (row.conversationId === value) fakeMessages.delete(id)
          }
        },
      }),
    }),
  },
  conversations: {
    get: async (id: string) => fakeConversations.get(id),
    put: async (row: { id: string }) => { fakeConversations.set(row.id, row) },
    delete: async (id: string) => { fakeConversations.delete(id) },
    toArray: async () => [...fakeConversations.values()],
    bulkPut: async (rows: Array<{ id: string }>) => {
      for (const row of rows) fakeConversations.set(row.id, row)
    },
    clear: async () => { fakeConversations.clear() },
  },
}

vi.mock('@lib/db', () => ({ db, Dexie: class {} }))

// [docs/43 §43.11.6 B3] Baris percakapan hidup di appStorage (SQLite); fake di
// atas yang menjadi backend-nya.
vi.mock('@lib/storage/appStorage', () => ({
  getAppRow: async (table: string, id: string) =>
    table === 'conversations' ? fakeConversations.get(id) : undefined,
  putAppRow: async (table: string, id: string, row: { id: string }) => {
    if (table === 'conversations') fakeConversations.set(id, row)
  },
  deleteAppRow: async (table: string, id: string) => {
    if (table === 'conversations') fakeConversations.delete(id)
  },
  listAppRows: async (table: string) =>
    table === 'conversations' ? [...fakeConversations.values()] : [],
  putAppRows: async (table: string, rows: { id: string }[]) => {
    if (table === 'conversations') for (const row of rows) fakeConversations.set(row.id, row)
  },
  clearAppTable: async (table: string) => {
    if (table === 'conversations') fakeConversations.clear()
  },
}))

// Import AFTER mock registration
const { shadowVault } = await import('@lib/shadowVaultDb')

beforeEach(() => {
  fakeMessages.clear()
  fakeConversations.clear()
  kvRows.clear()
})

describe('shadowVault.deleteConversation', () => {
  it('menghapus pesan, state kripto, dan baris conversations (regresi: percakapan muncul lagi setelah reload)', async () => {
    // Seed data
    fakeMessages.set('m1', { id: 'm1', conversationId: 'conv_1' })
    fakeMessages.set('m2', { id: 'm2', conversationId: 'conv_1' })
    fakeMessages.set('m3', { id: 'm3', conversationId: 'conv_2' })
    fakeConversations.set('conv_1', { id: 'conv_1' })
    fakeConversations.set('conv_2', { id: 'conv_2' })

    // State kripto di KeyStore — baris conv_2 harus utuh.
    const at = (label: string) => new TextEncoder().encode(label)
    kvRows.set('ratchet:conv_1', at('AAAA'))
    kvRows.set('ratchet:conv_2', at('BBBB'))
    kvRows.set('gs:conv_1', at('CCCC'))
    kvRows.set('gs:conv_2', at('DDDD'))
    kvRows.set('gr:conv_1_device', at('EEEE'))
    kvRows.set('gr:conv_2_device', at('FFFF'))
    kvRows.set('gskip:conv_1_device_1', at('GGGG'))
    kvRows.set('gskip:conv_2_device_1', at('HHHH'))

    await shadowVault.deleteConversation('conv_1')

    // Pesan milik conv_1 hilang; pesan conv_2 bertahan
    expect(fakeMessages.has('m1')).toBe(false)
    expect(fakeMessages.has('m2')).toBe(false)
    expect(fakeMessages.has('m3')).toBe(true)

    // State kripto conv_1 hilang, conv_2 bertahan
    expect(kvRows.has('ratchet:conv_1')).toBe(false)
    expect(kvRows.has('gs:conv_1')).toBe(false)
    expect(kvRows.has('gr:conv_1_device')).toBe(false)
    expect(kvRows.has('gskip:conv_1_device_1')).toBe(false)
    expect(kvRows.has('ratchet:conv_2')).toBe(true)
    expect(kvRows.has('gs:conv_2')).toBe(true)
    expect(kvRows.has('gr:conv_2_device')).toBe(true)
    expect(kvRows.has('gskip:conv_2_device_1')).toBe(true)

    // REGRESI: baris `conversations` conv_1 harus ikut terhapus
    expect(fakeConversations.has('conv_1')).toBe(false)
    expect(fakeConversations.has('conv_2')).toBe(true)
  })

  it('tidak melempar saat percakapan tidak dikenal', async () => {
    await expect(shadowVault.deleteConversation('ghost_conv')).resolves.toBeUndefined()
  })
})
