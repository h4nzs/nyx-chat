// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.4 R3] Alasan ban tidak lagi teks bebas.
 *
 * Kolom `User.banReason` dulu `String?`, jadi kalimat yang diketik operator
 * (kadang berisi kutipan laporan atau data pribadi pelapor) tersimpan plaintext
 * dan ikut ke setiap dump DB. Sekarang kolomnya enum `BanReason`; input bebas
 * dari dashboard dipetakan di sini dan hanya kode yang tersimpan/dikirim.
 *
 * Pemetaan keyword sengaja longgar dan berakhir di `OTHER`: admin lama yang
 * mengirim kalimat tetap bisa mem-ban, hanya detail kalimatnya tidak disimpan.
 */
import { BanReason } from '@prisma/client';

const KEYWORDS: Array<[RegExp, BanReason]> = [
    [/spam|scam|phish/i, BanReason.SPAM],
    [/abuse|harass|threat|hate/i, BanReason.ABUSE],
    [/impersonat|fake account|sockpuppet/i, BanReason.IMPERSONATION],
    [/security|compromis|breach|hijack/i, BanReason.SECURITY],
    [/tos|terms|policy|guideline/i, BanReason.TOS_VIOLATION],
];

/** Input admin (kode enum atau kalimat bebas) → kode enum yang disimpan. */
export function toBanReason (input: unknown): BanReason {
    if (typeof input !== 'string') return BanReason.TOS_VIOLATION;
    const text = input.trim();
    if (!text) return BanReason.TOS_VIOLATION;
    if ((Object.values(BanReason) as string[]).includes(text)) return text as BanReason;
    for (const [pattern, reason] of KEYWORDS) {
        if (pattern.test(text)) return reason;
    }
    return BanReason.OTHER;
}
