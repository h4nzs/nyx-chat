// Pure retry helper for the silent-refresh flow.
//
// Extracted from `store/auth.ts` so the "refresh must never log out on a
// transient failure" behavior can be unit-tested without importing the whole
// auth store (which pulls in transport, keychain, message store, etc.).
//
// Regression guard: a single transient failure (network hiccup, concurrent
// rotation from another tab) must NOT return failure — we retry up to
// `attempts` times with a small backoff. Only persistent failure returns null.

export interface RefreshResult {
  accessToken: string;
  [key: string]: unknown;
}

/**
 * Sifat kegagalan refresh:
 *   - `auth`      → server MENOLAK sesi ini (401/403). Sesi memang tidak bisa
 *                   dipulihkan; logout/revoke family dapat dibenarkan.
 *   - `transient` → jaringan/timeout/5xx/respons aneh. Sesi BELUM tentu mati;
 *                   jangan logout dan jangan revoke family.
 *
 * [BUGFIX 2026-10-18] Sebelumnya kedua jenis ini sama-sama menghasilkan `false`
 * di `silentRefresh()`, lalu `authFetch` memanggil handler logout yang
 * mem-POST `/api/auth/logout` (revoke seluruh family). Satu gangguan jaringan
 * singkat saat tab resume sudah cukup untuk mematikan sesi di semua tab — dan
 * tab lain yang tertinggal lalu memicu deteksi "reuse" + `/login?reason=revoked`.
 */
export type RefreshFailureKind = 'auth' | 'transient';

/** Klasifikasi error refresh. Hanya 401/403 yang dianggap final. */
export function classifyRefreshFailure(error: unknown): RefreshFailureKind {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403 ? 'auth' : 'transient';
}

export async function refreshWithRetry(
  refreshOnce: () => Promise<unknown>,
  attempts = 3,
  backoffBaseMs = 400,
  onFailure?: (kind: RefreshFailureKind, error: unknown) => void
): Promise<RefreshResult | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const data = await refreshOnce();
      if (
        data &&
        typeof data === 'object' &&
        'accessToken' in data &&
        typeof (data as Record<string, unknown>).accessToken === 'string'
      ) {
        return data as RefreshResult;
      }
      // Respons 2xx tanpa accessToken = server/proxy aneh, bukan sesi mati.
      onFailure?.('transient', new Error('Refresh response without accessToken'));
    } catch (error) {
      // Transient failure — fall through to retry (or final failure below).
      onFailure?.(classifyRefreshFailure(error), error);
      console.debug('[Auth] Refresh attempt failed:', error instanceof Error ? error.message : error);
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, backoffBaseMs * (attempt + 1)));
    }
  }
  return null;
}
