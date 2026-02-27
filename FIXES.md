**CONTEXT:**
Kita akan mengeksekusi "Phase 2: Group Ratchet Keychain & Distribution". Kita perlu memperbarui IndexedDB (`keychainDb.ts`) untuk menyimpan state Ratchet (Sender dan Receiver) dan memodifikasi `ensureGroupSession` di `crypto.ts` untuk menggunakan `groupInitSenderKey` alih-alih kunci simetris statis.

**TASK:**
Modifikasi file `keychainDb.ts` dan `crypto.ts`.

**Langkah 1: Modifikasi `web/src/lib/keychainDb.ts**`

1. Di `openDatabase()`, pada blok `onupgradeneeded`, tambahkan dua *object store* baru:
* `db.createObjectStore('group_sender_states', { keyPath: 'conversationId' })`
* `db.createObjectStore('group_receiver_states', { keyPath: 'id' })` // id akan berupa gabungan `conversationId_senderId`


2. Tambahkan tipe data untuk state:
```typescript
export interface GroupSenderState {
  conversationId: string;
  CK: string;
  N: number;
}
export interface GroupReceiverState {
  id: string; // "conversationId_senderId"
  conversationId: string;
  senderId: string;
  CK: string;
  N: number;
  skippedKeys: { n: number, mk: string }[];
}

```


3. Buat fungsi helper CRUD untuk store tersebut:
* `export async function getGroupSenderState(conversationId: string): Promise<GroupSenderState | null>`
* `export async function saveGroupSenderState(state: GroupSenderState): Promise<void>`
* `export async function getGroupReceiverState(conversationId: string, senderId: string): Promise<GroupReceiverState | null>` // ingat parameter id-nya `conversationId_senderId`
* `export async function saveGroupReceiverState(state: GroupReceiverState): Promise<void>`
* `export async function deleteGroupStates(conversationId: string): Promise<void>` // Hapus state sender dan semua receiver yang memiliki conversationId ini (bisa gunakan cursor atau hapus manual jika membership berubah).



**Langkah 2: Rombak `ensureGroupSession` di `web/src/utils/crypto.ts**`
Ubah logika `ensureGroupSession` dari menggunakan `worker_generate_random_key` menjadi `groupInitSenderKey`:

1. Import `groupInitSenderKey` dari `@lib/crypto-worker-proxy`.
2. Import fungsi-fungsi DB yang baru dibuat dari `keychainDb.ts`.
3. Alur `ensureGroupSession`:
* Cek apakah kita sudah punya `GroupSenderState` untuk `conversationId` tersebut menggunakan `getGroupSenderState`.
* Jika sudah ada, return `[]` (tidak perlu distribusi ulang).
* Jika belum ada:
a. Panggil `const { senderKeyB64 } = await groupInitSenderKey()`.
b. Simpan ke lokal: `await saveGroupSenderState({ conversationId, CK: senderKeyB64, N: 0 })`.
c. Lakukan *fan-out encryption* persis seperti sebelumnya: loop daftar `participants`, ambil public key mereka dari cache/DB, lalu enkripsi `senderKeyB64` menggunakan `worker_crypto_box_seal`.
d. Return array `distributionKeys` yang berisi object `{ userId, key: encryptedKey }`.



**Langkah 3: Rombak `processNewSessionKey` di `web/src/utils/crypto.ts` (Bagian GROUP_KEY)**
Saat menerima `GROUP_KEY` dari socket, sistem akan masuk ke `processNewSessionKey` (atau fungsi serupa yang menangani incoming `GROUP_KEY` di `crypto.ts`).

1. Decrypt kunci tersebut menggunakan `worker_crypto_box_seal_open` (kode lama sudah melakukan ini).
2. Dulu, hasil decrypt disimpan sebagai `groupKey`. **Ubah ini!**
3. Simpan hasil decrypt (yang merupakan `senderKeyB64` dari pengirim) ke `group_receiver_states`:
```typescript
await saveGroupReceiverState({
  id: `${conversationId}_${senderId}`,
  conversationId,
  senderId,
  CK: decryptedSenderKeyB64,
  N: 0,
  skippedKeys: []
});

```



**Aturan Penulisan Kode:**

* Jangan hapus fungsi IndexedDB yang lama (`session_keys`, `message_keys`) karena itu masih dipakai untuk chat 1-on-1.
* Pastikan penggunaan `conversationId_senderId` konsisten sebagai key di `group_receiver_states`.
