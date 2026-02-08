// Set cookie biasa
export function setCookie(name: string, value: string, days = 7) {
  if (typeof document === "undefined") return;
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = "expires=" + d.toUTCString();
  document.cookie = `${name}=${encodeURIComponent(
    value
  )};${expires};path=/;SameSite=Lax`;
}

// Set cookie "secure" (nama saja, browser client tidak bisa bikin httpOnly/secure asli)
export function setSecureCookie(name: string, value: string, days = 7) {
  if (typeof document === "undefined") return;
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = "expires=" + d.toUTCString();
  document.cookie = `${name}=${encodeURIComponent(
    value
  )};${expires};path=/;SameSite=Lax;Secure`;
}

// Hapus cookie
export function eraseCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

// Hapus semua cookie auth
export function clearAuthCookies() {
  if (typeof document === "undefined") return;
  document.cookie = "at=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  document.cookie = "rt=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
}