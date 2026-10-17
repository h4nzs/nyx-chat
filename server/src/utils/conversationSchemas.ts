import { z } from 'zod'
import { DELIVERY_TOKEN_RE } from './credentialAuth.js'

/**
 * Skema body untuk membuat percakapan (`POST /api/conversations`).
 *
 * PENTING — apa pun yang dibaca handler dari `req.body` WAJIB terdaftar di
 * sini. `zodValidate` mengganti `req.body` dengan hasil `schema.parse(req.body)`
 * (lihat `utils/validate.ts`), dan `z.object()` tanpa `.passthrough()` MEMBUANG
 * key yang tidak ada di skema. Dulu skema ini ditulis inline di route dan hanya
 * memuat `userIds`/`isGroup`/`encryptedMetadata`/`initialSession`/
 * `deliveryTokens`, sementara handler membaca `req.body.adminSecretHash`:
 * nilainya selalu `undefined` sehingga SETIAP pembuatan grup dijawab
 * `400 adminSecretHash required for groups` — walau klien mengirimnya
 * (terbukti di produksi 2026-10-16: `POST /api/conversations` → 400, log klien
 * "Failed to create group: adminSecretHash required for groups").
 *
 * Dipisah dari route supaya bisa diuji sebagai perilaku tanpa Postgres/Redis
 * (`tests/conversationCreateSchema.test.ts`) — pola yang sama dengan
 * `utils/groupAccess.ts` dan `utils/credentialAuth.ts`.
 */
export const conversationSchema = z.object({
  id: z.string().optional(),
  isGroup: z.boolean().optional(),
  encryptedMetadata: z.string().nullable().optional(),
})

// [T3b] Delivery tokens: creator issues one opaque token per invited member.
// Server stores (conversationId, token) — it cannot link token → identity
// beyond the routing-only row it is told to create. TOKEN-FIRST: discovery
// adalah possession token, bukan join userId (26.8.1 trigger #1 tertutup).
export const deliveryTokenSchema = z.string().regex(DELIVERY_TOKEN_RE)

/** Sesi awal 1:1 (X3DH) yang dikirim pembuat percakapan. */
export const initialSessionSchema = z.object({
  sessionId: z.string(),
  initialKeysPerDevice: z.record(z.string(), z.string()),
  initiatorCiphertextsPerDevice: z.record(z.string(), z.string()),
})

/**
 * Body `POST /api/conversations` — daftar key ini adalah satu-satunya yang
 * sampai ke handler; key di luar daftar ini hilang saat parse.
 */
export const createConversationBodySchema = conversationSchema
  .pick({ isGroup: true, encryptedMetadata: true })
  .extend({
    userIds: z.array(z.string()).min(1),
    initialSession: initialSessionSchema.optional(),
    // [T3b] Map userId -> delivery token, issued client-side by the creator.
    // NOTE Zod 4: argumen pertama z.record = schema KEY (userId), jadi harus
    // string biasa — `deliveryTokenSchema` hanya untuk VALUE (token 22-char).
    deliveryTokens: z.record(z.string().min(1), deliveryTokenSchema).optional(),
    // [26.9 RBAC] SHA-256 hex dari admin capability token buatan creator.
    // Sengaja hanya `z.string()`: pemeriksaan bentuk (64-hex lowercase) tetap di
    // handler agar pesan errornya spesifik ("Invalid adminSecretHash format"),
    // sementara pesan "adminSecretHash required for groups" tetap muncul untuk
    // permintaan yang benar-benar tidak mengirimkannya.
    adminSecretHash: z.string().optional(),
  })
