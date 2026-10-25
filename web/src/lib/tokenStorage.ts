// CATATAN KONTRAK: cookie `at`/`rt` yang sesungguhnya di-set server sebagai
// HttpOnly — JS klien tidak bisa membaca/menghapusnya (clearAuthCookies hanya
// membersihkan sisa cookie non-HttpOnly; penghapusan yang benar terjadi
// server-side via /api/auth/logout & /logout-all). Fungsi di sini untuk jalur
// khusus (halaman embed) saja, dan sengaja HANYA menulis nama `embed_at` —
// jangan pernah menulis `at` dari JS (lihat catatan di bawah).

// Hapus cookie
export function eraseCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

/**
 * [AUDIT 2026-10-24] Cookie token KHUSUS halaman embed (`/embed/:id?token=…`).
 *
 * Dulu halaman itu menulis token ke cookie bernama `at` — nama yang SAMA dengan
 * cookie sesi HttpOnly server — lalu hidup 7 hari meski token aksesnya hanya 15
 * menit. Dua cookie berbagi nama membuat hasil auth bergantung pada mana yang
 * menang di browser, dan salinan non-HttpOnly berumur panjang adalah target XSS.
 * Sekarang: nama berbeda (`embed_at`, dibaca `requireAuth` sebagai fallback) dan
 * umur cookie = `exp` token itu sendiri, jadi tidak ada kredensial yang hidup
 * lebih lama dari tokennya.
 */
export const EMBED_ACCESS_COOKIE = 'embed_at';

/** Kapan token ini kedaluwarsa? Tanpa `exp` yang bisa dibaca → 15 menit (umur token akses). */
function tokenExpiry (token: string): Date {
  const fallback = new Date(Date.now() + 15 * 60 * 1000);
  const part = token.split('.')[1];
  if (!part) return fallback;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : fallback;
  } catch {
    return fallback;
  }
}

/** Simpan token embed sebagai cookie yang mati tepat saat tokennya mati. */
export function setEmbedAccessCookie (token: string) {
  if (typeof document === "undefined") return;
  const expiresAt = tokenExpiry(token);
  // Token yang sudah kedaluwarsa tidak perlu disimpan sama sekali.
  if (expiresAt.getTime() <= Date.now()) return;
  document.cookie = `${EMBED_ACCESS_COOKIE}=${encodeURIComponent(
    token
  )};expires=${expiresAt.toUTCString()};path=/;SameSite=Lax;Secure`;
}

// Hapus semua cookie auth
export function clearAuthCookies() {
  if (typeof document === "undefined") return;
  document.cookie = "at=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  document.cookie = "rt=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  eraseCookie(EMBED_ACCESS_COOKIE);
}
