// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T4 UX] Hook pencarian user (blind index) untuk AddParticipantModal &
 * CreateGroupChat — satu implementasi, tiga perlindungan anti-spam server:
 *
 *  1. Debounce: request hanya jalan setelah user BERHENTI mengetik
 *     SEARCH_DEBOUNCE_MS (600ms — timer reset tiap ketikan).
 *  2. In-flight dedup + stale-guard: hashUsername butuh ~1.1s (Argon2id);
 *     hasil untuk query lama TIDAK PERNAH menimpa hasil query baru, dan
 *     query identik yang sedang jalan tidak diulang.
 *  3. Cache hasil per query (max 20, LRU sederhana) — mengetik ulang teks
 *     yang sama tidak memicu request kedua.
 *
 * Nyala loading ("Searching...") tetap instan saat debounce berjalan, jadi
 * UX tidak terasa lambat walau hash lambat. Ekstraksi modal yang berbeda:
 * bug race lama — hash 1.1s > debounce 500ms — membuat hasil pencarian
 * kadang kosong (resolve out-of-order menimpa state dengan array lama).
 */
import { useEffect, useRef, useState } from 'react';
import { asUserId } from '@nyx/shared';
import type { UserId, MinimalProfile } from '@nyx/shared';
import { api } from '@lib/api';

/** Jeda setelah user berhenti mengetik sebelum search dieksekusi. */
export const SEARCH_DEBOUNCE_MS = 600;
/** Panjang minimum query sebelum search dijalankan (kontrak lama: >2). */
export const MIN_QUERY_LENGTH = 3;

interface UseUserSearchOptions {
  /** UserId yang dikecualikan dari hasil (mis. anggota grup yang sudah ada). */
  excludeIds?: UserId[];
  /** Eksekusi pencarian (default: GET /api/users/search via blind index). */
  searchFn?: (query: string) => Promise<MinimalProfile[]>;
}

export function useUserSearch(rawSearchTerm: string, options: UseUserSearchOptions = {}) {
  const { excludeIds = [], searchFn } = options;
  const [results, setResults] = useState<MinimalProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Seq untuk stale-guard: hanya hasil dengan seq terbaru yang boleh menimpa state.
  const seqRef = useRef(0);
  // Query identik yang sedang in-flight — dedup antar-effect re-run.
  const inflightRef = useRef<Map<string, Promise<MinimalProfile[]>>>(new Map());
  // Cache hasil per query (LRU sederhana berbasis Map insertion order).
  const cacheRef = useRef<Map<string, MinimalProfile[]>>(new Map());

  const doSearch = searchFn ?? (async (query: string) => {
    const { hashUsername } = await import('@lib/crypto-worker-proxy');
    const hashedQuery = await hashUsername(query);
    return api<MinimalProfile[]>(`/api/users/search?q=${encodeURIComponent(hashedQuery)}`);
  });

  useEffect(() => {
    const query = rawSearchTerm.trim();
    seqRef.current += 1;
    const mySeq = seqRef.current;

    // Terlalu pendek → kosongkan, tanpa loading, tanpa request.
    if (query.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    // Cache hit → tampilkan tanpa menyentuh server.
    const cached = cacheRef.current.get(query);
    if (cached) {
      // Refresh LRU order.
      cacheRef.current.delete(query);
      cacheRef.current.set(query, cached);
      setResults(cached);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    setIsSearching(true);
    setSearchError(null);

    const timer = setTimeout(async () => {
      try {
        // Dedup in-flight untuk query identik.
        let pending = inflightRef.current.get(query);
        if (!pending) {
          pending = doSearch(query);
          inflightRef.current.set(query, pending);
        }
        const users = await pending;
        inflightRef.current.delete(query);

        // Stale-guard: user sudah mengetik lagi → buang hasil lama.
        if (seqRef.current !== mySeq) return;

        // Cache (batasi 20 entri, buang yang tertua).
        cacheRef.current.set(query, users);
        if (cacheRef.current.size > 20) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest !== undefined) cacheRef.current.delete(oldest);
        }

        const exclude = new Set(excludeIds.map(id => id as string));
        setResults(users.filter(u => !exclude.has(u.id)));
      } catch (err) {
        if (seqRef.current !== mySeq) return;
        console.error('[useUserSearch] Search failed:', err);
        setResults([]);
        setSearchError(err instanceof Error ? err.message : 'search_failed');
      } finally {
        inflightRef.current.delete(query);
        if (seqRef.current === mySeq) setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // excludeIds dieksekusi di dalam effect via Set snapshot — memasukkannya
    // ke deps hanya memicu re-filter, bukan request ulang (cache menahan).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSearchTerm]);

  return { results, isSearching, searchError };
}
