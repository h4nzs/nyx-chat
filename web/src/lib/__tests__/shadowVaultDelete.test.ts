import { describe, it, expect, vi, beforeEach } from 'vitest'

// [docs/43 §43.11.6 B3] keychainDb punya SATU backend. Tes jsdom memakai
// `db.kvStore` sebagai KeyStore (createDexieKvStore), jadi state ratchet/grup
// dihapus di sana — bukan di tabel Dexie bertipe lama.
// Seperti tabel Dexie `kvStore`: record `{key, value}`, bukan nilai saja.
const kvRows = new Map<string, { key: string; value: unknown }>()

const kvStore = {
  get: async (key: string) => kvRows.get(key),
  put: async (item: { key: string; value: unknown }) => { kvRows.set(item.key, item) },
  delete: async (key: string) => { kvRows.delete(key) },
  clear: async () => { kvRows.clear() },
  where: () => ({ startsWith: () => ({ delete: async () => {} }) }),
  toCollection: () => ({ primaryKeys: async () => [...kvRows.keys()] }),
}

const fakeMessages = new Map<string, { id: string; conversationId: string }>()
const fakeConversations = new Map<string, { id: string }>()

// Fake in-memory tables cukup untuk memverifikasi perilaku deleteConversation:
// pesan, state kripto, dan — yang menjadi regresi — baris `conversations`.
const db = {
  kvStore,
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
    kvRows.set('ratchet:conv_1', { key: 'ratchet:conv_1', value: { v: 'AAAA' } })
    kvRows.set('ratchet:conv_2', { key: 'ratchet:conv_2', value: { v: 'BBBB' } })
    kvRows.set('gs:conv_1', { key: 'gs:conv_1', value: { v: 'CCCC' } })
    kvRows.set('gs:conv_2', { key: 'gs:conv_2', value: { v: 'DDDD' } })
    kvRows.set('gr:conv_1_device', { key: 'gr:conv_1_device', value: { v: 'EEEE' } })
    kvRows.set('gr:conv_2_device', { key: 'gr:conv_2_device', value: { v: 'FFFF' } })
    kvRows.set('gskip:conv_1_device_1', { key: 'gskip:conv_1_device_1', value: { v: 'GGGG' } })
    kvRows.set('gskip:conv_2_device_1', { key: 'gskip:conv_2_device_1', value: { v: 'HHHH' } })

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
