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
