// ============================================================================
// [CONTACT TRUST — P4 2026-10-05]
// Level kepercayaan per kontak untuk picker grup/story — MURNI (tanpa import
// store) agar mudah dites dan dipakai lintas komponen.
//
// Hierarki (ala Signal "trust but verify"):
//   verified : safety number percakapan 1:1 dengan peer ini terverifikasi
//              (fingerprint cocok — verification store, keyed conversationId).
//   known    : pernah bertukar pesan (tercatat di contact store).
//   stranger : tidak ada riwayat (mis. hasil search blind-index).
//
// Catatan: user yang DIBLOKIR tidak pernah dipercaya — pemanggil wajib
// menyaring blocklist SEBELUM menghitung trust; bila tetap lolos,
// computeContactTrust defensif mengembalikan 'stranger'.
// ============================================================================

export type ContactTrustLevel = 'verified' | 'known' | 'stranger';

const TRUST_RANK: Record<ContactTrustLevel, number> = {
    stranger: 0,
    known: 1,
    verified: 2,
};

/** Hitung level trust dari state yang diberikan (tanpa efek samping). */
export function computeContactTrust(input: {
    inContacts: boolean;
    isVerified?: boolean;
    blocked?: boolean;
}): ContactTrustLevel {
    if (input.blocked) return 'stranger';
    if (input.isVerified) return 'verified';
    return input.inContacts ? 'known' : 'stranger';
}

/** Peringkat numerik — makin besar makin dipercaya. */
export function getTrustRank(level: ContactTrustLevel): number {
    return TRUST_RANK[level];
}

/**
 * Komparator: trust tertentu dulu, lalu interaksi terbaru, lalu id
 * (deterministik untuk tie-breaker). Ascending pada rank desc = item paling
 * dipercaya di paling atas list.
 */
export function compareByTrustDescThenRecency<T extends { trust: ContactTrustLevel; lastSeenAt: number; userId: string }>(
    a: T,
    b: T
): number {
    const byRank = TRUST_RANK[b.trust] - TRUST_RANK[a.trust];
    if (byRank !== 0) return byRank;
    if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}
