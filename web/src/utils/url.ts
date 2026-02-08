const API_URL = "";
/**
 * Converts a relative server path to an absolute URL.
 * If the path is already absolute (starts with http) or a blob, it returns it as is.
 * @param relativePath The relative path from the server (e.g., /uploads/avatars/file.png)
 * @returns The full absolute URL or the original path if it's not a relative server path.
 */
export function toAbsoluteUrl(path: string | null | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  if (path.startsWith('http') || path.startsWith('blob:')) {
    return path;
  }

  // Hasilnya akan menjadi "/uploads/..." yang akan diproxy oleh Vercel ke Render
  return path;
}

export function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}