// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.7 — Fase 6] Bank token untuk issuance credential anonim.
 *
 * Alur:
 *  1. klien terautentikasi membeli batch token (`nct1_…`) — server menyimpan
 *     HANYA SHA-256(token) di Redis (TTL 24 jam) dan menghitung kuota harian
 *     per `identityTag(user)`;
 *  2. redeem anonim menukar satu token dengan blind signature, tanpa JWT;
 *  3. redeem mengembalikan `commitTicket` (`cct1_…`) single-use yang terikat
 *     conversation, ditukar saat commit.
 *
 * Token adalah bearer secret: Redis persisten = artefak setara dump, jadi
 * plaintext token tidak pernah disimpan dan key memakai hash/tag (bukan userId).
 * Konsumsi memakai Lua GET+DEL supaya replay dua request paralel tetap hanya
 * satu yang menang.
 */

import { createHash, randomBytes } from 'node:crypto'
import { identityTag } from './redisIdentity.js'

export const CREDENTIAL_TOKEN_PREFIX = 'nct1_'
export const COMMIT_TICKET_PREFIX = 'cct1_'
const TOKEN_BODY_LENGTH = 43
const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{43}$/

/** Batas token yang boleh dibeli per user per hari (1 token = 1 issuance). */
export const CREDENTIAL_TOKENS_PER_DAY_MAX = 5

/** Batas token per permintaan bank. */
export const CREDENTIAL_TOKEN_BATCH_MAX = 5

export const CREDENTIAL_TOKEN_TTL_SECONDS = 86400
export const CREDENTIAL_TICKET_TTL_SECONDS = 600

export const generateCredentialToken = (): string =>
  `${CREDENTIAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

export const generateCommitTicket = (): string =>
  `${COMMIT_TICKET_PREFIX}${randomBytes(32).toString('base64url')}`

function hasPrefixedBody(value: unknown, prefix: string): boolean {
  if (typeof value !== 'string') return false
  return value.length === prefix.length + TOKEN_BODY_LENGTH &&
    value.startsWith(prefix) &&
    TOKEN_BODY_RE.test(value.slice(prefix.length))
}

export const isCredentialToken = (value: unknown): boolean =>
  hasPrefixedBody(value, CREDENTIAL_TOKEN_PREFIX)

export const isCommitTicket = (value: unknown): boolean =>
  hasPrefixedBody(value, COMMIT_TICKET_PREFIX)

/** SHA-256 hex — bentuk yang disimpan di Redis. */
export const credentialTokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const credentialTokenKey = (token: string): string =>
  `cred:token:${credentialTokenHash(token)}`

export const commitTicketKey = (ticket: string): string =>
  `cred:ticket:${credentialTokenHash(ticket)}`

/** Kuota bank token harian: `cred:tokens:<tag(user)>:<hari>`. */
export const credentialTokenQuotaKey = (userId: string, day: string): string =>
  `cred:tokens:${identityTag(userId)}:${day}`

/** INCRBY + EXPIRE atomik (pola yang sama dengan limiter lain di repo). */
export const CREDENTIAL_INCRBY_LUA = `
local current = redis.call('INCRBY', KEYS[1], ARGV[2])
if current == tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`

/**
 * Ambil-lalu-hapus atomik. Mengembalikan nilai tersimpan (string) atau nil.
 * Dipakai untuk token dan commit ticket: request kedua selalu kalah.
 */
export const CREDENTIAL_CONSUME_LUA = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`

/** Apakah kuota bank token melewati batas? NaN (infra error) = fail-open. */
export const exceedsTokenQuota = (count: number): boolean =>
  !Number.isNaN(count) && count > CREDENTIAL_TOKENS_PER_DAY_MAX
