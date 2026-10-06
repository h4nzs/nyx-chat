// Cross-tab single-flight lock for refresh-token rotation.
//
// Why: the refresh flow ROTATES the httpOnly `rt` cookie. If two tabs of the same
// browser profile (e.g. the main app and a burner "/drop" page) POST
// /api/auth/refresh at the same instant, both send the SAME `rt` cookie. The
// server rotates it once; the second request looks like a "reuse attack" and
// revokes the whole session family — bricking the user's session with 401s.
//
// Web Locks API is origin-wide across tabs, so a single lock name serializes
// refreshes; the second tab then uses the freshly-rotated cookie. Falls back to
// a localStorage mutex for browsers without navigator.locks.
//
// CATATAN JUJUR TENTANG FALLBACK: localStorage tidak punya operasi test-and-set
// atomik, jadi mutual exclusion lintas tab di jalur ini BEST-EFFORT — jendela
// TOCTOU kecil tetap ada (tab lain bisa menimpa lock tepat setelah verifikasi
// kita). Kebenaran TIDAK bergantung pada mutex ini. Lapisan kebenaran:
//   1. silentRefresh() SELALU probe GET /api/users/me dulu — kalau tab lain
//      sudah selesai refresh, cookie `at` valid → tidak ada POST kedua.
//   2. Server punya grace window 5 detik (FRESH_ROTATION_GRACE_MS): POST
//      near-simultaneous dengan rt yang sama dianggap refresh benign, bukan
//      reuse attack.
// Mutex ini murni optimasi: mengurangi jumlah POST /refresh yang berlomba.
const LOCK_NAME = 'nyx:auth-refresh';
const FALLBACK_KEY = 'nyx_refresh_lock';
const FALLBACK_STALE_MS = 10000;
const FALLBACK_POLL_MS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (locks) {
    return locks.request(LOCK_NAME, async () => fn());
  }

  // Fallback: localStorage mutex with stale-lock takeover.
  const token = crypto.randomUUID();
  const now = Date.now();
  const ownedValue = `${token}|${now}`;

  // Try to acquire; if another tab holds a fresh lock, wait and retry.
  while (true) {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (raw) {
      const [, ts] = raw.split('|');
      const heldAt = ts ? Number(ts) : 0;
      if (Date.now() - heldAt < FALLBACK_STALE_MS) {
        await sleep(FALLBACK_POLL_MS);
        continue;
      }
    }

    localStorage.setItem(FALLBACK_KEY, ownedValue);
    await sleep(0);
    // Verifikasi pertama + re-verify setelah satu macrotask lagi: menutup
    // sebagian jendela TOCTOU (tab lain yang menimpa di antara dua verifikasi
    // membuat kita mengalah dan mengantre ulang, bukan ikut masuk).
    if (localStorage.getItem(FALLBACK_KEY) === ownedValue) {
      await sleep(0);
      if (localStorage.getItem(FALLBACK_KEY) === ownedValue) break;
    }
  }

  try {
    return await fn();
  } finally {
    if (localStorage.getItem(FALLBACK_KEY) === ownedValue) {
      localStorage.removeItem(FALLBACK_KEY);
    }
  }
}
