/**
 * Global RAM-based Cache for Decrypted Blobs.
 * 
 * PURPOSE:
 * 1. Eliminate redundant CPU-intensive decryption (XChaCha20) when re-rendering 
 *    media components (images, voice notes) in virtual lists like react-virtuoso.
 * 2. Instant UI response when scrolling back to previously seen media.
 * 3. Security: Stores ONLY blob: URLs in memory. Never persists to disk (LocalStorage/IDB).
 *    All URLs are invalidated when the app session ends (tab closed).
 */

type BlobUrl = string;
type FileKey = string;

const blobCache = new Map<FileKey, BlobUrl>();

/**
 * Retrieves a cached blob: URL for a given file key.
 */
export function getCachedBlobUrl(fileKey: FileKey): BlobUrl | undefined {
  if (!fileKey) return undefined;
  return blobCache.get(fileKey);
}

/**
 * Stores a blob: URL in the global cache.
 */
export function setCachedBlobUrl(fileKey: FileKey, url: BlobUrl): void {
  if (!fileKey || !url) return;
  
  // If we already have a URL for this key, don't leak it
  const existing = blobCache.get(fileKey);
  if (existing && existing !== url) {
    if (existing.startsWith('blob:')) {
        try { URL.revokeObjectURL(existing); } catch (e) {}
    }
  }

  blobCache.set(fileKey, url);
}

/**
 * Revokes all cached blob URLs and clears the cache.
 * Use for global logout or emergency data wipe.
 */
export function clearBlobCache(): void {
  for (const url of blobCache.values()) {
    if (url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
  }
  blobCache.clear();
}

// Attach to window for debugging in development only
if (import.meta.env.DEV) {
  window._nyxBlobCache = blobCache;
}
