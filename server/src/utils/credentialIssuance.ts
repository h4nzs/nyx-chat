// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.1] Kuota + tiket credential keanggotaan grup (blind RSA).
 *
 * Dua masalah yang ditutup di sini:
 *
 *  1. **Key Redis tidak boleh memuat userId asli.** Dulu kunci kuota issuance
 *     berbentuk `cred:issue:<userId>:<conversationId>:<hari>` — Redis persisten
 *     (AOF) jadi setara dump DB, dan userId di kunci = daftar "siapa meminta
 *     credential untuk grup mana". Kini memakai `identityTag()` (HMAC pepper),
 *     deterministik sehingga counter tetap idempoten.
 *
 *  2. **Commit tanpa issuance.** `POST /credential-commit` menerima serial
 *     96-hex sembarang tanpa batas; siapa pun yang terautentikasi bisa
 *     menumbuhkan tabel GroupCredential sebanyak yang ia mau (spam/DoS) karena
 *     server tidak bisa (dan tidak boleh) mengaitkan serial dengan blinded
 *     message yang ditandatangani. Yang bisa dilakukan: mengikat commit ke
 *     **tiket issuance** — jumlah commit tidak boleh melebihi jumlah issuance
 *     untuk (user, conversation) pada hari yang sama. Blind signature tetap
 *     unlinkable secara kriptografis; yang dibatasi hanya volume penulisan.
 *
 * Hari diperiksa untuk hari ini **dan** kemarin supaya issuance di 23:59 yang
 * commit-nya mendarat 00:01 tidak ditolak.
 */

import { identityTag } from './redisIdentity.js';

/** Batas issuance credential per (user, conversation) per 24 jam. */
export const CREDENTIAL_ISSUANCE_DAILY_MAX = 3;

/** TTL counter kuota/tiket (detik) — 24 jam. */
export const CREDENTIAL_QUOTA_TTL_SECONDS = 86400;

/** Kunci counter issuance: `cred:issue:<tag(user)>:<conversationId>:<hari>`. */
export const credentialIssuanceKey = (userId: string, conversationId: string, day: string): string =>
  `cred:issue:${identityTag(userId)}:${conversationId}:${day}`;

/** Kunci counter commit: `cred:commit:<tag(user)>:<conversationId>:<hari>`. */
export const credentialCommitKey = (userId: string, conversationId: string, day: string): string =>
  `cred:commit:${identityTag(userId)}:${conversationId}:${day}`;

/**
 * INCR + EXPIRE atomik dalam satu skrip Lua — pola yang sama dengan limiter lain
 * di repo (jangan kembali ke incr-lalu-expire yang bisa meninggalkan key abadi).
 */
export const CREDENTIAL_INCR_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/** Hari (UTC) untuk kunci counter. */
export const credentialDay = (now: Date = new Date()): string => now.toISOString().split('T')[0]!;

const MS_PER_DAY = 86400000;

/** [hari ini, kemarin] — grace untuk commit yang melewati tengah malam. */
export const credentialDays = (now: Date = new Date()): string[] => [
  credentialDay(now),
  credentialDay(new Date(now.getTime() - MS_PER_DAY)),
];

/** Apakah counter issuance melewati batas? NaN (infra error) = fail-open. */
export const exceedsIssuanceQuota = (count: number): boolean =>
  !Number.isNaN(count) && count > CREDENTIAL_ISSUANCE_DAILY_MAX;

/**
 * Apakah commit masih boleh dicatat? Tidak bila tidak ada issuance sama sekali
 * (tiket kosong) atau commit sudah mengejar jumlah issuance.
 */
export const commitAllowed = (committed: number, issued: number): boolean =>
  issued > 0 && committed <= issued;
