const API_URL = "";
/**
 * Converts a relative server path to an absolute URL.
 * If the path is already absolute (starts with http) or a blob, it returns it as is.
 * @param relativePath The relative path from the server (e.g., /uploads/avatars/file.png)
 * @returns The full absolute URL or the original path if it's not a relative server path.
 */
export function toAbsoluteUrl(relativePath: string | null | undefined): string | undefined {
  if (!relativePath) {
    return undefined;
  }
  // Don't modify absolute URLs or blob URLs (for local previews)
if (relativePath.startsWith('http') || relativePath.startsWith('blob:')) {
    return relativePath;
  }

  let cleanPath = relativePath;
  if (cleanPath.startsWith('/api/uploads')) {
      cleanPath = cleanPath.replace('/api/uploads', '/uploads');
  } else if (!cleanPath.startsWith('/')) {
      // Pastikan ada slash di awal jika belum ada
      cleanPath = `/${cleanPath}`;
  }

  // Hasilnya akan menjadi "/uploads/..." yang akan diproxy oleh Vercel ke Render
  return `${API_URL}${cleanPath}`;
}
