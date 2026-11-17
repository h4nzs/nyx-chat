// CATATAN KONTRAK: cookie `at`/`rt` yang sesungguhnya di-set server sebagai
// HttpOnly — JS klien tidak bisa membaca/menghapusnya (clearAuthCookies hanya
// membersihkan sisa cookie non-HttpOnly; penghapusan yang benar terjadi
// server-side via /api/auth/logout & /logout-all). Jangan pernah menulis `at`
// atau `rt` dari JS.

// Hapus semua cookie auth
export function clearAuthCookies() {
  if (typeof document === "undefined") return;
  document.cookie = "at=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  document.cookie = "rt=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
}
