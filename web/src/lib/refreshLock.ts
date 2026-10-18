// Cross-tab single-flight lock for refresh-token rotation.
//
// Why: the refresh flow ROTATES the httpOnly `rt` cookie. If two tabs of the same
// browser profile (e.g. the main app and a burner "/drop" page) POST
// /api/auth/refresh at the same instant, both send the SAME `rt` cookie. The
// server rotates it once; the second request looks like a "reuse attack" and
// revokes the whole session family — bricking the user's session with 401s.
//
// TIGA TIER, dari yang paling kuat:
//   1. Web Locks API — mutual exclusion lintas-tab sejati (origin-wide).
//   2. Mutex via Service Worker (swMutexClient/swMutexCore) — exclusion sejati
//      juga: registry di SW TUNGGAL per-origin. Dipakai bila SW mengendalikan
//      halaman tapi navigator.locks tidak ada (browser lawas 2021–2022).
//   3. localStorage mutex — BEST-EFFORT (localStorage tanpa test-and-set
//      atomik; jendela TOCTOU kecil tetap ada). Hanya dijalankan bila dua tier
//      di atas tak tersedia.
// Lapisan kebenaran di luar mutex (selalu aktif):
//   1. silentRefresh() SELALU probe GET /api/users/me dulu, dan doRefresh
//      RE-PROBE SEKALI LAGI di dalam lock tepat sebelum POST — menunggu mutex
//      bisa makan waktu; tab lain mungkin sudah menyelesaikan refresh selama
//      kita menunggu → jangan POST rt basi.
//   2. Server mengklasifikasikan replay (utils/refreshReplay.ts): token yang
//      merupakan pendahulu LANGSUNG dari token hidup terbaru dan berumur
//      ≤ REFRESH_REPLAY_GRACE_MS (default 2 menit) dianggap retry benign — ini
//      menutup retry setelah respons hilang/timeout, bukan hanya yang
//      near-simultaneous. Family yang sudah tidak punya token hidup dibalas
//      401 biasa tanpa alarm, dan `force_logout` hanya dikirim ke device asal.
import { isSwMutexAvailable, withSwMutex } from './swMutexClient';

const LOCK_NAME = 'nyx:auth-refresh';
// Batas menunggu acquire di tier SW: cukup longgar untuk refresh pemegang
// lain yang berjalan normal (retry 3× + backoff ≈ ≤10s). Setelah itu jatuh ke
// localStorage — re-probe doRefresh menutup celah rt basi yang tersisa.
const SW_MUTEX_ACQUIRE_TIMEOUT_MS = 20_000;
const FALLBACK_KEY = 'nyx_refresh_lock';
const FALLBACK_STALE_MS = 10000;
const FALLBACK_POLL_MS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (locks) {
    return locks.request(LOCK_NAME, async () => fn());
  }

  // Tier 2: mutex via Service Worker — exclusion sejati (registry tunggal di
  // SW; semua tab satu-origin berbagi instance yang sama). {ok:false} berarti
  // SW tidak tersedia / acquire timeout → jatuh ke tier 3.
  if (isSwMutexAvailable()) {
    const result = await withSwMutex(LOCK_NAME, fn, {
      timeoutMs: SW_MUTEX_ACQUIRE_TIMEOUT_MS,
    });
    if (result.ok) return result.value;
    console.warn('[refreshLock] Mutex SW gagal/timeout — jatuh ke fallback localStorage.');
  }

  // Tier 3 (terakhir): localStorage mutex with stale-lock takeover.
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
