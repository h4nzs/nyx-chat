const API_URL = import.meta.env.VITE_API_URL ?? '';
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
  return `${API_URL}${relativePath}`;
}
